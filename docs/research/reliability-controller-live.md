# Live BG3 controller check, 2026-09-06

The user upgraded and tested BG3, reporting missed/sluggish LB/RB taps and
input becoming stuck until another button changes it. The user confirms the
on-screen controller works correctly; the complaint is physical input only.

## Confirmed runtime

- Production engine PID 3500227 reports version 1.4.2 through a read-only
  WebSocket connection. Installed shell index matches the checkout build.
- BG3 PID 3536994 runs GE-Proton11-5, loads XInput 1.3/1.4 and winex11.drv,
  and has actual X input focus on window 0x6400001. The separate root
  _NET_ACTIVE_WINDOW property was not a useful focus check.
- The game container can see event10, and its Wine device process has event10
  open. This is the production virtual controller reported by the startup log.
- An earlier shell module import failure/reload occurred at 15:24:50, before
  these recordings. No controller reset or socket failure was observed during
  the subsequent recording window.

## Passive recordings

No input was injected, devices were not grabbed, and neither the production
service nor BG3 was restarted. The XInput observer ran in its own disposable
GE-Proton prefix, outside BG3's runtime, and cleaned up after itself. It cannot
establish what BG3 itself reads on each frame.

| Capture | Evidence |
| --- | --- |
| First 60 seconds, 15:29:19 | 354 events, no SYN_DROPPED; three complete button holds, shortest 60.519 ms; LB held when capture ended, not proof of a stuck release |
| Second 60 seconds, 15:32:06 | No events; user activity during this interval was not established |
| Third 90 seconds with overlapping 60-second XInput observer | 1,878 kernel events, no SYN_DROPPED; all 14 LB and 6 RB edges in the overlap observed at XInput |
| Requested controlled sequence, 15:37:28 for 120 seconds | 19 LB presses/releases and 21 RB presses/releases, no unmatched holds and no SYN_DROPPED; observed shoulder holds about 132 to 300 ms |

XInput observation lag relative to kernel edge timestamps was 0.677 to 4.481 ms
for LB and 0.489 to 1.628 ms for RB. The observer made 55,743 polls; its largest
poll gap was 7.393 ms. It reported the controller on slot 0.

One LB hold lasted about 6.1 seconds and one RB hold about 13.8 seconds. The RB
release followed a new LB press by seven microseconds at the kernel. The user
could not recall whether those were intentional holds, so this is not a
confirmed delayed-release reproduction. The controlled trace's groups often
contain two or three observed taps; the user subsequently confirmed five physical taps per button per round.
This establishes missing whole presses before the kernel in the test, while
the exact total intended count across recording boundaries is unknown.

## Next distinguishing evidence

At this point in the investigation the browser recording was still missing.
The supplied recording is analyzed below. The planned comparison was: compare
raw button indices 4/5, value, pressed, Gamepad timestamp and poll gaps with
send messages and the kernel trace. Regular polling with stale raw state
points before lwfa's diff; raw releases without send messages implicate the
client path. Recorded edges arriving promptly at a separate XInput observer
do not by themselves prove BG3 consumes every press.

Current [WebKit button implementation](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/gamepad/GamepadButton.cpp)
derives pressed from value; the [controller callbacks](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/platform/gamepad/cocoa/GameControllerGamepad.mm)
update shoulders on both edges. Current source provides no basis for changing
the threshold to fix a seconds-long stale shoulder state, and does not prove
the behavior of the installed iPadOS release.

Raw local recordings are retained under
`target/controller-traces/bg3-2026-09-06/`, outside version control.
No speculative production change was made from these observations.

The user has completed the requested physical tapping many times. Do not ask
for another repetition of the same kernel-only test. All passive recorders
and the disposable XInput observer have finished. The next missing evidence at that time was the browser troubleshooting JSON;
it has since been supplied and analyzed below. The agent recorded
server-side input only and cannot remotely read Safari Gamepad API samples.

Source recheck: Connection.send forwards messages directly on an open socket;
the engine emits shoulder button events without an edge-coalescing queue.
This inspection does not prove what Safari sampled or which messages it sent.

## Supplied browser recording

The user supplied `~/Uploads/lwfa-controller-trace.json` after the server-side
tests. Its [summary](fixtures/controller-browser-trace-summary.json) records
the file hash and computed results without publishing the raw recording.

The ring retains 4,096 of 4,612 polls, covering 49.168 seconds. The oldest
516 samples were intentionally overwritten, so early tap counts are incomplete.
The median poll interval is 12 ms; the maximum is 26 ms. Every retained sample
is connected and exposes the same standard-mapped 8BitDo controller.

Replaying all retained samples through the actual `physical.ts::pollStep`
reproduces all 370 recorded send-action messages exactly. All 63 raw button
transitions produce the corresponding button message in the same sample.
The retained raw API exposes 14 LB presses, 10 RB presses, and eight presses
on other controls. LB/RB values are binary and their pressed flags agree.
There is no observed raw shoulder edge that lwfa's diff discards or delays.

The file also contains an RT state reported pressed from poll time 52.917 s
to 61.269 s. B becomes pressed at 61.101 s and remains pressed through the
last sample at 73.201 s. The Gamepad timestamp freezes after 61.269 s, while
JavaScript polling continues. Whether B was physically released during that
interval is not recorded; neither an intentional hold nor stale upstream
state can be ruled out from an unchanged snapshot alone. This file contains
no equivalent seconds-long shoulder hold.

The trace narrows the investigation to states before the client diff, including
controller/iPadOS/browser reporting and transitions entirely between polls.
It does not identify which of those layers missed an intended physical press.
The browser capture was not contemporaneous with the previous kernel capture;
its timestamps cannot establish new socket-to-kernel timing evidence.

A relevant historical [WebKit iOS 26 B-button focus fix](https://github.com/WebKit/WebKit/commit/7707c83355e323c15a209c63358b5fe6f0167f7a)
intercepts native game-controller navigation. The recorded UA reports Safari
26.6, so we cannot assume that older fix is absent. Native focus routing is
a plausible investigation lead, not the established cause. No automatic
release timeout or threshold change is justified: legitimate holds can also
have unchanged timestamps, and unseen presses cannot be reconstructed.


## 1.4.3 recovery patch

The live trace does not prove native focus loss caused the missing taps.
A reproducible code gap did exist: losing window focus while holding a
physical button left its engine state pressed. The hook had no blur, hidden,
or pagehide handling. Regression tests against the actual hook failed on all
three new recovery scenarios before the fix.

The hook now releases held physical input on blur, hidden, and pagehide and
suspends forwarding. Returning to the page suppresses each currently held
control until that individual control reports neutral. The new Gamepad
settings action, **Reset physical controller**, provides the same recovery
without restarting the game. A stale B no longer blocks fresh shoulder input
after recovery. Legitimate long holds are preserved during uninterrupted play;
there is no timestamp-based automatic release or invented missing tap.

This is supported by current WebKit's [native view routing](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/UIProcess/Gamepad/ios/UIGamepadProviderIOS.mm),
[snapshot synchronization](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/UIProcess/Gamepad/UIGamepadProvider.cpp),
and [tap/focus handling](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/UIProcess/ios/WKContentViewInteraction.mm).
A normal user tap can restore WKContentView's native first-responder status.
These sources support a recovery mechanism, not a claim that lwfa can repair
an upstream controller report or that this exact focus bug occurred on the iPad.

Trace schema 2 adds focus, visibility, forwarding/suspended/release modes,
and wall-clock anchors. Lifecycle releases are included; they do not split
poll-gap measurements. Ordinary forwarding messages can now reflect recovery
suppression, so raw diff-only replay must account for recovery state.

Validation uses Node 24.15.0 and TypeScript 5.9.3. The shell tests, typecheck,
and production build pass. `scripts/e2e-controller-recovery.mjs` mounts the
real React hook and Gamepad settings in Chromium with a simulated Gamepad API.
It verifies the actual reset button releases B, fresh LB works while B remains
stale, blur releases LB, focus does not replay held state, and LB rearms after
neutral. It opens no engine connection and closes its own browser/server.
Use PLAYWRIGHT_MODULE for an existing Playwright installation and optionally
CHROMIUM_EXECUTABLE for an existing Chromium binary.

This validates the app's recovery behavior, not native iPadOS focus handling.
The original physical LB/RB missing-tap issue still requires validation on the
updated iPad client. Production and BG3 were not restarted by this patch.


## Focus follow-up

The user requested the complete focus inventory before further fixes, then
approved correcting the confirmed gaps. See [Controller focus map](controller-focus-map.md)
for the 1.4.3 audit, isolated browser observations, and the subsequent 1.4.4
panel restoration, follower synchronization, and X11 focus repair changes.
The deliberately injected blur in the 1.4.3 recovery test was not a reproduction
of native iPad focus loss. The original physical-only missing-tap cause remains
unconfirmed; production has not been restarted during these changes.
