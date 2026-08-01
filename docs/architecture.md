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
| Shell | TypeScript, React 19, Motion, PreTeXt | Layout policy, chrome, gesture arbitration, responsive breakpoints |
| Remote backend | TypeScript, WebCodecs | Per-surface decode, appearance vocabulary via CSS, spring integration |

The shell does not know which backend it is talking to. That is the point.

**Smithay** is the compositor library: it covers core Wayland plus the official,
wlroots and KDE protocol extensions, and it is proven at scale by `cosmic-comp`
(System76's COSMIC) and `niri`.

**Motion** (formerly Framer Motion, package `motion`, imported from
`motion/react`) animates shell chrome. Note: `react-motion` is a different,
long-dead library.

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

**Touch is clean at the protocol level, messy at the UX level.** `wl_touch`
exists, with `frame` to batch multi-touch updates and `cancel` for when the
compositor claims a gesture. Delivering touch is easy. The hard part is that
Linux apps have never seen a touch event and have 16px hit targets. The gesture
arbitration layer (what stays a shell gesture vs what becomes a synthetic
pointer event, scroll-to-wheel, long-press-to-right-click, on-screen keyboard
via `zwp_virtual_keyboard_manager_v1` / `input-method-unstable-v2`) is probably
the most product-defining code in the project.

**Latency budget.** Capture → encode → network → decode → present, each stage
3-15ms. Under 50ms feels responsive, under 30ms feels good, under 16ms is
game-streaming territory and not worth chasing for v1. Mobile networks will miss
all of these, so quality/latency adaptation is needed early.

**Security.** This is a remote desktop with full input injection. TLS and real
authentication before anything is reachable off-localhost. Not a later concern.

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

## 8. Build order

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
   piece of work; see section 10.
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

   **Still one readback per frame.** `capture.rs` copies the GPU texture to
   host memory and the encoder uploads it back. Removing that needs CUDA/GL
   interop and is the obvious next optimisation; only `encode.rs` and
   `capture.rs` change.
5. **Appearance vocabulary** in both backends, with a visual diff test comparing
   a local screenshot against a remote screenshot of the same state.
6. **iPad.** WebCodecs, gesture arbitration, responsive breakpoints, on-screen
   keyboard.
7. Clipboard, audio, multi-monitor, DPI, reconnect, auth, packaging.

Steps 1 and 5 are the ones that would get skipped when moving fast, and they are
exactly the ones that make the two-renderer choice survivable.

## 9. Prior art

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
