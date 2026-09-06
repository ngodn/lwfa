#!/usr/bin/env bash
# Run one bounded Claude helper task. Usage: scripts/claude.sh <prompt-file>
# The caller owns integration and validation; the prompt assigns output files.
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" || ! -r "$1" || ! -s "$1" ]]; then
  echo "Usage: $0 <nonempty-readable-prompt-file>" >&2
  exit 2
fi

if [[ ${CLAUDE_BIN:-} == */* && ${CLAUDE_BIN:-} != /* ]]; then
  CLAUDE_BIN="$PWD/$CLAUDE_BIN"
fi

# Open before changing directory so relative prompt paths work from any cwd.
exec 3< "$1"
REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../" && pwd)
cd "$REPO"

# Resolve mise's installed binary directly. The desktop's claude launcher runs
# `mise use -g` on every call, which changes global config and pollutes stdout.
if [[ -n "${CLAUDE_BIN:-}" ]]; then
  :
elif command -v mise >/dev/null && CLAUDE_BIN=$(mise which claude 2>/dev/null); then
  :
else
  CLAUDE_BIN=$(command -v claude)
fi

# Keep auth in the installed CLI. JSON includes result/error and model usage.
# Never fall back to another model silently. No interactive permission prompts.
exec timeout --kill-after=10s "${CLAUDE_TIMEOUT:-15m}" \
  "$CLAUDE_BIN" --print --model "${CLAUDE_MODEL:-opus}" --effort "${CLAUDE_EFFORT:-medium}" \
    --output-format json --dangerously-skip-permissions \
    --append-system-prompt "Repository: $REPO. Read AGENTS.md and docs/research/reliability-index.md when present. Do not restart production lwfa.service, install into the real home directory, commit, or publish. Work only on the assigned files and report exact tests and remaining limits." <&3
