"""Downloads and inventory for private lwfa gaming components."""

from contextlib import contextmanager
import fcntl
import hashlib
import os
from pathlib import Path
import tempfile
import urllib.request


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


@contextmanager
def component_lock(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".components.lock").open("a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def download_verified(url: str, sha256: str, destination: Path,
                      max_bytes: int = 134217728) -> None:
    """Publish a bounded HTTPS download only after its pinned digest matches."""
    if not url.startswith("https://"):
        raise ValueError("Component downloads require HTTPS")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".download-", dir=destination.parent)
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "lwfa-component-manager"})
        with os.fdopen(descriptor, "wb") as output:
            with urllib.request.urlopen(request, timeout=30) as response:
                if not response.geturl().startswith("https://"):
                    raise ValueError("Component download redirected outside HTTPS")
                digest = hashlib.sha256()
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError("Component download exceeds its size limit")
                    digest.update(chunk)
                    output.write(chunk)
                if digest.hexdigest() != sha256:
                    raise ValueError("Component checksum does not match the pinned release")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)


def component_status(root: Path) -> dict:
    import lsfg
    import framegen
    return {"lsfg": lsfg.component_status(root), "framegen": framegen.component_status(root)}


def install_component(root: Path, component: str) -> dict:
    if component == "lsfg":
        import lsfg
        return lsfg.install_component(root)
    if component in ("framegen", "optiscaler"):
        import framegen
        return framegen.install_component(root)
    raise ValueError("Unknown gaming component")
