#!/usr/bin/env bash
# Disposable-prefix passive probe. Needs PROTON_DIR and Zig (or ZIG_BIN).
# Example: PROTON_DIR=/path/to/GE-Proton11-5 scripts/xinput-probe.sh 15 1
set -euo pipefail
: "${PROTON_DIR:?Set PROTON_DIR to the GE-Proton installation to test}"
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
probe_dir=$(mktemp -d -t lwfa-xinput.XXXXXXXX)
probe_pid=
cleanup() {
  if [[ -n $probe_pid ]]; then
    kill "$probe_pid" 2>/dev/null || true
    wait "$probe_pid" 2>/dev/null || true
  fi
  WINEPREFIX="$probe_dir/pfx" "$PROTON_DIR/files/bin/wineserver" -k 2>/dev/null || true
  WINEPREFIX="$probe_dir/pfx" timeout 5s "$PROTON_DIR/files/bin/wineserver" -w 2>/dev/null || true
  rm -rf -- "$probe_dir"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
if [[ -n ${ZIG_BIN:-} ]]; then
  compiler=("$ZIG_BIN")
elif command -v mise >/dev/null && mise where zig@0.16.0 >/dev/null 2>&1; then
  compiler=(mise exec zig@0.16.0 -- zig)
else
  compiler=(zig)
fi
duration=${1:-15}
interval=${2:-1}
[[ $duration =~ ^[0-9]+$ && $interval =~ ^[0-9]+$ ]] || { echo "Expected integer seconds and poll milliseconds" >&2; exit 2; }
duration=$((10#$duration))
interval=$((10#$interval))
(( duration >= 1 && duration <= 600 && interval >= 1 && interval <= 1000 )) || exit 2
"${compiler[@]}" cc -std=c11 -O2 -target x86_64-windows-gnu "$script_dir/xinput-probe.c" -lwinmm -o "$probe_dir/xinput-probe.exe"
env WINEPREFIX="$probe_dir/pfx" WINEDEBUG=-all WINEDLLOVERRIDES='mscoree,mshtml=' \
  DISPLAY= WAYLAND_DISPLAY= WINEESYNC=0 WINEFSYNC=0 \
  timeout --kill-after=5s "$((duration + 60))s" "$PROTON_DIR/files/bin/wine" "$probe_dir/xinput-probe.exe" "$duration" "$interval" &
probe_pid=$!
wait "$probe_pid"
probe_pid=
