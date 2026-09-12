"""Pinned MIT lsfg-vk v1, enabled only in the launched game's environment."""

import fnmatch
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import struct
import tempfile
import zipfile

from components import atomic_write, component_lock, download_verified

VERSION = "1.0.0"
SOURCE_COMMIT = "7113d7d02da9fc9df5cb3b03230d1f7de86f7056"
SOURCE = f"https://github.com/PancakeTAS/lsfg-vk/tree/{SOURCE_COMMIT}"
ARCHIVE_URL = "https://github.com/PancakeTAS/lsfg-vk/releases/download/v1.0.0/lsfg-vk_noui.zip"
ARCHIVE_SHA256 = "af5ee1626d9543349245520689da107c3ebc5ef3755086441fbb854173b8e096"
LIBRARY_SHA256 = "de4954bcce6904b62b6c48f1525c7fd78b4c2d7f9a959edf621528d9363ebbfd"
LAYER_NAME = "VK_LAYER_LWFA_LS_frame_generation"
FOREIGN_LAYERS = ("VK_LAYER_LS_frame_generation", "VK_LAYER_LSFGVK_frame_generation",
                  "VK_LAYER_LSFGVK_frame_generation_x86")
LICENSES = (
    ("lsfg-vk", "PancakeTAS/lsfg-vk", SOURCE_COMMIT, "LICENSE.md",
     "81fd6d483875f1d1520fa327f2139eda0bae28106863953ec57171d60a356b2f"),
    ("dxbc", "PancakeTAS/dxbc", "78ab59a8aaeb43cd1b0a5e91ba86722433a10b78", "LICENSE.md",
     "a5cb1a6ded7d2d7e92d550ba28edd21be2d1d4044662b399887351023e30ce64"),
    ("pe-parse", "trailofbits/pe-parse", "31ac5966503689d5693cd9fb520bd525a8710e17", "LICENSE",
     "5fb0c373b1b1077d3ae66fab21516a3c58dc2265e0480e526aaa8ff8da377dc6"),
    ("toml11", "ToruNiina/toml11", "be08ba2be2a964edcdb3d3e3ea8d100abc26f286", "LICENSE",
     "b547d41695cdfbc1d054b5044578e476a0e9d756849f1e0cb3864cfc83e50a9e"),
    ("volk", "zeux/volk", "be3dbd49bf77052665e96b6c7484af855e7e5f67", "LICENSE.md",
     "33c831f76b79501665e66c23ac8f876020457c216d44526a8f747da897999b35"),
)


def _directory(root: Path) -> Path:
    return root / "components" / "lsfg" / VERSION


def _digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def find_dll(env: dict | None = None) -> Path | None:
    """Read Steam library locations; never change Steam or Decky configuration."""
    env = os.environ if env is None else env
    home = Path(env.get("HOME", str(Path.home())))
    steam_roots = [
        home / ".local/share/Steam", home / ".steam/steam",
        home / ".steam/debian-installation",
        home / ".var/app/com.valvesoftware.Steam/.local/share/Steam",
        home / "snap/steam/common/.local/share/Steam",
    ]
    if env.get("XDG_DATA_HOME"):
        steam_roots.insert(0, Path(env["XDG_DATA_HOME"]) / "Steam")
    libraries = list(steam_roots)
    for steam in steam_roots:
        for vdf in (steam / "steamapps/libraryfolders.vdf", steam / "config/libraryfolders.vdf"):
            try:
                if vdf.stat().st_size > 4 * 1024 * 1024:
                    continue
                contents = vdf.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for encoded in re.findall(r'"path"\s+"((?:\\.|[^"\\])*)"', contents):
                path = encoded.replace(r'\\', '\\').replace(r'\"', '"')
                if Path(path).is_absolute():
                    libraries.append(Path(path))
    seen = set()
    for library in libraries:
        candidate = library / "steamapps/common/Lossless Scaling/Lossless.dll"
        if candidate in seen:
            continue
        seen.add(candidate)
        if candidate.is_file():
            return candidate.resolve()
    return None


def validate_dll(path: Path) -> None:
    """Check v1's required PE resources before its constructor can abort a game."""
    try:
        if path.stat().st_size > 128 * 1024 * 1024:
            raise ValueError("Lossless.dll exceeds the supported file size")
        data = path.read_bytes()
        if data[:2] != b"MZ":
            raise ValueError("Lossless.dll is not a Windows DLL")
        pe = struct.unpack_from("<I", data, 0x3C)[0]
        if data[pe:pe + 4] != b"PE\0\0":
            raise ValueError("Lossless.dll has an invalid PE header")
        machine, sections = struct.unpack_from("<HH", data, pe + 4)
        optional_size = struct.unpack_from("<H", data, pe + 20)[0]
        optional = pe + 24
        if machine != 0x8664 or struct.unpack_from("<H", data, optional)[0] != 0x20B:
            raise ValueError("LSFG requires the 64-bit Lossless.dll")
        if not 1 <= sections <= 96 or optional_size < 136:
            raise ValueError("Lossless.dll has an invalid section table")
        resource_rva, resource_size = struct.unpack_from("<II", data, optional + 128)

        def offset(rva, size=1):
            for index in range(sections):
                section = optional + optional_size + index * 40
                _, address, raw_size, raw = struct.unpack_from("<IIII", data, section + 8)
                relative = rva - address
                if 0 <= relative and relative + size <= raw_size:
                    start = raw + relative
                    if start + size <= len(data):
                        return start
            raise ValueError("Lossless.dll has an invalid resource address")

        def entries(relative):
            if relative < 0 or relative + 16 > resource_size:
                raise ValueError("Lossless.dll has an invalid resource directory")
            base = offset(resource_rva + relative, 16)
            named, numbered = struct.unpack_from("<HH", data, base + 12)
            count = named + numbered
            if count > 4096 or relative + 16 + count * 8 > resource_size:
                raise ValueError("Lossless.dll has an invalid resource count")
            start = offset(resource_rva + relative + 16, count * 8)
            return [struct.unpack_from("<II", data, start + index * 8) for index in range(count)]

        shaders = set()
        for kind, names in entries(0):
            if kind != 10 or not names & 0x80000000:
                continue
            for name, languages in entries(names & 0x7FFFFFFF):
                if name & 0x80000000 or not languages & 0x80000000:
                    continue
                for _, resource in entries(languages & 0x7FFFFFFF):
                    if resource & 0x80000000 or resource + 16 > resource_size:
                        continue
                    address = offset(resource_rva + resource, 16)
                    rva, size = struct.unpack_from("<II", data, address)
                    if size:
                        offset(rva, size)
                        shaders.add(name)
        if not set(range(255, 303)).issubset(shaders):
            raise ValueError("Lossless.dll lacks the LSFG 3.1 shaders required by this provider")
    except (OSError, struct.error, OverflowError) as error:
        raise ValueError("Cannot read a compatible Lossless.dll from this installation") from error


def component_status(root: Path) -> dict:
    directory = _directory(root)
    library = directory / "lib/liblsfg-vk.so"
    installed = False
    problem = None
    if directory.exists():
        try:
            installed = (_digest(library) == LIBRARY_SHA256
                         and (directory / "provenance.json").is_file()
                         and all((directory / "licenses" / f"{name}.txt").is_file()
                                 for name, *_ in LICENSES))
        except OSError:
            pass
        if not installed:
            problem = "The managed LSFG installation is incomplete or changed"
    dll = find_dll()
    dll_compatible = False
    if dll:
        try:
            validate_dll(dll)
            dll_compatible = True
        except ValueError as error:
            problem = str(error)
    return {"installed": installed, "version": VERSION, "provider": "lsfg-vk",
            "license": "MIT", "source": SOURCE, "dll_found": dll is not None,
            "dll_path": str(dll) if dll else None, "dll_compatible": dll_compatible,
            "error": problem}


def install_component(root: Path) -> dict:
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64"):
        raise ValueError("This LSFG component supports Linux x86-64")
    with component_lock(root):
        directory = _directory(root)
        if directory.exists():
            if component_status(root)["installed"]:
                return component_status(root)
            raise ValueError("Managed LSFG files are incomplete; remove that component before reinstalling")
        directory.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".lsfg-install-", dir=directory.parent) as temporary:
            stage = Path(temporary) / "payload"
            stage.mkdir()
            archive = Path(temporary) / "lsfg.zip"
            download_verified(ARCHIVE_URL, ARCHIVE_SHA256, archive, 16 * 1024 * 1024)
            with zipfile.ZipFile(archive) as bundle:
                expected = {"lib/liblsfg-vk.so", "share/vulkan/implicit_layer.d/VkLayer_LS_frame_generation.json"}
                if len(bundle.infolist()) != 2 or set(bundle.namelist()) != expected:
                    raise ValueError("Unexpected files in the pinned LSFG archive")
                info = bundle.getinfo("lib/liblsfg-vk.so")
                if info.file_size > 16 * 1024 * 1024:
                    raise ValueError("LSFG library exceeds its size limit")
                library = bundle.read(info)
                if hashlib.sha256(library).hexdigest() != LIBRARY_SHA256:
                    raise ValueError("LSFG library checksum does not match the pinned release")
                atomic_write(stage / "lib/liblsfg-vk.so", library)
            for name, repository, commit, filename, digest in LICENSES:
                url = f"https://raw.githubusercontent.com/{repository}/{commit}/{filename}"
                download_verified(url, digest, stage / "licenses" / f"{name}.txt", 65536)
            provenance = {"version": VERSION, "source": SOURCE, "source_commit": SOURCE_COMMIT,
                          "archive": ARCHIVE_URL, "archive_sha256": ARCHIVE_SHA256,
                          "library_sha256": LIBRARY_SHA256, "license": "MIT",
                          "manifest_note": "lwfa supplies a private named manifest; library is unmodified"}
            atomic_write(stage / "provenance.json", (json.dumps(provenance, indent=2) + "\n").encode())
            stage.rename(directory)
    return component_status(root)


def validate_profile(profile: dict) -> dict:
    if not isinstance(profile, dict):
        raise ValueError("LSFG settings must be an object")
    allowed = {"multiplier", "flow_scale", "performance_mode", "dll_path", "game_id"}
    if set(profile) - allowed:
        raise ValueError("Unknown LSFG setting")
    result = {"multiplier": 2, "flow_scale": 1.0, "performance_mode": False, **profile}
    if type(result["multiplier"]) is not int or result["multiplier"] not in (2, 3, 4):
        raise ValueError("LSFG multiplier must be 2, 3, or 4")
    flow = result["flow_scale"]
    if type(flow) not in (int, float) or not math.isfinite(flow) or not 0.25 <= flow <= 1:
        raise ValueError("LSFG flow scale must be between 0.25 and 1")
    if type(result["performance_mode"]) is not bool:
        raise ValueError("LSFG performance mode must be true or false")
    if "dll_path" in result and (not isinstance(result["dll_path"], str)
                                 or not Path(result["dll_path"]).is_absolute()
                                 or "\0" in result["dll_path"]):
        raise ValueError("Lossless.dll must have an absolute path")
    if "game_id" in result and (not isinstance(result["game_id"], str)
                                or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", result["game_id"])):
        raise ValueError("Invalid LSFG game identifier")
    return result


def prepare_launch(root: Path, profile: dict, env: dict) -> dict:
    profile = validate_profile(profile)
    if not component_status(root)["installed"]:
        raise ValueError("Install the lwfa LSFG component before enabling it")
    dll = Path(profile["dll_path"]) if profile.get("dll_path") else find_dll(env)
    if dll is None:
        raise ValueError("Install your purchased Lossless Scaling in Steam before enabling LSFG")
    validate_dll(dll)
    result = dict(env)
    # Explicit enable/allow filters override disable filters in the Vulkan loader.
    # Keep unrelated overlays, but reject broad overrides we cannot safely split.
    for key, separator in (("VK_INSTANCE_LAYERS", ":"), ("VK_LOADER_LAYERS_ENABLE", ","),
                           ("VK_LOADER_LAYERS_ALLOW", ",")):
        kept = []
        for value in result.get(key, "").split(separator):
            value = value.strip()
            if not value or value in FOREIGN_LAYERS or value == LAYER_NAME:
                continue
            if any(fnmatch.fnmatchcase(name, value) for name in (*FOREIGN_LAYERS, LAYER_NAME)):
                raise ValueError(f"{key} enables conflicting frame generation layers; remove that override")
            kept.append(value)
        if kept:
            result[key] = separator.join(kept)
        else:
            result.pop(key, None)
    for key in list(result):
        if key.startswith("LSFG_") or key.startswith("LSFGVK_") or key == "DISABLE_LSFG":
            result.pop(key)
    result["DISABLE_LSFGVK"] = "1"
    disabled = [value.strip() for value in result.get("VK_LOADER_LAYERS_DISABLE", "").split(",") if value.strip()]
    result["VK_LOADER_LAYERS_DISABLE"] = ",".join(dict.fromkeys([*disabled, *FOREIGN_LAYERS]))
    result["VK_LOADER_LAYERS_ALLOW"] = ",".join(filter(None, [result.get("VK_LOADER_LAYERS_ALLOW"), LAYER_NAME]))
    game_id = profile.get("game_id", "default")
    runtime = root / "runtime" / "lsfg" / game_id
    runtime.mkdir(parents=True, exist_ok=True)
    config = runtime / "conf.toml"
    process = f"lwfa-{game_id}"
    # JSON basic strings are TOML-compatible with ensure_ascii=False.
    contents = (f'version = 1\n[global]\ndll = {json.dumps(str(dll.resolve()), ensure_ascii=False)}\n'
                f'\n[[game]]\nexe = {json.dumps(process)}\n'
                f'multiplier = {profile["multiplier"]}\nflow_scale = {float(profile["flow_scale"])}\n'
                f'performance_mode = {str(profile["performance_mode"]).lower()}\n'
                'hdr_mode = false\nexperimental_present_mode = "fifo"\n')
    atomic_write(config, contents.encode())
    manifest_dir = runtime / "layers"
    manifest = {"file_format_version": "1.0.0", "layer": {
        "name": LAYER_NAME, "type": "GLOBAL", "api_version": "1.4.313",
        "library_path": str((_directory(root) / "lib/liblsfg-vk.so").resolve()),
        "implementation_version": "1", "description": "lwfa managed lsfg-vk 1.0.0",
        "functions": {"vkGetInstanceProcAddr": "layer_vkGetInstanceProcAddr",
                      "vkGetDeviceProcAddr": "layer_vkGetDeviceProcAddr"},
        "enable_environment": {"LWFA_LSFG": "1"},
        # Upstream sets this while creating its internal Vulkan device.
        "disable_environment": {"DISABLE_LSFG": "1"}}}
    atomic_write(manifest_dir / "lwfa-lsfg.json", (json.dumps(manifest, indent=2) + "\n").encode())
    path_key = "VK_IMPLICIT_LAYER_PATH" if result.get("VK_IMPLICIT_LAYER_PATH") else "VK_ADD_IMPLICIT_LAYER_PATH"
    result[path_key] = ":".join(filter(None, [str(manifest_dir.resolve()), result.get(path_key)]))
    result.update({"LWFA_LSFG": "1", "LSFG_CONFIG": str(config.resolve()), "LSFG_PROCESS": process})
    return result
