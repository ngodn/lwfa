# Helper scripts, 2026-09-06

`scripts/agy.sh` and `scripts/claude.sh` now derive lwfa's root from their own
location. The copied versions respectively hardcoded another checkout and
resolved one directory above lwfa. Both accept a readable, nonempty prompt file
from any working directory and prepend lwfa scope and production boundaries.
Path-containing `AGY_BIN` and `CLAUDE_BIN` overrides are resolved against the
caller's directory before switching to lwfa. Bare command names still use PATH.

The calling agent remains responsible for assigning files, reviewing changes,
and validating results. Prompts must specify one bounded task and its output.
Both helpers keep their existing noninteractive permission bypass and use a
15-minute outer timeout. Do not use them to delegate unreviewed production work.

- agy: default model `gemini-3.8-flash-high`, confirmed in installed `agy models`.
  Overrides: `AGY_MODEL`, `AGY_BIN`, `AGY_TIMEOUT`, `AGY_LOCK_FILE`,
  `AGY_LOCK_WAIT_SECONDS`. Calls are serialized through a user-owned lock in
  the runtime directory, or the XDG cache fallback, to avoid concurrent refreshes.
  The complete prompt, including the repository instructions, must be below
  120,000 bytes. Oversized files fail with a clear message to split the task,
  before reaching Linux's per-argument limit. Plain-text input remains `-p`:
  installed help and [Google's headless documentation](https://www.antigravity.google/docs/cli/headless)
  only establish stdin prompts through the separate stream-json protocol, which
  also requires stream-json output. Unverified plain-text stdin behavior was not
  substituted for the working interface.
- Claude: default model alias `opus`, confirmed supported by installed CLI help.
  Set `CLAUDE_MODEL` to pin an exact model. The copied unverified `claude-opus-4-8`
  identifier is no longer assumed. Overrides: `CLAUDE_BIN`, `CLAUDE_EFFORT`,
  `CLAUDE_TIMEOUT`. Normal resolution uses `mise which claude` to avoid the
  desktop launcher changing global tool configuration. Output remains JSON.

```sh
scripts/claude.sh /absolute/path/to/bounded-task.txt
scripts/agy.sh /absolute/path/to/bounded-task.txt
```

Validation used fake CLI executables in a temporary directory, not paid model
calls: both wrappers selected this checkout, accepted a relative prompt filename
with spaces, preserved literal dollar/backtick text, and rejected a missing
prompt with exit code 2. `bash -n` also passes. Installed `agy --help`, `agy models`
and Claude `--help` verified the accepted flag names. The primary Claude CLI
reference is <https://code.claude.com/docs/en/cli-reference>.

A follow-up fake-CLI check confirmed both relative executable overrides work
with spaces in their paths, a 140,000-byte Claude prompt still travels through
stdin, and agy rejects both oversized files and a prompt whose instructions push
the total over its limit. These checks made no model calls.

Standalone probe review also fixed three concrete issues: XInput WebSocket
handshakes now have a five-second deadline and reject early close; decimal
arguments such as `08` no longer trigger Bash octal parsing; the rendering probe
uses `wss:` for an HTTPS test origin. Three socket lifecycle tests pass. Decimal
arguments were checked against fake compiler/Wine programs, and both URL schemes
were checked using the actual rendering probe expression. No production input
was needed for these checks.

The separate `dev-nested.sh` launcher now builds from its own repository root
and names the actual `AUTH_PASS` setting in its login hint. The previous
`LWFA_SHELL_TOKEN` hint described a setting the engine no longer reads.
Its workspace comment now follows the configured default. Bash syntax checking
passes; the live probes use the equivalent direct engine launch to keep precise
ownership of the dev process.
