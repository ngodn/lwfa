# Canvas sizing after removing display scaling

Date: 2026-09-08. Development changes, not installed in the running service.

Sharper and More space are removed, including their protocol commands, window
metadata, engine state and tests for choosing a scaling factor. Protocol v2
makes the schema change explicit. A newer shell receiving a v1 greeting asks
for an update and reload instead of reconnecting indefinitely.

Normal windows use baseline logical dimensions. Browser display density no
longer requests a higher application rendering density. Native fractional
scale/viewporter negotiation, normalized input and allocation bounds remain.
The shell fills the whole canvas, removing the aspect-fit policy that added
margins to every Xwayland window. A source with a different aspect ratio fills
that rectangle by stretching; this does not change a game's internal resolution
or remove black bars already drawn by the game.

## Protections retained

The existing right/bottom strip correction in capture is unchanged. Its only
source change is the name of the module providing the allocation check.
Geometry-origin correction, source crop rectangles, GPU rendering and CPU
readback remain intact. Popup negotiation and normalized input are retained.
Oversized window requests are bounded before configuring the application, as
well as before allocating capture buffers.

Xwayland starts at the primary browser's first valid viewport and uses ordinary
Wayland output updates after that. Only viewport changes resize the monitor.
An individual app resize does not change it. Fullscreen apps receive the shell's
requested dimensions instead of being pinned to a frozen monitor. The obsolete
`session.xwayland_resolution` key remains parseable but is ignored with a warning.
The initial launch queue remains intact; an invalid viewport cannot start X11.

This restores the pre-scaling compositor policy. It does not, by itself, fix
Wine's cached virtual modes or its DPI assertion. The separate compatibility tool below addresses those failures for the pinned
GE-Proton 11-6 build. Other Wine versions do not receive these patches.

## Direct comparison with released 1.4.5

`scripts/e2e-canvas-sizing.mjs` was run against the actual released 1.4.5 binary,
the earlier fixed-monitor candidate, and the restored standard-output candidate.

- The fixed-monitor candidate failed six phases, including a requested
  1324x600 app becoming 1319x598, and a monitor that ignored rotation.
- Released 1.4.5 and the restored candidate passed all seven phases: exact
  app dimensions, viewport-driven monitor dimensions, landscape and portrait,
  DPR 2 without dimension multiplication, pointer delivery, and reconnect.
- The built-shell startup/reload test also passed on the restored candidate.
  A selected 662x814 column survived reload with no native resize events;
  the monitor remained 1324x838. A later 1490x910 viewport changed the monitor
  to 1490x910 without changing the Xwayland PID.

Evidence: `target/canvas-baseline/released-1.4.5-ready/`,
`restored-candidate/`, `fixed-monitor-red/`, and `client-display-final/`.

## Wine compatibility validation

The same stock GE-Proton11-5 DXVK fixture retains its old virtual monitor after
resizing under both released 1.4.5 and the restored candidate. This is a Wine
limitation already reachable before scaling. Scaling introduced additional
window-driven monitor changes, making it easier to trigger. Freezing the output
then added a separate lwfa sizing regression.

A disposable exact-version Wine candidate fixes the arithmetic assertion and
adopts a new physical mode when the virtual mode was following the old desktop.
Its GDI fixture passes four viewport transitions with matching Win32, X11 and
stream dimensions, four visible corners and bottom-right input. A passive DPI
observer passes 1319x839 to 1324x838; stock GE asserts on the same transition.
Neither runtime changes the monitor during an individual app resize.

Later GE11-5 candidates fix the stale presentation rectangle, native client
configuration and centered Vulkan child origin. Five repeated responsive DXVK
matrices pass, as do retained backbuffers and an explicit 1280x720 mode through
growth, portrait, shrink and restoration. Two-process tests distinguish an
explicit mode from desktop following, including restoring the current desktop
with `ChangeDisplaySettings(NULL)`.

The final target is GE-Proton11-6, prepared from its exact upstream source and
compiled separately for both architectures. Five consecutive native-responsive
DXVK matrices pass, alongside retained backbuffers, an explicit 1280x720 mode,
the DPI observer and two-process mode/cursor checks. Full 32-bit GDI and both
32-bit DXVK buffer policies pass on the NVIDIA GPU.

Testing found and corrected a presentation-update ordering error: server hit
bounds retained 1490x910 after the client became 838x1324. The corrected code
computes proposed presentation bounds before sending the position update, then
commits the stored presentation only after success. Custom cursor bounds use
the same centered aspect-fit transform as virtual monitor coordinates.

The earlier 32-bit stall also occurred on stock GE because direct Wine tests
lacked Steam's 32-bit libXi. Supplying a private copy resolves the original
runtime; the builder now requires XInput and XRender support in both generated
configurations. These are normal Steam runtime dependencies, not host changes.

The final reproducible artifact also passes the full 64-bit DXVK matrix through
the registered tool's actual launcher. Real process mappings verify original
libraries on host launches and private libraries inside lwfa. Opposite-runtime
attachment to an active prefix is refused in both directions, and the original
GE hashes remain unchanged. Canvas mode state is absent from saved registry
files after the test Wine server exits.

The 1.5.5 test installer includes this host-built artifact. It requires the
matching original GE tool and explicit game selection in Steam. A portable
release needs a Steam Runtime SDK build; passing these tests does not establish
compatibility with every game or other Proton versions.
See [the source investigation](canvas-sizing-upstream.md).
The [condensed Wine measurements](fixtures/proton-canvas-measurements.json)
retain the final artifact hash, rendered corner checks, input coordinates,
mode/cursor observations and launcher-isolation results.

Dependency candidates are under `target/wine-canvas/` and
`target/wine-canvas-11-6/`, copied from the installed runtime without hard links.
Installed Proton and user prefixes have
not been modified. Tests use disposable prefixes and isolated engines.

## Rejected monitor replacement experiment

An isolated experiment replaced the Xwayland output with a fresh RandR identity
on each viewport resize. A passive GE-Proton11-5 DPI observer completed the
previous failing 1319x839 to 1324x839 transition without an assertion.

It failed the fullscreen image test. After a 1324x838 to 1490x910 resize, native
window and stream dimensions became 1490x910 while the Win32 client and DXVK
swapchain remained 1324x838. The expected right and bottom corner samples were
black. The experiment was removed from the final code.

Local evidence is under `target/canvas-sizing-removal/`: the rejected patch,
`output-replacement-review.md`, `dpi-experiment/` and `fullscreen-experiment3/`.
The failure demonstrates why passing a DPI query alone is insufficient. See
[the Wine crash investigation](proton-dpi-assertion.md) and
[the fullscreen crop investigation](proton-fullscreen-cropping.md) for source
references and the original reproductions.

## Current standard-output regression coverage

- Rust workspace: 326 engine tests, 23 protocol tests, two cross-language tests
  and 11 spring tests passed. Six optional hardware/display tests were ignored.
  The later viewport-boundary test also passed after adding upper bounds.
- JavaScript: 721 tests passed, with TypeScript checking and the production
  shell build passing.
- Browser canvas/input: eight cases across four frame sizes and DPR 1/2 pass.
- Native capture: 48 cases pass on Wayland/X11, JPEG/H.264 and GPU-direct
  enabled/disabled. Each run includes 1000x640, the original 802x602 strip
  trigger, 1324x838, restoration, and DPR changes. All four colored edges,
  input, touch and popup checks pass. No right columns or bottom rows are black.
  The direct H.264 log confirms GL capture feeds NVENC on the GPU. The CPU
  readback configuration still encodes with NVENC.
- Zen: 18 recorded HEVC frames and five live resize stages pass through the
  real FrameDecoder. The test enables WebCodecs H.265 only in a private profile.

[Native measurements](fixtures/canvas-sizing-edge-measurements.json) keep the
48 current cases separately from the 52 earlier fixed-monitor cases. See
[Zen HEVC measurements](zen-hevc.md) for its separate profile/backend checks.
These results cover capture and shell regressions separately from the Wine
checks above. The test package is ready for real-game validation before release.

## Earlier removal-only regression coverage

These results predate the restored monitor policy above. New measurements must
be identified separately; the previous fullscreen tests used a fixed monitor.

- Browser fixture: four frame sizes, including 1324x970 and 2560x1440, in a
  1000x500 canvas at DPR 1 and 2. All screenshot corners remain visible and
  pointer/touch input aligns at 1%, 50% and 99%.
- GE-Proton11-5 DXVK fullscreen: all four colored corners and bottom-right
  clicks pass through landscape, portrait, small-window and restore layouts.
  Native fullscreen size remains stable; leaving fullscreen restores the
  requested normal window size. The built shell reload also passes.
- Startup/reconnect: the first valid browser viewport selects 1324x838. A
  deliberately selected 662x814 column survives a real shell reload with no
  native resize events.
- GE-Proton11-5 DPI observer: window growth and browser resize both complete
  all queries without the previously reproduced assertion.
- JavaScript suite: 721 tests passed. Protocol and connection tests were rerun
  after making the version-error class compatible with Node's TypeScript
  stripping.
- Rust checks: 327 engine, 23 protocol, two cross-language and 11 spring tests
  passed; six optional engine tests were excluded. The engine suite includes
  eleven geometry tests, including pre-configure allocation bounds.

Native pixel checks passed 52 cases: 28 with GPU-direct enabled and 24 with
CPU readback, on native Wayland and X11, through JPEG and H.264. Every case
has zero fully black right columns and bottom rows, all four colored content
edges, correct mouse/touch input and the requested codec. The CPU sequence
includes the original 802x602 strip reproduction. Native popup checks pass.
[Condensed measurements](fixtures/canvas-sizing-edge-measurements.json) retain
all dimensions, codec IDs and edge colors.

The original Chromium run advertised H.264 only. Subsequent tests with Zen
passed 18 HEVC decoder cases and five live resize stages using its WebCodecs
H.265 preference in a disposable profile. See [Zen HEVC results](zen-hevc.md). The rendering
fixture waits up to ten seconds for all four strict color markers, allowing
Chromium's temporary fullscreen hint and native resize repaint to finish.
Persistent missing edges still fail. This checks settled correctness, not
resize latency or visual quality on the user's iPad.
Tests use an isolated compositor, temporary application profiles and temporary
Wine prefixes. The production service and game settings are not modified.
