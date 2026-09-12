"""Routing and registration tests use only disposable fake runtimes."""
import hashlib
import json
import sys
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tarfile
import io
import unittest
from unittest.mock import patch

import manage
import base_archive
import router


class RouterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.launcher_directory = tempfile.TemporaryDirectory(prefix="lwfa-launcher-test-")
        cls.addClassCleanup(cls.launcher_directory.cleanup)
        cls.launcher = Path(cls.launcher_directory.name) / "launcher"
        subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                        str(Path(__file__).with_name("launcher.c")), "-o", str(cls.launcher)], check=True)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lwfa-router-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.steam = self.root / "Steam"
        self.base = self.steam / "compatibilitytools.d" / "GE-Test"
        self.bundle = self.root / "artifact"
        self.base.mkdir(parents=True)
        self.bundle.mkdir()
        executable = ('#!/usr/bin/env python3\nimport json,os,sys\n'
                      'print(json.dumps({"path":__file__,"args":sys.argv[1:],'
                      '"flags":{k:v for k,v in os.environ.items() if k.startswith("WINE_CANVAS_")},'
                      '"libs":os.environ.get("WINEDLLPATH"),"server":os.environ.get("WINESERVER"),"proton_libs":os.environ.get("PROTON_LD_LIBRARY_PATH"),"proton_path":os.environ.get("PROTON_PATH"),"wine_bin":os.environ.get("WINE_BIN")}))\n')
        for name in router.ENTRYPOINTS:
            path = self.base / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(executable)
            path.chmod(0o755)
        patched = {"files/bin/wineserver": executable}
        for arch in ("x86_64", "i386"):
            for dll in ("win32u", "winex11"):
                name = "files/lib/wine/" + arch + "-unix/" + dll + ".so"
                path = self.base / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("original:" + name)
                patched[name] = "patched:" + name
        for name, data in patched.items():
            path = self.bundle / "payload" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(data)
            if name.endswith("wineserver"):
                path.chmod(0o755)
        digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        self.manifest = {
            "schemaVersion": 1,
            "base": {"toolName": "GE-Test", "files": {
                name: digest(self.base / name) for name in set(patched) | set(router.ENTRYPOINTS)}},
            "patched": {"files": {name: digest(self.bundle / "payload" / name) for name in patched}},
            "build": {"kind": "host", "portable": False, "architectures": ["x86_64", "i386"]},
        }
        (self.bundle / "manifest.json").write_text(json.dumps(self.manifest))
        self.tool = manage.install(self.bundle, self.steam, self.launcher)

    def invoke(self, entry="proton", flags=None, check=True):
        env = {k: v for k, v in os.environ.items() if not k.startswith("WINE_CANVAS_")}
        env.update(flags or {})
        env["WINEPREFIX"] = str(self.root / "unused-prefix")
        env.pop("STEAM_COMPAT_DATA_PATH", None)
        env["WINEDLLPATH"] = str(self.tool / "files/lib/wine")
        env["WINESERVER"] = str(self.tool / "files/bin/wineserver")
        env["PROTON_LD_LIBRARY_PATH"] = str(self.tool / "files/lib") + ":/unrelated/lib"
        env["PROTON_PATH"] = str(self.tool)
        env["WINE_BIN"] = str(self.tool / "files/bin/wine")
        result = subprocess.run([str(self.tool / entry), "argument with spaces"], env=env,
                                text=True, capture_output=True, check=check)
        return json.loads(result.stdout) if check else result

    def test_prefix_guard_observes_real_kernel_lock_without_touching_owner(self):
        directory = self.root / "server-test"
        directory.mkdir()
        lock = directory / "lock"
        lock.write_text("unchanged")
        script = "import fcntl,sys,time; f=open(sys.argv[1],'r+'); fcntl.lockf(f,fcntl.LOCK_EX,1); print('ready',flush=True); time.sleep(30)"
        child = subprocess.Popen([sys.executable, "-c", script, str(lock)], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "ready")
            self.assertEqual(router.lock_owner(lock), child.pid)
            with patch.object(router, "server_directory", return_value=directory):
                router.guard_prefix_server(self.root / "prefix", Path(sys.executable))
                with self.assertRaisesRegex(ValueError, "another runtime"):
                    router.guard_prefix_server(self.root / "prefix", self.base / "files/bin/wineserver")
            self.assertIsNone(child.poll(), "guard must not terminate the active server")
            self.assertEqual(lock.read_text(), "unchanged")
        finally:
            child.terminate()
            child.wait(timeout=5)
            child.stdout.close()
        self.assertIsNone(router.lock_owner(lock))

    def test_server_identity_uses_prefix_inode_and_proton_prefix_location(self):
        prefix = self.root / "prefix"
        prefix.mkdir()
        info = prefix.stat()
        self.assertEqual(router.server_directory(prefix).name, "server-%x-%x" % (info.st_dev, info.st_ino))
        self.assertEqual(router.prefix_for("proton", {"STEAM_COMPAT_DATA_PATH": str(self.root)}), self.root / "pfx")
        self.assertEqual(router.prefix_for("files/bin/wine", {"WINEPREFIX": str(prefix)}), prefix)

    def test_host_uses_original_for_every_front_door_and_strips_partial_flags(self):
        for entry in router.ENTRYPOINTS:
            output = self.invoke(entry, {router.FLAGS[0]: "1", "WINE_CANVAS_OTHER": "1"})
            self.assertEqual(output["path"], str(self.base / entry))
            self.assertEqual(output["flags"], {})
            self.assertEqual(output["args"], ["argument with spaces"])
            self.assertEqual(output["libs"], str(self.base / "files/lib/wine"))
            self.assertEqual(output["server"], str(self.base / "files/bin/wineserver"))
            self.assertEqual(output["proton_libs"], str(self.base / "files/lib") + ":/unrelated/lib")
            self.assertEqual(output["proton_path"], str(self.base))
            self.assertEqual(output["wine_bin"], str(self.base / "files/bin/wine"))

    def test_nested_uses_private_runtime_for_every_front_door(self):
        for entry in router.ENTRYPOINTS:
            output = self.invoke(entry, dict.fromkeys(router.FLAGS, "1"))
            self.assertEqual(output["path"], str(self.tool / ".runtime" / entry))
            self.assertEqual(output["flags"], dict.fromkeys(router.FLAGS, "1"))
            self.assertEqual(output["libs"], str(self.tool / ".runtime/files/lib/wine"))
            self.assertEqual(output["proton_libs"], str(self.tool / ".runtime/files/lib") + ":/unrelated/lib")
            self.assertEqual(output["proton_path"], str(self.tool / ".runtime"))
            self.assertEqual(output["wine_bin"], str(self.tool / ".runtime/files/bin/wine"))

    def test_registered_tool_survives_lwfa_bundle_removal(self):
        shutil.rmtree(self.bundle)
        output = self.invoke(flags=dict.fromkeys(router.FLAGS, "1"))
        self.assertEqual(output["path"], str(self.tool / ".runtime/proton"))

    def test_host_survives_missing_patch_and_original_update(self):
        shutil.rmtree(self.bundle)
        shutil.rmtree(self.tool / ".artifact")
        shutil.rmtree(self.tool / ".runtime")
        with (self.base / "proton").open("a") as stream:
            stream.write("# updated original runtime\n")
        self.assertEqual(self.invoke()["path"], str(self.base / "proton"))
        self.assertNotEqual(self.invoke(flags=dict.fromkeys(router.FLAGS, "1"), check=False).returncode, 0)

    def test_nested_refuses_base_drift_without_breaking_host(self):
        with (self.base / "files/bin/wine").open("a") as stream:
            stream.write("# original updated\n")
        result = self.invoke(flags=dict.fromkeys(router.FLAGS, "1"), check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Runtime file changed", result.stderr)
        self.assertEqual(self.invoke()["path"], str(self.base / "proton"))

    def test_nested_refuses_private_payload_corruption(self):
        (self.tool / ".runtime/files/lib/wine/i386-unix/win32u.so").write_text("damaged")
        result = self.invoke(flags=dict.fromkeys(router.FLAGS, "1"), check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Runtime file changed", result.stderr)

    def test_portable_packaging_rejects_host_build(self):
        with self.assertRaisesRegex(ValueError, "Steam Runtime SDK"):
            router.artifact_manifest(self.bundle, portable=True)

    def test_packaging_requires_both_architectures(self):
        self.manifest["build"]["architectures"] = ["x86_64"]
        (self.bundle / "manifest.json").write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(ValueError, "matching x86_64 and i386"):
            router.artifact_manifest(self.bundle)

    def test_package_embeds_verified_payload_and_native_launchers(self):
        if not shutil.which("patchelf"):
            self.skipTest("patchelf is required by the package builder")
        repo = Path(__file__).resolve().parents[2]
        package = self.root / "package-source"
        for directory in ("scripts", "crates/lwfa-engine", "packages/shell/dist", "configs", "deploy", "docs", "compat", "vendor/smithay"):
            (package / directory).mkdir(parents=True, exist_ok=True)
        shutil.copy2(repo / "scripts/package.sh", package / "scripts/package.sh")
        shutil.copy2(repo / "install.sh", package / "install.sh")
        shutil.copy2(repo / "vendor/smithay/LICENSE.txt", package / "vendor/smithay/LICENSE.txt")
        shutil.copytree(Path(__file__).parent, package / "compat/wine-canvas", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(repo / "compat/gaming", package / "compat/gaming", ignore=shutil.ignore_patterns("__pycache__"))
        (package / "crates/lwfa-engine/Cargo.toml").write_text('version = "0.0.0-test"\n')
        (package / "packages/shell/dist/index.html").write_text("test shell")
        (package / "configs/defaults.toml").write_text("# test defaults\n")
        for name in ("README.md", "LICENSE"):
            (package / name).write_text("test package")
        env = dict(os.environ, LWFA_ENGINE=shutil.which("true"), LWFA_WINE_CANVAS_ARTIFACT=str(self.bundle), LWFA_PORTABLE_BUILD="0")
        subprocess.run(["bash", str(package / "scripts/package.sh"), "--no-build"], env=env,
                       check=True, text=True, capture_output=True)
        extracted = self.root / "extracted"
        subprocess.run([str(package / "releases/lwfa-0.0.0-test.run"), "--extract", str(extracted)],
                       check=True, text=True, capture_output=True)
        compat = extracted / "lwfa-0.0.0-test/share/lwfa/compat/wine-canvas"
        self.assertEqual(load_manifest := json.loads((compat / "artifact/manifest.json").read_text()), self.manifest)
        router.verify_files(compat / "artifact/payload", load_manifest["patched"]["files"])
        self.assertEqual((compat / "launcher").read_bytes()[:4], b"\x7fELF")
        self.assertTrue((compat / "router.py").is_file())
        self.assertTrue((compat.parent / "gaming/proton.py").is_file())
        self.assertTrue((compat.parent / "gaming/LICENSE").is_file())
        router.verify_files(self.base, self.manifest["base"]["files"])
        # The small package still needs both managers for one-click download.
        # This second build writes only inside the disposable package fixture.
        env.pop("LWFA_WINE_CANVAS_ARTIFACT")
        subprocess.run(["bash", str(package / "scripts/package.sh"), "--no-build"], env=env,
                       check=True, text=True, capture_output=True)
        small = self.root / "small-extracted"
        subprocess.run([str(package / "releases/lwfa-0.0.0-test.run"), "--extract", str(small)],
                       check=True, text=True, capture_output=True)
        compat = small / "lwfa-0.0.0-test/share/lwfa/compat"
        self.assertTrue((compat / "gaming/proton.py").is_file())
        self.assertTrue((compat / "gaming/README.md").is_file())
        self.assertTrue((compat / "wine-canvas/manage.py").is_file())
        self.assertTrue((compat / "wine-canvas/launcher").is_file())
        self.assertFalse((compat / "wine-canvas/artifact").exists())

    def test_install_leaves_original_intact_and_remove_does_not_touch_it(self):
        router.verify_files(self.base, self.manifest["base"]["files"])
        self.assertFalse((self.base / "route.json").exists())
        with self.assertRaises((ValueError, FileNotFoundError)):
            manage.remove(self.base)
        manage.remove(self.tool)
        router.verify_files(self.base, self.manifest["base"]["files"])

    def managed_archive(self, entries=None):
        archive = self.root / "original.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            if entries is None:
                output.add(self.base, arcname="GE-Test")
            else:
                for member, data in entries:
                    output.addfile(member, io.BytesIO(data))
        release = {"sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                   "size": archive.stat().st_size, "url": "https://example.invalid/pinned"}
        patched = patch.dict(base_archive.RELEASES, {"GE-Test": release})
        patched.start()
        self.addCleanup(patched.stop)
        return archive

    def test_managed_install_needs_no_external_ge_or_tools_directory(self):
        (self.base / "empty-directory").mkdir()
        (self.base / "internal-link").symlink_to("proton")
        archive = self.managed_archive()
        shutil.rmtree(self.steam / "compatibilitytools.d")
        self.tool = manage.install(self.bundle, self.steam, self.launcher, base_archive_path=archive)
        self.assertTrue((self.tool / ".original/empty-directory").is_dir())
        self.assertTrue((self.tool / ".original/internal-link").is_symlink())
        self.assertTrue((self.tool / "internal-link").is_file())
        for entry in router.ENTRYPOINTS:
            self.assertEqual(self.invoke(entry)["path"], str(self.tool / ".original" / entry))
            self.assertEqual(self.invoke(entry, dict.fromkeys(router.FLAGS, "1"))["path"], str(self.tool / ".runtime" / entry))
        shutil.rmtree(self.bundle)
        self.assertEqual(self.invoke()["path"], str(self.tool / ".original/proton"))

    def test_managed_install_reuses_exact_artifact_and_versions_changed_payload(self):
        archive = self.managed_archive()
        old = manage.install(self.bundle, self.steam, self.launcher, base_archive_path=archive)
        inode = old.stat().st_ino
        self.assertEqual(manage.install(self.bundle, self.steam, self.launcher, base_archive_path=archive), old)
        self.assertEqual(old.stat().st_ino, inode)
        name = "files/lib/wine/x86_64-unix/win32u.so"
        payload = self.bundle / "payload" / name
        payload.write_text("new patch")
        self.manifest["patched"]["files"][name] = hashlib.sha256(payload.read_bytes()).hexdigest()
        (self.bundle / "manifest.json").write_text(json.dumps(self.manifest))
        new = manage.install(self.bundle, self.steam, self.launcher, base_archive_path=archive)
        self.assertNotEqual(old, new)
        self.assertEqual((old / ".runtime" / name).read_text(), "patched:" + name)
        self.assertEqual((new / ".runtime" / name).read_text(), "new patch")

    def test_corrupt_archive_leaves_legacy_tool_and_no_staging(self):
        archive = self.managed_archive()
        original = archive.read_bytes()
        archive.write_bytes(bytes([original[0] ^ 1]) + original[1:])
        with self.assertRaisesRegex(ValueError, "checksum"):
            manage.install(self.bundle, self.steam, self.launcher, base_archive_path=archive)
        self.assertTrue(self.tool.is_dir())
        self.assertEqual(list(self.tool.parent.glob(".lwfa-canvas-*")), [])

    def test_archive_rejects_escape_symlink_hardlink_and_special_file(self):
        for kind in ("path", "symlink", "hardlink", "fifo"):
            with self.subTest(kind=kind):
                member = tarfile.TarInfo("../outside" if kind == "path" else "GE-Test/bad")
                if kind == "symlink":
                    member.type, member.linkname = tarfile.SYMTYPE, "../../outside"
                elif kind == "hardlink":
                    member.type, member.linkname = tarfile.LNKTYPE, "../outside"
                elif kind == "fifo":
                    member.type = tarfile.FIFOTYPE
                archive = self.managed_archive([(member, b"")])
                with self.assertRaises((ValueError, tarfile.FilterError)):
                    base_archive.extract(archive, self.root / "extract", "GE-Test")
                self.assertFalse((self.root / "extract").exists())
                self.assertFalse((self.root / "outside").exists())

    def test_unreviewed_runtime_rejects_archive_and_download(self):
        with self.assertRaisesRegex(ValueError, "No reviewed"):
            manage.install(self.bundle, self.steam, self.launcher, download_base=True)

    def test_old_python_rejects_managed_install_before_download(self):
        with patch.object(manage.sys, "version_info", (3, 9)), \
             patch.object(base_archive, "download", side_effect=AssertionError("must not download")):
            with self.assertRaisesRegex(ValueError, "Python 3.11"):
                manage.install(self.bundle, self.steam, self.launcher, download_base=True)

    def test_archive_download_checks_filtered_extraction_before_network_or_cache(self):
        for missing_filter in (False, True):
            with self.subTest(missing_filter=missing_filter):
                with patch.object(base_archive.sys, "version_info", (3, 11) if missing_filter else (3, 9)), \
                     patch.object(base_archive.urllib.request, "urlopen", side_effect=AssertionError("must not download")):
                    if missing_filter:
                        filter_function = base_archive.tarfile.data_filter
                        del base_archive.tarfile.data_filter
                    try:
                        with self.assertRaisesRegex(ValueError, "tar extraction filters"):
                            base_archive.download("GE-Test", self.root / "unused-cache")
                    finally:
                        if missing_filter:
                            base_archive.tarfile.data_filter = filter_function
        self.assertFalse((self.root / "unused-cache").exists())

    def test_download_verifies_pinned_bytes_and_reuses_cache(self):
        archive = self.managed_archive()
        cache = self.root / "cache"
        with patch.object(base_archive.urllib.request, "urlopen", return_value=io.BytesIO(archive.read_bytes())) as request:
            result = base_archive.download("GE-Test", cache)
            self.assertEqual(result.read_bytes(), archive.read_bytes())
            self.assertEqual(base_archive.download("GE-Test", cache), result)
            self.assertEqual(request.call_count, 1)
            self.assertEqual(request.call_args.args[0].full_url, "https://example.invalid/pinned")

    def test_download_failure_cleans_partial_file(self):
        self.managed_archive()
        cache = self.root / "cache"
        with patch.object(base_archive.urllib.request, "urlopen", return_value=io.BytesIO(b"truncated")):
            with self.assertRaisesRegex(ValueError, "size mismatch"):
                base_archive.download("GE-Test", cache)
        self.assertEqual(list(cache.iterdir()), [])

    def test_managed_bad_runtime_rolls_back_before_registration(self):
        (self.base / "files/bin/wine").write_text("incorrect upstream file")
        archive = self.managed_archive()
        with self.assertRaisesRegex(ValueError, "Runtime file changed"):
            manage.install(self.bundle, self.steam, self.launcher, base_archive_path=archive)
        self.assertEqual([p for p in self.tool.parent.iterdir() if p.name.startswith("lwfa-")], [self.tool])
        self.assertEqual(list(self.tool.parent.glob(".lwfa-canvas-*")), [])

    def test_status_cli_emits_json_without_registration_messages(self):
        result = subprocess.run([sys.executable, str(Path(manage.__file__)), "status",
                                 "--steam-root", str(self.steam), "--json"],
                                text=True, capture_output=True, check=True)
        record = json.loads(result.stdout)["tools"][0]
        self.assertEqual(record["path"], str(self.tool))
        self.assertFalse(record["selfContained"])

    def test_remove_refuses_real_process_executing_from_tool(self):
        executable = self.tool / "running-test"
        shutil.copy2(shutil.which("sleep"), executable)
        child = subprocess.Popen([str(executable), "30"])
        try:
            with self.assertRaisesRegex(ValueError, "in use"):
                manage.remove(self.tool)
            self.assertTrue(self.tool.is_dir())
            self.assertIsNone(child.poll())
            report = manage.status(self.steam)
            self.assertIn(child.pid, report["tools"][0]["activePids"])
        finally:
            child.terminate()
            child.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
