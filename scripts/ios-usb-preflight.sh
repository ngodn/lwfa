#!/usr/bin/env bash
set -euo pipefail
# Read-only transport check. stdout contains only the selected device ID.
for tool in timeout idevice_id ideviceinfo; do
  command -v "$tool" >/dev/null || { echo "Missing $tool. Install libimobiledevice and coreutils before USB installation." >&2; exit 1; }
done
if ! devices=$(timeout 5 idevice_id -l); then
  echo 'Could not read devices from usbmuxd. Installation has not started.' >&2
  exit 1
fi
mapfile -t ids < <(printf '%s\n' "$devices" | sed '/^[[:space:]]*$/d')
selected=${LWFA_IPAD_UDID:-}
if [[ -z $selected ]]; then
  if [[ ${#ids[@]} -ne 1 ]]; then
    echo 'Expected one USB iPad. Connect it, or set LWFA_IPAD_UDID when several devices are connected. Installation has not started.' >&2
    exit 1
  fi
  selected=${ids[0]}
fi
for sample in 1 2 3; do
  if [[ $sample -ne 1 ]] && ! devices=$(timeout 5 idevice_id -l); then
    echo 'The USB transport disappeared during the connection check. Installation has not started.' >&2
    exit 1
  fi
  if ! printf '%s\n' "$devices" | grep -Fxq -- "$selected"; then
    echo 'The selected iPad is not available over USB. Installation has not started.' >&2
    exit 1
  fi
  if ! timeout 8 ideviceinfo -u "$selected" -k ProductVersion >/dev/null; then
    echo 'The iPad did not complete the device handshake. A reconnect or pending trust prompt can cause this. Installation has not started.' >&2
    exit 1
  fi
  if [[ $sample -lt 3 ]]; then sleep 2; fi
done
printf '%s\n' "$selected"
