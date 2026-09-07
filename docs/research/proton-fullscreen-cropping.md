# Proton fullscreen cropping

Investigated on 2026-09-08 with lwfa 1.5.2 and GE-Proton11-6, fixed for 1.5.3.

## Finding

The advertised monitor resolution and the dimensions of an individual game
window are separate values. Seeing 2560x1440 in both Plague Tale games does not
by itself explain why Innocence crops while Requiem fits. An isolated D3D11
fixture reproduced the cropping at 1x: its Win32 client and X11 window shrank
to 1324x838 while its fullscreen render buffer remains 2560x1440. The stream
contains only the top-left portion. A GDI fixture following the same browser
layout change renders all four corners correctly.

The 1.5.3 fix keeps app fullscreen geometry at the fixed monitor size and fits
the complete frame inside the browser window. The same fixture now passes,
including browser resizing, workspace changes, fullscreen exit, and a lower
emulated game resolution. This establishes an lwfa/Proton compatibility fix
that does not require the user to select scaling. An Innocence retest is still
needed to confirm the reported game behaves correctly after upgrading.

## Live observations

The user's screenshot shows Innocence's graphics menu cut off on the right and
bottom. They confirmed default 1x and reported Requiem fits despite also showing
2560x1440. On the subsequent live launch, read-only X11 inspection recorded:

| Item | Observation |
| --- | --- |
| Shared Xwayland display | 2560x1440 |
| Innocence X11 window | 1192x814 at 0,0 |
| X11 state | `_NET_WM_STATE_FULLSCREEN` |
| Engine fullscreen request | Window w11 at 02:24:30 local time |

Evidence is in `target/innocence-fullscreen/live-window-geometry.jsonl` and the
lwfa user service journal. These X11 measurements do not reveal the game's
Win32 client size, D3D back buffer, or Vulkan surface extent. An XGetImage-based
capture returned black and is not usable evidence of the rendered game frame.

A subsequent passive Win32 query connected to the game's existing Wine server
and enumerated its windows. It caught the main window minimized, with a zero
client rectangle and an offscreen outer rectangle. This does not establish the
active game's client dimensions. Evidence is in
`target/innocence-fullscreen/live-win32-geometry.json`. The user's chat is inside
the same lwfa session, so switching back to reply changes foreground state;
another foreground-and-reply request would not resolve that measurement gap.

The earlier failure to launch was separate: the game volume had no free space,
and Proton prefix setup failed with `ENOSPC`. The user freed space and the game
started. No game files or prefix settings were changed by this investigation.

## What the APIs distinguish

DXGI separates changing a target from reallocating rendering buffers.
`ResizeTarget` changes a window's size in windowed mode or its output display
mode in fullscreen. It does not resize back buffers; applications use
`ResizeBuffers` for that. Consequently, resizing a window does not prove its
render buffer changed too. [Microsoft ResizeTarget documentation](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgiswapchain-resizetarget).

`ResizeBuffers` can take explicit dimensions or use the current client area
when width and height are zero. Microsoft recommends handling window resizing
with this call. Games can therefore follow different resize paths even when
they enumerate the same monitor. The specific difference between Innocence
and Requiem remains an inference until their presentation state is measured.
[Microsoft ResizeBuffers documentation](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgiswapchain-resizebuffers).

At DXVK revision `70d7508c01201ed3d4bfb33da42ba834eafe3857`,
`EnterFullscreenMode` selects an output and requests a window covering it.
`ResizeBuffers1` separately updates buffer dimensions, querying the client
size only for zero-valued dimensions. These are distinct operations in the
implementation too. [Pinned DXVK swapchain source](https://github.com/doitsujin/dxvk/blob/70d7508c01201ed3d4bfb33da42ba834eafe3857/src/dxgi/dxgi_swapchain.cpp#L384).

DXVK also distinguishes the D3D back buffer from the Vulkan presentation image,
with a blit between them. Therefore a large D3D buffer alone is insufficient
to locate the crop: the Vulkan image and the compositor's capture rectangle
also matter. [DXVK D3D11 presentation source](https://github.com/doitsujin/dxvk/blob/70d7508c01201ed3d4bfb33da42ba834eafe3857/src/d3d11/d3d11_swapchain.cpp#L413).

## Fullscreen contract and an important Wine qualification

EWMH fullscreen means filling the screen without decorations, with the window
manager restoring the previous geometry on exit. lwfa 1.5.2 acknowledged
that state in `request_fullscreen_x11`, while its browser layout could configure
a smaller native X11 window. The fix separates those two layouts.
[EWMH window-state specification](https://specifications.freedesktop.org/wm/latest/ar01s05.html),
[lwfa handler](../../crates/lwfa-engine/src/state.rs).

Wine revision `9358696fe9a2261329f4a83aa6a65fd436106154` has an early return in
`window_update_client_config` for some fullscreen configuration changes. Its
comment describes avoiding a resize fight with the window manager. It is
incorrect to summarize this as ignoring every resize within the same monitor.
The condition calls `xinerama_get_fullscreen_monitors` on both rectangles and
requires both calls to succeed. [Pinned Wine window source](https://github.com/ValveSoftware/wine/blob/9358696fe9a2261329f4a83aa6a65fd436106154/dlls/winex11.drv/window.c#L1827).

That helper succeeds only when the rectangle fully covers at least one monitor.
A 1192x814 rectangle inside a 2560x1440 monitor is insufficient. This branch
therefore does not explain the live measurement by itself, and the fixture
confirms that Win32 can receive the smaller client size.
[Pinned Wine Xinerama source](https://github.com/ValveSoftware/wine/blob/9358696fe9a2261329f4a83aa6a65fd436106154/dlls/winex11.drv/xinerama.c#L114).

## Controlled reproduction

The test uses an independent engine, Xwayland display, and fresh Wine prefix.
It does not change the production session. The browser viewport is 1324x838,
the fixed monitor is 2560x1440, and the scaling selection remains Sharp 1x.

| Renderer | Client after layout | Render buffer | Four corners visible |
| --- | --- | --- | --- |
| Win32 GDI | 1324x838 | Draws current client area | Yes |
| DXVK D3D11 fullscreen | 1324x838 | Retains 2560x1440 | No, only top-left |

The D3D11 case intentionally retains its original buffer when the window
manager resizes the window. Its stream is 1324x838; the bottom-right mouse
coordinate reaches 1297,821, so the failure is not merely an unreachable
browser input region. This fixture models one fullscreen rendering pattern,
not every game's response to `WM_SIZE`.

Maintained sources: `scripts/fixtures/proton-fullscreen-window.c` and
`scripts/e2e-proton-fullscreen.mjs`. Initial evidence:
`target/innocence-fullscreen/fixture-baseline/results.json` and
`target/innocence-fullscreen/fixture-dxvk-baseline/results.json`, including the
failed four-corner assertion and captured JPEG. No fix was established by
these baseline runs.

## Capture measurement

A repeat of the failing D3D11 fixture instrumented the frame entering lwfa's
capture code. Every recorded capture dimension was already 1324x838:

| Capture component | Measured size |
| --- | --- |
| Window geometry | 1324x838 |
| Source buffer rectangle | 1324x838 |
| Render element destination | 1324x838 |
| Capture target | 1324x838 |
| Fixture's retained D3D buffer | 2560x1440 |

The capture stage was not clipping a 2560x1440 source into its smaller target.
The image was already cropped when it reached that stage. Changing only the
capture blit cannot recover the missing edges from this submitted surface.
This narrows the failure to presentation before lwfa capture, without assigning
it to a particular DXVK, Wine, driver, or Xwayland operation. Evidence is in
`target/innocence-fullscreen/fixture-dxvk-capture-trace/engine.log` and the
corresponding fixture result and image.

## Fix and validation

Keep the shared Xwayland monitor stable. The 1.5.2 change addressed a reproduced
Wine DPI assertion caused by changing that monitor while Proton programs were
running. Matching the shared monitor to each browser resize would restore that
failure path. See [the DPI investigation](proton-dpi-assertion.md).

App fullscreen now reserves the fixed monitor geometry independently of its
browser rectangle. Browser viewport and workspace changes cannot shrink that
native fullscreen window. Exiting app fullscreen restores ordinary window
layout. The shell fits X11 frames without distorting their aspect ratio and
maps pointer coordinates through the displayed image, accounting for the bars
around it. Sources: [layout](../../crates/lwfa-engine/src/layout.rs),
[window presentation](../../packages/shell/src/WindowSurface.tsx),
and [pointer mapping](../../packages/shell/src/input.ts).

Initial fullscreen state also needed preservation. Smithay 0.7's cached state
did not import the initial `_NET_WM_STATE` property before lwfa focused a newly
mapped window. Updating activation could then overwrite that initial property.
The X11 handler reads it after mapping has flushed the server ungrab, before
focus changes, and seeds the fullscreen state used by layout. This handles a
game that starts fullscreen without waiting for a later fullscreen request.
The cached query connection is discarded when a new Xwayland instance becomes
ready. Sources: [initial X11 mapping](../../crates/lwfa-engine/src/handlers/xwayland.rs)
and [Xwayland startup](../../crates/lwfa-engine/src/main.rs).

The final D3D11 matrix passed six image and input checks. Fullscreen kept the
Win32 client, native X11 window, and frame at 2560x1440 during ordinary browser
layout, browser viewport resizing, and workspace factors 1.5x and 2x. All four
colored corners stayed visible and normalized input reached the bottom-right.
Exiting fullscreen restored 1324x838; windowed 1.5x workspace then produced
1986x1257. The shared X11 display remained 2560x1440 throughout.

A second passing case requested a 1280x720 fullscreen D3D buffer. Wine reported
a 1280x720 emulated monitor and client while the actual X11 window and stream
remained 2560x1440. All corners were visible, and bottom-right input arrived at
1254,706 in the game's client coordinates. This checks lower in-game resolution
without changing the shared display.

Selected baseline, capture, and final measurements are retained in
[proton-fullscreen-measurements.json](fixtures/proton-fullscreen-measurements.json).
Full local results are in
`target/innocence-fullscreen/fixture-dxvk-final-matrix/results.json` and
`target/innocence-fullscreen/fixture-dxvk-1280/results.json`.
The GDI fixture also passed the six-phase matrix, recorded in
`target/innocence-fullscreen/fixture-gdi-fixed-matrix/results.json`.
An actual Chromium run of the built shell verified `object-fit: contain`,
bottom-right input at 2508,1438, and no button press sent when clicking the
letterbox margin. The margin trace contained pointer motion and a button
release, which can safely clear a previously held button. Evidence is in
`target/innocence-fullscreen/fixture-dxvk-built-shell/results.json`.

The unit suites passed 358 Rust and 690 JavaScript tests, including two new
browser pointer-mapping tests. The optimized 1.5.3 release binary also passed
the six-phase D3D11 image and input matrix, recorded in
`target/innocence-fullscreen/release-1.5.3/results.json`.

The existing Proton DPI regression passed all three cases: window growth,
workspace scaling, and browser resizing. Each retained the 2560x1440 shared
display without a Wine DPI assertion. Results are in
`target/innocence-fullscreen/dpi-fixed/results.json`. Packaging's ten failure
and extraction checks also passed. The production game has not yet been
retested with the new engine.
