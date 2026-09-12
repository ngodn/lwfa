#!/usr/bin/env python3
"""Managed gaming components and per-Steam-game profiles. No Steam config writes."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent


def data_root() -> Path:
    # The installer replaces XDG_DATA_HOME/lwfa during upgrades.
    return Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "lwfa-gaming"


def steam_root() -> Path:
    for path in (Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "Steam", Path.home() / ".steam/steam", Path.home() / ".steam/root",
                 Path.home() / ".var/app/com.valvesoftware.Steam/.local/share/Steam"):
        if (path / "steamapps").is_dir():
            return path.resolve()
    raise ValueError("Steam installation not found.")


def read_vdf(path: Path) -> dict:
    """Read Valve's quoted KeyValues format without interpreting paths as code."""
    text = path.read_text(errors="replace")
    tokens = iter((match.group(1), match.group(2)) for match in re.finditer(r'"((?:\\.|[^"\\])*)"|([{}])|(?://[^\n]*)', text)
                  if match.group(1) is not None or match.group(2) is not None)

    def read(nested=False):
        result = {}
        for quoted, brace in tokens:
            if brace == "}":
                if not nested:
                    raise ValueError("Unexpected closing brace in Steam manifest")
                return result
            if not quoted and not brace:
                continue
            key = re.sub(r'\\([\\"])', r'\1', quoted or "")
            value, marker = next(tokens)
            result[key] = read(True) if marker == "{" else re.sub(r'\\([\\"])', r'\1', value)
        if nested:
            raise ValueError("Incomplete Steam manifest")
        return result
    return read()


def game_inventory(steam: Path) -> list[dict]:
    libraries = {steam}
    try:
        folders = read_vdf(steam / "steamapps/libraryfolders.vdf").get("libraryfolders", {})
        for entry in folders.values():
            if isinstance(entry, dict) and entry.get("path"):
                libraries.add(Path(entry["path"]))
    except (OSError, ValueError, StopIteration):
        pass
    games = {}
    for library in sorted(libraries):
        for manifest in sorted((library / "steamapps").glob("appmanifest_*.acf")):
            try:
                app = read_vdf(manifest)["AppState"]
                appid = str(int(app["appid"]))
                common = (library / "steamapps/common").resolve()
                directory = (common / app["installdir"]).resolve()
                if not directory.is_relative_to(common) or not directory.is_dir():
                    continue
                games[appid] = {"appid": appid, "name": app["name"], "directory": str(directory)}
            except (OSError, ValueError, KeyError, TypeError, StopIteration):
                continue
    return sorted(games.values(), key=lambda game: game["name"].casefold())


@contextlib.contextmanager
def locked(root: Path):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / "manager.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def read_profiles(root: Path) -> dict:
    path = root / "profiles.json"
    return json.loads(path.read_text()) if path.exists() else {}


def atomic_json(path: Path, value: object):
    fd, temporary = tempfile.mkstemp(prefix=".profile-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def validate_profile(profile: dict) -> dict:
    import lsfg
    if not isinstance(profile, dict) or set(profile) - {"provider", "lsfg", "framegen"}:
        raise ValueError("Invalid gaming profile fields.")
    provider = profile.get("provider")
    if not isinstance(provider, str) or provider not in {"off", "lsfg", "framegen"}:
        raise ValueError("Choose one frame generation provider.")
    result = {"provider": provider}
    if "lsfg" in profile:
        settings = profile["lsfg"]
        if not isinstance(settings, dict) or set(settings) - {"multiplier", "flow_scale", "performance_mode"}:
            raise ValueError("Invalid LSFG settings.")
        result["lsfg"] = lsfg.validate_profile(settings)
    if "framegen" in profile:
        settings = profile["framegen"]
        if not isinstance(settings, dict) or set(settings) != {"input", "output"}:
            raise ValueError("Choose Framegen input and output.")
        pair = (settings["input"], settings["output"])
        if not all(isinstance(value, str) for value in pair):
            raise ValueError("Framegen input and output must be names.")
        if pair != ("nukems", "nukems") and not (pair[0] in {"dlssg", "fsrfg", "fsrfg30", "upscaler"} and pair[1] in {"fsrfg", "xefg"}):
            raise ValueError("Unsupported Framegen input/output pair.")
        result["framegen"] = settings
    if provider != "off" and provider not in result:
        raise ValueError("Provider settings are required.")
    return result


def proton_command(*args: str) -> dict:
    helper = HERE.parent / "wine-canvas/manage.py"
    if not helper.is_file():
        raise ValueError("This installation does not include the Proton manager.")
    run = subprocess.run([sys.executable, str(helper), *args, "--json"], capture_output=True, text=True, timeout=1800)
    if run.returncode:
        raise ValueError(run.stderr.strip()[-1000:] or "Proton operation failed.")
    return json.loads(run.stdout)


def status(root: Path, steam: Path) -> dict:
    import lsfg
    import framegen
    profiles = {appid: validate_profile(profile) for appid, profile in read_profiles(root).items()}
    return {"games": game_inventory(steam), "profiles": profiles,
            "proton": proton_command("status", "--steam-root", str(steam)),
            "lsfg": lsfg.component_status(root), "framegen": framegen.component_status(root),
            "launchOption": shlex.quote(str(HERE / "lwfa-game")) + " %command%",
            "streamTargetFps": 60}


def request(root: Path, steam: Path, message: dict) -> dict:
    action = message.get("action")
    if action == "status":
        return status(root, steam)
    if action == "saveProfile":
        appid = str(message.get("appid", ""))
        if not any(game["appid"] == appid for game in game_inventory(steam)):
            raise ValueError("That Steam game is no longer installed.")
        profile = validate_profile(message.get("profile"))
        with locked(root):
            profiles = read_profiles(root)
            profiles[appid] = profile
            atomic_json(root / "profiles.json", profiles)
    elif action == "install":
        component = message.get("component")
        if component == "proton":
            import proton
            bundle = proton.ensure_bundle(root)
            archive = HERE.parent / "wine-canvas/base.tar.gz"
            base = ["--base-archive", str(archive)] if archive.is_file() else ["--download-base"]
            proton_command("install", "--bundle", str(bundle), "--steam-root", str(steam), *base, "--cache", str(root / "downloads"))
        elif component == "lsfg":
            import components
            components.install_component(root, "lsfg")
        elif component == "framegen":
            import framegen
            framegen.install_component(root)
        else:
            raise ValueError("Unknown gaming component.")
    else:
        raise ValueError("Unknown gaming action.")
    return status(root, steam)


def prepare_launch(root: Path, steam: Path, argv: list[str], env: dict) -> tuple[list[str], dict]:
    # The same Steam launch option can remain configured on the host desktop.
    if env.get("WINE_CANVAS_FOLLOW_HOST") != "1" or env.get("WINE_CANVAS_DPI_SAFE") != "1":
        return argv, env
    appid = env.get("SteamAppId") or env.get("SteamGameId")
    profile = read_profiles(root).get(appid, {"provider": "off"})
    if profile.get("provider") == "off":
        return argv, env
    game = next((item for item in game_inventory(steam) if item["appid"] == appid), None)
    if game is None:
        raise ValueError("Could not match this launch to an installed Steam game.")
    profile = validate_profile(profile)
    if profile["provider"] == "lsfg":
        import lsfg
        return argv, lsfg.prepare_launch(root, {**profile["lsfg"], "game_id": appid}, env)
    import framegen
    directory = Path(game["directory"])
    executables = [Path(arg).resolve() for arg in argv if arg.lower().endswith(".exe") and Path(arg).is_file()]
    executable = next((path for path in executables if path.is_relative_to(directory)), None)
    if executable is None:
        raise ValueError("Framegen needs a launch with the game's executable path. Select LSFG for launcher-based games.")
    if executable.parent == directory:
        # Unreal bootstraps start a shipping executable in a different directory.
        # Inject beside that child, while preserving Steam's original command.
        patterns = (f"{prefix}Binaries/{platform}/*-Win64-Shipping.exe"
                    for prefix in ("", "*/") for platform in ("Win64", "WinGDK"))
        candidates = {path.resolve() for pattern in patterns for path in directory.glob(pattern)
                      if path.is_file() and path.resolve().is_relative_to(directory)
                      and not {"engine", "thirdparty"}.intersection(part.casefold() for part in path.relative_to(directory).parts)}
        matching = {path for path in candidates if path.stem.removesuffix("-Win64-Shipping").casefold() == executable.stem.casefold()}
        choices = matching or candidates
        if len(choices) > 1:
            raise ValueError("This game has several shipping executables. Framegen cannot safely choose one; use LSFG or launch the intended executable directly.")
        if choices:
            executable = next(iter(choices))
    return framegen.prepare_launch(root, {**profile, "appid": appid, "game_path": str(executable),
                                         "framegen": {**profile["framegen"], "enabled": True}}, argv, env)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=data_root())
    parser.add_argument("--steam-root", type=Path)
    parser.add_argument("command", choices=["rpc", "launch"])
    parser.add_argument("argv", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    try:
        if args.command == "rpc":
            if sys.version_info < (3, 11):
                raise ValueError("Gaming components require Python 3.11 or newer.")
            message = json.loads(sys.stdin.read(16385))
            result = request(args.root, args.steam_root or steam_root(), message)
            print(json.dumps(result))
        else:
            argv = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
            if not argv:
                raise ValueError("Missing game command.")
            env = dict(os.environ)
            # Host passthrough must also work without Steam installed here.
            if env.get("WINE_CANVAS_FOLLOW_HOST") == "1" and env.get("WINE_CANVAS_DPI_SAFE") == "1":
                if sys.version_info < (3, 11):
                    raise ValueError("Gaming components require Python 3.11 or newer.")
                argv, env = prepare_launch(args.root, args.steam_root or steam_root(), argv, env)
            os.execvpe(argv[0], argv, env)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
