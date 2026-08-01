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
      compositor, gated by a shared token. Reachable over the LAN; **no TLS yet**
- [x] **XWayland** — X11 clients (Steam, Proton, older GTK2/Qt4, non-ozone
      Electron) map into the same strip, stream, and take remote input
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
pnpm --filter @lwfa/shell dev     # http://localhost:6733
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

### Configuration

Settings live in [`configs/defaults.toml`](configs/defaults.toml): ports, the
terminal, Xwayland, encoder limits, render timings, layout defaults, and which
workspace lwfa's own window should take in a host compositor. It is commented,
and it is the place to look before going hunting for a constant.

Precedence, highest first: environment variables, then `.env` (gitignored,
machine-local, holds `AUTH_PASS`), then that file, then built-ins. Loading never
fails: a missing or broken file falls back to defaults with a warning, because a
compositor you cannot start is a compositor you cannot fix from inside. Unknown
keys *are* rejected, so a typo is reported rather than silently ignored.

The shell cannot read the file (it runs in a browser), so
`scripts/gen-config.mjs` generates its layout defaults from the same source.
That runs automatically from `dev`, `build`, `test` and `typecheck`.

Environment:

- `LWFA_CONFIG` — path to a config file, overriding `configs/defaults.toml`
- `LWFA_TERMINAL` — which terminal to spawn (default `alacritty`)
- `LWFA_NO_AUTOSTART` — set to skip opening a terminal on launch
- `LWFA_NO_XWAYLAND` — set to skip starting Xwayland, so X11 clients cannot run
- `LWFA_SHELL_ADDR` — where the engine listens (default `127.0.0.1:6734`;
  use `0.0.0.0:6734` to reach it from other devices)
- `SHELL_PORT` — port for the shell page (default `6733`)
- `AUTH_PASS` — the shared password. Read from `.env` if not in the environment.
  A temporary one is generated if neither is set, which breaks bookmarked URLs
- `LWFA_PROFILE` — log per-window capture timings
- `LWFA_HEARTBEAT` — log redraws and ticks per second, once a second. `0
  redraws` with a healthy tick count is a hidden window behaving correctly; both
  at zero means the event loop has stopped
- `RUST_LOG=debug` — Smithay is chatty at `info`; `warn` is usually the useful level

### Using it from another device

Settings live in `.env`, which is gitignored. Start from the template:

```sh
cp .env.example .env
sed -i "s|^AUTH_PASS=.*|AUTH_PASS=$(openssl rand -hex 16)|" .env
sed -i "s|^LWFA_SHELL_ADDR=.*|LWFA_SHELL_ADDR=0.0.0.0:6734|" .env
chmod 600 .env
```

lwfa uses the **6733+** port block:

| Port | What | Typed by hand? |
|---|---|---|
| 6733 | shell page | **yes**, this is the one you open |
| 6734 | engine protocol | no, the page finds it |

Then run both halves and open the link the engine prints:

```sh
cargo run -p lwfa-engine
pnpm --filter @lwfa/shell dev    # binds 0.0.0.0 on SHELL_PORT
```

```
open the shell at:  http://192.168.1.x:6733/?token=…
```

The address is picked by filtering out virtual interfaces (Docker bridges,
VMware, VPN tunnels, Tailscale, loopback) and preferring a private range. If
the machine has several real interfaces the alternatives are printed too, since
only one of them is the network the tablet is on.

The shell connects to whatever host served the page, so nothing else needs
configuring. Bookmark that URL on the tablet; it keeps working as long as
`AUTH_PASS` stays the same.

Environment variables override `.env`, so a one-off
`LWFA_SHELL_ADDR=127.0.0.1:9843 cargo run -p lwfa-engine` works without
editing the file.

> **Security, plainly.** The shell protocol injects keystrokes and spawns
> processes, so whoever can open the socket controls the session. A shared
> token is required on every connection, which stops casual access.
>
> There is **no encryption**. The token and everything after it cross the
> network in the clear, so anyone who can watch the traffic can read your
> keystrokes and replay the token. That is an acceptable trade on a home
> network you control. It is not acceptable on café wifi, a shared office, or
> anywhere reachable from the internet — tunnel it over SSH or WireGuard until
> TLS exists.
>
> `AUTH_PASS` in `.env` keeps the password stable across restarts. Without it a
> fresh one is generated each run and any bookmarked URL stops working.

Changing `AUTH_PASS` takes effect within a couple of seconds, no restart needed
— which matters, because restarting the compositor kills every window in the
session. Existing connections are left alone; only the next one is affected.

### X11 clients

Xwayland starts with the engine and gets its own display, so `DISPLAY` inside
lwfa is *not* the host's. Clients spawned by the engine inherit the right one
automatically; to launch one by hand, take the display number the engine logs:

```
xwayland ready on DISPLAY=:1
```

```sh
WAYLAND_DISPLAY= DISPLAY=:1 xterm     # forced onto X11
```

Unsetting `WAYLAND_DISPLAY` is what forces a dual-backend program down the X11
path; most will pick Wayland if both are offered, which is what you usually
want. Clearing `DISPLAY` instead is how you force the opposite.

X11 windows land in the strip like any other, with `WM_CLASS` standing in for
the app id. Interactive move and resize are refused, as they are for Wayland,
and so are maximise and fullscreen: the shell owns column width. Override-
redirect windows (menus, tooltips) render on the local display but are not yet
composited into a remote shell, which is the same gap Wayland popups have.

### Giving lwfa a workspace of its own

lwfa's window is a whole desktop, not an app: it runs full-screen and takes the
keyboard, so it should not share a workspace with anything you were using. The
engine reports app id `lwfa`, so a host compositor can rule on it. On Hyprland
(0.53+ syntax):

```
# ~/.config/hypr/monitors.conf — a workspace of its own, kept alive when empty
workspace = 10, monitor:DP-1, persistent:true

# ~/.config/hypr/hyprland.conf
windowrule = workspace 10 silent, match:class ^(lwfa)$
windowrule = fullscreen true, match:class ^(lwfa)$
```

`silent` places the window there *without* switching your view to it, so
starting the engine never interrupts what you are doing. Keep the workspace
number in step with `[host].workspace` in `configs/defaults.toml`, which is
what `scripts/dev-nested.sh` reads.

A window on a workspace you are not looking at gets no frame callbacks from the
host, which the nested backend now handles in two places: the streaming path is
driven from a timer so remote clients keep working, and the on-screen path
refuses to present faster than a display interval, because presenting to a
surface the host has never shown blocks forever and takes the whole compositor
with it. See `[render]` in the config.

`scripts/dev-nested.sh` does the same placement on a host without those rules
installed, and verifies it afterwards.

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
