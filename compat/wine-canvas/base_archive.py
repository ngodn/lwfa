"""Fetch and unpack the reviewed GE runtime, never an arbitrary download URL."""
import hashlib
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile
import tempfile
import urllib.request


RELEASES = {
    "GE-Proton11-6-x86_64": {
        "url": "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-6/GE-Proton11-6-x86_64.tar.gz",
        "sha256": "659f8d71f2f78659340120b20c1c5a1464aa138939332a1376dea22f6d2dc2e4",
        "size": 533700853,
    },
}


def release_for(name):
    if name not in RELEASES:
        raise ValueError("No reviewed original GE archive for " + name)
    return RELEASES[name]


def verify_archive(path, release):
    if path.stat().st_size != release["size"]:
        raise ValueError("Original GE archive size mismatch")
    with path.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != release["sha256"]:
            raise ValueError("Original GE archive checksum mismatch")


def require_extractor():
    if sys.version_info < (3, 11) or not hasattr(tarfile, "data_filter"):
        raise ValueError("Managed Proton installation needs Python 3.11 or newer with tar extraction filters")


def download(name, cache):
    require_extractor()
    release = release_for(name)
    cache.mkdir(parents=True, exist_ok=True)
    destination = cache / (release["sha256"] + ".tar.gz")
    if destination.exists():
        try:
            verify_archive(destination, release)
            return destination
        except ValueError:
            destination.unlink()
    with tempfile.NamedTemporaryFile(prefix=".ge-download-", dir=cache, delete=False) as output:
        temporary = Path(output.name)
        try:
            request = urllib.request.Request(release["url"], headers={"User-Agent": "lwfa-Proton"})
            with urllib.request.urlopen(request, timeout=60) as response:
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > release["size"]:
                        raise ValueError("Original GE download exceeds pinned size")
                    output.write(chunk)
            output.flush()
            verify_archive(temporary, release)
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    return destination


def extract(path, destination, name):
    """Extract to a fresh directory with no links or writes outside its GE root."""
    require_extractor()
    verify_archive(path, release_for(name))
    destination.mkdir()
    root = (destination / name).resolve()
    seen = set()
    expanded = 0

    def checked(member, directory):
        nonlocal expanded
        entry = PurePosixPath(member.name)
        if entry.is_absolute() or ".." in entry.parts or not entry.parts or entry.parts[0] != name:
            raise ValueError("Unexpected GE archive path: " + member.name)
        seen.add(str(entry))
        target = (Path(directory) / member.name).resolve()
        if not target.is_relative_to(root):
            raise ValueError("GE archive path escapes original runtime")
        if member.issym() or member.islnk():
            link = PurePosixPath(member.linkname)
            link_base = target.parent if member.issym() else Path(directory)
            if link.is_absolute() or not (link_base / member.linkname).resolve().is_relative_to(root):
                raise ValueError("GE archive link escapes original runtime")
        expanded += member.size
        if expanded > 8 * 1024**3 or len(seen) > 200000:
            raise ValueError("GE archive exceeds extraction limits")
        return tarfile.data_filter(member, directory)

    try:
        with tarfile.open(path, "r:gz") as archive:
            archive.extractall(destination, filter=checked)
        if not root.is_dir():
            raise ValueError("GE archive has no runtime directory")
        return root
    except BaseException:
        shutil.rmtree(destination)
        raise
