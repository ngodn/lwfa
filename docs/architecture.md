# lwfa architecture

**lwfa** = literally work from anywhere.

A Wayland compositor whose shell is written in web technologies, so the same
desktop is usable on the machine's physical display and from a browser on any
other device, with layout that responds to the viewport it's being viewed on.

This document records decisions and the reasoning behind them. It is meant to be
read before changing anything structural.

---

## 1. Terms

| Term | Meaning here |
|---|---|
| **Wayland** | A *protocol*, not a program. There is no "Wayland" to install. |
| **Compositor** | Under Wayland, the compositor *is* the display server *and* the window manager, one process. It talks to DRM/KMS and libinput directly. |
| **Shell** | The UI layer: panels, launcher, window chrome, overview, animations. GNOME Shell is the precedent, written in JS/CSS on top of the Mutter compositor. |
| **Engine** | lwfa's Rust process. Compositor plus per-surface encode plus the local render path. |
| **Backend** | The thing that realises what the shell describes. Two exist: local (native GPU) and remote (browser DOM). |

## 2. The two decisions everything follows from

### 2.1 Per-surface streaming, not whole-screen streaming

Every window is encoded and transported as its **own** stream. The remote
browser puts each one in its own DOM node and composites them itself.

Rejected alternative: encode the whole desktop as one video (what Selkies,
wayvnc and every conventional remote desktop do). That is far easier, but the
browser receives a single rectangle and has no idea where windows are, so
responsive layout is impossible. An iPad would get a shrunken desktop.

Consequences we accept:
- N windows means N encoder sessions. On the dev machine's RTX 3060 the cap is
  **8 concurrent NVENC sessions** (NVIDIA raised the consumer limit 3 → 5 in
  March 2023, then 5 → 8 in early 2024). Past 8 live windows, small ones get
  batched into a shared atlas stream.
- Damage tracking is load-bearing, not an optimisation. Most windows are static
  most of the time, so idle windows must cost approximately nothing.

### 2.2 Native local fast path from day one

The local display is composited natively by the engine via DRM/KMS. The shell
draws chrome into a transparent `wlr-layer-shell` overlay. The remote path is
the browser.

Rejected alternative: route the local display through the same encode/decode
loop over loopback. One code path, ~15-25ms added latency, much less work.
Rejected because lwfa is meant to be the daily driver on this machine, and
input lag on the primary display would make it unusable in practice.

Consequence we accept: **two renderers for the same shell.** That is the central
risk of this design, and section 3 is entirely about containing it.

### 2.3 Scrollable tiling, not dynamic tiling

The layout model follows **[niri](https://github.com/niri-wm/niri)** (itself
following GNOME's PaperWM): windows live in columns on an infinite horizontal
strip, workspaces are stacked vertically, and each monitor has its own strip.

Rejected alternative: Hyprland/i3-style dynamic tiling, where a workspace is
subdivided among all its windows.

Four reasons, in order of how much they matter to lwfa:

1. **"Opening a new window never causes existing windows to resize"** (niri's
   stated principle). Every resize is an `xdg_shell configure`, and native apps
   handle those badly because they do not reflow (see section 6). Dynamic tiling
   reflows the whole layout on every open, close and move. Scrollable tiling
   makes resize a rare, explicit user action. For a compositor whose apps cannot
   be responsive, a layout model that mostly does not resize them is the right
   fit.
2. **One layout algorithm across every viewport.** A strip is a viewport onto a
   1D sequence: four columns on a 27" monitor, two on an iPad, one on a phone.
   Same algorithm, different viewport width, not a desktop mode plus a separate
   mobile mode. Dynamic tiling has no coherent phone form.
3. **It bounds the encoder budget.** Under dynamic tiling every window on a
   workspace is visible at once, so window count drives encoder count and the
   8-session NVENC cap (section 2.1) is hit at nine open windows. On a strip,
   only columns intersecting the viewport are visible and everything scrolled
   off needs no encoding at all. The budget is bounded by **viewport width
   rather than by how many apps are open**.
4. **It reduces navigation to two orthogonal 1D gestures.** Horizontal swipe
   moves along the strip, vertical swipe switches workspaces. Both are a scroll
   offset, both are continuous and interruptible, and a swipe released mid-flick
   settles to the nearest column carrying the flick's momentum. That is exactly
   the `velocity` parameter of the spring in section 5, which is why the two
   integrators have to agree: the settle has to look the same whether the engine
   or the browser is running it.

Caveats:

- **niri has no touchscreen gestures yet.** It has touchpad gestures (3-finger
  horizontal scrolls columns, 3-finger vertical switches workspaces) and its
  docs state touchscreen gestures are not implemented. So lwfa inherits the
  layout *model*, not touch behaviour. The gesture layer is ours regardless.
- **niri is GPL-3.0.** Smithay is MIT, so building on Smithay keeps lwfa's
  license open. Reading niri for reference is fine and encouraged; porting its
  code would make lwfa GPL-3.0. Decision deferred, but it must be made
  *before* any code is copied, not after.
- The repo moved from `YaLTeR/niri` to `niri-wm/niri`. Many links in the wild
  still point at the old org.

## 3. Containing the two-renderer risk

If the remote path styles windows with CSS while the local path uses shaders,
they diverge. Different easing, different corner antialiasing, different blur
semantics. Within weeks you'd have a desktop that looks subtly wrong depending
on where you're sitting.

Two rules prevent that.

### 3.1 The shell never touches window pixels

The shell does not style windows. It emits **declarative state** over the shell
protocol, and each backend implements the same small vocabulary:

```jsonc
{ "id": 7,
  "rect": { "x": 120, "y": 80, "w": 1280, "h": 800 },
  "z": 3,
  "radius": 12,
  "opacity": 0.96,
  "blurBehind": 8,
  "shadow": { "dy": 6, "blur": 24, "alpha": 0.35 },
  "transform": { "scale": 0.98, "rotate": 0 } }
```

- **Local backend**: a wgpu shader applies this when compositing the surface.
- **Remote backend**: CSS applies this to the `<canvas>` node.

The vocabulary stays deliberately small. Every property costs two
implementations, which is a healthy tax that keeps the design honest.

### 3.2 Animation intents, not animation frames

The shell does not push a new rect every frame. It sends the target and the
spring parameters:

```jsonc
{ "id": 7,
  "animate": { "to": { "rect": { "x": 0, "y": 0, "w": 1920, "h": 1080 } },
               "spring": { "stiffness": 220, "damping": 26, "mass": 1 } } }
```

Each backend integrates the spring **itself**, at its own refresh rate. So
animations stay locally smooth regardless of network conditions, and a dropped
WebSocket mid-animation still lands cleanly instead of freezing halfway.

This only works if the two integrators agree. See section 5.

### 3.3 Layout is a pure function

Layout must not depend on DOM measurement. If it did, the shell could not
compute a layout without a browser, which breaks "one shell, two backends" and
forces a reflow round-trip before every frame.

This is why text measurement uses **[PreTeXt.js](https://pretextjs.dev/)**
rather than `getBoundingClientRect`. Pretext computes line breaks and heights
arithmetically, with a one-time Canvas glyph-measurement step in `prepare()` and
zero DOM access in `layout()`. That makes the shell's layout pure, so it is
runnable in a worker, testable headlessly, and identical across both backends by
construction.

It matters most where it'll be felt: window titles in the taskbar and overview,
re-measured every frame during a pinch gesture, on an iPad already busy decoding
video streams.

## 4. Layers

| Layer | Language | Owns |
|---|---|---|
| Engine | Rust, Smithay, wgpu | Wayland protocol, DRM/KMS, libinput, per-surface encode, local compositing, spring integration |
| Shell protocol | WebSocket | Window state, appearance vocabulary, animation intents, input events |
| Shell | TypeScript, React 19, shadcn/ui, Motion, PreTeXt | Layout policy, chrome, gesture arbitration, responsive breakpoints |
| Remote backend | TypeScript, WebCodecs | Per-surface decode, appearance vocabulary via CSS, spring integration |

The shell does not know which backend it is talking to. That is the point.

**Smithay** is the compositor library: it covers core Wayland plus the official,
wlroots and KDE protocol extensions, and it is proven at scale by `cosmic-comp`
(System76's COSMIC) and `niri`.

**Motion** (formerly Framer Motion, package `motion`, imported from
`motion/react`) animates shell chrome. Note: `react-motion` is a different,
long-dead library.

**shadcn/ui** on Tailwind v4 for the chrome. Not a component library in the
usual sense: the components are copied into `packages/shell/src/components/ui`
and owned here, which matters because two of them needed patching for this
repo's `exactOptionalPropertyTypes`. Fonts are self-hosted rather than from a
CDN; the machine is frequently not on the internet, and a shell that waits on a
font before painting is a shell that never paints.

### 4.1 Rendering, and why the shell is split the way it is

A remote desktop is an unusual React application: part of the tree updates many
times a second forever, and the rest updates when somebody taps a button. Left
alone, the two contaminate each other, so the split is structural rather than a
matter of adding `memo` later.

- **Decoded frames are not React state.** They live in a per-window external
  store (`lib/frames.ts`) that each surface subscribes to by id. A frame for one
  window wakes exactly one component. Held in a `Map` in a parent's state, every
  frame from every window would re-render the whole tree including the
  navigation.
- **Preferences are an external store too** (`lib/prefs.ts`), for the same
  reason: they are read almost everywhere and change almost never, and a context
  would walk every consumer on each change.
- **The desktop is passed to the chrome as `children`**, so opening a panel
  cannot re-render a window surface.
- **Session state and session actions are separate contexts.** Actions never
  change; state changes constantly. A component that only calls something should
  not re-render because something else *is* something.

`ImageBitmap`s hold GPU memory and are not collected promptly, so every one that
is replaced or dropped is closed explicitly. Forgetting that is a leak that only
shows up after an hour.

### 4.2 The navigation rail

The rail is two clusters with the slack between them: controls used constantly
while working are anchored to the far end where a thumb rests, and controls
touched once a week sit at the near end out of accidental reach. That is a
reachability decision and it survives every edge, every size and every collapse
tier.

It **measures itself** rather than trusting breakpoints, because "do nine
buttons fit" is a different question along the bottom of a phone than down its
side. When they stop fitting, buttons merge into grouped ones rather than
scrolling or disappearing: nothing becomes unreachable, only differently routed.

Edge, order, visibility, anchoring and size are stored **per device**, not per
account. A phone wants the bar where a thumb is; the same person on a 27"
display wants it down the side. Syncing them would make one device's ergonomics
fight the other's.

### 4.3 Input surfaces are devices, not panels

The on-screen keyboard and gamepad dock across the bottom, full width, rather
than opening in the side panel. This was got wrong first and is worth recording:
a keyboard in a 26rem side sheet has nowhere to lay out sixty keys and hides the
window you are typing into. A two-thumb reach only works along the bottom.

The keyboard **takes space** from the desktop, because typing while the keyboard
covers the line being edited is the failure it exists to prevent. The gamepad
**floats** over it: a game wants every pixel and its interesting parts are not
under your thumbs.

Both send evdev keycodes, never characters. The remote machine holds the xkb
keymap and does the translation, exactly as it does for a physical keyboard;
deciding here what layout the far end has would break for anyone whose remote
machine is not configured like their tablet.

## 5. The spring parity contract

Implemented, this is milestone 1. See `crates/lwfa-spring` and
`packages/spring`.

Both integrators are line-by-line ports of Motion's solver (`motion-dom`
12.43.0, `dist/es/animation/generators/spring.mjs`), which is a closed-form
damped harmonic oscillator with three branches (underdamped, critically damped,
overdamped).

Closed form rather than numeric integration is deliberate: it is exact and
frame-rate independent, so a backend that drops frames lands on the same curve
as one that does not, and the two languages agree to floating-point precision
instead of merely being close.

Motion is the reference because the shell already animates chrome with it.
Matching it means a window animation and a panel animation given the same
parameters land on the same curve.

`packages/spring/test/parity.test.ts` checks three parties agree at **1e-9
relative**:
1. the Rust implementation, via generated fixtures
2. the TypeScript implementation
3. upstream `motion-dom`, pinned exactly

Both directions are verified to actually fail on drift (checked by deliberately
perturbing each side by 1 part in 10 million).

**If this test fails after a `motion-dom` bump, that is the test working.** Read
the upstream diff, port the change to both implementations, regenerate fixtures,
re-pin.

Notes:
- Motion's docs state `stiffness` defaults to 1. The shipped source says 100.
  The source wins; both ports use 100.
- `findSpring` (the Newton-iteration resolver for the `duration` + `bounce`
  form) is **not** ported. `from_visual_duration` / `fromVisualDuration` covers
  the ergonomic case with an exact closed form. Its derivative also looks
  suspect upstream (`calcAngularFreq(undampedFreq², dampingRatio)` where a
  non-squared frequency is expected), which is another reason to leave it alone
  for now.
- Rest thresholds are **absolute, not relative** to the distance travelled, and
  tighten below a delta of 5 (opacity and scale get 0.005/0.01 instead of
  0.5/2). So settle time depends on how far a window moves.

## 6. Known limits, decided rather than discovered

Some of these have since been resolved; where that happened the entry says so
rather than being deleted, because the reasoning is still the reason the thing
is shaped the way it is.

**Responsive windows have a hard ceiling.** `xdg_shell`'s `configure` lets the
compositor tell a window "you are now 400x800" and the app complies, but native
apps do not reflow. There is no CSS breakpoint inside GIMP.

So: **the shell is responsive, the apps are not.** Mitigations are all
shell-level, and the scrollable-tiling choice (section 2.3) is the main one:
columns keep their size, so the common case never issues a `configure` at all.
On a phone the strip narrows to one visible column, which is the mobile pattern
already. For windows whose minimum size exceeds the viewport, render at column
width and let the user pinch-zoom and pan inside the window. Designed for from
day one rather than discovered in month four.

**iOS Safari is the gating platform.** Full WebCodecs shipped in **Safari 26.0**
on iOS/iPadOS; `VideoDecoder` specifically has existed in partial form since
16.4. Below 16.4 needs an MSE or WebRTC fallback. Budget for Safari-specific
work: background tab throttling, fullscreen behaviour, PWA lifecycle.

In practice the binding constraint has not been Safari's version but the secure
context requirement: WebCodecs is unavailable over plain HTTP at any version, so
`SetStreams` carries an `h264` flag and the engine falls back to JPEG per client
rather than assuming what the browser can decode. Every localhost test passed
and every LAN test showed blank windows until that was found.

**Touch is clean at the protocol level, messy at the UX level.** `wl_touch`
exists, with `frame` to batch multi-touch updates and `cancel` for when the
compositor claims a gesture. Delivering touch is easy. The hard part is that
Linux apps have never seen a touch event and have 16px hit targets. The gesture
arbitration layer (what stays a shell gesture and what becomes a synthetic
pointer event, scroll-to-wheel, long-press-to-right-click) is probably the most
product-defining code in the project, and is still to be built.

The on-screen keyboard turned out **not** to need
`zwp_virtual_keyboard_manager_v1` or `input-method-unstable-v2`, which is what
this section originally expected. Those protocols exist so an unprivileged
client can inject text; the engine *is* the compositor, so it already owns the
seat. The keyboard sends evdev keycodes over the shell protocol and the engine
feeds them to the seat exactly as it does the physical keyboard, which means
xkb, modifiers and repeat all behave without a second implementation. Those
protocols become relevant only when something other than lwfa's own shell wants
to type.

**Latency budget.** Capture → encode → network → decode → present, each stage
3-15ms. Under 50ms feels responsive, under 30ms feels good, under 16ms is
game-streaming territory and not worth chasing for v1. Mobile networks will miss
all of these, so quality/latency adaptation is needed early.

**Security.** This is a remote desktop with full input injection.

Authentication and authorisation now exist (section 10). **TLS still does not.**
The password and every keystroke after it cross the network in the clear, so the
socket is only safe on a network you control; anywhere else needs an SSH or
WireGuard tunnel until TLS lands.

The lack of TLS has a second cost that is easy to miss: WebCodecs requires a
secure context, so a shell served over plain HTTP has no `VideoDecoder` and
falls back to JPEG. Encryption and hardware decoding arrive together.

## 7. Development environment

**No VM.** The dev machine has a single NVIDIA RTX 3060 with no iGPU, so VFIO
passthrough is impossible, and a VM would fall back to `virtio-gpu`: no hardware
encoder (making per-surface streaming benchmarks meaningless) and a different
DRM driver (making the native local path untestable). Touch in a VM is virtual
devices, which tests nothing.

Instead:
- **Nested backend** for ~90% of work. Smithay supports winit and X11 backends
  that run the compositor as a window inside the existing Hyprland session.
  Sub-second iteration, debugger attaches normally, no session risk. Smithay's
  docs prefer the X11 backend over winit where available.
- **A spare TTY** (Ctrl+Alt+F2) for the real DRM/KMS path, with Hyprland still
  alive on TTY1. Better than a VM because it is the real driver.
- **`sshd` enabled** before the first TTY session, so a wedged compositor can be
  killed from a phone instead of hard-rebooting. Plus a heartbeat watchdog.
- **A second physical device** for the remote path. Real Safari, real network.
- **`tc netem`** for simulating mobile latency, jitter and loss.

A VM earns its place later, at packaging: proving lwfa runs on a clean install
without this machine's config, greetd session integration, and a generic
non-NVIDIA smoke test.

### 7.1 The nested backend must survive not being looked at

This is the single hardest bug the project has had, and the fix is
counter-intuitive enough to be worth writing down before somebody reintroduces
it.

A nested compositor redraws when the host hands it a frame callback, and a host
stops doing that the moment its window is not visible. For an ordinary nested
compositor that is correct. It is wrong for lwfa, whose entire premise is that
the session stays usable from a tablet while nobody is looking at the host
screen. Two separate faults followed:

1. **Streaming stopped.** Titles, geometry and layout kept working, because
   those are protocol traffic and owe nothing to rendering, so the shell looked
   perfectly alive and rendered "waiting for pixels" for every window. The fix
   is a timer that drives the capture path when the on-screen loop has been
   quiet, and that also sends frame callbacks: without those the clients would
   not merely stop streaming, they would stop *running*.

2. **The whole compositor hung.** Asking for the next frame at the end of the
   current one is the obvious way to keep a render loop going, and it wedges
   the process the first time the window is never shown. Traced: exactly two
   redraws happen, 0.24ms apart. The first presents; the second's `submit()`
   never returns, because the host has not released the first buffer and will
   not release it for a surface it has never displayed. That blocks the *event
   loop thread*, so nothing is dispatched at all: no shell events, no protocol
   traffic, no reply to the host's ping. The host reports "application not
   responding" and every remote client dies with it.

   The discriminator is timing. A host drives a nested compositor through frame
   callbacks, so a genuine request cannot arrive sooner than one display
   interval: 16ms at 60Hz, 5.5ms at 180Hz. Anything faster came from a burst of
   configures as a window rule placed or full-screened us, and presenting on it
   is what hangs. `[render].min_present_ms` refuses to present twice within
   4ms, which is below any real display's interval.

`LWFA_HEARTBEAT=1` logs redraws and ticks per second, because both hangs looked
identical from outside: a live process with an unresponsive window, and no way
to tell a spinning loop from an idle one from a blocked syscall.

## 8. Configuration

`configs/defaults.toml`. Settings that were spread across six modules as `const`
declarations, in one commented place: ports, terminal, Xwayland, encoder limits,
render timings, layout defaults, and which workspace lwfa's own window should
take in a host compositor.

Precedence, highest first: environment variables, `.env` (gitignored,
machine-local, holds `AUTH_PASS`), that file, built-in defaults.

**Loading never fails.** A missing, partial or syntactically broken file falls
back to defaults with a warning, because a compositor that refuses to start over
a config typo is one you cannot fix from inside. Unknown keys *are* rejected:
silently ignoring a typo is the failure mode that wastes an afternoon.

Constants that are facts rather than choices stay in code: the xkb keycode
offset, the protocol version, the frame header layout. Making those configurable
would invite someone to set them wrong.

The shell cannot read the file, so `scripts/gen-config.mjs` generates its layout
defaults from the same source. That generated module is gitignored for the same
reason as the spring fixtures: a committed copy lets the TOML drift while
everything keeps building against a stale snapshot.

## 9. Build order

1. **Spring parity harness.** ✅ Done. Small, and it de-risks the thing most
   likely to silently go wrong later.
2. **Smithay compositor** on the nested backend, able to open a terminal.
   ✅ Done. `crates/lwfa-engine`. Scrollable strip driven by keybinds, with the
   scroll offset animated by `lwfa-spring`, so milestone 1 is load-bearing
   rather than decorative. No shell protocol yet.

   Two things it deliberately does *not* have: interactive move and resize
   grabs. Under scrollable tiling windows do not float, so `move_request` and
   `resize_request` are no-ops. That removes most of what a floating
   compositor's xdg-shell code does.
3. **Shell protocol v0.** ✅ Done. `crates/lwfa-proto`, `packages/proto`,
   `packages/shell`, and the WebSocket link in `crates/lwfa-engine/src/shell.rs`.
   The scrollable strip now lives in TypeScript and dictates geometry; the
   engine reconciles and integrates the springs.

   **Not done: the layer-shell chrome path.** The shell runs in a browser
   against the engine, but it does not yet draw chrome over the native output.
   That needs a `wlr-layer-shell` client hosting a webview, which is a separate
   piece of work.
4. **Per-surface encode plus remote backend.** ⚠️ Architecture done and
   verified; the codec is a stopgap.

   Done: per-surface GPU capture with damage tracking
   (`crates/lwfa-engine/src/capture.rs`), a binary frame transport on the same
   WebSocket as control, backpressure so a slow client costs no read-back, and
   browser-side DOM compositing (`packages/shell/src/WindowSurface.tsx`).
   Verified in a real browser: two windows composited as separate elements with
   decoded pixels, positioned by the strip, with `border-radius` applied to
   live application windows.

   **Hardware H.264 done.** `crates/lwfa-engine/src/encode.rs` encodes each
   window on NVENC via ffmpeg's `h264_nvenc`, and the browser decodes with
   WebCodecs `VideoDecoder`. Measured on the RTX 3060 at 631x1366: **0.6-0.7 KB
   per frame against JPEG's 30.5 KB**, and 0.80ms of GPU encode against several
   milliseconds of software JPEG. JPEG remains as the fallback for when the
   8-session NVENC limit is hit, which is why `FrameFormat` is per frame.

   Not the NVENC SDK directly: `nvidia-video-codec-sdk`'s `cudarc` dependency
   hard-panics at build time on CUDA 13.3, which is what this machine has.

   **Encoding runs on its own thread**, and the reason is worth recording
   because it overturned an assumption. Measured with `LWFA_PROFILE=1`, per
   window per frame:

   | Stage | Cost |
   |---|---|
   | capture + GPU-to-CPU readback | 0.6-1.1ms |
   | encode, steady state | 1.6-1.9ms |
   | encode, **opening an NVENC session** | **90-160ms** |

   The readback was assumed to be the bottleneck and is not. Opening a session
   is, and it happens on every window resize, because H.264 cannot change
   resolution mid-stream and the layout resizes windows whenever a column width
   or workspace changes. Inline, that put an up-to-160ms stall (eight dropped
   frames) into the render loop every time you touched the layout. Moving
   encoding to a worker took the render loop's share to a mean of 2.2ms.

   **Zero-copy capture is deprioritised as a result.** It would save around a
   millisecond. Fixing where encoding runs saved two orders of magnitude more,
   and doing zero-copy first would have meant a fight with CUDA/GL interop for
   the smaller win. Worth revisiting only once something else makes 1ms matter.
5. **XWayland.** ✅ Done. `crates/lwfa-engine/src/handlers/xwayland.rs`. X11
   clients map into the same strip, stream, and take remote input. Steam is
   X11, so everything under Proton is X11, and so are older GTK2/Qt4 programs
   and Electron builds without the ozone flags; without this they do not
   degrade, they fail to start.

   Interactive move, resize, maximise and fullscreen requests are all refused,
   exactly as on the Wayland side and for the same reason: the shell owns
   column width, and a client that could take the strip would be deciding
   layout.

6. **The shell UI.** ✅ Done. Sections 4.1 to 4.3 for the rendering split, the
   rail and the input surfaces.
7. **Accounts and permissions.** ✅ Done. Section 10.
8. **Appearance vocabulary** in both backends, with a visual diff test comparing
   a local screenshot against a remote screenshot of the same state.
9. **iPad.** Gesture arbitration, PWA lifecycle, offline shell. WebCodecs and
   the on-screen keyboard are done.
10. Clipboard, audio, multi-monitor, DPI, TLS, packaging.

Steps 1 and 8 are the ones that would get skipped when moving fast, and they are
exactly the ones that make the two-renderer choice survivable.

## 10. Accounts and permissions

Implemented. `crates/lwfa-engine/src/accounts.rs`, and the Access panel.

The engine had one shared password, and everyone who knew it could do
everything: inject keystrokes, spawn processes, close windows. Handing somebody
a link so they can *watch* should not also let them run commands.

**Accounts live on the machine they authenticate for**, in SQLite at
`$XDG_STATE_HOME/lwfa/accounts.db`. There is no control plane: nothing to enrol
with, nothing to be offline from, and a machine that is switched off simply
cannot be connected to. Passwords are Argon2id with a per-user salt.

An account *is* its password. A browser sends only a token on a bookmarked URL,
and adding a username field would be another thing to mistype on a tablet for no
gain, since the password already identifies the row. Login therefore costs one
Argon2 verification per account, which is the point of Argon2 and is irrelevant
at household scale.

`AUTH_PASS` means **the owner**: the bootstrap credential, so a fresh install is
usable before any account exists; the only identity that may administer
accounts; and the way back in when the last named account locks itself out.

**Enforcement is in the engine**, at the single point every shell message passes
through, not in each handler. A permission checked in nine places is one that
will be missing from the tenth. The shell greys out what it cannot use, which is
a courtesy to the user rather than a control: anyone can open a socket and send
whatever they like.

**Saved connections are the opposite** and live in the browser. Which machines
*you* care about is a property of the device in your hand; storing that list on
a machine would mean that machine being switched off loses you the list of the
others.

### 10.1 The launcher

`apps.rs` reads freedesktop desktop entries, the same list every other Linux
launcher shows, so whatever is installed simply appears.

Icons are the interesting part. A `.desktop` file *names* an icon rather than
pointing at one, so `icons.rs` walks the theme chain: the GTK theme, its
`Inherits=`, `hicolor`, then `/usr/share/pixmaps`. All four steps are
load-bearing in practice.

The first implementation searched the tree once per icon name and never
returned: four themes, two dozen size directories, a dozen contexts each, times
a hundred names. Indexing the chain once turns that into one pass and a hundred
hash lookups, 26ms instead of never.

A full icon set is over a megabyte, so the shell caches them in IndexedDB and
requests only what it lacks; a returning client requests nothing. IndexedDB
rather than `localStorage` because the latter is synchronous, so reading a
megabyte of base64 would block the main thread while frames are decoding, and
its ~5MB origin quota would evict the preferences that matter. Misses are cached
as tombstones: roughly a sixth of entries name an icon that is not installed,
and without that the shell would ask again on every reload forever.

## 11. Prior art

| Project | Relevance |
|---|---|
| [Greenfield](https://github.com/udevbe/greenfield) | Closest existing thing: a Wayland compositor in TypeScript running in the browser, per-surface, WebRTC transport. AGPL. |
| [Selkies](https://github.com/selkies-project/selkies) | Proves the streaming half. GPU-accelerated H.264, Opus audio, 60fps at 1080p to HTML5. |
| [wayvnc](https://github.com/any1/wayvnc) | Compositor-side capture and virtual input plumbing, via `wlr-screencopy` / `ext-image-copy-capture-v1`. |
| [waypipe](https://mstoeckl.com/notes/gsoc/blog.html) | Protocol-level forwarding with mirror buffers and damage-only transmission. |
| Sunshine / Moonlight | The latency ceiling reference. |
| GNOME Shell | Precedent for a scripted shell on a native compositor. |
| [niri](https://github.com/niri-wm/niri) | The layout model (section 2.3), and the closest reference for a Smithay compositor in production. GPL-3.0, so read but do not copy without a license decision. |
| GNOME PaperWM | Where scrollable tiling came from. |
