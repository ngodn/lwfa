# Window scaling status

Historical record. Sharper and More space were removed on 2026-09-08.
See [the removal and regression checks](canvas-sizing-removal.md) for current behavior.

Status as of 2026-09-07. Version 1.5.0 is implemented and verified locally,
ready for the user's package/upgrade test. It has not been installed into the
production compositor or published as a release.

## Requested behavior

The user selected **both modes** after correcting an accidental question reply:

- Sharper: keep application logical size and browser layout unchanged; request
  more rendering detail from native Wayland apps.
- More space: multiply the app's workspace dimensions while keeping its browser
  rectangle unchanged. Text generally gets smaller above 1x and larger below 1x.
- Both expose 0.5x, 0.75x, 1x, 1.25x, 1.5x, 1.75x, and 2x per window.

The initial default remains 1x. Sharper also offers Auto, based on the primary
client's display density and bounded at 2x. Xwayland's per-window same-size HiDPI
is not promised: its controls explain the limitation, while More space remains
available. Settings belong to a live window and are shared with other clients.

The user also requested checking newer dependencies, adapting to them, and
looking for concrete rendering, connection, and Rust logic improvements. The
dependency audit runs alongside the scaling work; upgrades follow verification
of the initial implementation so new failures can be attributed correctly.

## Implementation approach

Protocol version 1 adds per-window scaling configuration and normalized pointer
and touch coordinates. Native Wayland uses preferred fractional and integer
buffer scales plus the viewporter protocol. Capture scales the surface tree,
its crop origin, and its popups consistently. Workspace mode changes application
configure sizes independently of the shell rectangle. The local preview fits
actual committed application geometry into the shell rectangle, independently
on each axis; its input mapping uses the inverse of the same transform.

The browser keeps canvas backing pixels equal to received frame pixels and CSS
layout independent of them. Gesture thresholds use layout pixels. Only the
engine maps normalized positions into actual application coordinates.

## Evidence so far

| Capability | Status | Evidence |
| --- | --- | --- |
| Panel modes, factors, Auto, limits, and permission behavior | Passed isolated browser | `scripts/e2e-window-scaling-panel.mjs` |
| Stable 1000x500 browser layout and pointer/touch fractions at all factors, DPR 1 and 2 | Passed isolated browser with supplied frames | `scripts/e2e-scaling-input.mjs` |
| TypeScript integration | Passed final typecheck and 679 tests | TypeScript 7, Vitest 5, regenerated protocol fixtures |
| Native buffer density, application layout, pointer/touch, and edges | Passed 105 live cases | Original 96-case matrix plus nine cases through the real shell FrameDecoder |
| Native menus and popup input | Passed 25 live checks | Both backends at workspace 2x and reset 1x, plus native Wayland sharp 2x |
| Engine bounds, normalized input, and scale transitions | Rust and native checks pass | 307 engine tests, 23 protocol tests, two cross-language fixture checks, 11 spring tests |
| Local preview and input fitting | Eight focused tests pass | Actual geometry, independent axes, fixed/minimum-size clients, CSD crop, drag projection, and opaque fitted rendering |
| Additional source detail at 2x | Measured | Half-CSS-pixel grating has 223 transitions at 2x versus zero at 1x, in each native codec/configuration run |
| Codec cost, host-preview screenshots, and iPad behavior | Not measured | The native fixtures do not certify bandwidth, latency, or device compatibility |
| Encoder cleanup without new frames | Three queue tests pass | Idle cleanup, 64-window control burst with a full frame queue, and shutdown wakeup |
| Real shell decoder with actual-size capability negotiation | Nine native H264 cases passed | Actual FrameDecoder, protocol frame parser and SPS/configuration logic bundled from shell source |
| Independent X11 windows and negative layout positions | Three scenarios, nine input alternations passed | Concurrent H264 streams, distinct workspace factors, no input delivered to the other app |
| HEVC browser decoding in this test environment | Unsupported | Real `decodable()` probe returned only H264; HEVC native browser matrix was skipped explicitly |
| HEVC encoder and software decoder | 12 combined H264/HEVC checks passed | Normal to 4000x3000 to normal, standalone resize and forced-IDR decoding, correct dimensions and edge colors |
| Codec fallback and reconnect cleanup | Six real-App browser scenarios passed | Rejected HEVC/H264 reaches JPEG, stale probes cannot restore failed codecs, reconnect retires missing windows and preserves surviving ones |
| Dependency upgrades | Frozen install, typecheck, unit, browser, and portable checks passed | See the dependency audit for exact versions and retained toolchains |
| Portable package | Final isolated checks passed | Seven ELF files checked, maximum GLIBC 2.30, Debian 13 missing only documented libdrm2; actual installer cancellation exited without installing; bundled assets/docs match source |

The [measurement artifact](fixtures/window-scaling-measurements.json) contains
four complete 24-case runs, nine more H264 cases through the real shell decoder,
three multi-window scenarios, and the original X11 input-clamping diagnosis. At
workspace 1.5x, the fixture requested content position (870, 612.59), but X11
initially delivered (869, 583), the bottom of its old root screen. Expanding an
Xwayland-only output fixed this while leaving browser layout unchanged. The
same case now reaches the target, as do workspace 1.75x and 2x.

The first two runs allowed GPU-direct capture in configuration. They did not
independently establish whether the driver used zero-copy or fell back. The
other two explicitly disabled GPU-direct capture and exercised CPU readback.
All runs had zero fully black right columns or bottom rows. JPEG 2x grating
contrast was approximately 127 RMS intensity units, compared with zero at 1x;
H264 measured 127.5 versus approximately 0.044. These measurements establish
additional resolved source detail, not a universal text-quality or latency claim.

The real-decoder rerun bundles `FrameDecoder`, the actual protocol frame parser,
codec probes, and parameter-set parser from the shell with Vite. It records the
actual codec strings, dimensions and browser support results. The original
96-case matrix used the earlier small fixture decoder; the artifact preserves
that distinction instead of retroactively claiming it exercised new code.

The two-X11-window scenarios use overlapping native window geometries with
independent 2x/0.75x factors, then a 2000-pixel-wide tile positioned at CSS x=-1000
with workspace 0.5x and 2x. Each alternates first window, second window, then
first again. Every intended button receives mouse and touch input, while the
other app receives neither. Both concurrent H264 streams pass through the real
FrameDecoder. This verifies the negative-origin fix against actual Xwayland,
not just arithmetic fixtures.

HEVC is not advertised by Chromium in this environment. Its explicit capability
probe and skipped status are recorded separately. Standalone NVENC HEVC encoding
and FFmpeg decoding passed at 1000x640, 4000x3000, and back to 1000x640, including
independent decoding of forced IDRs. The actual HEVC level changes from 4.1 to
6.0 and back, confirming why a fixed 5.1 declaration was insufficient. These
checks cannot substitute for browser or iPad hardware decoding.
The shell's actual SPS parser matched all 12 hardware packets, including HEVC
High/Main tier transitions. See [hardware codec recovery](codec-resize-recovery.md).

Final workspace tests passed 307 engine, 23 protocol, two parity, and 11 spring
tests. Five environment-dependent tests are ignored in the default suite;
the new hardware codec recovery test was also run explicitly and passed.

The live fixtures used only the root-owned dev engine and their own Chromium
profiles. All fixture browsers were closed after each run. Production and BG3
were not restarted or given synthetic input.

## User verification and release

The user requested a commit and version bump, followed by their own package and
upgrade test. Public release comes later. Build with
`mise exec -- scripts/package-portable.sh`, run `./releases/lwfa-1.5.0.run`, and
reload connected browser tabs for protocol version 1. Check both display modes,
HEVC on the actual iPad, and the normal game/controller/audio workflow before
publishing. The existing Safari/WebKit physical-controller limitation remains.

Never restart production or BG3, send test input into production, change desktop
configuration, or run the installer against the user's home for these tests.
