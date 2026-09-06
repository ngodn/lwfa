# Testing lwfa

Use `test:all` and check its **exit code**. Grepping the output for `FAILED` is
not enough: a Rust *compile* error never prints that word, so a broken build
reads as green. That has already happened once, when a field was added to
`Hello` and `crates/lwfa-proto/tests/from_ts.rs` was not updated.

```sh
pnpm run test:all     # Rust unit tests, then cross-language parity
pnpm run test:rust    # cargo test --workspace
pnpm test             # regenerates fixtures, then runs vitest
pnpm run typecheck
cargo clippy --workspace --all-targets
```

## End to end, against a running engine

These drive the real shell code as a headless client rather than mocking the
protocol:

```sh
cargo run -p lwfa-engine &
node --experimental-strip-types scripts/e2e-shell.mjs    # protocol + layout
node --experimental-strip-types scripts/e2e-stream.mjs   # per-surface streaming
pnpm run e2e:audio                                       # audio capture + opus
```

`LWFA_CAPTURE_DUMP=/some/dir` makes the engine write a PNG per window each
frame, which is how per-surface capture gets checked against what is actually on
screen.

## Isolated display and browser checks

The browser-only fixtures load the real components without attaching to a
running compositor:

```sh
node scripts/e2e-window-scaling-panel.mjs
node scripts/e2e-scaling-input.mjs
node scripts/e2e-opus-decoder.mjs
node scripts/e2e-codec-fallback.mjs
```

Set `PLAYWRIGHT_MODULE` to the installed Playwright module path and
`CHROMIUM_EXECUTABLE` to its Chromium binary when they are not discoverable.
The scaling input fixture checks all seven factors at display densities 1 and
2. The Opus fixture tests the real WASM decoder through a production build.
The codec fallback fixture uses the real App and intercepted sockets to verify
immediate renegotiation and a displayed JPEG after decoder rejection.

`scripts/e2e-scaling-rendering.mjs` needs a separate development engine and
launches native Wayland and X11 Chromium test apps inside it. Supply that
engine's `AUTH_PASS`, `LWFA_TEST_URL`, `LWFA_TEST_WAYLAND`, and
`LWFA_TEST_DISPLAY`. Do not point it at an engine containing your actual apps.
Run once with the default JPEG codec and again with `LWFA_TEST_CODEC=h264`.
Repeat with the dev engine's `[stream] gpu_direct = false` to exercise CPU
readback. The fixture measures committed app size, frame size, actual mouse
and touch delivery, popups, edge pixels, and fine-line contrast.

The opt-in [hardware codec recovery test](research/codec-resize-recovery.md)
checks real NVENC H.264/HEVC packets and independent FFmpeg decoding through
4000x3000 resize and forced-keyframe recovery. It requires hardware and explicit
output-directory selection, and is ignored by the normal suite.

## Protocol fixtures

The protocol fixtures round-trip in both directions, and each half regenerates
the other's input. `cargo run -p lwfa-proto --bin gen-proto-fixtures` writes
`fixtures/proto`, and `pnpm test` writes `fixtures/proto-from-ts` from it.

After changing a protocol message, run **both**, in that order, or the Rust side
compares against a stale TypeScript round trip and fails confusingly.

`pnpm test` regenerates `fixtures/rust.*.tsv` from the Rust implementation
before running. Those files are gitignored on purpose: a committed copy would
let the Rust side drift while the test kept passing against a stale snapshot.

## The spring parity test

`packages/spring` and `crates/lwfa-spring` are two implementations of the same
spring solver, and `packages/spring/test/parity.test.ts` checks that they agree
with each other and with upstream `motion-dom` to 1e-9.

This is not redundancy for its own sake. The engine integrates window animations
natively for the local display, the browser integrates them for remote displays,
and the same animation has to look identical on both. The spring itself is one
set of constants in `[animation]`, shared by both halves. Section 5 of
[the architecture doc](architecture.md) explains the contract.

**When you change one implementation, change the other.** The test will tell you
if you forgot.

## Next

- [Architecture](architecture.md)
- [Releasing](releasing.md)
