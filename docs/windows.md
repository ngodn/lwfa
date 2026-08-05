# lwfa on Windows

**Status: research, 2026-08-05. Nothing here is built and nothing is committed
to.** Companion to [macos.md](macos.md), and worth reading against it, because
the two platforms fail and succeed in opposite places. On macOS the product
survives but the gaming use case dies. On Windows the gaming use case is the
part that transfers best.

The goal is the same one, restated for the platform:

> A Windows user can use their PC from an iPad. Including for games.

The last sentence is the difference. On macOS it had to be dropped (no Proton,
no virtual gamepad without a DriverKit entitlement). On Windows the games are
native, and the virtual controller problem was solved years ago by the game
streaming ecosystem lwfa already borrows ideas from.

---

## 1. Same verdict on the compositor, different reasons

lwfa cannot be the innermost compositor on Windows any more than on macOS. DWM
owns composition; applications render into swapchains that DWM composites, and
nothing else gets to own that relationship. Cross-process window reparenting
via `SetParent` nominally exists and is a documented minefield that breaks
input, DPI and focus; nobody builds on it deliberately.

So, as on macOS, `lwfa-engine-win` is a session agent, not a compositor: it
enumerates windows, captures them individually, encodes, injects input, and
speaks the existing protocol to the existing shell. The shell does not change.
The protocol does not change.

The difference from macOS is that every mechanism this needs is a public,
documented API. The macOS doc records two private APIs as load bearing
(`CGVirtualDisplay`, the `SLPS*` pair). The Windows equivalents are supported
frameworks with Microsoft sample code.

## 2. The mechanism table

| Job | macOS | Windows |
|---|---|---|
| Per-window capture | ScreenCaptureKit | `Windows.Graphics.Capture`, `CreateForWindow` on an HWND |
| Encode | VideoToolbox, H.264/HEVC | ffmpeg's `h264_nvenc`, `h264_amf`, `h264_qsv`: all three GPU vendors |
| Audio | Core Audio taps (14.2+) | WASAPI loopback; per-process loopback on Win10 2004+ |
| Viewport | `CGVirtualDisplay`, private | Indirect Display Driver (IddCx), public framework |
| Input | `CGEventPost`, second-class | `SendInput`, the sanctioned path games actually accept |
| Touch | Does not exist | `InjectTouchInput`, public API since Windows 8 |
| Gamepad | DriverKit entitlement, out of scope | ViGEmBus-class virtual bus driver, proven by Sunshine |
| Geometry | Accessibility API, async IPC | `SetWindowPos`, direct |
| Applications | `NSWorkspace` | Start menu shortcuts plus the UWP package manager |

Four rows deserve expansion, because they are where the platform decides what
the product can be.

### 2.1 Capture: the requirement is first class here too

`Windows.Graphics.Capture` takes an HWND through
`IGraphicsCaptureItemInterop::CreateForWindow` and delivers that window's
content as D3D11 textures, straight off DWM's composition. Occlusion does not
matter: the window's own swapchain is captured, not a screen region, so
windows can overlap freely on whatever display holds them. This is the same
first-class per-window property ScreenCaptureKit gives on macOS, and the same
property section 2.1 of the architecture doc builds everything on.

The texture arrives as D3D11, which is the right side of the fence: NVENC, AMF
and QuickSync all consume D3D11 surfaces, so the zero-copy path the Linux
engine has through CUDA has a direct analogue, and this time for all three GPU
vendors. The Linux engine is NVIDIA-only today; the Windows one would not be.

Two constraints, both with the same shape as elsewhere:

- **Minimised windows stop rendering**, so they stop producing frames. Same
  constraint as macOS ("streamed windows live un-minimised") and the same
  resolution: they live on the virtual display, restored, where nobody local
  is looking.
- **The capture border.** Windows draws a yellow border around captured
  windows. `IsBorderRequired = false` removes it (Win10 21H1+) after a
  one-time `GraphicsCaptureAccess` consent. Cosmetic, but on the owner's
  screen it would outline every streamed window, so it matters and it is
  solvable.

Rust bindings are unusually good here: `windows-rs` is Microsoft's own crate,
and `windows-capture` wraps exactly this API.

### 2.2 The virtual display is a supported driver model

`SetViewport` maps to the same idea as on macOS: a display sized to the
client, holding the streamed windows. The difference is standing. On macOS
that is `CGVirtualDisplay`, private, breakable in any release. On Windows it
is the Indirect Display Driver framework (IddCx): a documented, user-mode
driver model with a Microsoft sample, which is why a dozen shipping projects
exist on top of it. parsec-vdd and the Virtual Display Driver family do custom
resolutions to 8K, custom refresh rates, and HDR. Apollo, the Sunshine fork,
ships one per client and sizes it to the connecting device, which is
precisely the `SetViewport` semantic.

The cost moves from API risk to distribution: it is a driver, so it must be
signed and installed once, with a UAC prompt. UMDF drivers use attestation
signing rather than the old kernel certificate ordeal, and the installer
already has the pkexec-style pattern for "one privileged step, shown and
asked".

### 2.3 Input: SendInput is believed, and touch survives

The macOS doc spends its longest section on the ways `CGEventPost` is second
class. Windows is the opposite story. `SendInput` feeds the normal input
stack, which means raw input consumers see it, which means games see it. This
is not theoretical: it is how Sunshine, Parsec and Steam Remote Play deliver
mouse and keyboard, including to anti-cheat-protected titles, and has been
for years.

**Touch is the headline.** `InitializeTouchInjection` / `InjectTouchInput`
inject real touch contacts, public API since Windows 8. The iPad's touch can
arrive as touch: pinch in maps, two-finger scroll, handwriting. The macOS doc
accepts "touch does not survive" as a permanent constraint; here it survives.
Games reading raw input still want a mouse, so the shell's existing
touch-as-pointer path stays for them, and the trackpad-mode work planned for
macOS serves both.

The focus discipline transfers rather than disappears. Games take input only
in the foreground, so the strip's focused window must be the foreground
window, and `SetForegroundWindow` from a background process is restricted by
the foreground lock. The workarounds are well known (thread input attachment,
or a `uiAccess` manifest with signing), but this is the Windows analogue of
the X11 focus re-assertion the Linux engine already does, complete with its
own folklore. Expect to spend the same care here that `xfocus.rs` records.

### 2.4 The gamepad exists, which changes what the product is

On macOS the virtual controller was ruled out of scope: DriverKit entitlement,
system extension, and no games to justify it. On Windows the entire mechanism
is proven. ViGEmBus is a signed kernel bus driver that presents virtual
Xbox 360 and DualShock 4 controllers indistinguishable from hardware; Sunshine
shipped on it for years, and games, Steam and anti-cheat accept it.

Its upstream was archived in 2023 over a trademark conflict, which is a supply
question rather than a mechanism question: the driver still works and still
installs, LizardByte maintains a revival (Virtual-Gamepad-Emulation-Bus), and
the original author's successor (VirtualPad) is in progress. The protocol
side is already done: `SetGamepad`, `GamepadButton`, `GamepadAxis` map onto a
ViGEm-class device the same way they map onto uinput, dpad hat and all.

This is why Windows is the port that keeps lwfa's soul. The production use
case, games played from the couch with the on-screen controller, works here
without Proton, because the games are native.

## 3. Audio: better than Linux, about equal to macOS

Session audio is plain WASAPI loopback, the equivalent of the monitor capture
`audio.rs` does today.

Per-process audio is `ActivateAudioInterfaceAsync` with
`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` (Windows 10 2004+, documented
in 11): capture one process's audio, **including its child process tree**.
The child-tree detail matters more here than anywhere, because the thing being
captured is usually "Steam and whatever it launched". The Linux engine
documents per-process capture as structurally impossible; on Windows it is a
parameter.

The `sink.rs` job, keeping remote audio out of the local speakers, maps to
`ISimpleAudioVolume` per audio session: public, no virtual device, no module
loading. Same protocol implication as macOS section 3.2: ship session audio
first, since it needs no protocol change; per-application streams are the
follow-up.

## 4. What disappears and what appears

The same structural change as macOS section 3.4: there is one desktop, so
there is no "inside lwfa". `outside.rs`, `AlreadyRunning` and `CloseAndSpawn`
are deleted, and the same product question arrives in their place: which
windows does the shell see by default? Everything on the machine, only what
lwfa launched, or user-picked. Same answer needed before the first line of
code, and it should be the *same* answer as the macOS build gives, because it
shapes the window model both share.

Window events arrive through `SetWinEventHook`
(`EVENT_OBJECT_CREATE/DESTROY/LOCATIONCHANGE`), which is one global hook
rather than macOS's per-process `AXObserver` registration. Simpler.

Applications and icons: Start menu `.lnk` enumeration plus the UWP package
manager, icons through `IShellItemImageFactory`. Different archaeology than
freedesktop themes, comparable effort, well trodden.

DPI needs deciding early rather than discovered late: the agent must be
per-monitor-DPI aware, and the virtual display should be created at the
client's scale so streamed windows never render at a mixed DPI.

## 5. Constraints accepted

**Logged in and unlocked, at first.** Capture and injection live in the user
session. Running as a service to survive the login screen and UAC's secure
desktop is what Sunshine does, and its issue tracker records the cost:
session juggling, invisible UAC prompts, desktop switching. Version one is an
ordinary app in the user's session, exactly like the macOS plan. The service
is a later, separable investment.

**Games take input only via the foreground window.** One window plays at a
time, which the one-seat model already implies. The strip's background
windows keep streaming pixels; they just do not hear a gamepad until focused.

**Two driver installs for the full experience.** The virtual display and the
virtual gamepad are each a signed driver with an install prompt. Both are
optional degradations rather than requirements: without the display driver,
windows live on the real desktop and `SetViewport` clamps, as on macOS;
without the gamepad driver, `SetGamepad` answers with an error, the path the
shell already handles.

**The capture border consent.** One-time, per machine. Less invasive than
macOS's Screen Recording + Accessibility pair.

**Antivirus and anti-cheat friction exists but is survivable.** SendInput and
ViGEm are what the whole remote-play ecosystem uses; the residual risk is a
specific title deciding virtual controllers are cheating hardware, which is
rare and documented per game rather than systemic.

## 6. What carries over

The same split as the macOS table, and the platform-neutral 40% is the same
40%: `lwfa-proto`, `lwfa-spring`, `layout.rs`, `bitrate.rs`, `auth.rs`,
`accounts.rs`, `shell.rs`, `config.rs`, and `encode.rs` gains encoders rather
than losing any. Replaced: `winit.rs`, `capture.rs`, `cuda.rs`, `input.rs`,
`remote_input.rs`, `xfocus.rs`, `gamepad.rs`, `sink.rs`, `handlers/*`,
`state.rs`. Deleted: `outside.rs`.

The prerequisite is also the same one, and it is now wanted by three backends
(TTY, macOS, Windows): split `lwfa-core` from a backend trait, with
`lwfa-backend-linux` as the first implementation. Whichever port goes first
pays for the seam; the other inherits it.

## 7. Ranking the ports

Recorded because the two research docs exist to be compared.

| | macOS | Windows |
|---|---|---|
| Per-window capture | first class | first class |
| All-vendor hardware encode | n/a (VideoToolbox) | yes, and better than Linux today |
| Games | no | **yes, native, with controller** |
| Touch | lost | **kept** |
| Private API exposure | two, load bearing | none |
| Driver installs | one, entitlement-gated | two, but proven and self-serve |
| Audio | per-process | per-process, plus child trees |
| Rust bindings | community | Microsoft's own |

Windows preserves the reason lwfa exists (games from the couch) and needs no
private API to do it. macOS preserves the productivity product with two
private APIs and loses the games. If only one port is built, this comparison
says which.

## 8. Open questions

- Whether `windows-capture` (the Rust crate) exposes enough of
  `Windows.Graphics.Capture` for per-window use at this cadence, or whether
  the engine goes to `windows-rs` directly.
- Frame cadence of a WGC capture on a window that is idle: whether it delivers
  on-damage like the Linux engine's commit-driven path, or ticks at the
  display rate regardless.
- Whether windows parked on an IddCx virtual display render at that display's
  refresh rate independent of the primary, which the 60Hz cap on macOS virtual
  displays made a real limitation.
- Which ViGEm lineage to depend on: the archived original, LizardByte's
  revival, or VirtualPad, judged by signing status and maintenance rather than
  by feature.
- Whether `InjectTouchInput` coordinates land correctly on a virtual display
  positioned outside the primary's bounds.
- How `SetForegroundWindow`'s restrictions behave when every involved window
  sits on a display nobody is looking at, where the raise the lock exists to
  prevent cannot annoy anyone.

## 9. Sources

- [Windows.Graphics.Capture](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture), [CreateForWindow](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow), [Win32CaptureSample](https://github.com/robmikh/Win32CaptureSample)
- [Process loopback audio](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-audioclient_activation_type), [Microsoft's sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
- [InjectTouchInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-injecttouchinput)
- [parsec-vdd](https://github.com/nomi-san/parsec-vdd), [Virtual Display Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver), both on IddCx
- [ViGEmBus](https://github.com/nefarius/ViGEmBus) (archived), [Sunshine's transition discussion](https://github.com/LizardByte/Sunshine/issues/3527)
- [Sunshine on invisible UAC under WGC](https://github.com/LizardByte/Sunshine/issues/3487), for the service/session cost
- [windows-rs](https://github.com/microsoft/windows-rs), [windows-capture](https://github.com/NiiightmareXD/windows-capture)
