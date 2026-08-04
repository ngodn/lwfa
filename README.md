<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/svg/mark-on-dark.svg">
    <img src="brand/svg/mark-on-light.svg" alt="The lwfa mark: three columns of the scrollable strip with the spring curve running across them" width="140">
  </picture>
</p>

<h1 align="center">lwfa</h1>

<p align="center"><strong>literally work from anywhere</strong></p>

<p align="center">A Wayland compositor with a browser-native shell. The same desktop runs on the
machine's physical display and in a browser on any other device, and it is
built to be <em>used</em> from that browser: video, audio, keyboard, mouse,
touch, and a controller games treat as real hardware.</p>

---

- **Engine**: Rust, [Smithay](https://smithay.github.io/), running nested in a
  host compositor. Wayland plus XWayland, per-window NVENC encode, PipeWire
  audio capture, a uinput virtual gamepad. Owns mechanism, not policy.
- **Shell**: TypeScript, React 19, [shadcn/ui](https://ui.shadcn.com/) on
  Tailwind v4. Owns layout policy and everything the user touches.
- **Layout**: scrollable tiling, following [niri](https://github.com/niri-wm/niri).
  Columns on an infinite strip, workspaces stacked vertically.
- **Remote**: per-window video streams (H.264 or HEVC, chosen by what every
  connected device can decode) decoded with WebCodecs and composited in the
  DOM, so the browser lays windows out however the viewport demands. Audio is
  Opus on the same socket.

Read [docs/architecture.md](docs/architecture.md) before changing anything
structural. It records the decisions and, more importantly, why.

## Status

Daily-driven in production: a gaming PC in one room, an iPad on the couch,
Steam games under Proton played over wifi with the on-screen controller. The
original seven milestones are done, and the work since has been the things
production surfaces: audio, the virtual controller, adaptive streaming, and
sessions that survive their own network.

What works today:

- [x] Per-window hardware video with WebCodecs decode, zero-copy from the
      GL texture into NVENC when the NVIDIA driver is present
- [x] Adaptive bitrate driven by real socket backpressure, up to 32 Mbit/s,
      with the focused window getting the budget and unwatched windows paused
- [x] Audio: Opus over the wire, per-device opt-in, quality that degrades last
- [x] Remote input: keyboard, mouse, touch (long-press right-click), and an
      on-screen gamepad that is a real `/dev/uinput` controller on the machine
- [x] XWayland, so Steam, Proton and everything X11 runs in the same strip
- [x] Sessions that survive reconnects: a wifi blip costs nothing visible.
      45 seconds of grace, the controller stays in the game's hands,
      fullscreen and audio carry across
- [x] Accounts: named users in SQLite, watch-only or interact, per-app launch
      permissions, enforced in the engine
- [x] Multi-device: one client drives, the rest watch, control is taken
      explicitly
- [x] Installs as a PWA, edge to edge on an iPad, with the brand's icons

Deliberately not done yet: built-in TLS (terminate it at a reverse proxy, see
[Production](#production)), clipboard sync, multi-monitor, DPI awareness, the
layer-shell chrome path for the native output, and a TTY backend. The engine
runs nested inside an existing compositor; it does not own a display outright.

## Requirements

Pinned in `.mise.toml` and `rust-toolchain.toml`:

- Rust 1.95.0 (edition 2024)
- Node 24.15.0, pnpm 11

```sh
mise install
pnpm install
```

Hardware and system expectations, all degrading rather than failing:

- **NVIDIA + NVENC** for hardware video. Without it, frames fall back to JPEG,
  which works but costs bandwidth. Eight concurrent encoder sessions is the
  consumer-card limit; the ninth window degrades to JPEG.
- **PipeWire or PulseAudio**, with `parec` on the path, for audio capture.
  No audio without it, nothing else affected.
- **`/dev/uinput` access** for the virtual controller. Without it the gamepad
  still works in keyboard mode, mapping pads to keys.

## Running

lwfa runs nested inside whatever compositor you are already using, as an
ordinary window. Your session is never at risk.

```sh
pnpm run build                # the shell, once
cargo run -p lwfa-engine      # serves it, and the protocol, on 6733
```

For development you want Vite instead, for hot reload. It takes 6733 and
proxies `/engine` back to the engine, so the engine moves up one:

```sh
scripts/dev-nested.sh                              # sets this up for you
pnpm --filter @lwfa/shell dev                      # http://localhost:6733

# or by hand:
LWFA_SHELL_ADDR=127.0.0.1:6734 cargo run -p lwfa-engine
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
| `Alt+4` | shell | cycle the focused column's width (⅓, ½, ⅔, 90%) |
| `Alt+F` | shell | toggle fullscreen for the focused window |
| `Alt+W` | shell | close the focused window |

Layout follows [niri](https://github.com/niri-wm/niri): windows live in columns
on an infinite strip, a column can hold a vertical stack, and workspaces stack
vertically. The strip runs along the viewport's long axis by default, so it is
a row of columns on a monitor and a stack of rows on a phone held upright.
Workspaces need no protocol support at all, because `SetLayout` is total: the
shell omits the windows on other workspaces and the engine hides whatever it is
not told about.

All of that is layout policy, so the engine forwards those keys to the shell
rather than acting on them. Alt rather than Super, because the host compositor
sees keys first and usually has Super bound.

### Configuration

Settings live in [`configs/defaults.toml`](configs/defaults.toml): ports, the
terminal, Xwayland, encoder limits, render timings, layout defaults, the shared
animation spring, audio capture, the persistent gamepad, and which workspace
lwfa's own window should take in a host compositor. It is commented, and it is
the place to look before going hunting for a constant.

Precedence, highest first: environment variables, then `.env` (gitignored,
machine-local, holds `AUTH_PASS`), then a config file, then built-ins. Loading
never fails: a missing or broken file falls back to defaults with a warning,
because a compositor you cannot start is a compositor you cannot fix from
inside. Unknown keys *are* rejected, so a typo is reported rather than silently
ignored.

The config file is looked for in four places, highest first:

| Where | For |
|---|---|
| `$LWFA_CONFIG` | an explicit answer, and a bad one is reported |
| `~/.config/lwfa/config.toml` | your own settings, and what an installer writes |
| `configs/defaults.toml` above the binary | a development checkout |
| `/etc/lwfa/config.toml` | machine-wide, overridable per user |

`$XDG_CONFIG_HOME` is honoured where set. The engine logs which file it used,
so a setting that appears to be ignored is one line away from an explanation.

Files do **not** merge. The first one found is the config, and every key it
omits falls through to the built-in default rather than to the file below it.
That keeps precedence to one rule instead of two, and it means a minimal
`config.toml` holding only what is specific to your machine is the right thing
to write.

The shell cannot read the file (it runs in a browser), so
`scripts/gen-config.mjs` generates its layout and animation defaults from the
same source. That runs automatically from `dev`, `build`, `test` and
`typecheck`.

Environment:

- `LWFA_CONFIG`: path to a config file, overriding every other location
- `LWFA_TERMINAL`: which terminal to spawn (default `alacritty`, falling back
  to any of foot, kitty, ghostty, wezterm, gnome-terminal, konsole,
  xfce4-terminal or xterm that is actually installed)
- `LWFA_NO_AUTOSTART`: set to skip opening a terminal on launch
- `LWFA_NO_XWAYLAND`: set to skip starting Xwayland, so X11 clients cannot run
- `LWFA_NO_PREVIEW`: set to stop presenting to the nested host window. Do this
  when the window is parked on a hidden workspace and the session is only used
  remotely; presenting to a window the host never shows can block the engine
  (see `[window] preview` in the config for the full story)
- `LWFA_SHELL_ADDR`: where the engine listens, for both the page and the
  protocol (default `127.0.0.1:6733`; use `0.0.0.0:6733` to reach it from
  other devices). During development Vite serves the page on 6733, so the
  engine moves to `127.0.0.1:6734` and Vite proxies `/engine` back to it
- `LWFA_SHELL_DIR`: where the built shell is, when it is not in one of the
  usual places (`packages/shell/dist` above the binary, `share/lwfa/shell`
  beside it, or the system prefixes)
- `SHELL_PORT`: port for Vite's dev server (default `6733`)
- `AUTH_PASS`: the shared password. Read from `.env` if not in the environment.
  A temporary one is generated if neither is set, which breaks bookmarked URLs
- `LWFA_PROFILE`: log per-window capture timings
- `LWFA_HEARTBEAT`: log redraws and ticks per second, once a second. `0
  redraws` with a healthy tick count is a hidden window behaving correctly;
  both at zero means the event loop has stopped
- `RUST_LOG=debug`: Smithay is chatty at `info`; `warn` is usually the useful
  level

### Using it from another device

Settings live in `.env`, which is gitignored. Start from the template:

```sh
cp .env.example .env
sed -i "s|^AUTH_PASS=.*|AUTH_PASS=$(openssl rand -hex 16)|" .env
sed -i "s|^LWFA_SHELL_ADDR=.*|LWFA_SHELL_ADDR=0.0.0.0:6733|" .env
chmod 600 .env
```

lwfa listens on **one port**, 6733. A WebSocket upgrade is the protocol,
everything else is a file from the built shell, so there is one port to open,
one to type, and nothing for the page to find.

During development that port belongs to Vite, which serves the page with hot
reload and proxies `/engine` back to the engine on 6734. The shell always
reaches its socket at the page's own origin, so it behaves identically either
way.

Build the shell once, then run the engine and open the link it prints:

```sh
pnpm run build
cargo run -p lwfa-engine
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

> **Security, plainly.** The shell protocol injects keystrokes and spawns
> processes, so whoever can open the socket controls the session. A shared
> token is required on every connection, which stops casual access.
>
> The engine itself speaks **no TLS**. Over plain HTTP the token and
> everything after it cross the network readable, and the browser refuses
> WebCodecs on an insecure page, so you get the JPEG fallback too. On a home
> network you control that can be an acceptable trade for a quick test. For
> anything more, put a TLS-terminating reverse proxy in front (see
> [Production](#production)) or tunnel over SSH or WireGuard. Never expose the
> raw ports to the internet.

Changing `AUTH_PASS` takes effect within a couple of seconds, no restart
needed, which matters because restarting the compositor kills every window in
the session. Existing connections are left alone; only the next one is
affected.

## Installing

From a release, which is one self-extracting file:

```sh
./lwfa-1.0.0.run                      # unpack and install
./lwfa-1.0.0.run --extract /tmp/lwfa  # or unpack and read it first
```

Or from a checkout:

```sh
pnpm run build && pnpm run engine:release
./install.sh
```

> **Which machines the `.run` works on.** It bundles FFmpeg and its
> dependencies, so those need not be installed. What it cannot bundle is
> glibc: every bundled library still requires symbols from the glibc it was
> built against. A release built on Arch therefore runs on Arch and other
> rolling distributions, and **not** on Debian stable or Ubuntu LTS, where it
> fails at exec with a message about `libm`. Build from source there.
>
> The graphics stack deliberately comes from your machine, not the bundle: a
> bundled libEGL or libdrm cannot talk to your kernel modules. `scripts/package.sh`
> records exactly which libraries are excluded and why.

It looks first and writes second: distribution, host compositor, GPU,
Xwayland, audio, terminal, `/dev/uinput`, and any controller already plugged
in. Then it shows what it is about to write and asks.

What it writes is small: `~/.config/lwfa/config.toml` holding only what is
specific to this machine, `~/.config/lwfa/env` at mode 600 holding a generated
password, a systemd **user** service, and one udev rule under `/etc` for the
virtual controller. Nothing else is touched.

Packages are never installed behind your back. When something is missing it
says so, prints the exact command for the distribution it found, and asks.

`--yes` takes every default. `--uninstall` undoes it, and asks separately
before removing the accounts database, since that is the one thing here you
cannot regenerate.

A user service rather than a system one, deliberately: a system unit has no
`XDG_RUNTIME_DIR`, starts before any session exists, and cannot express "after
this user's compositor came up", because the system manager has no
`graphical-session.target`.

## Production

The dev servers work, but the production pieces are built and committed:

```sh
pnpm run build             # the shell, built to packages/shell/dist
pnpm run engine:release    # the engine, optimised (fat LTO)
./target/release/lwfa-engine   # serves both, on one port
```

### TLS

Not optional beyond the machine itself. `VideoDecoder` and `AudioWorklet` are
secure-context APIs, so a plain-HTTP page silently loses hardware decode and
the low-latency audio path. That shows up as "it works but looks worse than
the README promised", which is a confusing way to find out you needed a
certificate.

Locally you need nothing: `localhost` is already a secure context.

For everything else, three options, cheapest first.

**Tailscale, if you have it.** One command, and it is the only option with
nothing to install on the tablet:

```sh
tailscale serve 6733
```

Tailscale gets a real Let's Encrypt certificate for the machine's `*.ts.net`
name through a DNS-01 challenge it completes itself. Every device already
trusts that chain, so there is no CA to distribute, no profile to install and
no trust setting to find. It works away from home as a side effect.

**A container, if you would rather not install a proxy.** Everything lives in
[`deploy/docker/`](deploy/docker/) and `docker compose down` removes all of
it:

```sh
cd deploy/docker
./make-cert.sh 192.168.1.51      # your machine's LAN address
docker compose up -d
```

Host networking, because nginx has to reach the engine on the host's own
loopback and because bridged networking puts NAT in front of every video
frame. The certificate is self-signed, so each device has to be told to trust
it once, and the container serves the public half over plain HTTP on 8880 for
exactly that (a device cannot fetch a certificate over the HTTPS that
certificate is for). On iOS that is two steps, and the second is the one
people miss: install the profile, **then** enable it under Settings > General
> About > Certificate Trust Settings.

**Your own proxy.** [`deploy/`](deploy/) has a template for
[Traefik](deploy/traefik-lwfa.yml) and one for [nginx](deploy/nginx-lwfa.conf).
One hostname, one backend: the engine splits page from socket by request, so
there is nothing for the proxy to route. Both carry placeholder values,
`lwfa.example.com` and a TEST-NET-1 address, so an unedited copy fails visibly
instead of routing somewhere real. Fill one in and keep it in `deploy/local/`,
which is gitignored.

None of the three enables HTTP/2, deliberately. Safari on iPadOS 26.x sends
CONNECT instead of GET for a WebSocket upgrade over h2, so the socket fails on
the device this project is for.

HTTPS is not only transport security here. WebCodecs requires a secure
context, so the proxy is also what turns the stream from JPEG into hardware
H.264/HEVC.

On the tablet, open the HTTPS address and add it to the home screen. The shell
ships the manifest and icons from [brand/](brand/), draws edge to edge under
the iPad's home indicator, and behaves as an installed app. iOS never says
goodbye when an app is swiped away, so the engine pings idle sockets and reaps
the ones that stop answering; a discarded client cannot hold windows or the
microphone.

### Giving lwfa a workspace of its own

lwfa's window is a whole desktop, not an app: it runs full-screen and takes
the keyboard, so it should not share a workspace with anything you were using.
The engine reports app id `lwfa`, so a host compositor can rule on it. On
Hyprland (0.53+ syntax):

```
# ~/.config/hypr/monitors.conf: a workspace of its own, kept alive when empty
workspace = 10, monitor:DP-1, persistent:true

# ~/.config/hypr/hyprland.conf
windowrule = workspace 10 silent, match:class ^(lwfa)$
windowrule = fullscreen true, match:class ^(lwfa)$
```

`silent` places the window there *without* switching your view to it, so
starting the engine never interrupts what you are doing. Keep the workspace
number in step with `[host].workspace` in `configs/defaults.toml`, which is
what `scripts/dev-nested.sh` reads.

A window on a workspace you are not looking at gets no frame callbacks from
the host. The streaming path is driven from a timer so remote clients keep
working regardless, and for a session that is only ever used remotely, set
`[window] preview = false` (or `LWFA_NO_PREVIEW=1`) so the engine never
touches the host's swapchain at all.

`scripts/dev-nested.sh` does the same placement on a host without those rules
installed, and verifies it afterwards.

## Streaming

Every window is its own video stream, encoded on NVENC and decoded with
WebCodecs, so the browser composites real DOM elements rather than a screen
rectangle. The codec is negotiated: HEVC where every connected device decodes
it, H.264 otherwise, JPEG as the last resort.

When the driver allows it, pixels never leave the GPU: the rendered window
texture is handed to CUDA through GL interop and NVENC reads it in place, so
nothing but the compressed bitstream ever reaches system RAM. On any failure
the engine falls back to read-back capture by itself; `[stream] gpu_direct`
exists to force the fallback for debugging.

Bitrate adapts to the network it is actually on. A frame stays on a client's
account until the kernel accepts it, so backpressure is the network's own
voice rather than a guess: a fresh connection climbs to the 32 Mbit/s ceiling
in about six seconds on a clean LAN, and a congested one backs off without
buffering seconds of stale video inside the socket. The focused window gets
the budget; inactive windows pause by default, frozen on their last frame, and
resume the moment they are focused. A paused window's application is told to
stop rendering too, so a window nobody watches costs approximately nothing.

## The shell

The browser side is React 19 with [shadcn/ui](https://ui.shadcn.com/) on
Tailwind v4. Fonts are self-hosted: the machine is often not on the internet,
and a shell that waits on a font CDN before painting is a shell that never
paints.

### The navigation rail

One strip of buttons along an edge you choose, in **two clusters**. The ones
you reach for while working (windows, keyboard, gamepad) are anchored to the
far end where a thumb rests; the ones you touch once a week sit at the near
end, out of accidental reach, with the slack between them. That is a
reachability decision, not decoration, and it survives every edge and every
size.

The rail **measures itself** rather than trusting breakpoints, because "do
nine buttons fit" is a different question along the bottom of a phone than
down its side. When they stop fitting they merge rather than disappear:
keyboard and gamepad into **Input**, the management panels into **More**.
Nothing becomes unreachable, only differently routed.

Edge, order, visibility, which end each button is anchored to, and button size
are all in Settings, stored per device. They are per device on purpose: a
phone wants the bar where a thumb is, the same person on a 27" display wants
it down the side, and syncing them would make one device's ergonomics fight
the other's.

### Input

The keyboard and gamepad are **input devices, not settings screens**, so they
dock across the bottom rather than opening in a side panel. The keyboard takes
space from the desktop, because typing while the keyboard covers the line you
are editing is the failure it exists to prevent. The gamepad floats over the
game at reduced opacity: a game wants every pixel, and its interesting parts
are not under your thumbs.

- **Keyboard**: Escape and the function row are always on screen; the
  full-size tail (Insert, Home, Page Up…) is behind a toggle. Modifiers latch
  for one keypress in normal mode and stay held in **combo** mode, so one
  finger can build Ctrl+Alt+F2. Keys are sent as evdev keycodes, so the remote
  machine's own keymap decides what they mean.
- **Gamepad**: the [W3C standard mapping](https://w3c.github.io/gamepad/#remapping),
  and in controller mode it is not an on-screen abstraction: presses land on a
  virtual controller the engine creates through `/dev/uinput`, which Steam and
  games enumerate exactly like a plugged-in pad. Analog sticks carry real axis
  values with a 5% dead zone, coalesced to one send per animation frame so a
  moving thumb never floods the socket the video shares. Keyboard mode remains
  for emulators and older titles, quantising sticks to eight directions. Edit
  mode rearranges and resizes pads on a dot grid, "Copy layout" puts the
  arrangement on the clipboard as JSON, and skins (PlayStation, Xbox, neutral)
  change labels only.

### Audio

Off until a device asks: audio is a per-device switch in the shell, and the
engine captures nothing until someone flips it. What gets captured is the
default sink's monitor (whatever you would hear at the machine), or a source
you name in `[audio]`; the config shows the null-sink recipe for routing only
chosen programs. On the wire it is Opus, with its own send accounting so fifty
audio chunks a second can never crowd video out. Quality is Auto by default,
following the same budget as the video with sound degrading last, or pinned to
High, Medium or Low per device.

### Launcher and windows

**Apps** reads the machine's freedesktop desktop entries, the same list every
other Linux launcher shows. Icons are resolved through the icon theme chain on
the machine and cached in IndexedDB on the device, so a returning client
requests nothing; icons that resolve to nothing are cached as tombstones so
the shell does not ask again forever. Which apps an account may launch is
enforced by the engine, per account.

**Windows** has workspaces, per-window actions, pause and resume per stream,
and **arrange mode**, which edits the desktop on the desktop: drag a window
along the strip, drop it where it should go, leave. Moves animate on the
shared spring, so the same gesture looks the same from the physical display
and from a browser.

Touch also carries a right click: a long press held still for half a second,
measured in the shell because iOS Safari stopped firing `contextmenu` on long
press at iOS 13, and iPads are the point of this project.

### Sessions that survive their own network

A tablet on wifi disconnects; that is not an error, it is the medium. The
shell reconnects by itself, and the engine treats the gap as weather rather
than departure:

- The last client leaving starts a **45-second grace** in which the world
  holds: layout stays, windows stay awake, audio keeps flowing, and the
  virtual controller is parked rather than unplugged, so the game never sees
  the device leave.
- A returning client adopts the parked controller, keeps its fullscreen
  window fullscreen, and re-announces its gamepad on its own; nothing needs
  toggling by hand.
- Silent clients are found honestly: ten seconds of inbound silence earns a
  ping, fifteen more unanswered means the client is gone and it is reaped
  through the same path as a clean disconnect. Browsers answer pings below
  JavaScript, so a live page always passes, however idle.
- When several devices are connected, one **drives** and the rest **watch**;
  control is taken explicitly, not stolen by whoever last touched the screen.

## Playing games

Steam is X11, so everything under Proton is X11; Xwayland starts with the
engine and those windows land in the strip like any other. Three details make
the on-screen controller reliable in practice:

- `[gamepad] persistent = true` creates the virtual controller at engine
  startup and never destroys it. Proton runs games in a container where
  controller hotplug is unreliable; a pad that exists before the game launches
  is found like real hardware, because that is what real hardware does.
- Wine decides whether a game is foreground from X input focus, and SDL games
  deliberately drop controller input in the background. The engine re-asserts
  focus after layout changes and runs a once-a-second guardian that repairs X
  focus if it points at nothing, so a fullscreen toggle cannot leave the pad
  unheard.
- Disable **Steam Input** for the game (Properties → Controller), while the
  game is closed. Steam otherwise grabs the pad and re-emits its own, with
  forwarding gated on its idea of the foreground window.

### X11 clients by hand

Xwayland gets its own display, so `DISPLAY` inside lwfa is *not* the host's.
Clients spawned by the engine inherit the right one automatically; to launch
one by hand, take the display number the engine logs:

```
xwayland ready on DISPLAY=:1
```

```sh
WAYLAND_DISPLAY= DISPLAY=:1 xterm     # forced onto X11
```

Unsetting `WAYLAND_DISPLAY` is what forces a dual-backend program down the X11
path; clearing `DISPLAY` instead forces the opposite. X11 windows use
`WM_CLASS` as the app id. Interactive move, resize, maximise and fullscreen
grabs are refused on both backends for the same reason: the shell owns layout.
Override-redirect windows (menus, tooltips) render locally but are not yet
composited into a remote shell, the same gap Wayland popups have.

## Accounts

The engine has one shared password (`AUTH_PASS`) and named users as well.
Everyone who knows the shared password can do everything; handing somebody a
link so they can *watch* should not also let them run commands.

Accounts live in SQLite on the machine they authenticate for, at
`$XDG_STATE_HOME/lwfa/accounts.db`. There is no control plane to enrol with
and nothing to be offline from. Passwords are Argon2id with a per-user salt.

Each account has a **mode** (watch only, or interact) and a list of
applications it may launch. `AUTH_PASS` means **the owner**: the bootstrap
credential, the only identity that may administer accounts, and the way back
in if the last named account locks itself out. Manage them in the Access
panel.

Enforcement is in the engine, at the single point every shell message passes
through. The shell greys out what it cannot use, which is a courtesy rather
than a control: anyone can open a socket and send whatever they like.

Saved **connections** are the opposite and live in the browser. Which machines
*you* care about is a property of the device in your hand, and storing that on
a machine would mean that machine being switched off loses you the list of the
others.

## Tests

Use `test:all` and check its **exit code**. Grepping the output for `FAILED`
is not enough: a Rust *compile* error never prints that word, so a broken
build reads as green. That has already happened once, when a field was added
to `Hello` and `crates/lwfa-proto/tests/from_ts.rs` was not updated.

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
pnpm run e2e:audio                                       # audio capture + opus
```

`LWFA_CAPTURE_DUMP=/some/dir` makes the engine write a PNG per window each
frame, which is how per-surface capture gets checked against what is actually
on screen.

The protocol fixtures round-trip in both directions, and each half regenerates
the other's input: `cargo run -p lwfa-proto --bin gen-proto-fixtures` writes
`fixtures/proto`, and `pnpm test` writes `fixtures/proto-from-ts` from it.
After changing a protocol message, run **both**, in that order, or the Rust
side compares against a stale TypeScript round trip and fails confusingly.

`pnpm test` regenerates `fixtures/rust.*.tsv` from the Rust implementation
before running. Those files are gitignored on purpose: a committed copy would
let the Rust side drift while the test kept passing against a stale snapshot.

### About the parity test

`packages/spring` and `crates/lwfa-spring` are two implementations of the same
spring solver, and `packages/spring/test/parity.test.ts` checks that they
agree with each other and with upstream `motion-dom` to 1e-9.

This is not redundancy for its own sake. The engine integrates window
animations natively for the local display, the browser integrates them for
remote displays, and the same animation has to look identical on both. The
spring itself is one set of constants in `[animation]`, shared by both halves.
Section 5 of the architecture doc explains the contract.

**When you change one implementation, change the other.** The test will tell
you if you forgot.

## Brand

The mark, wordmark lockups, favicons and PWA icons live in [brand/](brand/),
with usage rules in [brand/README.md](brand/README.md). The shell references
them directly; if you fork this, that is the one directory to replace.

## License

MIT. See [LICENSE](LICENSE).

One thing to keep in mind while working: [niri](https://github.com/niri-wm/niri)
is GPL-3.0, and lwfa follows its layout model (architecture doc, section 2.3).
Reading niri as a reference is fine and encouraged. **Porting its code is not**,
because that would force lwfa to GPL-3.0. If that ever looks worth doing, it is
a deliberate relicensing decision to make first, not a consequence to discover
afterwards.
