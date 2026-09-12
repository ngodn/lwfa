#!/usr/bin/env bash
# Install the Linux iOS build helper. Apple SDKs are supplied separately.
set -euo pipefail

xtool_version=1.19.2
case "$(uname -m)" in
  x86_64) xtool_arch=x86_64; xtool_sha=41c5adcfab3d8d65fba3db0b5885ae16cf9851560da724781be38e523fe4e3e7 ;;
  aarch64) xtool_arch=aarch64; xtool_sha=83201c74365d6fcd7d0581d9854d7d13ad683ad6ca2fa921441086656a891455 ;;
  *) echo 'xtool requires an x86_64 or aarch64 Linux host.' >&2; exit 1 ;;
esac
[[ $(uname -s) == Linux ]] || { echo 'This setup script is for Linux.' >&2; exit 1; }

sdk_path=''
if [[ $# -gt 0 ]]; then
  if [[ $# != 2 || $1 != --sdk ]]; then
    echo "Usage: $0 [--sdk /path/to/Xcode.xip]" >&2
    exit 2
  fi
  sdk_path=$2
  [[ -e $sdk_path ]] || { echo 'The supplied Xcode path does not exist.' >&2; exit 1; }
fi

command -v swift >/dev/null || { echo 'Install Swift 6.3 first.' >&2; exit 1; }
swift --version
# xtool uses `clang -print-resource-dir` to choose intrinsic headers. Match the
# selected Swift compiler, not a newer unrelated distro Clang on PATH.
swift_bin_dir=$(swift -print-target-info | python3 -c 'import json,sys; from pathlib import Path; print(Path(json.load(sys.stdin)["paths"]["runtimeResourcePath"]).resolve().parent.parent / "bin")')
[[ -x "$swift_bin_dir/clang" ]] || { echo 'The selected Swift toolchain must include Clang.' >&2; exit 1; }
xtool_root="${XDG_DATA_HOME:-$HOME/.local/share}/lwfa-ios/toolchains/xtool/$xtool_version"
xtool_bin="$HOME/.local/bin/lwfa-xtool"
mkdir -p "$xtool_root" "$(dirname "$xtool_bin")"
xtool_work=$(mktemp -d "$xtool_root/.setup.XXXXXX")
trap 'rm -rf -- "$xtool_work"' EXIT

if [[ ! -x "$xtool_root/AppDir/AppRun" ]]; then
  curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
    "https://github.com/xtool-org/xtool/releases/download/$xtool_version/xtool-$xtool_arch.AppImage" \
    --output "$xtool_work/xtool.AppImage"
  printf '%s  %s\n' "$xtool_sha" "$xtool_work/xtool.AppImage" | sha256sum --check --status
  chmod u+x "$xtool_work/xtool.AppImage"
  (cd "$xtool_work" && ./xtool.AppImage --appimage-extract >/dev/null)
  mv "$xtool_work/squashfs-root" "$xtool_root/AppDir"
  printf '%s  %s\n' "$xtool_sha" "xtool-$xtool_arch.AppImage" > "$xtool_root/SHA256SUMS"
fi

# Use a project-specific command so an existing xtool installation stays intact.
printf '#!/usr/bin/env bash\nexec %q "$@"\n' "$xtool_root/AppDir/AppRun" > "$xtool_work/lwfa-xtool"
chmod u+x "$xtool_work/lwfa-xtool"
mv "$xtool_work/lwfa-xtool" "$xtool_bin"
"$xtool_bin" --version

if [[ -n $sdk_path ]]; then
  PATH="$swift_bin_dir:$PATH" "$xtool_bin" sdk install "$sdk_path"
fi
sdk_status=$("$xtool_bin" sdk status)
printf '%s\n' "$sdk_status"
if [[ $sdk_status == 'Installed at '* ]]; then
  # Repair SDKs previously generated with another Clang. Preserve every replaced
  # include directory inside the generated SDK; never modify the host toolchain.
  python3 - "${sdk_status#Installed at }" "$swift_bin_dir/clang" <<'PY'
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sdk = Path(sys.argv[1]).resolve()
metadata = json.loads((sdk / 'swift-sdk.json').read_text())
resource = metadata['targetTriples']['arm64-apple-ios']['swiftResourcesPath']
destination = sdk / resource / 'clang/include'
source = Path(subprocess.check_output([sys.argv[2], '-print-resource-dir'], text=True).strip()) / 'include'
if not destination.resolve().is_relative_to(sdk):
    raise SystemExit('Refusing to modify Clang resources outside the generated SDK.')
if not (source / 'arm_neon.h').is_file():
    raise SystemExit('Selected Swift Clang is missing its ARM intrinsic headers.')

def digest(directory):
    result = hashlib.sha256()
    for path in sorted(directory.rglob('*')):
        if path.is_file():
            result.update(str(path.relative_to(directory)).encode())
            result.update(path.read_bytes())
    return result.digest()

if not destination.is_dir() or digest(source) != digest(destination):
    work = Path(tempfile.mkdtemp(prefix='.lwfa-clang-', dir=destination.parent))
    try:
        replacement = work / 'include'
        shutil.copytree(source, replacement, symlinks=True)
        if destination.exists():
            backup = destination.with_name('include.lwfa-backup-' + work.name.removeprefix('.lwfa-clang-'))
            destination.rename(backup)
            print('Preserved previous Clang headers:', backup)
        replacement.rename(destination)
    finally:
        shutil.rmtree(work)
print('SDK Clang headers match:', source)
PY
fi
printf '\nInstalled helper: %s\n' "$xtool_bin"
if [[ -z $sdk_path && $sdk_status == 'Not installed' ]]; then
  printf '%s\n' 'To add the Apple SDK, download Xcode 26.x from Apple and run:'
  printf '  %q --sdk /path/to/Xcode.xip\n' "$0"
fi
