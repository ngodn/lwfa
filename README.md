# lwfa

**literally work from anywhere**

A Wayland compositor with a browser-native shell. The same desktop runs on the
machine's physical display and in a browser on any other device, with layout
that responds to the viewport it's being viewed on.

- **Engine**: Rust, [Smithay](https://smithay.github.io/), wgpu. Wayland
  protocol, DRM/KMS, per-surface encode, native local compositing.
- **Shell**: TypeScript, React 19, [Motion](https://motion.dev/),
  [PreTeXt.js](https://pretextjs.dev/). Runs unchanged against either backend.
- **Layout**: scrollable tiling, following [niri](https://github.com/niri-wm/niri).
- **Remote**: per-surface streams decoded with WebCodecs and composited in the
  DOM, so the browser can lay windows out however the viewport demands.

Read [docs/architecture.md](docs/architecture.md) before changing anything
structural. It records the decisions and, more importantly, why.

## Status

Milestone 1 of 7. See the build order in the architecture doc.

- [x] **1. Spring parity harness** — `crates/lwfa-spring`, `packages/spring`
- [ ] 2. Smithay compositor, nested backend
- [ ] 3. Shell protocol v0 and the layer-shell chrome path
- [ ] 4. Per-surface encode and the remote backend
- [ ] 5. Appearance vocabulary in both backends
- [ ] 6. iPad: WebCodecs, gestures, responsive breakpoints
- [ ] 7. Clipboard, audio, multi-monitor, DPI, reconnect, auth, packaging

## Requirements

Pinned in `.mise.toml` and `rust-toolchain.toml`:

- Rust 1.95.0 (edition 2024)
- Node 24.15.0, pnpm 11

```sh
mise install
pnpm install
```

## Tests

```sh
pnpm run test:all     # Rust unit tests, then cross-language parity
pnpm run test:rust    # cargo test --workspace
pnpm test             # regenerates fixtures, then runs vitest
pnpm run typecheck
cargo clippy --workspace --all-targets
```

`pnpm test` regenerates `fixtures/rust.*.tsv` from the Rust implementation
before running. Those files are gitignored on purpose: a committed copy would
let the Rust side drift while the test kept passing against a stale snapshot.

### About the parity test

`packages/spring` and `crates/lwfa-spring` are two implementations of the same
spring solver, and `packages/spring/test/parity.test.ts` checks that they agree
with each other and with upstream `motion-dom` to 1e-9.

This is not redundancy for its own sake. The engine integrates window
animations natively for the local display, the browser integrates them for
remote displays, and the same animation has to look identical on both. Section 5
of the architecture doc explains the contract.

**When you change one implementation, change the other.** The test will tell you
if you forgot.

## License

MIT. See [LICENSE](LICENSE).

One thing to keep in mind while working: [niri](https://github.com/niri-wm/niri)
is GPL-3.0, and lwfa follows its layout model (architecture doc, section 2.3).
Reading niri as a reference is fine and encouraged. **Porting its code is not**,
because that would force lwfa to GPL-3.0. If that ever looks worth doing, it is
a deliberate relicensing decision to make first, not a consequence to discover
afterwards.
