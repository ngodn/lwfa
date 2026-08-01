# lwfa

**literally work from anywhere**

A Wayland compositor with a browser-native shell. The same desktop runs on the
machine's physical display and in a browser on any other device, with layout
that responds to the viewport it's being viewed on.

- **Engine**: Rust, [Smithay](https://smithay.github.io/), wgpu. Wayland
  protocol, DRM/KMS, per-surface encode, native local compositing. Owns
  mechanism, not policy.
- **Shell**: TypeScript, React 19, [Motion](https://motion.dev/),
  [PreTeXt.js](https://pretextjs.dev/). Runs unchanged against either backend.
- **Layout**: scrollable tiling, following [niri](https://github.com/niri-wm/niri).
- **Remote**: per-surface streams decoded with WebCodecs and composited in the
  DOM, so the browser can lay windows out however the viewport demands.

Read [docs/architecture.md](docs/architecture.md) before changing anything
structural. It records the decisions and, more importantly, why.

## Status

Milestone 4 of 7 complete. See the build order in the architecture doc.

- [x] **1. Spring parity harness** — `crates/lwfa-spring`, `packages/spring`
- [x] **2. Smithay compositor, nested backend** — `crates/lwfa-engine`
- [x] **3. Shell protocol v0** — `crates/lwfa-proto`, `packages/proto`, `packages/shell`
      (the layer-shell chrome path is *not* done; see the architecture doc)
- [x] **4. Per-surface streaming and the remote backend** — hardware H.264 via
      NVENC, decoded with WebCodecs, composited in the browser DOM
- [x] **Remote input** — pointer, keyboard and touch from the browser into the
      compositor. **Localhost only, no auth yet** (see the warning below)
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

## Running

lwfa runs nested inside whatever compositor you are already using, as an
ordinary window. Your session is never at risk.

```sh
cargo run -p lwfa-engine
```

Then start the shell, which is what actually lays windows out:

```sh
pnpm --filter @lwfa/shell dev     # http://localhost:5173
```

Until a shell connects the engine runs in **safe mode**: focused window
full-screen, and that is all. Safe mode is deliberately not a layout engine, so
that layout policy exists in exactly one place. See `crates/lwfa-engine/src/layout.rs`.

| Bind | Handled by | Action |
|---|---|---|
| `Alt+Return` | engine | spawn a terminal |
| `Alt+Q` | engine | quit |
| `Alt+H` / `Alt+Left` | shell | focus the column to the left |
| `Alt+L` / `Alt+Right` | shell | focus the column to the right |
| `Alt+K` / `Alt+Up` | shell | focus up within a column's stack |
| `Alt+J` / `Alt+Down` | shell | focus down within a column's stack |
| `Alt+Shift+H` | shell | consume: pull this window into the column on its left |
| `Alt+Shift+L` | shell | expel: push this window out into its own column |
| `Alt+Shift+K` / `Alt+Shift+J` | shell | move this window to the workspace above/below |
| `Alt+1` … `Alt+3` | shell | jump to a workspace |
| `Alt+4` | shell | cycle the focused column's width (⅓, ½, ⅔) |
| `Alt+W` | shell | close the focused window |

Layout follows [niri](https://github.com/niri-wm/niri): windows live in columns
on an infinite horizontal strip, a column can hold a vertical stack, and
workspaces stack vertically. Workspaces need no protocol support at all, because
`SetLayout` is total: the shell omits the windows on other workspaces and the
engine hides whatever it is not told about.

All of that is layout policy, so the engine forwards those keys to the shell
rather than acting on them. Alt rather than Super, because the host compositor
sees keys first and usually has Super bound. The TTY backend will move these to
Super.

Environment:

- `LWFA_TERMINAL` — which terminal to spawn (default `alacritty`)
- `LWFA_NO_AUTOSTART` — set to skip opening a terminal on launch
- `LWFA_SHELL_ADDR` — where to listen for a shell (default `127.0.0.1:9843`)
- `RUST_LOG=debug` — Smithay is chatty at `info`; `warn` is usually the useful level

> **The shell socket has no authentication.** It accepts input injection and
> can spawn processes, so anything that reaches the port has full control of
> the session. It is bound to localhost and must stay there until auth exists.
> Do not set `LWFA_SHELL_ADDR` to a non-loopback address.

On Hyprland, `scripts/dev-nested.sh` launches the engine pinned to a specific
workspace (default 2, override with `LWFA_DEV_WORKSPACE`) so it never lands on
whatever you are using.

## Tests

```sh
pnpm run test:all     # Rust unit tests, then cross-language parity
pnpm run test:rust    # cargo test --workspace
pnpm test             # regenerates fixtures, then runs vitest
pnpm run typecheck
cargo clippy --workspace --all-targets
```

End-to-end checks against a running engine. These drive the real shell code as
a headless client rather than mocking the protocol:

```sh
cargo run -p lwfa-engine &
node --experimental-strip-types scripts/e2e-shell.mjs    # protocol + layout
node --experimental-strip-types scripts/e2e-stream.mjs   # per-surface streaming
```

`LWFA_CAPTURE_DUMP=/some/dir` makes the engine write a PNG per window each
frame, which is how per-surface capture gets checked against what is actually
on screen.

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
