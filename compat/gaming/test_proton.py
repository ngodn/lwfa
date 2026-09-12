"""Read release archives as data using temporary component directories."""
import hashlib
import io
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import proton


class ProtonArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lwfa-proton-artifact-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def archive(self, entries):
        compressed = io.BytesIO()
        with tarfile.open(fileobj=compressed, mode="w:gz") as archive:
            for name, data, kind in entries:
                info = tarfile.TarInfo(proton.PREFIX + "/" + name)
                info.type = kind
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        installer = self.root / "fixture.run"
        installer.write_bytes(b"#!/bin/sh\nexit 99\n__PAYLOAD__\n" + compressed.getvalue())
        for name, value in (("SIZE", installer.stat().st_size), ("SHA256", hashlib.sha256(installer.read_bytes()).hexdigest())):
            context = patch.object(proton, name, value)
            context.start()
            self.addCleanup(context.stop)
        return installer

    def test_extract_reads_data_without_executing_header(self):
        installer = self.archive([("manifest.json", b"{}", tarfile.REGTYPE), ("payload/test", b"payload", tarfile.REGTYPE)])
        with patch.object(proton, "_validate") as validate:
            result = proton.extract_artifact(installer, self.root / "extracted")
        self.assertEqual((result / "payload/test").read_bytes(), b"payload")
        validate.assert_called_once_with(result, pinned=True)

    def test_rejects_corrupt_archive_before_extraction(self):
        installer = self.archive([])
        installer.write_bytes(installer.read_bytes() + b"changed")
        with self.assertRaisesRegex(ValueError, "pinned release"):
            proton.extract_artifact(installer, self.root / "extracted")
        self.assertFalse((self.root / "extracted").exists())

    def test_rejects_traversal_and_links_and_cleans_staging(self):
        for name, kind in (("../outside", tarfile.REGTYPE), ("link", tarfile.SYMTYPE), ("hardlink", tarfile.LNKTYPE)):
            with self.subTest(name=name):
                installer = self.archive([(name, b"", kind)])
                with self.assertRaises(ValueError):
                    proton.extract_artifact(installer, self.root / "extracted")
                self.assertFalse((self.root / "extracted").exists())
                self.assertFalse((self.root / "outside").exists())

    def test_packaged_artifact_avoids_download(self):
        packaged = self.root / "packaged"
        packaged.mkdir()
        with patch.object(proton, "_validate") as validate, patch.object(proton, "download_verified", side_effect=AssertionError("download")):
            self.assertEqual(proton.ensure_bundle(self.root, packaged), packaged)
        validate.assert_called_once_with(packaged)

    def test_cached_installer_is_extracted_once_without_network(self):
        source = self.archive([("manifest.json", b"{}", tarfile.REGTYPE)])
        downloads = self.root / "downloads"
        downloads.mkdir()
        shutil.copyfile(source, downloads / ("lwfa-" + proton.RELEASE + "-" + proton.SHA256[:12] + ".run"))
        with patch.object(proton, "_validate"), patch.object(proton, "download_verified", side_effect=AssertionError("download")):
            first = proton.ensure_bundle(self.root, self.root / "missing-packaged")
            inode = first.stat().st_ino
            second = proton.ensure_bundle(self.root, self.root / "missing-packaged")
            self.assertEqual(first, second)
            self.assertEqual(second.stat().st_ino, inode)

    def test_real_released_payload_when_local_asset_is_available(self):
        installer = Path(proton.__file__).resolve().parents[2] / "releases/lwfa-1.5.8.run"
        if not installer.exists():
            self.skipTest("Released installer is not cached locally")
        destination = proton.extract_artifact(installer, self.root / "real-artifact")
        self.assertTrue((destination / "payload/files/bin/wineserver").is_file())
        self.assertEqual(proton._digest(destination / "manifest.json"), proton.MANIFEST_SHA256)


if __name__ == "__main__":
    unittest.main()
