#!/usr/bin/env python3
"""Validate the local ARM64 iPad artifact before handing it to a signer."""
import pathlib
import plistlib
import struct
import sys
import zipfile

path = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(path) as ipa:
    bad = ipa.testzip()
    if bad:
        raise SystemExit(f"Corrupt IPA entry: {bad}")
    info_names = [name for name in ipa.namelist() if name.startswith("Payload/") and name.count("/") == 2 and name.endswith(".app/Info.plist")]
    if len(info_names) != 1:
        raise SystemExit("Expected one application bundle")
    info_name = info_names[0]
    root = info_name.removesuffix("Info.plist")
    info = plistlib.loads(ipa.read(info_name))
    assert info["CFBundleIdentifier"] == "io.github.ngodn.lwfa", "Wrong application identifier"
    assert 2 in info["UIDeviceFamily"], "Missing iPad support"
    executable = ipa.read(root + info["CFBundleExecutable"])
    magic, cpu, _, kind = struct.unpack_from("<IIII", executable)
    assert magic == 0xFEEDFACF and cpu == 0x0100000C and kind == 2, "Expected an ARM64 Mach-O executable"
    for resource in ("layout.js", "mark-on-dark.png", "mark-on-light.png", "Opus-LICENSE.txt"):
        matches = [name for name in ipa.namelist() if name.startswith(root) and name.endswith("/" + resource)]
        assert len(matches) == 1 and len(ipa.read(matches[0])) > 0, f"Missing or duplicate {resource}"
    assert info.get("UIApplicationSupportsIndirectInputEvents"), "Missing pointer input support"
    print(f"Verified {path.name}: ARM64 iPad app {info['CFBundleShortVersionString']} ({info['CFBundleVersion']}), resources intact")
    print("Signing, installation, and physical-device behavior are separate checks.")
