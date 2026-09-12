"""Framegen installer and real namespace regressions; never launch a real game."""

import configparser
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import framegen


class FramegenTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lwfa-framegen-test-")
        self.base = Path(self.temporary.name)
        self.root = self.base / "gaming"
        self.game_dir = self.base / "game"
        self.game_dir.mkdir()
        self.game = self.game_dir / "Game-Win64-Shipping.exe"
        self.game.write_bytes(b"disposable executable fixture")
        self.profile = {"appid": "1234", "game_path": str(self.game), "provider": "framegen",
                        "framegen": {"input": "nukems", "output": "nukems", "enabled": True}}
        self.env = dict(os.environ, WINEPREFIX=str(self.base / "prefix"),
                        WINE_CANVAS_FOLLOW_HOST="1", WINE_CANVAS_DPI_SAFE="1")
        self.env.pop("STEAM_COMPAT_DATA_PATH", None)
        self.payload = framegen._release_dir(self.root) / "payload"
        self.payload.mkdir(parents=True)
        for name in framegen.REQUIRED_FILES:
            (self.payload / name).write_bytes(b"test component " + name.encode())
        (self.payload / "OptiScaler.ini").write_text(
            "[Upscalers]\nDx12Upscaler=auto\n[FrameGen]\nEnabled=auto\n"
            "FGInput=auto\nFGOutput=auto\n[Libraries]\nOptiDllPath=auto\n"
            "[Hotfix]\nDisableOverlays=auto\n[Plugins]\nLoadAsiPlugins=auto\n"
            "[NvApi]\nOverrideNvapiDll=auto\n[DLSS]\nEnabled=auto\n")
        self.write_manifest()

    def tearDown(self):
        self.temporary.cleanup()

    def write_manifest(self):
        files = {p.name: {"size": p.stat().st_size, "sha256": framegen._sha256(p)}
                 for p in self.payload.iterdir()}
        (self.payload.parent / "manifest.json").write_text(json.dumps({
            "schema": 1, "version": framegen.VERSION,
            "archive_sha256": framegen.ARCHIVE_SHA256, "files": files,
        }))

    def prepare(self, argv=None, env=None):
        with patch.object(framegen, "_bubblewrap", return_value="/usr/bin/bwrap"):
            return framegen.prepare_launch(self.root, self.profile, argv or ["/usr/bin/true"], env or self.env)

    def test_host_launch_is_unchanged_even_with_enabled_profile(self):
        self.env.pop("WINE_CANVAS_DPI_SAFE")
        shutil.rmtree(self.root)
        argv, env = self.prepare(["/unavailable/host/program"], self.env)
        self.assertEqual(argv, ["/unavailable/host/program"])
        self.assertEqual(env, self.env)
        self.assertFalse(self.root.exists())

    def test_off_provider_is_a_noop(self):
        self.profile["provider"] = "off"
        self.assertEqual(self.prepare(), (["/usr/bin/true"], self.env))

    def test_preserves_existing_ue4ss_and_native_upscalers(self):
        original = {"dwmapi.dll": b"UE4SS", "nvngx_dlss.dll": b"native DLSS",
                    "libxess.dll": b"game's XeSS", "plugins": None}
        for name, data in original.items():
            if data is None:
                (self.game_dir / name).mkdir()
                (self.game_dir / name / "my-mod.asi").write_bytes(b"existing mod")
            else:
                (self.game_dir / name).write_bytes(data)
        self.env["WINEDLLOVERRIDES"] = "dwmapi=n,b;d3dcompiler_47=n"
        argv, env = self.prepare()
        self.assertEqual(env["WINEDLLOVERRIDES"], "dwmapi=n,b;d3dcompiler_47=n;dxgi=n,b")
        self.assertIn("--overlay", argv)
        for name, data in original.items():
            if data is not None:
                self.assertEqual((self.game_dir / name).read_bytes(), data)
        self.assertFalse((self.game_dir / "dxgi.dll").exists())
        self.assertFalse((self.game_dir / "OptiScaler.ini").exists())
        self.assertEqual((self.game_dir / "plugins/my-mod.asi").read_bytes(), b"existing mod")

    def test_config_keeps_steam_input_and_native_nvidia_paths(self):
        self.prepare()
        ini = next((self.root / "overlays").rglob("OptiScaler.ini"))
        cfg = configparser.ConfigParser()
        cfg.read(ini)
        self.assertEqual(cfg["Hotfix"]["DisableOverlays"], "false")
        self.assertEqual(cfg["Plugins"]["LoadAsiPlugins"], "false")
        self.assertEqual(cfg["NvApi"]["OverrideNvapiDll"], "false")
        self.assertEqual(cfg["DLSS"]["Enabled"], "auto")
        self.assertEqual(cfg["Upscalers"]["Dx12Upscaler"], "auto")
        self.assertEqual(cfg["FrameGen"]["FGInput"], "nukems")

    def test_existing_graphics_injector_is_not_overwritten(self):
        (self.game_dir / "DXGI.DLL").write_bytes(b"ReShade")
        with self.assertRaisesRegex(ValueError, "already has a graphics injector"):
            self.prepare()
        self.assertEqual((self.game_dir / "DXGI.DLL").read_bytes(), b"ReShade")
        self.assertFalse((self.root / "overlays").exists())

    def test_grouped_override_is_preserved_and_conflicting_override_rejected(self):
        existing = "dxgi,winmm=n,b;dwmapi=n,b"
        self.assertEqual(framegen._merge_override(existing, "dxgi"), existing)
        with self.assertRaisesRegex(ValueError, "conflicts"):
            framegen._merge_override("dxgi=b;dwmapi=n,b", "dxgi")

    def test_foreign_framegen_is_disabled_without_removing_controller_environment(self):
        self.env.update(LSFG_MULTIPLIER="3", LSFGVK_PROFILE="old-profile", LWFA_LSFG="1",
                        VK_INSTANCE_LAYERS="VK_LAYER_LS_frame_generation:VK_LAYER_MANGOHUD_overlay",
                        VK_LOADER_LAYERS_ALLOW="VK_LAYER_LSFGVK_frame_generation",
                        SDL_GAMECONTROLLERCONFIG="controller layout", SteamAppId="1234")
        original = dict(self.env)
        _, env = self.prepare()
        self.assertEqual(self.env, original)
        self.assertEqual(env["DISABLE_LSFG"], "1")
        self.assertEqual(env["DISABLE_LSFGVK"], "1")
        self.assertEqual(env["VK_INSTANCE_LAYERS"], "VK_LAYER_MANGOHUD_overlay")
        self.assertNotIn("VK_LOADER_LAYERS_ALLOW", env)
        self.assertNotIn("LWFA_LSFG", env)
        self.assertNotIn("LSFG_MULTIPLIER", env)
        self.assertNotIn("LSFGVK_PROFILE", env)
        self.assertEqual(env["SDL_GAMECONTROLLERCONFIG"], "controller layout")
        self.assertEqual(env["SteamAppId"], "1234")
        self.assertIn("VK_LAYER_LWFA_LS_frame_generation", env["VK_LOADER_LAYERS_DISABLE"])

    def test_wildcard_layer_enable_is_rejected(self):
        self.env["VK_LOADER_LAYERS_ENABLE"] = "VK_LAYER_*"
        with self.assertRaisesRegex(ValueError, "conflicting frame generation layers"):
            self.prepare()

    def test_rejects_invalid_or_ineffective_provider_pairs(self):
        for source, output in [("auto", "auto"), ("nukems", "xefg"), ("dlssg", "nukems")]:
            self.profile["framegen"].update(input=source, output=output)
            with self.subTest(source=source, output=output), self.assertRaises(ValueError):
                self.prepare()
        self.assertFalse((self.root / "overlays").exists())

    def test_changed_component_is_detected_before_launch(self):
        (self.payload / "OptiScaler.dll").write_bytes(b"x" * (self.payload / "OptiScaler.dll").stat().st_size)
        with self.assertRaisesRegex(ValueError, "checksum changed"):
            self.prepare()
        self.assertFalse((self.game_dir / "dxgi.dll").exists())

    def test_parent_symlink_cannot_redirect_overlay_writes(self):
        outside = self.base / "outside"
        outside.mkdir()
        (self.root / "overlays").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.prepare()
        self.assertEqual(list(outside.iterdir()), [])

    def test_wine_prefix_without_identity_is_rejected(self):
        self.env.pop("WINEPREFIX")
        with self.assertRaisesRegex(ValueError, "identify.*Wine prefix"):
            self.prepare()

    def test_live_wine_server_is_rejected(self):
        prefix = self.base / "prefix"
        prefix.mkdir()
        locked = framegen._FileLock(fcntl.F_WRLCK, os.SEEK_SET, 0, 1, 2468)
        with patch.object(framegen.os, "open", return_value=99), \
             patch.object(framegen.os, "close"), \
             patch.object(framegen.fcntl, "fcntl", return_value=bytes(locked)):
            with self.assertRaisesRegex(ValueError, "already running"):
                framegen._guard_prefix(self.env)

    def test_custom_wine_drive_mapping_is_rejected(self):
        devices = self.base / "prefix/dosdevices"
        devices.mkdir(parents=True)
        (devices / "z:").symlink_to(self.base)
        with self.assertRaisesRegex(ValueError, "custom Z: mapping"):
            self.prepare()

    def test_existing_verified_install_is_not_downloaded_again(self):
        with patch.object(framegen, "download_verified") as download:
            self.assertTrue(framegen.install_component(self.root)["installed"])
            download.assert_not_called()

    def test_failed_install_does_not_publish_partial_component(self):
        shutil.rmtree(self.root)

        def failed_download(url, digest, path, **kwargs):
            path.write_bytes(b"partial archive")
            raise ValueError("download failed")

        with patch.object(framegen, "download_verified", side_effect=failed_download):
            with self.assertRaisesRegex(ValueError, "download failed"):
                framegen.install_component(self.root)
        self.assertFalse(framegen._release_dir(self.root).exists())
        self.assertFalse(any(framegen._release_dir(self.root).parent.glob(".install-*")))

    def test_unverified_archive_is_not_extracted(self):
        archive = self.base / "invalid.7z"
        archive.write_bytes(b"unverified content")
        with patch.object(framegen.shutil, "which", return_value="/usr/bin/7z"), \
             patch.object(framegen.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "checksum"):
                framegen._extract_archive(archive, self.base / "extract")
            run.assert_not_called()
        self.assertFalse((self.base / "extract").exists())

    def test_archive_rejects_traversal_links_duplicates_and_size_bombs(self):
        def entry(name, size=4, extra=""):
            return f"Path = {name}\nSize = {size}\nAttributes = A\nEncrypted = -\n{extra}\n"
        bad = [entry("../escape"), entry("/absolute"), entry("C:/windows"),
               entry("safe.dll", extra="Symbolic Link = ../../outside"),
               entry("safe.dll") + entry("SAFE.DLL"),
               entry("huge.dll", framegen.MAX_EXTRACTED_BYTES + 1)]
        for listing in bad:
            with self.subTest(listing=listing), self.assertRaises(ValueError):
                framegen._archive_entries(listing)
        self.assertEqual(framegen._archive_entries(entry("regular.dll")), {"regular.dll": (4, False)})

    def test_real_overlay_preserves_host_files_and_isolates_new_files(self):
        try:
            binary = framegen._bubblewrap()
        except (ValueError, OSError, subprocess.SubprocessError) as exc:
            self.skipTest(str(exc))
        (self.game_dir / "dwmapi.dll").write_bytes(b"UE4SS")
        code = (
            "from pathlib import Path; import sys; p=Path(sys.argv[1]); "
            "assert (p/'dwmapi.dll').read_bytes()==b'UE4SS'; "
            "assert (p/'dxgi.dll').read_bytes().startswith(b'test component'); "
            "assert 'FGInput=nukems' in (p/'OptiScaler.ini').read_text(); "
            "(p/'new-save.txt').write_text('private save'); print('overlay-ok')"
        )
        argv, env = self.prepare([sys.executable, "-c", code, str(self.game_dir)])
        argv[0] = binary
        result = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=15)
        # This test is deliberately not skipped on a mount failure when bwrap
        # advertises support; that is a real unsupported deployment to report.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "overlay-ok")
        self.assertFalse((self.game_dir / "dxgi.dll").exists())
        self.assertFalse((self.game_dir / "new-save.txt").exists())
        self.assertEqual((self.game_dir / "dwmapi.dll").read_bytes(), b"UE4SS")
        self.assertEqual(next((self.root / "overlays").rglob("new-save.txt")).read_text(), "private save")


if __name__ == "__main__":
    unittest.main()
