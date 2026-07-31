#!/usr/bin/env bash
# Launch lwfa nested, pinned to a specific Hyprland workspace.
#
# Why this exists rather than just `cargo run`: the nested compositor opens a
# real window in the host session, and it must never land on the workspace
# you are actually using. It goes to LWFA_DEV_WORKSPACE (default 2) with the
# `silent` flag, so focus never moves.
#
# Hyprland has a known bug where `exec [workspace N silent]` sometimes places
# the window on the wrong workspace (hyprwm/Hyprland#8907), so placement is
# verified by PID afterwards and corrected if it drifted. Do not simplify this
# to just the exec rule.
#
# Usage:
#   scripts/dev-nested.sh            # run until Ctrl+C
#   scripts/dev-nested.sh --smoke    # run briefly, verify, screenshot, exit
set -uo pipefail

WORKSPACE="${LWFA_DEV_WORKSPACE:-2}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/target/debug/lwfa-engine"
SMOKE=0
[ "${1:-}" = "--smoke" ] && SMOKE=1

if ! command -v hyprctl >/dev/null; then
  echo "hyprctl not found. This script is Hyprland-specific; use 'cargo run -p lwfa-engine' instead." >&2
  exit 1
fi

cargo build -p lwfa-engine || exit 1

"$BIN" "$@" &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT

# Give the window time to map before looking for it.
for _ in $(seq 1 40); do
  sleep 0.25
  ADDR=$(hyprctl clients -j 2>/dev/null | PID="$PID" python3 -c '
import json, os, sys
want = int(os.environ["PID"])
try:
    for c in json.load(sys.stdin):
        if c.get("pid") == want:
            print(c["address"], c["workspace"]["id"])
            break
except Exception:
    pass
')
  [ -n "$ADDR" ] && break
done

if [ -z "${ADDR:-}" ]; then
  echo "could not find lwfa's window (pid $PID) in hyprctl" >&2
else
  set -- $ADDR
  ADDRESS=$1; ON_WS=$2
  if [ "$ON_WS" != "$WORKSPACE" ]; then
    echo "window landed on workspace $ON_WS, moving to $WORKSPACE"
    hyprctl dispatch movetoworkspacesilent "$WORKSPACE,address:$ADDRESS" >/dev/null
  fi
  echo "lwfa on workspace $WORKSPACE (address $ADDRESS, pid $PID)"
fi

if [ "$SMOKE" = "1" ]; then
  sleep 4
  ACTIVE=$(hyprctl activeworkspace -j | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  if [ "$ACTIVE" = "$WORKSPACE" ] && [ -n "${ADDRESS:-}" ]; then
    GEO=$(hyprctl clients -j | ADDRESS="$ADDRESS" python3 -c '
import json, os, sys
want = os.environ["ADDRESS"]
for c in json.load(sys.stdin):
    if c["address"] == want:
        x, y = c["at"]; w, h = c["size"]
        print(f"{x},{y} {w}x{h}")
        break
')
    [ -n "$GEO" ] && grim -g "$GEO" "$ROOT/target/lwfa-smoke.png" && echo "screenshot: target/lwfa-smoke.png"
  else
    echo "active workspace is $ACTIVE, not $WORKSPACE; skipping screenshot so nothing is disturbed"
  fi
  exit 0
fi

wait $PID
