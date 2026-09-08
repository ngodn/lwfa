#!/usr/bin/env python3
"""Route a separate Steam tool to original GE on host or private Wine in lwfa."""
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys

FLAGS = ("WINE_CANVAS_FOLLOW_HOST", "WINE_CANVAS_DPI_SAFE")
ENTRYPOINTS = ("proton", "files/bin/wine", "files/bin/wine64", "files/bin/wineserver", "files/bin/msidb")
MARKER = "lwfa-wine-canvas-v1"


def load_json(path):
    with open(path, encoding="utf-8") as stream:
        return json.load(stream)


def relative_path(value):
    path = PurePosixPath(value)
    if not value or path.is_absolute() or ".." in path.parts or str(path) != value:
        raise ValueError("Invalid runtime-relative path: " + repr(value))
    return Path(*path.parts)


def verify_files(root, files):
    if not isinstance(files, dict) or not files:
        raise ValueError("Runtime manifest must contain pinned file hashes")
    for name, expected in files.items():
        path = root / relative_path(name)
        if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise ValueError("Invalid SHA-256 for " + name)
        if not path.is_file():
            raise ValueError("Missing runtime file: " + str(path))
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError("Runtime file changed: " + str(path) + "; rebuild the lwfa compatibility tool for this GE version")


def artifact_manifest(bundle, portable=False):
    manifest = load_json(bundle / "manifest.json")
    if manifest.get("schemaVersion") != 1:
        raise ValueError("Unsupported Wine canvas artifact manifest")
    tool_name = manifest["base"]["toolName"]
    if relative_path(tool_name).name != tool_name:
        raise ValueError("Base toolName must be one directory name")
    build = manifest["build"]
    if set(build.get("architectures", [])) != {"x86_64", "i386"}:
        raise ValueError("Wine canvas packaging requires matching x86_64 and i386 builds")
    if build.get("kind") not in {"host", "steam-runtime-sdk"}:
        raise ValueError("Wine canvas artifact must declare its build kind")
    if portable and (build.get("portable") is not True or build.get("kind") != "steam-runtime-sdk"):
        raise ValueError("Portable packaging requires a Steam Runtime SDK build; host-built Wine libraries cannot be bundled")
    patched = manifest["patched"]["files"]
    required = {"files/bin/wineserver"}
    required.update("files/lib/wine/" + arch + "-unix/" + dll + ".so"
                    for arch in ("x86_64", "i386") for dll in ("win32u", "winex11"))
    if not required.issubset(patched):
        raise ValueError("Wine canvas artifact is missing required 32-bit or 64-bit components")
    base_files = manifest["base"]["files"]
    if not (required | {"proton", "files/bin/wine"}).issubset(base_files):
        raise ValueError("Manifest must pin original GE entrypoints and every replaced component")
    for name in patched:
        path = bundle / "payload" / relative_path(name)
        if path.is_symlink() or not path.resolve().is_relative_to((bundle / "payload").resolve()):
            raise ValueError("Patched payload must contain regular files inside its payload directory")
    verify_files(bundle / "payload", patched)
    return manifest


def prefix_for(entry, environ):
    if entry == "proton":
        compat = environ.get("STEAM_COMPAT_DATA_PATH")
        return Path(compat) / "pfx" if compat else None
    return Path(environ.get("WINEPREFIX", str(Path(environ.get("HOME", str(Path.home()))) / ".wine")))


def server_directory(prefix):
    # Wine server/request.c and ntdll/unix/server.c key Linux server identity
    # to the prefix inode/device, not DISPLAY or the Wine executable path.
    try:
        info = prefix.stat()
    except FileNotFoundError:
        return None
    return Path("/tmp") / (".wine-" + str(os.getuid())) / ("server-%x-%x" % (info.st_dev, info.st_ino))


class FileLock(ctypes.Structure):
    # This launcher ships with the Linux x86_64 engine. Native alignment gives
    # struct flock's 64-bit off_t fields and padding on that ABI.
    _fields_ = [("type", ctypes.c_short), ("whence", ctypes.c_short),
                ("start", ctypes.c_long), ("length", ctypes.c_long), ("pid", ctypes.c_int)]


def lock_owner(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    try:
        query = FileLock(fcntl.F_WRLCK, os.SEEK_SET, 0, 1, 0)
        answer = FileLock.from_buffer_copy(fcntl.fcntl(fd, fcntl.F_GETLK, bytes(query)))
        if answer.type == fcntl.F_UNLCK:
            return None
        if answer.pid <= 0:
            raise ValueError("An active Wine server is hidden by the current process namespace; close applications using this prefix before switching runtimes")
        return answer.pid
    finally:
        os.close(fd)


def guard_prefix_server(prefix, expected_server):
    if prefix is None:
        return
    directory = server_directory(prefix)
    if directory is None:
        return
    pid = lock_owner(directory / "lock")
    if pid is None:
        return
    try:
        matches = os.path.samefile(Path("/proc") / str(pid) / "exe", expected_server)
    except FileNotFoundError:
        # A server may exit between the lock query and executable lookup.
        if lock_owner(directory / "lock") is None:
            return
        matches = False
    except PermissionError:
        matches = False
    if not matches:
        raise ValueError("This prefix already has an active Wine server from another runtime (PID " + str(pid)
                         + "): " + str(prefix) + ". Close its games and Protontricks applications, wait for them to exit, then launch again. No process was stopped or prefix changed.")


def selected_runtime(tool, entry, environ):
    if entry not in ENTRYPOINTS:
        raise ValueError("Unsupported compatibility tool entrypoint")
    config = load_json(tool / "route.json")
    if config.get("owner") != MARKER:
        raise ValueError("Unrecognized lwfa compatibility tool")
    base = Path(config["base"]).resolve()
    private = Path(config["runtime"]).resolve()
    if base == tool.resolve() or base == private or (base / "route.json").exists():
        raise ValueError("Original GE runtime must not point to a routing wrapper")
    nested = all(environ.get(flag) == "1" for flag in FLAGS)
    # Host launches deliberately do not depend on any patch file or hash. An
    # updated original GE remains usable even when its old canvas patch expires.
    target = private if nested else base
    if nested:
        manifest = artifact_manifest(Path(config["bundle"]))
        verify_files(base, manifest["base"]["files"])
        verify_files(private, {**manifest["base"]["files"], **manifest["patched"]["files"]})
    guard_prefix_server(prefix_for(entry, environ), target / "files/bin/wineserver")
    executable = target / entry
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise ValueError("Runtime entrypoint is unavailable: " + str(executable))
    env = dict(environ)
    if not nested:
        for name in list(env):
            if name.startswith("WINE_CANVAS_"):
                env.pop(name)
    # Protontricks builds paths from the advertised files/ directory. Translate
    # those paths before invoking either runtime, including direct Wine calls.
    prefixes = sorted({str(tool.resolve()), str(private), str(base)}, key=len, reverse=True)
    def remap(value):
        for prefix in prefixes:
            if value == prefix or value.startswith(prefix + "/"):
                return str(target) + value[len(prefix):]
        return value
    for name in ("PATH", "LD_LIBRARY_PATH", "WINEDLLPATH", "STEAM_COMPAT_TOOL_PATHS", "PROTON_LD_LIBRARY_PATH"):
        if name in env:
            env[name] = ":".join(remap(part) for part in env[name].split(":"))
    for name in ("WINELOADER", "WINESERVER", "WINE_BIN", "WINESERVER_BIN", "PROTONPATH", "PROTON_PATH", "PROTON_DIST_PATH"):
        if name in env:
            env[name] = remap(env[name])
    return executable, env


def main():
    if len(sys.argv) < 3 or sys.argv[1] != "run":
        raise ValueError("Usage: router.py run <proton|files/bin/wine|files/bin/wine64|files/bin/wineserver> [arguments...]")
    executable, env = selected_runtime(Path(__file__).resolve().parent, sys.argv[2], os.environ)
    os.execve(executable, [str(executable), *sys.argv[3:]], env)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("lwfa Wine: " + str(error), file=sys.stderr)
        sys.exit(1)
