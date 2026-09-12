"""Pinned OptiScaler and a private, per-launch Wine game-directory overlay."""

import configparser
import ctypes
import fcntl
import fnmatch
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile

from components import atomic_write, component_lock, download_verified

VERSION = "0.9.4"
ARCHIVE_NAME = "Optiscaler_0.9.4-final.20260718._MM.7z"
ARCHIVE_URL = f"https://github.com/optiscaler/OptiScaler/releases/download/v{VERSION}/{ARCHIVE_NAME}"
ARCHIVE_SHA256 = "575cb4df866116093df75af607e37fd70e10f5163e0f23fd5c804142e80ef0ad"
SOURCE_URL = "https://github.com/optiscaler/OptiScaler/tree/v0.9.4"
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_EXTRACTED_BYTES = 384 * 1024 * 1024
INPUTS = ("dlssg", "nukems", "fsrfg", "fsrfg30", "upscaler")
OUTPUTS = ("fsrfg", "xefg", "nukems")
REQUIRED_FILES = (
    "OptiScaler.dll", "OptiScaler.ini", "fakenvapi.dll", "fakenvapi.ini",
    "amd_fidelityfx_dx12.dll", "amd_fidelityfx_framegeneration_dx12.dll",
    "dlssg_to_fsr3_amd_is_better.dll", "libxess_fg.dll", "libxell.dll",
)


def _release_dir(root: Path) -> Path:
    return root / "components" / "framegen" / VERSION


def _sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _relative_name(name: str) -> Path:
    path = PurePosixPath(name)
    if (not name or path.is_absolute() or ".." in path.parts or str(path) != name
            or "\\" in name or ":" in name or any(ord(c) < 32 for c in name)):
        raise ValueError("Unsafe component archive path")
    return Path(*path.parts)


def _archive_entries(listing: str) -> dict[str, tuple[int, bool]]:
    """Validate 7-Zip's technical listing before the extractor sees any paths."""
    if len(listing) > 1024 * 1024:
        raise ValueError("Component archive listing exceeds its limit")
    entries = {}
    total = 0
    for block in listing.strip().split("\n\n"):
        fields = dict(line.split(" = ", 1) for line in block.splitlines() if " = " in line)
        if not fields:
            continue
        name = fields.get("Path", "")
        _relative_name(name)
        folded = name.casefold()
        if folded in {n.casefold() for n in entries}:
            raise ValueError("Component archive has duplicate paths")
        attributes = fields.get("Attributes", "")
        if (fields.get("Encrypted", "-") != "-" or "Symbolic Link" in fields
                or "Hard Link" in fields or "Reparse" in fields
                or attributes.startswith("l") or " l" in attributes):
            raise ValueError("Component archive must contain only regular files and directories")
        try:
            size = int(fields["Size"])
        except (KeyError, ValueError) as exc:
            raise ValueError("Component archive is missing a valid size") from exc
        if size < 0:
            raise ValueError("Component archive contains a negative size")
        is_dir = "D" in attributes or fields.get("Folder") == "+"
        entries[name] = (size, is_dir)
        total += size
        if len(entries) > 256 or total > MAX_EXTRACTED_BYTES:
            raise ValueError("Component archive exceeds its extraction limit")
    if not entries:
        raise ValueError("Component archive is empty")
    for name in entries:
        for parent in PurePosixPath(name).parents:
            if str(parent) in entries and not entries[str(parent)][1]:
                raise ValueError("Component archive uses a file as a directory")
    return entries


def _extract_archive(archive: Path, destination: Path) -> dict:
    extractor = shutil.which("7z") or shutil.which("7zz")
    if not extractor:
        raise ValueError("7-Zip is required to install OptiScaler")
    if _sha256(archive) != ARCHIVE_SHA256:
        raise ValueError("OptiScaler archive checksum does not match the pinned release")
    listed = subprocess.run([extractor, "l", "-slt", "-ba", "--", str(archive)],
                            capture_output=True, text=True, check=True, timeout=30)
    entries = _archive_entries(listed.stdout)
    destination.mkdir()
    subprocess.run([extractor, "x", "-y", "-bd", "-mmt=2", f"-o{destination}", "--", str(archive)],
                   capture_output=True, check=True, timeout=120)
    files = {}
    for path in destination.rglob("*"):
        name = path.relative_to(destination).as_posix()
        info = path.lstat()
        if name not in entries or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise ValueError("Unexpected object in extracted component")
        size, is_dir = entries[name]
        if is_dir != stat.S_ISDIR(info.st_mode) or (not is_dir and info.st_size != size):
            raise ValueError("Extracted component differs from its archive listing")
        if not is_dir:
            path.chmod(0o644)
            files[name] = {"size": info.st_size, "sha256": _sha256(path)}
    if not set(REQUIRED_FILES).issubset(files):
        raise ValueError("OptiScaler archive is missing required runtime files")
    if set(files) != {name for name, (_, is_dir) in entries.items() if not is_dir}:
        raise ValueError("Component extraction is incomplete")
    return files


def _manifest(root: Path, verify: bool = False) -> dict:
    release = _release_dir(root)
    payload = release / "payload"
    manifest_path = release / "manifest.json"
    if (release.is_symlink() or payload.is_symlink() or manifest_path.is_symlink()
            or not release.resolve().is_relative_to(root.resolve())):
        raise ValueError("OptiScaler installation must not be a symlink")
    data = json.loads(manifest_path.read_text())
    if (data.get("version") != VERSION or data.get("archive_sha256") != ARCHIVE_SHA256
            or data.get("schema") != 1 or not isinstance(data.get("files"), dict)
            or not set(REQUIRED_FILES).issubset(data["files"])):
        raise ValueError("Unrecognized OptiScaler installation manifest")
    for name, expected in data["files"].items():
        path = payload / _relative_name(name)
        if path.is_symlink() or not path.resolve().is_relative_to(payload.resolve()):
            raise ValueError("OptiScaler runtime path escapes its installation")
        if not path.is_file() or path.stat().st_size != expected["size"]:
            raise ValueError("OptiScaler runtime is missing or changed; reinstall it")
        if verify and _sha256(path) != expected["sha256"]:
            raise ValueError("OptiScaler runtime checksum changed; reinstall it")
    return data


def _bubblewrap() -> str:
    binary = shutil.which("bwrap")
    if not binary:
        raise ValueError("Bubblewrap with overlay support is required for isolated frame generation")
    result = subprocess.run([binary, "--help"], capture_output=True, text=True, timeout=5, check=True)
    if "--overlay-src" not in result.stdout or "--overlay " not in result.stdout:
        raise ValueError("Bubblewrap 0.11 or newer with overlay support is required")
    if os.stat(binary).st_mode & stat.S_ISUID:
        raise ValueError("Setuid Bubblewrap cannot create the required private overlay")
    return binary


def component_status(root: Path) -> dict:
    installed = False
    error = None
    try:
        _manifest(root)
        installed = True
    except FileNotFoundError:
        pass
    except (OSError, ValueError, KeyError, TypeError) as exc:
        error = str(exc)
    try:
        _bubblewrap()
        overlay = True
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        overlay = False
        error = error or str(exc)
    return {"installed": installed, "version": VERSION, "availableVersion": VERSION,
            "name": "OptiScaler", "path": str(_release_dir(root)) if installed else None,
            "overlaySupported": overlay, "error": error, "restartRequired": True,
            "inputs": list(INPUTS), "outputs": list(OUTPUTS), "sourceUrl": SOURCE_URL}


def install_component(root: Path) -> dict:
    root = root.resolve()
    with component_lock(root):
        try:
            _manifest(root, verify=True)
            return component_status(root)
        except FileNotFoundError:
            pass
        release = _release_dir(root)
        if release.exists() or release.is_symlink():
            raise ValueError("Existing OptiScaler installation is invalid; move it aside before reinstalling")
        release.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".install-", dir=release.parent) as temporary:
            stage = Path(temporary)
            archive = stage / ARCHIVE_NAME
            download_verified(ARCHIVE_URL, ARCHIVE_SHA256, archive, max_bytes=MAX_ARCHIVE_BYTES)
            files = _extract_archive(archive, stage / "payload")
            archive.unlink()
            atomic_write(stage / "manifest.json", json.dumps({
                "schema": 1, "version": VERSION, "archive_sha256": ARCHIVE_SHA256,
                "archive_url": ARCHIVE_URL, "source_url": SOURCE_URL, "files": files,
            }, indent=2).encode())
            os.rename(stage, release)
    return component_status(root)


def _merge_override(existing: str, library: str) -> str:
    """Retain every unrelated Wine override, including grouped library names."""
    for item in existing.split(";"):
        if "=" not in item:
            continue
        names, order = item.split("=", 1)
        if library in {name.strip().lower().removesuffix(".dll") for name in names.split(",")}:
            if order.replace(" ", "").lower() != "n,b":
                raise ValueError(f"Existing Wine override conflicts with {library}; it was not changed")
            return existing
    return existing.rstrip(";") + (";" if existing.rstrip(";") else "") + library + "=n,b"


def _disable_lsfg(env: dict) -> dict:
    from lsfg import FOREIGN_LAYERS, LAYER_NAME

    result = dict(env)
    layers = (*FOREIGN_LAYERS, LAYER_NAME)
    for key, separator in (("VK_INSTANCE_LAYERS", ":"), ("VK_LOADER_LAYERS_ENABLE", ","),
                           ("VK_LOADER_LAYERS_ALLOW", ",")):
        kept = []
        for value in result.get(key, "").split(separator):
            value = value.strip()
            if not value or value in layers:
                continue
            if any(fnmatch.fnmatchcase(name, value) for name in layers):
                raise ValueError(f"{key} enables conflicting frame generation layers; remove that override")
            kept.append(value)
        if kept:
            result[key] = separator.join(kept)
        else:
            result.pop(key, None)
    for key in list(result):
        if key.startswith(("LSFG_", "LSFGVK_", "LWFA_LSFG")):
            result.pop(key)
    result["DISABLE_LSFG"] = "1"
    result["DISABLE_LSFGVK"] = "1"
    disabled = [value for value in result.get("VK_LOADER_LAYERS_DISABLE", "").split(",") if value]
    result["VK_LOADER_LAYERS_DISABLE"] = ",".join(dict.fromkeys([*disabled, *layers]))
    return result


class _FileLock(ctypes.Structure):
    _fields_ = [("type", ctypes.c_short), ("whence", ctypes.c_short),
                ("start", ctypes.c_long), ("length", ctypes.c_long), ("pid", ctypes.c_int)]


def _guard_prefix(env: dict) -> None:
    prefix = (Path(env["STEAM_COMPAT_DATA_PATH"]) / "pfx" if env.get("STEAM_COMPAT_DATA_PATH")
              else Path(env["WINEPREFIX"]) if env.get("WINEPREFIX") else None)
    if prefix is None:
        raise ValueError("Cannot identify this game's Wine prefix for an isolated launch")
    try:
        info = prefix.stat()
    except FileNotFoundError:
        return
    dosdevices = prefix / "dosdevices"
    if dosdevices.is_dir():
        try:
            root_drive = (dosdevices / "z:").resolve(strict=True)
        except FileNotFoundError as exc:
            raise ValueError("This Wine prefix has no Z: filesystem mapping for private frame generation") from exc
        if root_drive != Path("/"):
            raise ValueError("This Wine prefix uses a custom Z: mapping; private frame generation is not supported")
    path = Path("/tmp") / f".wine-{os.getuid()}" / f"server-{info.st_dev:x}-{info.st_ino:x}" / "lock"
    try:
        fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    except FileNotFoundError:
        return
    try:
        query = _FileLock(fcntl.F_WRLCK, os.SEEK_SET, 0, 1, 0)
        answer = _FileLock.from_buffer_copy(fcntl.fcntl(fd, fcntl.F_GETLK, bytes(query)))
        if answer.type != fcntl.F_UNLCK:
            raise ValueError("This game's Wine prefix is already running. Close its game and Protontricks apps before enabling frame generation")
    finally:
        os.close(fd)


def _configuration(payload: Path, settings: dict) -> bytes:
    source = settings.get("input")
    output = settings.get("output")
    if source not in INPUTS or output not in OUTPUTS:
        raise ValueError("Select a supported frame generation input and output before launching")
    if (source == "nukems") != (output == "nukems"):
        raise ValueError("Nukem's frame generation requires both input and output set to nukems")
    config = configparser.ConfigParser(interpolation=None, strict=True)
    config.optionxform = str
    config.read_string((payload / "OptiScaler.ini").read_text(encoding="utf-8-sig"))
    overrides = {
        "FrameGen": {"Enabled": "true", "FGInput": source, "FGOutput": output},
        "Libraries": {"OptiDllPath": "Z:" + str(payload).replace("/", "\\")},
        "Hotfix": {"DisableOverlays": "false", "CheckForUpdate": "false"},
        "Plugins": {"LoadAsiPlugins": "false", "LoadSpecialK": "false", "LoadReshade": "false"},
        "NvApi": {"OverrideNvapiDll": "false"},
    }
    for section, options in overrides.items():
        if not config.has_section(section):
            config.add_section(section)
        for key, value in options.items():
            config.set(section, key, value)
    stream = io.StringIO()
    config.write(stream, space_around_delimiters=False)
    return stream.getvalue().encode()


def prepare_launch(root: Path, profile: dict, argv: list[str], env: dict) -> tuple[list[str], dict]:
    """Return an isolated command. Never install files into the real game directory."""
    if not all(env.get(flag) == "1" for flag in ("WINE_CANVAS_FOLLOW_HOST", "WINE_CANVAS_DPI_SAFE")):
        return list(argv), dict(env)
    if profile.get("provider") != "framegen" or profile.get("framegen", {}).get("enabled") is False:
        return list(argv), dict(env)
    if not argv or not all(isinstance(item, str) and "\0" not in item for item in argv):
        raise ValueError("Invalid game launch command")
    root = root.resolve()
    raw_path = profile.get("game_path", "")
    if not isinstance(raw_path, str) or not Path(raw_path).is_absolute():
        raise ValueError("Frame generation needs a resolved game executable")
    game = Path(raw_path).resolve(strict=True)
    if not game.is_file() or game.suffix.lower() != ".exe":
        raise ValueError("Frame generation needs the game's Windows executable")
    appid = str(profile.get("appid", ""))
    if not re.fullmatch(r"[0-9]{1,12}", appid):
        raise ValueError("Frame generation needs a valid game identifier")
    for path in (root, game.parent):
        if any(c in str(path) for c in (":", "\n", "\r", "\\", ",")):
            raise ValueError("This game or component path cannot be represented safely by the overlay")
    _guard_prefix(env)
    _manifest(root, verify=True)
    binary = _bubblewrap()
    names = {entry.name.casefold() for entry in game.parent.iterdir()}
    # dxgi is loaded by the graphics stack. Do not guess another proxy that
    # the executable may never import, or overwrite an existing graphics mod.
    if names.intersection({"dxgi.dll", "optiscaler.dll", "optiscaler.ini", "framegen_patch"}):
        raise ValueError("This game already has a graphics injector or OptiScaler installation. Existing game files were left unchanged")
    payload = _release_dir(root) / "payload"
    configuration = _configuration(payload, profile.get("framegen", {}))
    result = _disable_lsfg(env)
    result["WINEDLLOVERRIDES"] = _merge_override(result.get("WINEDLLOVERRIDES", ""), "dxgi")
    identity = hashlib.sha256(str(game).encode()).hexdigest()[:16]
    overlay = root / "overlays" / "framegen" / appid / VERSION / identity
    lower, upper, work = (overlay / name for name in ("mod", "writes", "work"))
    with component_lock(root):
        for directory in (lower, upper, work):
            if directory.is_symlink() or not directory.resolve().is_relative_to(root):
                raise ValueError("Frame generation overlay must not be a symlink")
            directory.mkdir(parents=True, exist_ok=True)
        proxy = lower / "dxgi.dll"
        if proxy.is_symlink():
            raise ValueError("The private graphics injector must not be a symlink")
        if proxy.exists() and _sha256(proxy) != _manifest(root)["files"]["OptiScaler.dll"]["sha256"]:
            raise ValueError("The private graphics injector changed; it was not overwritten")
        if not proxy.exists():
            shutil.copyfile(payload / "OptiScaler.dll", proxy)
        # Game-side INI edits live in the private upper layer. Apply the selected
        # profile for the next launch without touching the real game directory.
        atomic_write(upper / "OptiScaler.ini", configuration)
    wrapped = [binary, "--dev-bind", "/", "/", "--overlay-src", str(game.parent),
               "--overlay-src", str(lower), "--overlay", str(upper), str(work), str(game.parent),
               "--ro-bind", str(proxy), str(game.parent / "dxgi.dll"),
               "--ro-bind", str(payload), str(payload), "--", *argv]
    # pressure-vessel must retain the managed component at the same absolute
    # path used by Wine's Z: mapping. This variable applies only to this launch.
    variable = "PRESSURE_VESSEL_FILESYSTEMS_RO"
    previous = result.get(variable, "")
    result[variable] = previous + (":" if previous else "") + str(payload)
    result["LWFA_FRAMEGEN_VERSION"] = VERSION
    result["LWFA_FRAMEGEN_GAME"] = appid
    return wrapped, result
