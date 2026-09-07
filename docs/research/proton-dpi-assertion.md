# Proton monitor DPI assertion

Investigated on 2026-09-07 after the 1.5.1 release.

## Finding

The scaling implementation introduced an additional trigger for this Wine
failure. It enlarges the shared Xwayland display to include individual window
workspaces. An ordinary X11 window resize can therefore change the monitor
resolution seen by unrelated Proton programs, even at 1x with a fixed browser
viewport. This is an lwfa compatibility regression as well as a Wine arithmetic
bug.

The initial investigation incorrectly ruled out the scaling work because a
forced browser viewport resize could reproduce the assertion on 1.4.5. That
test established the Wine failure mechanism, but did not compare the display
changes caused by normal window operations. The follow-up below does.

The exact sequence in the user's original game session remains unknown because
its display dimensions were not captured. The controlled comparison establishes
that the new window-driven output updates can cause the same assertion.

## Fixed-viewport comparison

The browser viewport stays at 1319x839 throughout this test. A native X11
fixture window starts at 1000x600. The passive Wine DPI observer starts before
the fixture is widened to 1324x600 through the ordinary `setLayout` message.
There is no browser resize, mode toggle, Cheat Engine, or protonhax.

| Engine | Xwayland display before and after the window resize | Wine assertion |
| --- | --- | --- |
| Released 1.4.5 | 1319x839 stays 1319x839 | No |
| Released 1.5.0 | 1319x839 becomes 1324x839 | Yes |
| 1.5.1 | 1319x839 becomes 1324x839 | Yes |

A separate 1.5.1 test leaves the fixture's browser rectangle at 1000x600 and
changes only its workspace scaling to 1.5x. The shared Xwayland display grows
from 1319x839 to 1500x900 and the same Wine assertion fires.

The changed behavior is in `x11_output.rs`, introduced by commit `d7f57ab` for
1.5.0. `x11_root_size` includes actual and configured X11 window bounds, and
`refresh_x11_outputs` publishes those bounds as the output mode and logical
size. Layout updates, scaling changes, and surface commits can call it.
Previously, that output followed the main viewport instead of individual
window extents. These output/scaling functions are unchanged between the
1.5.0 and 1.5.1 tags.

This explains why the assertion can first appear after the scaling work even
if the user does not select a scaling factor: the shared-output behavior is
active at 1x too. Not every resolution transition overflows Wine's fraction,
so earlier successful gameplay does not contradict this reproduction.

Evidence: `window-repro.mjs`, `x11-window.c`, and `window-*.json`/`.log` under
`target/proton-dpi-investigation/`. The same operation exits 0 on 1.4.5 and 1
on 1.5.1, with the captured assertion serving as the failure signal.

## Initial forced-viewport reproduction

An isolated headless Weston hosted a separate lwfa engine at port 6749, with
its own Wayland runtime, Xwayland display, authentication, and disposable Wine
prefixes. No game, production compositor, or installed prefix was changed.

A C11 Windows program built with Zig 0.16.0 repeatedly called
`EnumDisplayMonitors`, `GetMonitorInfo`, `EnumDisplaySettingsEx`, and
`GetDpiForMonitor`. It created no windows and changed no Windows display modes.
The test client changed only the isolated lwfa viewport, from 1319x839 to
1324x838 at scale 1.

| Engine | Proton | Result |
| --- | --- | --- |
| 1.5.1 | GE-Proton11-5 | Exact assertion, repeated in separate fresh prefixes |
| 1.4.5 released artifact | GE-Proton11-5 | Same assertion |
| 1.5.1 | GE-Proton11-5, mode emulation disabled | No assertion; monitor query updates to 1324x838 |
| 1.5.1 | GE-Proton10-34 | No assertion, but monitor query remains at 1319x839 |

The failing Wine process printed:

```text
../src-wine/dlls/win32u/sysparams.c:2676: monitor_get_dpi: Assertion `num * dpi / d < 65536' failed.
```

The passive probe itself could still exit successfully after another Wine
process asserted. The harness therefore checks the captured assertion, rather
than relying on the top-level Wine exit status. Its failing run exits 1.

A separate copy of the user's `cheatengine-x86_64-SSE4-AVX2.exe` was then
launched after the resize in another disposable prefix. With default mode
emulation, Cheat Engine also hit the exact assertion and opened no window.
With emulation disabled, it reached its splash screen and a `Confirmation`
dialog without the assertion. This establishes startup progress, not successful
game attachment or operation of every Cheat Engine feature.

Local harness, C source, logs, and result JSON are retained in
`target/proton-dpi-investigation/`. Test processes, runtime, credentials,
prefixes, and the copied application were removed after testing.

## Why it fails

GE-Proton11-5's Wine source stores physical and emulated current display modes
separately. The trace records the host mode changing to 1324x838 while the
probe still sees the emulated 1319x839 mode.

For non-effective DPI, `monitor_get_dpi` reduces the fraction
`physical_width * dpi / current_width`, then packs its numerator and denominator
into 16-bit fields. It asserts if either reduced component does not fit.
At 96 DPI, the test's width calculation is `1324 * 96 / 1319`. Its numerator
is 127104 and the greatest common divisor is 1, so the assertion fails even
though the resulting DPI is only about 96.36. This is not evidence of a user
having configured an enormous DPI.

Source: [Wine revision referenced by the GE-Proton11-5 tag](https://github.com/ValveSoftware/wine/blob/36078f5f947532885a596dabbc7893c048133660/dlls/win32u/sysparams.c).
See `add_modes` and `monitor_get_dpi`. GE applies additional patches, so source
line numbers differ from the packaged assertion.

The overlay preload and ProtonFixes warnings are not required for this crash:
the direct-Wine reproduction has neither Steam's preload nor the Proton wrapper.
[protonhax](https://github.com/jcnils/protonhax/blob/main/protonhax) restores the
game's environment and invokes Proton; it does not perform this DPI calculation.

## Workaround and follow-up

In disposable prefixes, setting the string value `EmulateModeset=N` under
`HKCU\Software\Wine\X11 Driver` before starting the Wine session prevented
this reproduction. This changes mode switching for the prefix and may affect
fullscreen games. It has not been applied to the user's game prefix or verified
with the running game, so it should not become a silent lwfa default.

Wine needs to handle these valid resolution ratios without asserting. lwfa
also needs to address the shared-display side effect of per-window workspace
scaling. Simply reverting the output expansion would restore the earlier X11
pointer clipping that it was introduced to fix, so a compositor fix needs both
the new Wine regression check and the existing scaled-input tests.

## Fix for 1.5.2

Xwayland now receives a fixed display resolution from its first output bind.
Its output resources are kept separate from the native Wayland output, so a
browser resize cannot briefly publish a changed monitor mode before an
override restores it. Native Wayland output updates continue normally.

The default is the host window's initial size. A larger display can be reserved
with `session.xwayland_resolution = [3840, 2160]` before restarting lwfa.
Both dimensions must be between 1 and 8192. Invalid values log a warning and
use the startup size. A large resolution is optional because games may choose
the advertised desktop size for their swapchains.

X11 workspace sizes fit proportionally within the fixed display, and their
native origins stay inside it. Their browser rectangles remain unchanged.
The scaling panel reports the effective factor and explains when a workspace
request is limited. This avoids both live monitor changes and unreachable
pixels outside X11's pointer coordinate range.

The maintained regression is `scripts/e2e-proton-display.mjs`, with native and
Windows C11 fixtures under `scripts/fixtures/`. It requires an explicitly
identified, empty, isolated engine and creates disposable Wine prefixes.
`LWFA_TEST_BROWSER_RESIZE=1` adds the earlier viewport trigger. Every case
requires completed DPI queries, an unchanged shared display, and no assertion
in any child log, regardless of Wine's top-level exit status.

Validation with GE-Proton11-5:

| Trigger | Released implementation | Fixed implementation |
| --- | --- | --- |
| Individual window growth | DPI assertion | Pass, fixed 1400x1000 display |
| Workspace scaling to 1.5x | DPI assertion | Pass, fixed 1400x1000 display |
| Browser viewport resize | DPI assertion in initial reproduction | Pass, fixed 1400x1000 display |

Results are in `target/proton-display-before/results.json` and
`target/proton-display-fixed/results.json`. The actual H.264 rendering test
also passed 24 native Wayland and X11 cases, including fractional factors,
Auto, reset, popup input, and mouse/touch input at the bottom-right edge.
Its results are in
`target/proton-dpi-investigation/fixed-scaling-rendering.json`.
Three overlapping/scrolled X11 window scenarios also passed all 18 center/edge
mouse and touch checks, recorded in `fixed-multiple-windows-dom-ready.json`.
The harness waits for Chromium's DOM resize as well as its outer window size;
the two update separately in a background window.

A configured 3840x2160 display passed the same three Wine regression cases and
X11 H.264 rendering/input checks at 1x and 2x, including a full 2000x1280
workspace. Results are in `fixed-4k-proton/results.json` and
`fixed-4k-rendering.json` under the investigation directory.

This removes lwfa's reproduced trigger. It does not patch Wine's arithmetic
or establish that every game-initiated mode change is safe. The user's game
prefix remains unchanged; the registry workaround is not part of the fix.
