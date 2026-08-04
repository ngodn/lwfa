# lwfa on macOS

**Status: research, 2026-08-04. Nothing here is built and nothing is committed
to.** This records what was investigated, what the platform actually allows, and
which of several possible shapes is the one that answers the goal. Read it
before proposing a macOS port, because two of the three obvious approaches are
dead ends for reasons that are not obvious.

The goal being answered is narrow and worth stating first:

> A Mac user can use their Mac from an iPad.

Not "lwfa runs on macOS". The distinction decides everything below.

---

## 1. The compositor cannot be ported, and that is not the interesting part

Two independent reasons, either one sufficient:

**No EGL.** Smithay's `backend_winit` feature pulls in `backend_egl` and
`wayland_egl` (`smithay-0.7.0/Cargo.toml:81`), and `backend/winit/mod.rs:127`
constructs an `EGLDisplay` directly. macOS has neither EGL nor GLES. So
`winit.rs` and `capture.rs` cannot be conditionally compiled around. They are
rewritten against Metal or they do not exist.

**No buffer ownership.** More fundamental. On Linux the engine *is* the
compositor, so every application is one of its clients and its buffers belong to
us. That is what makes section 2.1 possible at all. On macOS, WindowServer owns
every window and exposes pixels, never surfaces. There is no cross-process
window reparenting: it is an X11 idea, and macOS deliberately does not have it.
Asked this exact question, embedding another process's `NSView`, Apple's own
answer is "use IOSurface", which is not embedding, it is capture with extra
steps.

So on macOS lwfa can never be the thing it is on Linux. The question is what it
should be instead.

## 2. Three readings of "macOS support"

| | What it means | Verdict |
|---|---|---|
| **A. macOS as a client** | Safari on a Mac opens the shell | Already works. Nothing to build. |
| **B. macOS as a Wayland host** | The Mac runs a Wayland compositor for Linux apps in a VM or container | Buildable, wrong product |
| **C. macOS as a capture host** | Native Mac apps are captured per window and streamed | **The one that answers the goal** |

### Why B is buildable but wrong

[cocoa-way](https://github.com/J-x-Z/cocoa-way) proves the hard part: a native
macOS app using Smithay's Wayland frontend with a Metal renderer, for Linux apps
reached over waypipe. It vendors its own Smithay integration rather than using
upstream, which independently confirms the EGL problem above.

B is attractive because it keeps every input property intact. The Linux apps
would be Wayland clients of the engine, so `remote_input.rs` works unchanged,
touch stays touch, no Accessibility permission is needed, and `gamepad.rs` keeps
working because uinput exists inside the guest. Nothing about the input path
degrades.

It is still wrong, because it gives a Mac user Linux apps. It does not stream
Safari, Xcode or anything they actually own the machine for.

It also has a GPU wall. Guest applications have no GPU unless the runtime
paravirtualises one:

- `apple/container` has none. `virtio-gpu` there is an unanswered feature
  request ([apple/containerization#480](https://github.com/apple/containerization/issues/480),
  opened January 2026, no assignee, no maintainer response). Everything renders
  on llvmpipe.
- `krunkit`/`libkrun` does have one: Mesa's Venus driver over `virtio-gpu`,
  deserialised on the host by virglrenderer into MoltenVK into Metal. This is
  real and ships in Podman machine. GL applications reach it through Zink.

Even with krunkit, getting a rendered guest buffer into a Metal renderer without
a copy needs `virtio-gpu` cross-domain, the mechanism ChromeOS uses for
Crostini. libkrun shares crosvm's cross-domain code through `rutabaga_gfx`, so
the guest half exists. The host half does not: cross-domain hands the host a
dmabuf and macOS has no dmabuf, it has IOSurface. Asahi's muvm did this work for
a Linux host. No evidence anyone has done the macOS end. That is research, not
integration.

### Why "Omarchy in a container" specifically does not work

Recorded because it is the natural first idea and it fails three times over:

1. **Omarchy is not containerisable.** It is a whole-disk Arch installer: wipes
   the drive, requires UEFI, wants Secure Boot and TPM off, 60GB minimum. You
   could build an image from its package list, but that is not Omarchy and its
   installer will not produce it.
2. **lwfa has to be the innermost compositor.** Nesting above lwfa is fine and
   is what happens today: Hyprland outside, lwfa inside, applications connecting
   to lwfa directly. Nesting a *desktop* below it is what breaks. Hyprland in a
   guest would composite every application into one output surface before the
   engine saw anything, so the engine would see exactly one window. That is
   precisely the single-rectangle failure section 2.1 exists to reject.
3. **No GPU**, per above.

If B were ever built, the guest ships applications plus waypipe, never a
desktop.

## 3. What `lwfa-engine-mac` is

The name stays for product consistency. The program is not a compositor: it
composites nothing and owns no buffers. It is a session agent that speaks the
same protocol to the same browser shell.

| Job | Mechanism |
|---|---|
| Enumerate windows | `CGWindowList` plus the Accessibility API |
| Capture per window | ScreenCaptureKit, `SCContentFilter(desktopIndependentWindow:)` |
| Encode | VideoToolbox, `h264_videotoolbox` through the ffmpeg already depended on |
| Audio | Core Audio process taps (`CATapDescription`, macOS 14.2+), see section 3.2 |
| Geometry | Accessibility API |
| Viewport | `CGVirtualDisplay`, sized to the client (section 3.1) |
| Input | `CGEventPost` |
| Applications and icons | `NSWorkspace` |

The shell does not change. The protocol does not change.

`SCContentFilter(desktopIndependentWindow:)` deserves the emphasis: it is
literally per-window capture, one window's full content, no desktop bleeding
through the rounded corners and no child or popup windows mixed in. Section
2.1's core requirement is a supported first-class API on this platform rather
than something to be engineered. Rust bindings exist
([screencapturekit-rs](https://github.com/doom-fish/screencapturekit-rs),
macOS 12.3+).

### 3.1 Sizing: what `SetViewport` and `SetLayout` become

The two messages sit at different levels and map to different mechanisms.

`SetLayout` is the easy half. The per-window geometry the shell asks for is
applied to the real Mac window with the Accessibility API. Because the browser
owns layout, this happens when a column width changes rather than per frame.

`SetViewport` is the interesting half, because the engine does not own an output
here. The Mac has real displays at real resolutions, and **a window on macOS
cannot be larger than the screen**: WindowServer clamps it. A headless mini
reporting 1280x800 would silently truncate every window an iPad asked for, which
destroys the one property `SetViewport` exists to deliver.

So `SetViewport` becomes: **create or reconfigure a virtual display at exactly
`width` x `height` at `scale`, and place every streamed window on it.** That is
`CGVirtualDisplay`, a private CoreGraphics API, the same one BetterDisplay and
FluffyDisplay use, whose most commonly documented use is precisely a headless
Mac at a custom resolution for remote access.

This is conceptually the same operation the engine already performs on Linux,
resizing its output to match the client. Only the mechanism differs. HiDPI
virtual displays also reconcile `scale` against the Retina backing store rather
than fighting it.

It resolves the Space problem as a side effect. Streamed windows must live
somewhere un-minimised (section 5), and the obvious reading of that is a pile of
windows on the owner's real screen. They live on the virtual display instead,
which nobody is looking at.

What it costs:

- **A private API.** It can break in any macOS release. It costs nothing extra
  in distribution terms, since Accessibility already rules out the App Store,
  but it needs a fallback that clamps to the real display's bounds.
- **60Hz**, an API limitation on virtual displays.
- **Minimum window sizes still bite.** Xcode will not go below roughly 1000
  points wide whatever is asked. This is the same ceiling `architecture.md` §6
  records for Linux, with the same mitigation: render at column width and let
  the user pinch and pan.
- **Fixed-size windows refuse outright.** Dialogs, preference panes.
- **An AX resize is a request, not a command.** The engine must read back the
  real `AXSize` and report *that* in `WindowInfo`, never the size it asked for.
  The codebase already has this discipline: `remote_input.rs::window_point`
  deliberately uses the engine's actual placement rather than the shell's
  target, for exactly this reason.

### 3.2 Audio does not ride on the capture streams

ScreenCaptureKit does capture audio, but it filters video per window and audio
only **per application**. A single-window filter with `capturesAudio` set yields
all of the owning application's audio, including from windows that are not in
the video output at all.

So audio must not be attached to the per-window capture streams: two Safari
windows in the strip would each carry the whole of Safari's audio and it would
be sent twice. Audio stays a separate concern, which is how it already is here.
`audio.rs` and `sink.rs` are independent of `capture.rs`, and that separation is
what ports cleanly.

The mechanism is Core Audio process taps rather than ScreenCaptureKit, because
taps do two things the Linux side structurally cannot:

**Per-process capture.** `audio.rs` opens by explaining why Linux is stuck with
session audio: there is no reliable link from a Wayland window to the PipeWire
node its client writes to. Taps are addressed by process, so the link exists.
Still not per *window*, so two Safari windows share one stream, but per
application beats per machine.

**Muting, which replaces `sink.rs` outright.** `CATapDescription` with
`muteBehavior = .mutedWhenTapped` stops the tapped application's audio reaching
the output device and routes it through the tap instead. That is exactly what
`sink.rs` constructs by hand out of a PipeWire null sink plus an optional
loopback, and here it needs no module loading and no virtual audio driver
installed. `isPrivate` keeps the tap from appearing to other capture clients.

`excludesCurrentProcessAudio` has to be set or the engine captures itself.

**Protocol implication.** Today the protocol carries one audio stream per
session, opt-in per device. Per-application audio would be a protocol change:
streams keyed by process, and the shell choosing which to play. Ship session
audio first, since a tap can address a process *group* and the protocol does not
move at all. Per-application is the natural follow-up and is the one place the
macOS build can exceed the Linux one.

### 3.3 The architecture pays off in one unexpected place

Moving or resizing another application's window through the Accessibility API is
IPC: it goes through that application's event loop and can take seconds.
That would destroy a 60fps spring animation on any conventional window manager.

It does not here, because the browser owns layout (`architecture.md` §3.1). The engine only
supplies pixels and geometry. A Mac window is resized when a column width
changes, not per frame. The single most quoted macOS window-management problem
is structurally absent.

### 3.4 Applications, launching, and the disappearance of the session boundary

Enumerating and launching get easier. `NSWorkspace` and LaunchServices give the
installed applications, and `NSWorkspace.icon(forFile:)` gives an icon directly,
so `icons.rs`'s 553 lines of freedesktop theme inheritance, size buckets and
`/usr/share/pixmaps` fallbacks collapse to an image conversion. `Spawn`'s
`terminal: bool` has no analogue and is simply ignored: Terminal.app is an
application like any other.

The structural change is bigger than either of those. **On macOS there is no
"inside lwfa" and no "outside" it.**

On Linux, `Spawn` sets `WAYLAND_DISPLAY` and `PULSE_SINK` so the launched
application becomes a client of the engine, and that boundary is what
`outside.rs` exists to police: lwfa is a second session sharing one home
directory, so a single-instance application like anything Chromium-based
connects to the copy already running on the other screen and raises a window
nobody is looking at. Hence `ToShell::AlreadyRunning` and
`ToEngine::CloseAndSpawn`.

On macOS there is one GUI session and every application is already in it. That
whole mechanism becomes unnecessary and should be deleted rather than ported:
`outside.rs`, `AlreadyRunning`, `CloseAndSpawn`. The failure it prevents cannot
occur.

The same fact inverts into a new question that Linux never has to answer:
**which windows does the shell see?** On Linux the answer is free, it is the
ones that connected to us. On macOS the default is every window on the machine,
including whatever the owner left open. That is a scoping and privacy decision
which has to be made explicitly:

- everything on the machine, which is the most useful and the least private
- only applications launched through lwfa, which reconstructs the Linux
  boundary by bookkeeping rather than by mechanism
- user-picked, per window or per application

This also weakens what `accounts.rs` means. Per-application launch permissions
still gate `Spawn`, but they no longer imply anything about visibility, because
the engine cannot prevent a window from existing, only refuse to stream it.
Worth deciding before the first line of code, because the answer shapes the
window model.

Two mechanical consequences:

- **There is no `map_window_request`.** Window creation arrives through
  `AXObserver` with `kAXWindowCreatedNotification`, which is registered *per
  process*, plus `NSWorkspace` notifications for applications launching and
  terminating. So the engine keeps an observer per application it cares about
  rather than receiving one global stream of events.
- **A launched application places its own window.** macOS decides where it
  opens. The engine has to move it onto the virtual display (section 3.1) after
  the created notification arrives, which means a visible jump unless the
  virtual display is also the active one.

### 3.5 The on-screen keyboard

`architecture.md` §6 records that the on-screen keyboard needed no
`zwp_virtual_keyboard_manager_v1` and no `input-method-unstable-v2`, because
those protocols exist so an unprivileged client can inject text and the engine
*is* the compositor, so it already owns the seat. Keycodes go to the seat and
xkb handles layout, modifiers and repeat with no second implementation.

That argument does not survive the move. The engine owns no seat here, and three
things xkb was doing for free become the engine's problem.

**Keycode translation.** The protocol sends evdev numbering (`KEY_A` = 30,
`lib.rs:603`) and macOS wants its own virtual key codes (`kVK_ANSI_A` = 0).
A translation table is unavoidable. It belongs in the engine, not the shell,
because the protocol's decision to send *physical* keys rather than characters
is deliberate and still correct: macOS applies the user's keyboard layout to a
virtual keycode exactly as xkb applies it to a keycode, so a Dvorak user on a
QWERTY-configured remote machine still gets the right result.

**Modifier state.** xkb derives modifier state from the key events themselves.
CGEvent does not: flags are stamped onto each event with `CGEventSetFlags`, so
the engine has to track modifier state itself and apply it to every event it
posts. This is the single most common cause of "the Command shortcut does
nothing" in event-injection code.

**Repeat.** The seat generates key repeat on Linux. Posted CGEvents do not
repeat. Repeat has to be produced somewhere, and the shell is the better place
because it already knows whether a finger is still on the key.

`CGEventKeyboardSetUnicodeString` can post a character with no keycode behind
it, which is tempting for the iPad's own soft keyboard producing symbols that
have no key. Treat it as a fallback rather than the main path: application
frameworks are explicitly permitted to ignore the Unicode string and re-derive
the character from the virtual keycode, so shortcuts and navigation must go
through keycodes regardless.

### 3.6 The on-screen controller

`gamepad.rs` creates a real `/dev/uinput` device reporting Microsoft's Xbox One
vendor and product ids, visible to the entire machine, which is exactly what
makes Steam and SDL find it with no per-game configuration. There is no
equivalent on macOS.

The options, none good:

- **DriverKit** (`HIDDriverKit`) publishing a virtual HID device. This is the
  only working approach and what JoyCon2Mac and similar projects do. It costs an
  Apple Developer account, a `com.apple.developer.driverkit.*` entitlement
  granted by request rather than by checkbox, and a user-approved system
  extension install.
- **Kexts** are dead on Apple silicon, so foohid and its descendants are not
  options.
- **The Game Controller framework** has no public API for creating a virtual
  controller, only for reading real ones.
- **`CGEventPost`** cannot express a gamepad at all, and games reading HID
  directly ignore posted events anyway.

**Recommendation: out of scope for the first version.** The on-screen controller
exists for Proton games, and the macOS product has no Proton (section 5). The
cost is an entitlement request and a system extension install prompt on every
user's machine; the payoff is a thin native Mac games library minus anything
with anti-cheat, which rejects virtual HID regardless.

The protocol does not change. `SetGamepad`, `GamepadButton` and `GamepadAxis`
stay, and the engine answers `SetGamepad { enabled: true }` with
`ToShell::Error`. The shell already has to handle that path, because a Linux
engine without `/dev/uinput` permission answers the same way.

### 3.7 The rest of the protocol

For completeness, since the messages not discussed above are what determine
whether the shell needs changing at all.

| Message | macOS |
|---|---|
| `FocusWindow` | Section 3.8 |
| `CloseWindow` | Press the window's AX close button, not terminating the process |
| `PointerMotion` / `Button` / `Axis` / `Leave` | `CGEventPost` at the window's screen coordinates. `remote_input.rs::window_point`'s discipline of using actual placement rather than the shell's target applies unchanged, and matters more here because an AX resize can be refused |
| `TouchDown` / `Motion` / `Up` | Converted to pointer events, per section 5 |
| `Key` | Section 3.5 |
| `Spawn`, `ListApps`, `RequestIcons` | Section 3.4 |
| `CloseAndSpawn` | Deleted, see section 3.4 |
| `SetLayout`, `SetViewport` | Section 3.1 |
| `SetAudio` | Section 3.2 |
| `SetGamepad`, `GamepadButton`, `GamepadAxis` | Section 3.6, answered with an error |
| `SetStreams`, `TakeControl`, `EndSession`, `SetSessionMode`, account messages, `Ping` | Unchanged. These are engine-level and already platform-neutral |

### 3.8 Focus, and keeping it off the local user's screen

On Linux focus is entirely internal: the engine owns the seat, so focusing a
window is invisible to anything outside lwfa. On macOS focus is a property of
the machine, so the naive implementation would change the front application on
a desk somebody might be sitting at.

It is separable. What AppKit presents as one operation is two:

1. **Telling the application it is active** for input routing.
   `SLPSPostEventRecordTo`.
2. **Telling WindowServer to raise the window** and reparent it onto the current
   Space. `SLPSSetFrontProcessWithOptions`.

`NSRunningApplication.activate` does both. yabai and cua's background-agent work
split them and perform only the first, which is what is wanted here: correct
input routing with no raise and no Space switch.

**Step 1 is not optional, and that is the non-obvious part.** The tempting
design is to activate nothing and post everything with `CGEventPostToPid`, which
delivers straight to a process with no focus steal and no cursor movement. It
fails twice over. It is unreliable, breaking on modal dialogs and working best
only for applications that own the menu bar. And an inactive Mac application
*renders* as inactive: grey title bar, no blinking caret, controls drawn dead.
Since the engine is streaming that application's pixels, a window being typed
into would look unfocused on the client, which is a worse outcome than the side
effect being avoided. `CGEventPostToPid` is the fallback, not the primary path.

Two things bound the remaining exposure:

- **The virtual display absorbs the raise.** Streamed windows live there
  (section 3.1), so raising within it does not touch the local desktop.
- **The protocol already permits one driver.** `Role { primary }` and
  `TakeControl` mean one client holds input at a time, so there is no
  multi-client focus contest. That constraint is identical on Linux, where the
  engine also has exactly one seat.

For the case where somebody *is* physically at the Mac,
`CGEventSourceSecondsSinceLastEventType` with `kCGEventSourceStateHIDSystemState`
reports time since the last real hardware input, distinct from injected events.
That makes local presence a number rather than a guess, and the engine can warn
the remote client, yield, or simply report it.

Both `SLPS*` functions are private SkyLight API, the same risk class as
`CGVirtualDisplay` in section 3.1, and want the same treatment: a public-API
fallback that activates normally and accepts the visible raise.

## 4. What carries over

| Carries over unchanged | Replaced entirely | Easier on macOS |
|---|---|---|
| `lwfa-proto`, `lwfa-spring` | `state.rs`, `handlers/*` | `apps.rs`, `icons.rs` become a few `NSWorkspace` calls instead of freedesktop theme-lookup archaeology |
| `layout.rs`, `bitrate.rs`, `config.rs` | `winit.rs`, `capture.rs`, `cuda.rs` | `audio.rs` becomes a per-process tap rather than the whole session's monitor, which is the limitation that module documents as unavoidable on Linux |
| `auth.rs`, `accounts.rs`, `shell.rs` | `input.rs`, `remote_input.rs`, `xfocus.rs` | |
| `encode.rs`, modulo one encoder name | `gamepad.rs`, `sink.rs` | |
| | `outside.rs`, deleted rather than replaced (section 3.4) | |

Roughly 40% of the engine by line count is already platform-neutral, and it is
the 40% that took the most thought.

## 5. Constraints accepted

Recorded as decisions, not surprises.

**Touch does not survive.** macOS has no touch input model and no touch
injection, public or private. Every Mac application expects a mouse, so the
iPad's touch arrives as pointer events, permanently.

This is worth distinguishing from the mistake made on 2026-08-04 in the Linux
engine, where touch was converted to a click to paper over a bug that turned out
to be `reassert_focus` dismissing X11 menus, and where touch worked correctly
once the real cause was fixed. That conversion threw away real capability: GTK
and Qt applications do handle `wl_touch`, so a genuine touch event could have
done something better.

Here nothing is thrown away, because AppKit has no touch input model and there
is no Mac application on the other end that could have done better with a touch
event. Every one of them was written against a mouse.

The mitigation is well trodden rather than novel. Every iPad remote desktop
client converges on the same two modes, and the work is entirely shell-side:

- **Direct touch.** Tap where the target is, the cursor jumps there and clicks.
  Good for buttons, poor for precision.
- **Trackpad mode.** The finger moves a cursor relatively and a tap clicks
  wherever the cursor is. Good for precision. Jump Desktop and Splashtop both
  ship this and it is what users of those apps expect to find.

With the usual conventions layered on: two-finger tap or tap-and-hold for right
click, two-finger drag for scroll, double tap for double click, pinch zooming
the view rather than the application.

Much of this already exists. `packages/shell/src/lib/longPress.ts` implements
long-press-to-right-click with the iOS Safari `contextmenu` quirk handled, and
`WindowSurface.tsx` owns the pointer and touch mapping. Trackpad mode and the
two-finger conventions are what is missing.

**Synthetic events are second class.** WindowServer distinguishes posted events
from hardware ones and no flag changes that. Anything reading HID directly,
which means games, ignores them.

**The gamepad needs a driver.** No uinput. The working approach is a DriverKit
virtual HID system extension, which means an Apple Developer account, a
`com.apple.developer.driverkit.*` entitlement granted by request, and a
user-approved install. `CGEventPost` is not a substitute.

A driver is needed for exactly two things, both of them on the gaming path that
macOS does not have anyway: a gamepad, which has no `CGEventPost` equivalent,
and games with kernel anti-cheat, which reject posted events outright. This is a
known limit across Apollo, Sunshine and Parsec. For the productivity product,
`CGEventPost` is sufficient and no system extension is shipped.

**Permissions and distribution.** Accessibility plus Screen Recording, both
user-granted. Accessibility is incompatible with the App Sandbox, and the
sandbox is mandatory for the App Store, so distribution is Developer ID only.

**Two private APIs are load bearing.** `CGVirtualDisplay` for the viewport
(section 3.1) and the `SLPS*` pair for focus without a raise (section 3.8).
Neither is exotic, both are what shipping applications use, and neither costs
anything extra in distribution terms because the App Store is already out. Both
can break in any macOS release, so both need a public-API fallback that degrades
rather than fails: clamp the viewport to the real display's bounds, and activate
normally while accepting the visible raise.

**The Mac must be awake, logged in and unlocked.** ScreenCaptureKit has no
pre-login context and fails at the login window citing no graphical context. The
engine holds a power assertion, and the machine sits unlocked while in use.

**Sleep ends the capture session.** Apple confirms ScreenCaptureKit does not
resume a session interrupted by system sleep; OBS shipped a "restart capture"
button for exactly this. The engine must detect wake and rebuild every stream.
This is the same class of problem as the reconnect grace path and should reuse
its thinking.

**Streamed windows live on a real Space, un-minimised.** Minimising pauses a
stream. Fully off-screen windows emit frames only when the mouse moves on the
display holding them. Occluded windows are fine and still deliver full content,
which is what makes the whole thing work: every streamed window piles on one
Space and keeps delivering.

**No Proton, so no games.** The production use case that lwfa exists for on
Linux, Steam under Proton played from the couch, does not transfer. What
transfers is Xcode, Safari, Figma, terminals.

## 6. Prerequisite

Whichever direction is taken, the same refactor comes first: split `lwfa-engine`
into `lwfa-core` (protocol, layout, spring, auth, accounts, bitrate, shell
socket) plus a backend behind a trait, with `lwfa-backend-linux` as the first
implementation.

That seam is worth building on its own merits. The TTY backend in section 9
needs exactly the same one.

## 7. Open questions

- Whether `CGEventPost` routing to a specific window is reliable enough for a
  strip of eight windows, or whether focus has to be stolen per event.
  `CGEventPostToPid` exists; its behaviour under rapid target switching was not
  tested.
- Whether a headless Mac mini needs a dummy display plug for a usable
  resolution, or whether a virtual display can be created without one.
- Which windows the shell should see by default (section 3.4). This is a product
  decision, not a technical one, and it shapes the window model.
- Whether `AXObserver` per-process registration scales to every running
  application, or whether observers should be attached lazily to applications
  the shell actually streams.
- How many concurrent Core Audio process taps are practical, since the
  per-application design in section 3.2 wants one per streaming application
  rather than one per session.
- Whether `muteBehavior = .mutedWhenTapped` composes with the user still wanting
  sound out of the Mac's own speakers, which is what `sink.rs`'s optional
  loopback exists for.

## 8. Sources

- [Capturing screen content in macOS](https://developer.apple.com/documentation/ScreenCaptureKit/capturing-screen-content-in-macos)
- [Capturing system audio with Core Audio taps](https://developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps)
- [screencapturekit-rs](https://github.com/doom-fish/screencapturekit-rs), [video-toolbox-rs](https://github.com/shiguredo/video-toolbox-rs)
- [cocoa-way](https://github.com/J-x-Z/cocoa-way)
- [apple/containerization#480](https://github.com/apple/containerization/issues/480), [apple/container GPU discussion](https://github.com/apple/container/discussions/62)
- [krunkit](https://lima-vm.io/docs/config/vmtype/krunkit/), [libkrun](https://github.com/containers/libkrun), [Sergio López on GPU paravirtualisation](https://sinrega.org/2024-03-06-enabling-containers-gpu-macos/)
- [crosvm Wayland and cross-domain](https://crosvm.dev/book/devices/wayland.html), [muvm X11 bridging](https://asahilinux.org/2024/12/muvm-x11-bridging/)
- [Swindler, on Accessibility API latency](https://github.com/tmandry/Swindler), [Accessibility and the App Sandbox](https://developer.apple.com/forums/thread/805780)
- [Jump Desktop input methods](https://support.jumpdesktop.com/hc/en-us/articles/216423623-iPad-Input-methods), [Splashtop pointer control](https://www.splashtop.com/blog/mouse-control-remote-desktop-ipad-iphone-ios-13)
- [Apollo, on anti-cheat rejecting posted events](https://github.com/ClassicOldSong/Apollo/issues/1202)
- [BetterDisplay](https://github.com/waydabber/betterdisplay) and [oldmac-display](https://github.com/crazyathlete220-stack/oldmac-display), both on `CGVirtualDisplay`
- [Inside macOS window internals](https://cua.ai/blog/inside-macos-window-internals), on splitting AppKit activation from the raise
- [CGEventPostToPid and background dialogs](https://developer.apple.com/forums/thread/724835)
- [A window cannot be larger than the screen on macOS](https://github.com/DevExpress/testcafe/issues/3022)
- [AudioCap](https://github.com/insidegui/AudioCap) and [audiotee](https://github.com/makeusabrew/audiotee), working Core Audio tap implementations
