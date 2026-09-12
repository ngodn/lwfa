#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
xtool_bin=${LWFA_XTOOL:-$HOME/.local/bin/lwfa-xtool}
force_login=false
check_only=false
ipa_path=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --help|-h)
      cat <<'HELP'
Usage: scripts/install-ios.sh [--login] [--check] [path/to/LWFA.ipa]

Sign and install the existing lwfa IPA with xtool over USB.
Run in your terminal with the unlocked iPad connected. On first use,
xtool prompts for your Apple account and any required verification code.

  --login  Authenticate again if the saved xtool login has expired.
  --check  Check the tool and unsigned IPA without logging in or installing.

LWFA_XTOOL       Override the xtool executable (default: ~/.local/bin/lwfa-xtool)
LWFA_IPAD_UDID   Select a device when several are connected
HELP
      exit 0 ;;
    --login) force_login=true ;;
    --check) check_only=true ;;
    --*) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
    *) [[ -z $ipa_path ]] || { echo 'Expected at most one IPA path.' >&2; exit 1; }; ipa_path=$1 ;;
  esac
  shift
done
ipa_path=${ipa_path:-$repo_dir/clients/ios/xtool/LWFA.ipa}
[[ -x $xtool_bin ]] || { echo 'Run scripts/setup-ios-toolchain.sh first, or set LWFA_XTOOL.' >&2; exit 1; }
[[ -s $ipa_path ]] || { echo 'Build the app first with scripts/build-ios.sh.' >&2; exit 1; }
ipa_path=$(realpath -- "$ipa_path")
python3 "$repo_dir/scripts/check-ios-ipa.py" "$ipa_path"
if $check_only; then
  "$xtool_bin" --version
  exit 0
fi
[[ -t 0 ]] || { echo 'Run this script in your terminal so xtool can request authentication.' >&2; exit 1; }
device_id=$(bash "$repo_dir/scripts/ios-usb-preflight.sh")
# auth status reports only saved-login metadata. Do not read its credential files.
login_status=$("$xtool_bin" auth status)
if $force_login || [[ $login_status == 'Logged out' ]]; then
  "$xtool_bin" auth login --mode password
elif [[ $login_status != 'Logged in.'* ]]; then
  echo 'Could not determine xtool login status. Run with --login to authenticate.' >&2
  exit 1
fi
# Login can take long enough for the USB connection to change. Recheck the same
# device before signing, including when multiple devices are now connected.
LWFA_IPAD_UDID=$device_id bash "$repo_dir/scripts/ios-usb-preflight.sh" >/dev/null
args=(install --usb --udid "$device_id")
printf 'Signing and installing %s with xtool\n' "$(basename -- "$ipa_path")"
# xtool's integrated installer provisions, signs, and installs this existing IPA.
# The old Sideloader/libplist compatibility environment is not used.
exec "$xtool_bin" "${args[@]}" "$ipa_path"
