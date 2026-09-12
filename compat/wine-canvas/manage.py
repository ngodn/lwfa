#!/usr/bin/env python3
"""Install an independent Steam compatibility tool without changing selections."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tarfile
import urllib.error

import base_archive
from router import ENTRYPOINTS, MARKER, artifact_manifest, load_json, verify_files


def tool_name(manifest):
    name = "lwfa-" + manifest["base"]["toolName"] + "-canvas"
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
        raise ValueError("Unsupported GE tool identity")
    return name


@contextmanager
def installation_lock(tools):
    tools.mkdir(parents=True, exist_ok=True)
    with (tools / ".lwfa-install.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def active_pids(path):
    """Find callers and mapped runtime files without attaching to a process."""
    prefix = str(path.resolve()) + "/"
    found = []
    for process in Path("/proc").iterdir():
        if not process.name.isdigit() or int(process.name) == os.getpid():
            continue
        try:
            if process.stat().st_uid != os.getuid():
                continue
            command = (process / "cmdline").read_bytes().decode(errors="replace").split("\0")
            if any(arg.startswith(prefix) for arg in command):
                found.append(int(process.name))
                continue
            executable = str((process / "exe").readlink())
            if executable.startswith(prefix):
                found.append(int(process.name))
                continue
            with (process / "maps").open() as maps:
                if any(len(parts := line.split(None, 5)) == 6 and parts[5].startswith(prefix) for line in maps):
                    found.append(int(process.name))
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError:
            # Some unrelated user services are non-dumpable. Their command
            # line is checked first; Wine's ordinary runtime mappings remain
            # readable. This is a process snapshot, not a global launch lock.
            continue
    return found


def install(bundle, steam_root, launcher=None, *, base_archive_path=None, download_base=False, cache=None, quiet=False):
    if base_archive_path is not None and download_base:
        raise ValueError("Choose a local base archive or download, not both")
    if not steam_root.is_dir():
        raise ValueError("Steam root does not exist: " + str(steam_root))
    with installation_lock(steam_root / "compatibilitytools.d"):
        return install_locked(bundle, steam_root, launcher, base_archive_path=base_archive_path,
                              download_base=download_base, cache=cache, quiet=quiet)


def install_locked(bundle, steam_root, launcher=None, *, base_archive_path=None, download_base=False, cache=None, quiet=False):
    manifest = artifact_manifest(bundle)
    launcher = launcher or Path(__file__).with_name("launcher")
    if not launcher.is_file() or not os.access(launcher, os.X_OK):
        raise ValueError("Missing packaged native Wine launcher: " + str(launcher))
    tools = steam_root / "compatibilitytools.d"
    managed = base_archive_path is not None or download_base
    base = (tools / manifest["base"]["toolName"]).resolve()
    if managed:
        if sys.version_info < (3, 11) or not hasattr(tarfile, "data_filter"):
            raise ValueError("Managed Proton installation needs Python 3.11 or newer with tar extraction filters")
        base_archive.release_for(manifest["base"]["toolName"])
    else:
        if not base.is_dir():
            raise ValueError("Install the matching original " + manifest["base"]["toolName"] + " or use --download-base")
        verify_files(base, manifest["base"]["files"])
    name = tool_name(manifest)
    if managed:
        identity = {"layout": 1, "manifest": manifest,
                    "archive": base_archive.release_for(manifest["base"]["toolName"])["sha256"]}
        digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode())
        for source in (Path(__file__).with_name("router.py"), launcher):
            digest.update(source.read_bytes())
        name += "-" + digest.hexdigest()[:12]
    display_name = manifest["base"]["toolName"].removesuffix("-x86_64").replace("GE-Proton", "GE-Proton ", 1)
    destination = tools / name
    original = destination / ".original" if managed else base
    if destination.exists() or destination.is_symlink():
        if destination.is_symlink() or load_json(destination / "route.json").get("owner") != MARKER:
            raise ValueError("Refusing to replace an existing compatibility tool: " + str(destination))
        # Steam/Wine may still be using this tool. A changed package can be
        # registered on the next install after the old tool is removed explicitly.
        existing = load_json(destination / "route.json")
        if existing.get("base") == str(original) and existing.get("manifest") == manifest:
            if managed:
                verify_files(original, manifest["base"]["files"])
                verify_files(destination / ".runtime", {**manifest["base"]["files"], **manifest["patched"]["files"]})
                verify_files(destination, {"router.py": hashlib.sha256(Path(__file__).with_name("router.py").read_bytes()).hexdigest(),
                                          **{entry: hashlib.sha256(launcher.read_bytes()).hexdigest()
                                             for entry in ENTRYPOINTS if (original / entry).exists()}})
            if not quiet:
                print("lwfa compatibility tool already registered: " + str(destination))
            return destination
        if pids := active_pids(destination):
            raise ValueError("Compatibility tool is in use by PID(s): " + ", ".join(map(str, pids)))
        raise ValueError("Existing lwfa tool differs; close its games and remove it with manage.py remove before registering this build")
    temporary = Path(tempfile.mkdtemp(prefix=".lwfa-canvas-", dir=tools))
    try:
        if managed:
            archive = base_archive_path
            if download_base:
                cache = cache or Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "lwfa/proton"
                archive = base_archive.download(manifest["base"]["toolName"], cache)
            extracted = base_archive.extract(archive, temporary / ".extract", manifest["base"]["toolName"])
            base = temporary / ".original"
            extracted.rename(base)
            (temporary / ".extract").rmdir()
            verify_files(base, manifest["base"]["files"])
        private = temporary / ".runtime"
        # A real private tree matters: symlinked Wine loaders resolve their own
        # original directory and can silently load unpatched libraries.
        subprocess.run(["cp", "--reflink=auto", "-a", str(base), str(private)], check=True)
        for relative in manifest["patched"]["files"]:
            target = private / relative
            target.unlink(missing_ok=True)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(bundle / "payload" / relative, target)
        verify_files(private, {**manifest["base"]["files"], **manifest["patched"]["files"]})
        for item in base.iterdir():
            if item.name not in {"proton", "files", "compatibilitytool.vdf", "route.json", "router.py", ".runtime"}:
                (temporary / item.name).symlink_to(original / item.name, target_is_directory=item.is_dir())
        (temporary / "files" / "bin").mkdir(parents=True)
        for item in (base / "files").iterdir():
            if item.name != "bin":
                (temporary / "files" / item.name).symlink_to(original / "files" / item.name, target_is_directory=item.is_dir())
        for item in (base / "files" / "bin").iterdir():
            relative = "files/bin/" + item.name
            if relative not in ENTRYPOINTS:
                (temporary / relative).symlink_to(original / relative, target_is_directory=item.is_dir())
        shutil.copy2(Path(__file__).with_name("router.py"), temporary / "router.py")
        for entry in ENTRYPOINTS:
            if not (base / entry).exists():
                continue
            shutil.copy2(launcher, temporary / entry)
        (temporary / "compatibilitytool.vdf").write_text(
            '"compatibilitytools" { "compat_tools" { "' + name + '" {\n'
            '"install_path" "."\n"display_name" "lwfa ' + display_name + ' (Canvas' + (" " + name.rsplit("-", 1)[1] if managed else "") + ')"\n'
            '"from_oslist" "windows"\n"to_oslist" "linux"\n} } }\n', encoding="utf-8")
        # Keep this tool usable across lwfa upgrades or removal. A newer
        # package must not replace the manifest underneath an active runtime.
        shutil.copytree(bundle, temporary / ".artifact", symlinks=False)
        (temporary / "route.json").write_text(json.dumps({
            "owner": MARKER, "base": str(original), "runtime": str(destination / ".runtime"),
            "bundle": str(destination / ".artifact"), "manifest": manifest, "selfContained": managed,
        }, indent=2) + "\n", encoding="utf-8")
        temporary.rename(destination)
        if not quiet:
            print("Registered " + str(destination) + "; select it explicitly in Steam after restarting Steam")
        return destination
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def remove(path, quiet=False):
    with installation_lock(path.parent):
        if path.is_symlink() or load_json(path / "route.json").get("owner") != MARKER:
            raise ValueError("Refusing to remove a compatibility tool not owned by lwfa")
        if pids := active_pids(path):
            raise ValueError("Compatibility tool is in use by PID(s): " + ", ".join(map(str, pids)))
        shutil.rmtree(path)
        if not quiet:
            print("Removed " + str(path))


def status(steam_root):
    result = []
    directory = steam_root / "compatibilitytools.d"
    if directory.is_dir():
        for path in sorted(directory.iterdir()):
            if not path.name.startswith("lwfa-") or path.is_symlink() or not (path / "route.json").is_file():
                continue
            config = load_json(path / "route.json")
            if config.get("owner") != MARKER:
                continue
            result.append({"path": str(path), "name": path.name,
                           "baseTool": config["manifest"]["base"]["toolName"],
                           "selfContained": config.get("selfContained", False),
                           "activePids": active_pids(path)})
    return {"tools": result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    check = sub.add_parser("validate")
    check.add_argument("--bundle", type=Path, required=True)
    check.add_argument("--portable", action="store_true")
    add = sub.add_parser("install")
    add.add_argument("--bundle", type=Path, required=True)
    add.add_argument("--steam-root", type=Path, required=True)
    base = add.add_mutually_exclusive_group()
    base.add_argument("--base-archive", type=Path)
    base.add_argument("--download-base", action="store_true")
    add.add_argument("--cache", type=Path)
    add.add_argument("--json", action="store_true")
    delete = sub.add_parser("remove")
    delete.add_argument("--tool", type=Path, required=True)
    delete.add_argument("--json", action="store_true")
    inspect = sub.add_parser("status")
    inspect.add_argument("--steam-root", type=Path, required=True)
    inspect.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.action == "validate":
        artifact_manifest(args.bundle.resolve(), args.portable)
    elif args.action == "install":
        destination = install(args.bundle.resolve(), args.steam_root.resolve(),
                              base_archive_path=args.base_archive.resolve() if args.base_archive else None,
                              download_base=args.download_base, cache=args.cache, quiet=args.json)
        if args.json:
            print(json.dumps({"path": str(destination), "name": destination.name}))
    elif args.action == "status":
        print(json.dumps(status(args.steam_root.resolve())))
    else:
        remove(args.tool.absolute(), quiet=args.json)
        if args.json:
            print(json.dumps({"removed": str(args.tool.absolute())}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError, urllib.error.URLError, subprocess.CalledProcessError) as error:
        print("lwfa Wine: " + str(error), file=sys.stderr)
        sys.exit(1)
