"""LSFG install integrity, launch isolation, and shader compatibility regressions."""

import hashlib
import io
import json
import os
from pathlib import Path
import struct
import tempfile
import tomllib
import unittest
from unittest.mock import patch
import zipfile

import components
import lsfg


def shader_dll(missing=None):
    """Small PE resource tree carrying the IDs the upstream extractor requires."""
    data = bytearray(8192)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 0x80)
    data[0x80:0x84] = b"PE\0\0"
    struct.pack_into("<HH", data, 0x84, 0x8664, 1)
    struct.pack_into("<H", data, 0x94, 240)
    struct.pack_into("<H", data, 0x98, 0x20B)
    struct.pack_into("<II", data, 0x98 + 128, 0x1000, 4096)
    section = 0x98 + 240
    struct.pack_into("<IIII", data, section + 8, 4096, 0x1000, 4096, 512)
    root = 512
    struct.pack_into("<HHII", data, root + 12, 0, 1, 10, 0x80000020)
    identifiers = [i for i in range(255, 303) if i != missing]
    struct.pack_into("<HH", data, root + 32 + 12, 0, len(identifiers))
    for index, identifier in enumerate(identifiers):
        language = 512 + index * 24
        resource = 2048 + index * 16
        struct.pack_into("<II", data, root + 48 + index * 8, identifier, language | 0x80000000)
        struct.pack_into("<HHII", data, root + language + 12, 0, 1, 1033, resource)
        struct.pack_into("<II", data, root + resource, 0x1000 + 3000 + index * 4, 4)
    return bytes(data)


class LSFGTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.root = self.base / "lwfa"
        self.home = self.base / "home"
        self.home.mkdir()
        self.env = {"HOME": str(self.home), "DISPLAY": ":87", "PULSE_SINK": "lwfa"}
        self.environment = patch.dict(os.environ, self.env, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.addCleanup(self.temporary.cleanup)

    def dll(self, missing=None):
        path = self.home / ".local/share/Steam/steamapps/common/Lossless Scaling/Lossless.dll"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(shader_dll(missing))
        return path

    def test_shader_preflight_accepts_complete_resources(self):
        lsfg.validate_dll(self.dll())

    def test_shader_preflight_rejects_missing_required_resource(self):
        with self.assertRaisesRegex(ValueError, "lacks the LSFG 3.1 shaders"):
            lsfg.validate_dll(self.dll(302))

    def test_shader_preflight_rejects_broken_resource_offsets(self):
        path = self.dll()
        data = bytearray(path.read_bytes())
        struct.pack_into("<I", data, 512 + 20, 0x800FFFFF)
        path.write_bytes(data)
        with self.assertRaisesRegex(ValueError, "resource directory"):
            lsfg.validate_dll(path)

    def test_non_dll_and_truncated_pe_rejected(self):
        path = self.dll()
        for data in (b"not a DLL", b"MZ"):
            path.write_bytes(data)
            with self.assertRaises(ValueError):
                lsfg.validate_dll(path)

    def test_secondary_steam_library_detected_without_modification(self):
        library = self.base / 'games "one"'
        dll = library / "steamapps/common/Lossless Scaling/Lossless.dll"
        dll.parent.mkdir(parents=True)
        dll.write_bytes(shader_dll())
        vdf = self.home / ".local/share/Steam/steamapps/libraryfolders.vdf"
        vdf.parent.mkdir(parents=True)
        value = '"libraryfolders" { "1" { "path" ' + json.dumps(str(library)) + ' } }'
        vdf.write_text(value)
        self.assertEqual(lsfg.find_dll(self.env), dll)
        self.assertEqual(vdf.read_text(), value)

    def test_invalid_profiles_rejected_before_writing(self):
        for profile in ({"multiplier": True}, {"multiplier": 5}, {"flow_scale": float("nan")},
                        {"flow_scale": True}, {"flow_scale": 0.1}, {"performance_mode": "false"},
                        {"game_id": "../../host"}, {"dll_path": "relative.dll"}, {"hdr_mode": True}):
            with self.subTest(profile=profile), self.assertRaises(ValueError):
                lsfg.prepare_launch(self.root, profile, self.env)
        self.assertFalse(self.root.exists())

    def prepared(self, env=None, profile=None):
        self.dll()
        with patch.object(lsfg, "component_status", return_value={"installed": True}):
            return lsfg.prepare_launch(self.root, profile or {"game_id": "2584270"}, env or self.env)

    def test_launch_is_private_and_preserves_game_environment(self):
        foreign_config = self.home / ".config/lsfg-vk/conf.toml"
        foreign_config.parent.mkdir(parents=True)
        foreign_config.write_text("existing Decky config")
        original = {**self.env, "LSFG_CONFIG": str(foreign_config), "LSFG_PROCESS": "3060",
                    "LSFG_LEGACY": "1", "LSFG_BENCHMARK": "1920x1080",
                    "LSFGVK_ENV": "1", "DISABLE_LSFG": "1",
                    "VK_INSTANCE_LAYERS": "VK_LAYER_MANGOHUD_overlay:VK_LAYER_LS_frame_generation",
                    "VK_ADD_IMPLICIT_LAYER_PATH": "/other/layers"}
        saved = dict(original)
        result = self.prepared(original)
        self.assertEqual(original, saved)
        self.assertEqual(result["DISPLAY"], ":87")
        self.assertEqual(result["PULSE_SINK"], "lwfa")
        self.assertEqual(result["VK_INSTANCE_LAYERS"], "VK_LAYER_MANGOHUD_overlay")
        self.assertEqual(result["DISABLE_LSFGVK"], "1")
        self.assertNotIn("DISABLE_LSFG", result)
        self.assertNotIn("LSFG_BENCHMARK", result)
        self.assertNotIn("LSFGVK_ENV", result)
        self.assertTrue(result["VK_ADD_IMPLICIT_LAYER_PATH"].endswith(":/other/layers"))
        self.assertEqual(foreign_config.read_text(), "existing Decky config")
        self.assertFalse((self.home / ".local/share/vulkan").exists())
        config = tomllib.loads(Path(result["LSFG_CONFIG"]).read_text())
        self.assertEqual(config["version"], 1)
        self.assertEqual(config["game"][0]["experimental_present_mode"], "fifo")
        self.assertFalse(config["game"][0]["hdr_mode"])
        manifest = json.loads(next(self.root.rglob("lwfa-lsfg.json")).read_text())["layer"]
        self.assertEqual(manifest["name"], lsfg.LAYER_NAME)
        self.assertEqual(manifest["disable_environment"], {"DISABLE_LSFG": "1"})
        self.assertEqual(manifest["enable_environment"], {"LWFA_LSFG": "1"})

    def test_private_path_preserves_explicit_implicit_override(self):
        result = self.prepared({**self.env, "VK_IMPLICIT_LAYER_PATH": "/existing/only"})
        self.assertTrue(result["VK_IMPLICIT_LAYER_PATH"].endswith(":/existing/only"))
        self.assertNotIn("VK_ADD_IMPLICIT_LAYER_PATH", result)

    def test_broad_layer_override_rejected_without_writing(self):
        self.dll()
        for key in ("VK_LOADER_LAYERS_ENABLE", "VK_LOADER_LAYERS_ALLOW"):
            with patch.object(lsfg, "component_status", return_value={"installed": True}):
                with self.assertRaisesRegex(ValueError, "conflicting frame generation layers"):
                    lsfg.prepare_launch(self.root, {}, {**self.env, key: "VK_LAYER_*"})
        self.assertFalse(self.root.exists())

    def test_two_games_do_not_overwrite_each_others_configuration(self):
        first = self.prepared(profile={"game_id": "1", "multiplier": 2})
        second = self.prepared(profile={"game_id": "2", "multiplier": 3})
        self.assertNotEqual(first["LSFG_CONFIG"], second["LSFG_CONFIG"])
        self.assertEqual(tomllib.loads(Path(first["LSFG_CONFIG"]).read_text())["game"][0]["multiplier"], 2)

    def test_missing_component_or_dll_does_not_create_runtime(self):
        with self.assertRaisesRegex(ValueError, "Install the lwfa LSFG"):
            lsfg.prepare_launch(self.root, {}, self.env)
        with patch.object(lsfg, "component_status", return_value={"installed": True}):
            with self.assertRaisesRegex(ValueError, "purchased Lossless Scaling"):
                lsfg.prepare_launch(self.root, {}, self.env)
        self.assertFalse(self.root.exists())

    def bundle(self, unsafe=False):
        content = io.BytesIO()
        with zipfile.ZipFile(content, "w") as archive:
            archive.writestr("lib/liblsfg-vk.so", b"test library")
            archive.writestr("share/vulkan/implicit_layer.d/VkLayer_LS_frame_generation.json", "{}")
            if unsafe:
                archive.writestr("../../escape", "bad")
        return content.getvalue()

    def fake_download(self, bundle, fail_license=False):
        def download(url, digest, path, max_bytes):
            if fail_license and "raw.githubusercontent" in url:
                raise ValueError("Component checksum does not match the pinned release")
            components.atomic_write(path, bundle if url == lsfg.ARCHIVE_URL else b"license")
        return download

    def test_install_publishes_only_complete_verified_component(self):
        digest = hashlib.sha256(b"test library").hexdigest()
        with patch.object(lsfg, "LIBRARY_SHA256", digest), \
             patch.object(lsfg, "download_verified", self.fake_download(self.bundle())):
            status = lsfg.install_component(self.root)
            self.assertTrue(status["installed"])
            self.assertFalse(status["dll_found"])
            self.assertTrue((lsfg._directory(self.root) / "licenses/lsfg-vk.txt").is_file())
            self.assertEqual(lsfg.install_component(self.root)["installed"], True)
        self.assertFalse((self.home / ".local/share/vulkan").exists())

    def test_archive_paths_and_failed_licenses_never_publish_install(self):
        for unsafe, fail_license in ((True, False), (False, True)):
            with self.subTest(unsafe=unsafe), patch.object(lsfg, "LIBRARY_SHA256", hashlib.sha256(b"test library").hexdigest()), \
                 patch.object(lsfg, "download_verified", self.fake_download(self.bundle(unsafe), fail_license)):
                with self.assertRaises(ValueError):
                    lsfg.install_component(self.root)
            self.assertFalse(lsfg._directory(self.root).exists())
            self.assertFalse((self.base / "escape").exists())


class DownloadsTests(unittest.TestCase):
    def test_bad_checksum_or_size_preserves_destination(self):
        class Response(io.BytesIO):
            def geturl(self):
                return "https://example.org/archive"
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "component"
            destination.write_bytes(b"existing")
            for digest, size in (("wrong", 100), (hashlib.sha256(b"data").hexdigest(), 2)):
                with patch("urllib.request.urlopen", return_value=Response(b"data")):
                    with self.assertRaises(ValueError):
                        components.download_verified("https://example.org/archive", digest, destination, size)
                self.assertEqual(destination.read_bytes(), b"existing")
                self.assertEqual([path.name for path in Path(directory).iterdir()], ["component"])


if __name__ == "__main__":
    unittest.main()
