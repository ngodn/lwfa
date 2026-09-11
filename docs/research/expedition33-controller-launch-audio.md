# Expedition 33: silence after a controller launch

Investigated 2026-09-11, Asia/Kuala_Lumpur, against the installed lwfa service and lwfa GE-Proton11-6 Canvas. No service restart, game configuration change, or host display change was made.

## Reproduction and measurements

The user reports silence when launching from Steam Big Picture using a physical controller. Clicking Play with a mouse, touchpad, or touch, or launching from normal Steam, works. Physical versus on-screen controller behavior is not yet separately established.

A working run at 11:59 produced nonzero PCM on Expedition 33's individual sink input and on lwfa.monitor. A later working run at 12:03 also produced nonzero PCM. These were working observations, not evidence that the reported failure was absent.

The controller launch recorded from 12:05 produced repeated all-zero PCM samples until 12:07:47. The user confirmed silence, and a direct tap inside the game did not recover it. The stream was uncorked, unmuted, at 100% volume and routed to the private lwfa sink. X11 GetInputFocus named the game, and its _NET_WM_STATE included FOCUSED.

A Windows API probe in the existing Wine server found:

- Windows foreground: desktop HWND 0x10020.
- Game HWND: 0x200ae, visible, with its thread's active and keyboard-focus HWND both pointing to itself.
- X11 keyboard focus: game window 0x5000001.
- Root _NET_ACTIVE_WINDOW: 0x3c1, the X root, instead of the game.

The game configuration contains NotFocusedVolume=0 and MasterVolume=1. This configuration was only read.

At 12:08:32, a single controlled correction changed _NET_ACTIVE_WINDOW on lwfa's private display :1 to the existing keyboard-focus game window, preserving its WINDOW property type. No keyboard focus, game settings, or display modes were changed. Before writing, the probe verified GetInputFocus still named that exact game window.

The resulting five-second sample had peak 11026 and RMS 1813.54 on signed 16-bit PCM, instead of zero. A subsequent Windows probe reported foreground HWND 0x200ae, the game. This establishes that correcting the active-window property recovered this silent run without a game restart. User confirmation of hearing the recovered sound remains separate from the measured PCM recovery.

## Source evidence

Smithay 0.7.0, src/xwayland/xwm/mod.rs, handles both FocusIn and FocusOut by writing the event window directly into _NET_ACTIVE_WINDOW. The property can consequently name an ancestor/root or a window losing focus. The same root value was observed in an earlier working run too: the property mismatch alone is not sufficient to predict silence, but changing it recovered the captured failing state.

Wine's dlls/winex11.drv/window.c consumes this property through net_active_window_notify and its Windows foreground synchronization. dlls/winex11.drv/event.c also distinguishes X11 FocusIn from WM_TAKE_FOCUS and can ignore focus events while window state changes are pending. Those distinctions explain why an X11 keyboard-focus query alone was insufficient here; they do not yet establish every launch-timing detail.

## Implementation

The workspace now uses a local copy of Smithay 0.7.0 through Cargo's patch mechanism. Its XWM subscribes to client focus events, queries current server focus when processing FocusIn or FocusOut, resolves child windows to their managed application and transient override-redirect menus to their owner, and publishes only a changed value. It never changes keyboard focus. Root, None, and PointerRoot publish no active X11 application. Queued events cannot publish the old event window over the current application.

This is part of the lwfa binary. No additional Proton patch, host window-manager change, game setting, audio routing, or controller button remapping is needed. See vendor/smithay/LWFA-PATCHES.md for provenance and the isolated test runner.

The existing one-second guardian covers a different, previously reproduced failure: the X server loses keyboard focus while lwfa still owns an X11 window. It remains a fallback for None/PointerRoot. A new regression exposed that this path ignored the popup grace period honored by delayed layout repair. Both now wait for a newly mapped menu, preserve actual popup focus, and allow recovery after the grace period expires. Intentional compositor focus clearing still prevents repair.

The audit also followed frontend primary/follower focus publication, panel and dialog restoration, physical controller suspension and recovery, compositor map/unmap and delayed repairs, the Wayland/X11 keyboard targets, audio session lifetime, capture, and routing. No additional cause was established in those paths for this silent launch. In particular, the captured failure was already silent at the game's source, before browser playback.

## Validation

- Live causal check: correcting the private display's active-window property restored source PCM and Windows foreground state as recorded above.
- Isolated X11 regression: the original publication behavior failed with the root instead of the game. The patched implementation passes sibling changes, child focus, keyboard grabs, transient menus, empty/root focus, destroyed windows, and repeated updates without focus or property churn. The test uses the same event subscription helper as CreateNotify.
- Popup regression: the old guardian stole empty focus during a new menu handshake. The updated code passes, including expiry recovery, preserving a real popup, intentional focus clearing, and an isolated outer X server remaining usable.
- `cargo test --workspace`: 362 passed, six optional tests ignored. The two optional X focus tests were separately run and passed with namespace isolation.
- `pnpm test`: 736 passed across 42 files.
- Chromium browser checks passed: e2e-audio-playback.mjs (scheduled and AudioWorklet PCM), e2e-focus-restoration.mjs, e2e-follower-focus.mjs (interact and view permissions), and e2e-controller-recovery.mjs.

Commands for the isolated X tests:

```sh
LWFA_TEST_XVFB=/path/to/Xvfb node scripts/test-xwm-focus.mjs
LWFA_TEST_XVFB=/path/to/Xvfb cargo test -p lwfa-engine xfocus::tests:: -- --ignored --nocapture
```

All X-server tests follow docs/research/host-x11-test-isolation.md. The installed service was not restarted or replaced during validation. After upgrading to the 1.5.8 test package, the user reported that the fix works and approved release. The earlier live property correction alone lasted only until another window-manager update changed it.

## Evidence and references

Local measurements are under /tmp/lwfa-expedition-audio-20260911/: game.json, lwfa_mix.json, controller-launch.json (a working run), launch-watch-120502.jsonl (the failing launch), active-property-correction.json, and windows-focus-after-correction.txt. The scratch Windows probe creates no application windows and only queries window state. Its output file was overwritten on the second invocation; the original foreground result is preserved in this report and the tool transcript.

- [EWMH active-window property](https://specifications.freedesktop.org/wm/1.5/ar01s03.html)
- [Smithay XWM source](https://docs.rs/smithay/0.7.0/src/smithay/xwayland/xwm/mod.rs.html)
- [Windows foreground query](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow)
- [Unreal unfocused volume](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Core/Misc/FApp/UnfocusedVolumeMultiplier?application_version=5.5)
