# Client display sizing and refresh

This records the 1.5.4 investigation. Scaling controls and the blanket X11
letterboxing described below have since been removed. See
[the current behavior and regression checks](canvas-sizing-removal.md).

Investigated on 2026-09-08 after 1.5.3.

## Reproduced causes

Xwayland bound its output before the browser sent a viewport. The 1.5.2
Wine compatibility fix then froze the host's startup size for the session.
An isolated 2560x1440 host still advertised 2560x1440 after receiving a
1324x838 browser viewport at DPR 2. With the startup change, the same test
advertises 1324x838. DPR does not multiply the desktop resolution.

Separately, the shell rebuilt its arrangement from window IDs on every hello.
A selected 662x814 column became the default 1192x814 column. The shell now
validates its saved tab arrangement against the engine's current layout before
restoring it. All hello paths include that existing layout message. No wire
schema change is needed, and older engines have a bounded fallback.

The user clarified that Resident Evil Requiem's observed mode changes happened
while refreshing lwfa, without changing game settings. The reconnect resize
is reproduced, but that does not prove the game's particular fullscreen
request was caused by it.

## Startup policy

Automatic Xwayland startup waits for the first valid primary viewport.
Application launches wait until its DISPLAY is ready, including the initial
terminal. A failed or timed-out startup releases native Wayland launches
without inheriting the host's DISPLAY. An explicit resolution starts Xwayland
without waiting for a browser. A deliberate local launch can also initialize
it from the host size.

The monitor stays fixed once applications start. Browser reconnects and
presentation resizes must not change an active Wine session's monitor.

## Scaling paused

At the user's request, Sharper and More space are temporarily disabled for
both Wayland and X11 windows. The controls are removed and the engine accepts
only the default sharp/1x policy. Auto and other requests from cached clients
are rejected. Window scaling was session state, not a browser preference or
a saved application setting; an upgraded engine starts with empty state.

This avoids presenting X11 scaling that cannot fit within a client-sized
fixed monitor. Restoring it needs a display design that supports independent
application resolutions without changing unrelated Wine sessions.

## Wine constraint

GE-Proton11-6 retains its emulated current mode separately from the physical
monitor mode. Its DPI calculation can assert for valid fractional ratios
after the physical mode changes. Changing Wayland event order cannot update
Wine's private mode atomically. See the
[pinned Wine implementation](https://github.com/ValveSoftware/wine/blob/9358696fe9a2261329f4a83aa6a65fd436106154/dlls/win32u/sysparams.c)
and [the existing crash reproduction](proton-dpi-assertion.md).

Independent game displays are a larger option. Gamescope documents separate
game and presentation resolutions inside its own Xwayland sandbox:
[Gamescope README](https://github.com/ValveSoftware/gamescope/blob/master/README.md).
No Wine registry changes or game-prefix modifications are part of this fix.

## Cursor evidence

The frontend image-to-input mapping passed a 30,603-point grid, including
2560x1440 contained in 1324x838. Its letterbox correction is consistent with
the rendered image. The existing 24-pixel edge-parking behavior intentionally
shifts positions near edges; it does not explain the central pointer shown
in the user's screenshot. The live game's Win32 cursor and internal render
extent were not measured together, so its cursor offset remains unverified.

## Regression commands

- `scripts/e2e-client-display.mjs`: startup, queued app DISPLAY, reconnect and
  fixed monitor checks. `LWFA_TEST_BROWSER=1` adds an actual shell reload with
  a non-default column width and records native geometry transitions.
- `scripts/e2e-proton-fullscreen.mjs`: Wine/DXVK window, rendered corners and
  pointer positions, with the selected monitor measured after the viewport.
- `scripts/e2e-proton-display.mjs`: the prior Wine DPI assertion triggers in
  disposable prefixes.

All require an explicitly identified isolated engine. They do not discover or
modify the production game session.

Validation on GE-Proton11-6:

- Automatic startup: 1324x838 at browser DPR 2; queued application inherited
  the correct DISPLAY. Refresh and later viewport changes kept the same server
  and monitor. An explicit 2560x1440 override also passed.
- Actual Chromium reload: 1192x814 default column changed to 662x814 through
  the Windows panel. Reload sent one 662x814 layout and produced no native
  ConfigureNotify resize events.
- DXVK fullscreen: 1324x838 Win32 client, X11 window and captured frame;
  all four corner markers and bottom-right input passed. Rejected workspace,
  sharp and Auto requests preserved these dimensions.
- Wine DPI: window growth, rejected workspace scaling and browser resizing
  all completed their queries without the assertion.

An additional 1280x720 DXVK emulated fullscreen case exposed an incorrect
test assumption. Wine fits that image inside the 1324x838 monitor, adding
approximately 47 pixels above and below it. The harness had sampled and
clicked those black margins. It now samples the known render rectangle and
maps the test click through that same rectangle. Passing runs show all four
markers and a bottom-right Win32 click at 1254,705.

That extra case is still intermittent. Some runs stop delivering frames,
timer observations, or input before the timeout. Explicitly focusing the
fixture does not reliably prevent it. A controlled native/emulated/native/
emulated sequence passed all four runs. A subsequent monitor comparison had
one pass and one timeout at the earlier fixed 2560x1440 monitor, and two
timeouts at 1324x838. This therefore is not specific to the new monitor size,
but its cause remains unresolved. Do not count the emulated-resolution case
as a reliable passing regression or claim that its stalls are fixed.

During the investigation, GPU samples showed 17–21% utilization and about
4.3 GiB used out of 12.3 GiB, providing no evidence of sustained GPU
saturation. One protocol-traced run delivered frame callbacks and buffer
releases continuously and rendered the complete letterboxed image. Kernel
ptrace restrictions prevented obtaining a fixture backtrace. These
observations do not establish whether the intermittent stall originates in
the fixture, Wine/DXVK, the driver, or the compositor.

Artifacts are under `target/innocence-fullscreen/`: `client-display-browser-verified`,
`explicit-display`, `one-x-fullscreen`, and `one-x-dpi`. These checks do not
establish a live Resident Evil Requiem cursor fix; that needs a game test after
upgrading.

Additional local evidence: `emulated-protocol` contains the captured image
and saved Wayland trace; `emulated-focused-1` and `emulated-focused-2` contain
passing image/input checks; `mode-comparison` contains the four alternating
native/emulated passes; and `monitor-comparison-*` contains the fixed versus
client-sized display comparison, including failures and thread wait states.
Failed fullscreen runs now retain observation counts and their last JPEG.
