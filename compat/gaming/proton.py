"""Obtain the released Canvas artifact without executing its installer."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import tempfile

from components import component_lock, download_verified

HERE = Path(__file__).resolve().parent
RELEASE = "1.5.8"
URL = "https://github.com/ngodn/lwfa/releases/download/v1.5.8/lwfa-1.5.8.run"
SHA256 = "4090523eb59d839ae0723953136887a1214c5c4c10136e4e09f6bc4a6b907560"
SIZE = 24232484
MANIFEST_SHA256 = "6c5e856dd1be03af620f6b3d587effc91b5189b669d990b38b84c957974d6fb7"
PREFIX = "lwfa-1.5.8/share/lwfa/compat/wine-canvas/artifact"
SOURCE_URL = "https://github.com/ngodn/lwfa/releases/download/v1.5.8/lwfa-1.5.5-wine-source.tar.gz"


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate(bundle: Path, pinned: bool = False):
    if pinned and _digest(bundle / "manifest.json") != MANIFEST_SHA256:
        raise ValueError("Canvas Proton manifest does not match the pinned release")
    helper = HERE.parent / "wine-canvas/manage.py"
    result = subprocess.run([sys.executable, str(helper), "validate", "--bundle", str(bundle), "--portable"],
                            text=True, capture_output=True, timeout=60)
    if result.returncode:
        raise ValueError(result.stderr.strip()[-1000:] or "Canvas Proton artifact validation failed")


def extract_artifact(installer: Path, destination: Path) -> Path:
    """Read only the pinned archive's artifact subtree, with bounded extraction."""
    if installer.stat().st_size != SIZE or _digest(installer) != SHA256:
        raise ValueError("Canvas Proton installer does not match the pinned release")
    destination.mkdir()
    count = total = 0
    try:
        with installer.open("rb") as source:
            for _ in range(256):
                line = source.readline(8192)
                if line == b"__PAYLOAD__\n":
                    break
                if not line:
                    raise ValueError("Canvas Proton installer has no payload")
            else:
                raise ValueError("Canvas Proton installer header exceeds its limit")
            with tarfile.open(fileobj=source, mode="r|gz") as archive:
                for member in archive:
                    if not member.name.startswith(PREFIX + "/"):
                        continue
                    relative = PurePosixPath(member.name[len(PREFIX) + 1:])
                    if relative.is_absolute() or ".." in relative.parts or not relative.parts:
                        raise ValueError("Canvas artifact path escapes its directory")
                    target = destination / str(relative)
                    if member.isdir():
                        target.mkdir(parents=True, exist_ok=True)
                        continue
                    if not member.isfile():
                        raise ValueError("Canvas artifact contains an unsupported link or special file")
                    count += 1
                    total += member.size
                    if count > 10000 or total > 256 * 1024**2:
                        raise ValueError("Canvas artifact exceeds extraction limits")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with target.open("xb") as output, archive.extractfile(member) as contents:
                        shutil.copyfileobj(contents, output)
                    target.chmod(0o755 if member.mode & 0o111 else 0o644)
        _validate(destination, pinned=True)
        return destination
    except BaseException:
        shutil.rmtree(destination)
        raise


def ensure_bundle(root: Path, packaged: Path | None = None) -> Path:
    packaged = packaged if packaged is not None else HERE.parent / "wine-canvas/artifact"
    if packaged.is_dir():
        _validate(packaged)
        return packaged.resolve()
    destination = root / "components/proton-artifact" / (RELEASE + "-" + SHA256[:12])
    with component_lock(root):
        if destination.is_dir():
            _validate(destination, pinned=True)
            return destination.resolve()
        downloads = root / "downloads"
        installer = downloads / ("lwfa-" + RELEASE + "-" + SHA256[:12] + ".run")
        if not installer.is_file() or installer.stat().st_size != SIZE or _digest(installer) != SHA256:
            download_verified(URL, SHA256, installer, max_bytes=SIZE)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".artifact-", dir=destination.parent) as temporary:
            artifact = extract_artifact(installer, Path(temporary) / "artifact")
            (artifact / "download-source.json").write_text(json.dumps({
                "release": RELEASE, "url": URL, "sha256": SHA256, "sourceUrl": SOURCE_URL,
            }, indent=2) + "\n")
            artifact.rename(destination)
    return destination.resolve()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(ensure_bundle(args.root))
    except (ValueError, OSError, tarfile.TarError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
