"""Coordinator tests use disposable Steam libraries and never launch games."""
import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("gaming_manage", HERE / "manage.py")
manage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manage)
import components
import framegen
import lsfg
import proton


class ManageTests(unittest.TestCase):
    def test_unreal_bootstrap_injects_beside_unique_shipping_child(self):
        bootstrap = self.game / "Example.exe"
        bootstrap.touch()
        shipping = self.game / "Example/Binaries/Win64/Example-Win64-Shipping.exe"
        shipping.parent.mkdir(parents=True)
        shipping.touch()
        self.write_profile({"provider": "framegen", "framegen": {"input": "dlssg", "output": "fsrfg"}})
        argv = ["proton", "waitforexitandrun", str(bootstrap)]
        with patch.object(framegen, "prepare_launch", return_value=(argv, self.nested_env())) as prepare:
            manage.prepare_launch(self.root, self.steam, argv, self.nested_env())
            self.assertEqual(prepare.call_args.args[1]["game_path"], str(shipping))
            self.assertEqual(prepare.call_args.args[2], argv)

    def test_unreal_ambiguous_shipping_children_fail_before_overlay(self):
        bootstrap = self.game / "Launcher.exe"
        bootstrap.touch()
        for name in ("Game", "Benchmark"):
            path = self.game / name / "Binaries/Win64" / (name + "-Win64-Shipping.exe")
            path.parent.mkdir(parents=True)
            path.touch()
        self.write_profile({"provider": "framegen", "framegen": {"input": "dlssg", "output": "fsrfg"}})
        with patch.object(framegen, "prepare_launch") as prepare:
            with self.assertRaisesRegex(ValueError, "several shipping"):
                manage.prepare_launch(self.root, self.steam, [str(bootstrap)], self.nested_env())
            prepare.assert_not_called()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="lwfa-gaming-coordinator-")
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.root = self.home / "gaming"
        self.steam = self.home / "Steam"
        (self.steam / "steamapps/common").mkdir(parents=True)
        self.game = self.add_game(self.steam, "100", "Test Game", "Game with spaces")

    def add_game(self, library, appid, title, install):
        directory = library / "steamapps/common" / install
        directory.mkdir(parents=True, exist_ok=True)
        manifest = library / "steamapps" / ("appmanifest_" + appid + ".acf")
        quote = lambda value: json.dumps(str(value))
        manifest.write_text('"AppState" { "appid" ' + quote(appid) + ' "name" ' + quote(title)
                            + ' "installdir" ' + quote(install) + ' }\n')
        return directory

    def write_profile(self, profile):
        self.root.mkdir(exist_ok=True)
        manage.atomic_json(self.root / "profiles.json", {"100": profile})

    def nested_env(self):
        return {"SteamAppId": "100", "WINE_CANVAS_FOLLOW_HOST": "1", "WINE_CANVAS_DPI_SAFE": "1"}

    def test_inventory_reads_additional_libraries_and_preserves_titles(self):
        other = self.home / "Other Library"
        second = self.add_game(other, "200", 'Another "game"', "Nested/Game")
        (self.steam / "steamapps/libraryfolders.vdf").write_text(
            '"libraryfolders" { "1" { "path" ' + json.dumps(str(other)) + ' } }')
        self.assertEqual(manage.game_inventory(self.steam), [
            {"appid": "200", "name": 'Another "game"', "directory": str(second)},
            {"appid": "100", "name": "Test Game", "directory": str(self.game)},
        ])

    def test_inventory_rejects_traversal_absolute_and_symlink_escapes(self):
        outside = self.home / "outside"
        outside.mkdir()
        (self.steam / "steamapps/common/link").symlink_to(outside, target_is_directory=True)
        for appid, install in [("201", "../../../outside"), ("202", str(outside)), ("203", "link")]:
            (self.steam / "steamapps" / ("appmanifest_" + appid + ".acf")).write_text(
                '"AppState" { "appid" ' + json.dumps(appid) + ' "name" "Escape" "installdir" ' + json.dumps(install) + ' }')
        self.assertEqual([game["appid"] for game in manage.game_inventory(self.steam)], ["100"])

    def test_inventory_skips_bad_manifest_and_missing_directory(self):
        (self.steam / "steamapps/appmanifest_200.acf").write_text('"AppState" { "appid"')
        (self.steam / "steamapps/appmanifest_300.acf").write_text(
            '"AppState" { "appid" "300" "name" "Missing" "installdir" "missing" }')
        self.assertEqual([game["appid"] for game in manage.game_inventory(self.steam)], ["100"])

    def test_valid_vdf_comments_between_key_and_value(self):
        path = self.home / "commented.vdf"
        path.write_text('"AppState" // comment\n { "appid" // id\n "100" "name" "" }')
        self.assertEqual(manage.read_vdf(path), {"AppState": {"appid": "100", "name": ""}})

    def test_invalid_profiles_are_value_errors_and_never_saved(self):
        invalid = [None, [], {}, {"provider": []}, {"provider": "both"},
                   {"provider": "lsfg"}, {"provider": "lsfg", "lsfg": {"multiplier": True}},
                   {"provider": "lsfg", "lsfg": {"flow_scale": float("nan")}},
                   {"provider": "lsfg", "lsfg": {"dll_path": "/untrusted"}},
                   {"provider": "framegen", "framegen": {"input": [], "output": "fsrfg"}},
                   {"provider": "framegen", "framegen": {"input": "nukems", "output": "xefg"}}]
        for profile in invalid:
            with self.subTest(profile=profile), self.assertRaises(ValueError):
                manage.request(self.root, self.steam, {"action": "saveProfile", "appid": "100", "profile": profile})
        self.assertFalse((self.root / "profiles.json").exists())

    def test_save_rejects_removed_game(self):
        with self.assertRaisesRegex(ValueError, "no longer installed"):
            manage.request(self.root, self.steam, {"action": "saveProfile", "appid": "999", "profile": {"provider": "off"}})

    def test_concurrent_profile_saves_preserve_every_game(self):
        appids = [str(n) for n in range(300, 308)]
        for appid in appids:
            self.add_game(self.steam, appid, "Game " + appid, appid)
        script = ("import sys; from pathlib import Path; import manage; "
                  "manage.status=lambda root, steam: {}; "
                  "manage.request(Path(sys.argv[1]),Path(sys.argv[2]),"
                  "{'action':'saveProfile','appid':sys.argv[3],'profile':{'provider':'off'}})")
        children = [subprocess.Popen([sys.executable, "-c", script, str(self.root), str(self.steam), appid],
                                     cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for appid in appids]
        for child in children:
            stdout, stderr = child.communicate(timeout=15)
            self.assertEqual(child.returncode, 0, stderr or stdout)
        self.assertEqual(set(manage.read_profiles(self.root)), set(appids))
        self.assertEqual(list(self.root.glob(".profile-*")), [])

    def test_atomic_save_failure_preserves_previous_file(self):
        self.write_profile({"provider": "off"})
        previous = (self.root / "profiles.json").read_bytes()
        with patch.object(manage.os, "replace", side_effect=OSError("disk failure")):
            with self.assertRaises(OSError):
                manage.atomic_json(self.root / "profiles.json", {"changed": True})
        self.assertEqual((self.root / "profiles.json").read_bytes(), previous)
        self.assertEqual(list(self.root.glob(".profile-*")), [])

    def test_host_passthrough_ignores_profiles_and_unavailable_components(self):
        command = ["proton", "run", "a game.exe", "argument with spaces"]
        for env in ({}, {"WINE_CANVAS_FOLLOW_HOST": "1"}, {"WINE_CANVAS_DPI_SAFE": "1"}):
            with patch.object(manage, "read_profiles", side_effect=AssertionError("host read profiles")):
                self.assertEqual(manage.prepare_launch(self.root, self.steam, command, env), (command, env))

    def test_host_wrapper_executes_exact_arguments_without_steam_discovery(self):
        env = {key: value for key, value in os.environ.items() if not key.startswith("WINE_CANVAS_")}
        env.update(HOME=str(self.home / "empty-home"), XDG_DATA_HOME=str(self.home / "empty-data"))
        command = [str(HERE / "lwfa-game"), sys.executable, "-c",
                   "import json,sys;print(json.dumps(sys.argv[1:]))", "argument with spaces", "$(touch do-not-run)"]
        result = subprocess.run(command, env=env, text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout), ["argument with spaces", "$(touch do-not-run)"])

    def test_lsfg_launch_passes_appid_and_only_selected_provider(self):
        settings = {"multiplier": 2, "flow_scale": 0.75, "performance_mode": True}
        self.write_profile({"provider": "lsfg", "lsfg": settings})
        env = self.nested_env()
        command = ["proton", "run", "game.exe"]
        with patch.object(lsfg, "prepare_launch", return_value={**env, "TEST_LSFG": "1"}) as prepare:
            with patch.object(framegen, "prepare_launch", side_effect=AssertionError("other provider")):
                result = manage.prepare_launch(self.root, self.steam, command, env)
        prepare.assert_called_once_with(self.root, {**settings, "game_id": "100"}, env)
        self.assertEqual(result, (command, {**env, "TEST_LSFG": "1"}))
        self.assertNotIn("TEST_LSFG", env)

    def test_framegen_uses_game_executable_inside_selected_installation(self):
        executable = self.game / "Game.exe"
        executable.write_bytes(b"fixture")
        foreign = self.home / "Foreign.exe"
        foreign.write_bytes(b"fixture")
        settings = {"input": "dlssg", "output": "fsrfg"}
        self.write_profile({"provider": "framegen", "framegen": settings})
        env = self.nested_env()
        command = ["proton", str(foreign), "run", str(executable)]
        with patch.object(framegen, "prepare_launch", return_value=(["isolated", *command], env)) as prepare:
            result = manage.prepare_launch(self.root, self.steam, command, env)
        self.assertEqual(prepare.call_args.args[1], {"provider": "framegen", "framegen": {**settings, "enabled": True},
                                                   "appid": "100", "game_path": str(executable)})
        self.assertEqual(result[0], ["isolated", *command])

    def test_framegen_rejects_foreign_executable_before_provider_launch(self):
        executable = self.home / "Foreign.exe"
        executable.write_bytes(b"fixture")
        self.write_profile({"provider": "framegen", "framegen": {"input": "dlssg", "output": "fsrfg"}})
        with patch.object(framegen, "prepare_launch", side_effect=AssertionError("must not launch")):
            with self.assertRaisesRegex(ValueError, "executable path"):
                manage.prepare_launch(self.root, self.steam, [str(executable)], self.nested_env())

    def test_steam_game_id_fallback_uses_matching_profile(self):
        self.write_profile({"provider": "lsfg", "lsfg": {}})
        env = self.nested_env()
        env["SteamGameId"] = env.pop("SteamAppId")
        with patch.object(lsfg, "prepare_launch", return_value=env) as prepare:
            manage.prepare_launch(self.root, self.steam, ["proton"], env)
        self.assertEqual(prepare.call_args.args[1]["game_id"], "100")

    def test_status_keeps_component_shapes_and_proton_manager_tools(self):
        # Exercise the actual read-only Proton helper against our empty Steam fixture.
        with patch.object(lsfg, "component_status", return_value={"installed": False, "version": "fixture"}), \
             patch.object(framegen, "component_status", return_value={"installed": False, "version": "fixture-fg"}):
            result = manage.status(self.root, self.steam)
        self.assertEqual(result["proton"], {"tools": []})
        self.assertEqual(result["lsfg"], {"installed": False, "version": "fixture"})
        self.assertEqual(result["framegen"], {"installed": False, "version": "fixture-fg"})

    def test_lsfg_install_calls_component_with_correct_signature(self):
        with patch.object(lsfg, "install_component", return_value={}) as install, \
             patch.object(manage, "status", return_value={}):
            manage.request(self.root, self.steam, {"action": "install", "component": "lsfg"})
        install.assert_called_once_with(self.root)

    def test_proton_install_uses_packaged_artifact_and_pinned_download_path(self):
        here = self.home / "package/compat/gaming"
        bundle = here.parent / "wine-canvas/artifact"
        bundle.mkdir(parents=True)
        with patch.object(manage, "HERE", here), patch.object(proton, "ensure_bundle", return_value=bundle) as ensure, \
             patch.object(manage, "proton_command", return_value={}) as invoke, \
             patch.object(manage, "status", return_value={}):
            manage.request(self.root, self.steam, {"action": "install", "component": "proton"})
        ensure.assert_called_once_with(self.root)
        invoke.assert_called_once_with("install", "--bundle", str(bundle), "--steam-root", str(self.steam),
                                       "--download-base", "--cache", str(self.root / "downloads"))

    def test_empty_lsfg_settings_are_normalized_before_storage_and_status(self):
        with patch.object(manage, "proton_command", return_value={"tools": []}), \
             patch.object(lsfg, "component_status", return_value={"installed": False}), \
             patch.object(framegen, "component_status", return_value={"installed": False}):
            result = manage.request(self.root, self.steam, {"action": "saveProfile", "appid": "100",
                                                           "profile": {"provider": "lsfg", "lsfg": {}}})
        expected = {"provider": "lsfg", "lsfg": {"multiplier": 2, "flow_scale": 1.0, "performance_mode": False}}
        self.assertEqual(result["profiles"]["100"], expected)
        self.assertEqual(manage.read_profiles(self.root)["100"], expected)

    def test_proton_install_uses_offline_original_when_packaged(self):
        here = self.home / "package/compat/gaming"
        archive = here.parent / "wine-canvas/base.tar.gz"
        archive.parent.mkdir(parents=True)
        archive.write_bytes(b"fixture")
        bundle = archive.parent / "artifact"
        with patch.object(manage, "HERE", here), patch.object(proton, "ensure_bundle", return_value=bundle), \
             patch.object(manage, "proton_command", return_value={}) as invoke, \
             patch.object(manage, "status", return_value={}):
            manage.request(self.root, self.steam, {"action": "install", "component": "proton"})
        invoke.assert_called_once_with("install", "--bundle", str(bundle), "--steam-root", str(self.steam),
                                       "--base-archive", str(archive), "--cache", str(self.root / "downloads"))

    def test_proton_adapter_preserves_json_shape_and_reports_helper_error(self):
        with patch.object(manage.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, '{"tools": []}', '')) as invoke:
            self.assertEqual(manage.proton_command("status", "--steam-root", str(self.steam)), {"tools": []})
        self.assertEqual(invoke.call_args.args[0][-4:], ["status", "--steam-root", str(self.steam), "--json"])
        with patch.object(manage.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, '', 'fixture checksum error')):
            with self.assertRaisesRegex(ValueError, "checksum error"):
                manage.proton_command("install")

    def test_persistent_profiles_components_and_overlays_survive_engine_replacement(self):
        data = self.home / "user-data"
        engine = data / "lwfa"
        with patch.dict(os.environ, {"XDG_DATA_HOME": str(data)}):
            persistent = manage.data_root()
        self.assertEqual(persistent, data / "lwfa-gaming")
        self.assertFalse(persistent.is_relative_to(engine))
        engine.mkdir(parents=True)
        (engine / "old-engine").write_text("old release")
        files = {
            "profiles.json": '{"100":{"provider":"off"}}',
            "components/proton-artifact/fixture/manifest.json": "fixture artifact",
            "overlays/framegen/100/fixture/settings.ini": "retained game edits",
        }
        for relative, contents in files.items():
            path = persistent / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents)
        # Mirror the installer's replaceable payload boundary without invoking
        # installation, service management, or any real user directories.
        shutil.rmtree(engine)
        engine.mkdir()
        (engine / "new-engine").write_text("new release")
        self.assertEqual(manage.read_profiles(persistent), {"100": {"provider": "off"}})
        for relative, contents in files.items():
            self.assertEqual((persistent / relative).read_text(), contents)


if __name__ == "__main__":
    unittest.main()
