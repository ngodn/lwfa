#!/usr/bin/env bash
# Run a bounded lwfa analysis task with agy. Usage: scripts/agy.sh <prompt-file>
# The caller assigns files and owns integration and validation.
# Serialize helpers sharing the same login to avoid competing token refreshes.
set -euo pipefail

REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
MODEL=${AGY_MODEL:-gemini-3.8-flash-high}
if [[ $# -ne 1 || ! -f "$1" || ! -r "$1" || ! -s "$1" ]]; then
  echo "Usage: $0 <nonempty-readable-prompt-file>" >&2
  exit 2
fi
# Preserve caller-relative executable overrides when switching to the repo.
AGY_EXECUTABLE=${AGY_BIN:-agy}
if [[ $AGY_EXECUTABLE == */* && $AGY_EXECUTABLE != /* ]]; then
  AGY_EXECUTABLE="$PWD/$AGY_EXECUTABLE"
fi
# agy's documented plain-text mode takes the prompt as one argv entry.
# Reject before reading very large files, then include our prefix below.
if (( $(wc -c < "$1") >= 120000 )); then
  echo "Prompt exceeds the 119999-byte limit including wrapper instructions. Split this into smaller bounded tasks." >&2
  exit 2
fi
# Resolve the prompt before changing directory. State the root in the prompt
# too, since the helper's filesystem tools may start outside the CLI cwd.
TASK_PROMPT=$(cat -- "$1")
TASK_PROMPT="Repository: $REPO. Resolve all task paths under this repository; use absolute paths when calling filesystem tools. Read AGENTS.md and docs/research/reliability-index.md when present. Do not restart production lwfa.service, install into the real home directory, commit, or publish. Work only on the assigned files and report exact tests and remaining limits.

$TASK_PROMPT"
if (( $(printf '%s' "$TASK_PROMPT" | wc -c) >= 120000 )); then
  echo "Prompt exceeds the 119999-byte limit including wrapper instructions. Split this into smaller bounded tasks." >&2
  exit 2
fi
LOCK_DIR=${XDG_RUNTIME_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/lwfa}
mkdir -p -- "$LOCK_DIR"
LOCK=${AGY_LOCK_FILE:-$LOCK_DIR/lwfa-agy.lock}
# Long enough for a full analysis run to finish and release the lock.
LOCK_WAIT_SECONDS=${AGY_LOCK_WAIT_SECONDS:-3600}

cd "$REPO"
exec flock --wait "$LOCK_WAIT_SECONDS" "$LOCK" \
  timeout --kill-after=10s "${AGY_TIMEOUT:-15m}" \
  "$AGY_EXECUTABLE" -p "$TASK_PROMPT" \
      --model "$MODEL" \
      --output-format text \
      --dangerously-skip-permissions \
      --print-timeout "${AGY_TIMEOUT:-15m}"
