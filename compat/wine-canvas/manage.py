#!/usr/bin/env python3
"""Install an independent Steam compatibility tool without changing selections."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

from router import ENTRYPOINTS, MARKER, artifact_manifest, load_json, verify_files


def tool_name(manifest):
    name = "lwfa-" + manifest["base"]["toolName"] + "-canvas"
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
        raise ValueError("Unsupported GE tool identity")
    return name


def install(bundle, steam_root, launcher=None):
    manifest = artifact_manifest(bundle)
    launcher = launcher or Path(__file__).with_name("launcher")
    if not launcher.is_file() or not os.access(launcher, os.X_OK):
        raise ValueError("Missing packaged native Wine launcher: " + str(launcher))
    tools = steam_root / "compatibilitytools.d"
    base = (tools / manifest["base"]["toolName"]).resolve()
    if not base.is_dir():
        raise ValueError("Install the matching original " + manifest["base"]["toolName"] + " in " + str(tools) + " first")
    verify_files(base, manifest["base"]["files"])
    name = tool_name(manifest)
    display_name = manifest["base"]["toolName"].removesuffix("-x86_64").replace("GE-Proton", "GE-Proton ", 1)
    destination = tools / name
    if destination.exists() or destination.is_symlink():
        if destination.is_symlink() or load_json(destination / "route.json").get("owner") != MARKER:
            raise ValueError("Refusing to replace an existing compatibility tool: " + str(destination))
        # Steam/Wine may still be using this tool. A changed package can be
        # registered on the next install after the old tool is removed explicitly.
        existing = load_json(destination / "route.json")
        if existing.get("base") == str(base) and existing.get("manifest") == manifest:
            print("lwfa compatibility tool already registered: " + str(destination))
            return destination
        raise ValueError("Existing lwfa tool differs; close its games and remove it with manage.py remove before registering this build")
    temporary = Path(tempfile.mkdtemp(prefix=".lwfa-canvas-", dir=tools))
    try:
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
                (temporary / item.name).symlink_to(item, target_is_directory=item.is_dir())
        (temporary / "files" / "bin").mkdir(parents=True)
        for item in (base / "files").iterdir():
            if item.name != "bin":
                (temporary / "files" / item.name).symlink_to(item, target_is_directory=item.is_dir())
        for item in (base / "files" / "bin").iterdir():
            relative = "files/bin/" + item.name
            if relative not in ENTRYPOINTS:
                (temporary / relative).symlink_to(item, target_is_directory=item.is_dir())
        shutil.copy2(Path(__file__).with_name("router.py"), temporary / "router.py")
        for entry in ENTRYPOINTS:
            if not (base / entry).exists():
                continue
            shutil.copy2(launcher, temporary / entry)
        (temporary / "compatibilitytool.vdf").write_text(
            '"compatibilitytools" { "compat_tools" { "' + name + '" {\n'
            '"install_path" "."\n"display_name" "lwfa ' + display_name + ' (Canvas)"\n'
            '"from_oslist" "windows"\n"to_oslist" "linux"\n} } }\n', encoding="utf-8")
        # Keep this tool usable across lwfa upgrades or removal. A newer
        # package must not replace the manifest underneath an active runtime.
        shutil.copytree(bundle, temporary / ".artifact", symlinks=False)
        (temporary / "route.json").write_text(json.dumps({
            "owner": MARKER, "base": str(base), "runtime": str(destination / ".runtime"),
            "bundle": str(destination / ".artifact"), "manifest": manifest,
        }, indent=2) + "\n", encoding="utf-8")
        temporary.rename(destination)
        print("Registered " + str(destination) + "; select it explicitly in Steam after restarting Steam")
        return destination
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def remove(path):
    if path.is_symlink() or load_json(path / "route.json").get("owner") != MARKER:
        raise ValueError("Refusing to remove a compatibility tool not owned by lwfa")
    shutil.rmtree(path)
    print("Removed " + str(path))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    check = sub.add_parser("validate")
    check.add_argument("--bundle", type=Path, required=True)
    check.add_argument("--portable", action="store_true")
    add = sub.add_parser("install")
    add.add_argument("--bundle", type=Path, required=True)
    add.add_argument("--steam-root", type=Path, required=True)
    delete = sub.add_parser("remove")
    delete.add_argument("--tool", type=Path, required=True)
    args = parser.parse_args()
    if args.action == "validate":
        artifact_manifest(args.bundle.resolve(), args.portable)
    elif args.action == "install":
        install(args.bundle.resolve(), args.steam_root.resolve())
    else:
        remove(args.tool.absolute())


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print("lwfa Wine: " + str(error), file=sys.stderr)
        sys.exit(1)
