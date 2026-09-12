#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
xtool_bin="${LWFA_XTOOL:-$HOME/.local/bin/lwfa-xtool}"
[[ -x $xtool_bin ]] || {
  echo 'Run scripts/setup-ios-toolchain.sh first.' >&2
  exit 1
}
command -v swift >/dev/null || { echo 'Run this script through mise exec to select Swift 6.3.' >&2; exit 1; }
node "$repo_dir/scripts/build-ios-layout.mjs"
cd -- "$repo_dir/clients/ios"
"$xtool_bin" dev build --configuration release --ipa
python3 "$repo_dir/scripts/check-ios-ipa.py" "$repo_dir/clients/ios/xtool/LWFA.ipa"
printf '\nUnsigned iPad app: %s/clients/ios/xtool/LWFA.ipa\n' "$repo_dir"
printf '%s\n' 'Device installation requires Apple signing and provisioning.'
