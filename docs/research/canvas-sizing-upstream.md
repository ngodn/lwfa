# Canvas sizing and Wine display compatibility

Researched on 2026-09-08; experiment status updated 2026-09-09. This document separates source findings from proposed
patches. No installed Proton runtime or game prefix was changed by this research.

## Current finding

Ordinary browser-driven output changes can be restored, but the tested GE Wine
build needs compatibility corrections for cached modes, fullscreen geometry,
presentation destinations and cursor clipping. The work now has a source-pinned
GE-Proton11-6 candidate with both Unix architectures and a matching private
wineserver. No original runtime or real game prefix has been modified.

The third GE11-6 candidate passes five consecutive native fullscreen DXVK
resize matrices, plus the full 32-bit GDI matrix and two-process native-mode,
explicit-mode and custom ClipCursor checks. The earlier missing native click
was caused by a stale server visible rectangle, now corrected before the
position request. The 32-bit stall came from a missing libXi dependency; both
the stock control and corrected candidate dispatch input normally when that
runtime dependency is available. Retained-buffer and lower-resolution final
regression checks are recorded below as their results become available.

The sections below preserve the original source research and experiment rationale.
The build and routing recipe is in [compat/wine-canvas](../../compat/wine-canvas/README.md).

Changing monitor identity passed the passive DPI test but failed fullscreen
presentation. It is not a substitute for fixing the original mode-change path.
See [the existing DPI reproduction](proton-dpi-assertion.md) and
[fullscreen capture measurements](proton-fullscreen-cropping.md).

## The newer Wine ratio type does not fix the assertion

Wine introduced a ratio structure in
[ea2dfc84614a31c041c51b983a240baadf460e6a](https://github.com/wine-mirror/wine/commit/ea2dfc84614a31c041c51b983a240baadf460e6a),
then used it in the server in
[e749e2bffaa663b3cea366a9ea773ea630aa29da](https://github.com/wine-mirror/wine/commit/e749e2bffaa663b3cea366a9ea773ea630aa29da).
These changes cross the Wine client/server protocol and affect many modules;
they are not a drop-in replacement for one DLL in an older Proton build.

The subsequent rational-DPI change,
[2587d2822c986f525ce96e2176bd41d01dcb5593](https://github.com/wine-mirror/wine/commit/2587d2822c986f525ce96e2176bd41d01dcb5593),
still asserts that the reduced numerator and denominator fit in 16 bits.
That restriction is also present in Wine master as inspected at
[490f6d5dcbb2a5047345b8af88d114bbcaad69a8](https://github.com/wine-mirror/wine/blob/490f6d5dcbb2a5047345b8af88d114bbcaad69a8/dlls/win32u/sysparams.c#L320).
Its protocol fields remain `unsigned short`.
[Protocol definition](https://github.com/wine-mirror/wine/blob/490f6d5dcbb2a5047345b8af88d114bbcaad69a8/server/protocol.def#L275).

Therefore upgrading solely because a Wine version contains `struct ratio` is
not an established cure for this failure. The searched primary sources did not
identify an existing overflow fix to backport.

## Why standard output changes need two corrections

GE-Proton's inspected Wine source keeps a physical mode and an emulated current
mode. `add_modes` retains the previous virtual mode on a physical mode change.
`monitor_get_dpi` subsequently reduces `physical * dpi / current`, which can
overflow the packed numerator for harmless dimensions. The default emulation
setting also collapses an advertised host modelist to one mode, so adding a
second mode does not bypass this logic.
[Pinned GE Wine base](https://github.com/ValveSoftware/wine/blob/9358696fe9a2261329f4a83aa6a65fd436106154/dlls/win32u/sysparams.c).

The first correction is arithmetic. A bounded rational approximation, used only
when the exact reduced fraction does not fit, can preserve the existing ABI and
avoid aborting. For the reproduced width change, the exact fraction is
`127104/1319`; `64082/665` fits both fields. A local rational calculation gives
about 0.000194 pixels of proportional error at 8192 pixels. This is a numerical
example, not a tested Wine patch. Tests must cover both axes, unusual DPI values,
zero/detached modes, rounding and intermediate multiplication bounds.

Forcing every raw DPI result to 96 is not equivalent. Wine uses the difference
between window DPI and raw monitor DPI to activate its Vulkan presentation
scaling. Suppressing that difference can break deliberately emulated resolutions
and pointer mapping.
[Vulkan scaling decision](https://github.com/ValveSoftware/wine/blob/9358696fe9a2261329f4a83aa6a65fd436106154/dlls/win32u/vulkan.c#L2524).

The second correction is mode policy. A candidate patch should detect when the
previous virtual mode matched the previous physical desktop mode, then update
both to the new physical mode. A deliberately selected lower virtual resolution
should remain distinct. This needs a reliable previous-mode snapshot and tests
across multiple processes sharing the display cache. It is a proposed Wine
change, not behavior the compositor can demand through ordinary RandR events.

## Existing configuration scope

The inspected Wine code supports `EmulateModeset` under
`HKCU\Software\Wine\X11 Driver` and the executable-specific
`HKCU\Software\Wine\AppDefaults\app.exe\X11 Driver`. The app key overrides the
general key, but persists in the prefix and affects subsequent runs of that
executable, including runs on the host. No process environment override for this
option was found in that code path. The value is read during initialization.
[Configuration lookup](https://github.com/ValveSoftware/wine/blob/9358696fe9a2261329f4a83aa6a65fd436106154/dlls/win32u/sysparams.c#L6170).

Proton's documented runtime options at
[d28b7bc82d3ca7226fe6ef454c87116261ca9534](https://github.com/ValveSoftware/Proton/blob/d28b7bc82d3ca7226fe6ef454c87116261ca9534/README.md#runtime-config-options)
do not document a mode-emulation switch. `PROTON_USE_WINED3D` changes renderer;
it does not repair the shared display/DPI code reached by the passive probe.

A custom runtime could add an explicit environment switch for the proposed
desktop-following policy or for the existing emulation option. Reading it in
Wine initialization would avoid permanently editing user game configuration.
That switch would be new lwfa compatibility code, not a supported stock Proton
option. It must be scoped to children launched inside lwfa, and its behavior with
other processes in the same Wine server must be tested. Writing a registry value
before launch and restoring it afterward is not a reliable per-process substitute.

## Fullscreen behavior and next experiment

DXVK stores fullscreen state privately. Removing the X11 fullscreen property
does not itself turn a swapchain into a windowed swapchain.
[DXVK fullscreen query](https://github.com/doitsujin/dxvk/blob/70d7508c01201ed3d4bfb33da42ba834eafe3857/src/dxgi/dxgi_swapchain.cpp#L264).
Wine's Vulkan surface extent can use its private presentation rectangle before
the current client rectangle, so forcing a native window resize does not prove
that presentation geometry followed.
[Wine surface extent](https://github.com/ValveSoftware/wine/blob/9358696fe9a2261329f4a83aa6a65fd436106154/dlls/win32u/vulkan.c#L1762).

The next useful comparison is a stable output identity with ordinary mode events,
not another monitor hotplug experiment:

1. Use a separate copy of a pinned Proton runtime and disposable prefixes. Apply
   the arithmetic patch first, then the desktop-following policy separately.
2. Start from the actual browser canvas size at 96 effective DPI. Change the
   existing output mode and native window layout together, as the real shell
   does. Exercise both growth and shrinkage without delays that hide ordering.
3. Record physical monitor, virtual monitor, Win32 client, native X11 window,
   Vulkan presentation and captured frame dimensions. Require all four colored
   corners, continuous presentation and correct edge input.
4. Repeat with a lower in-game emulated resolution, two Wine processes, fresh
   and reused disposable prefixes, rotation and browser reconnect.
5. Keep the unpatched runtime as the failing control. Do not replace user runtime
   files or enable dynamic monitor changes for stock affected Proton builds on
   the strength of the passive DPI result alone.

This path could restore normal canvas sizing while preserving explicit in-game
resolution choices. Only the full presentation and input comparison can establish
that result.

## Private runtime candidate

A GE-Proton11-5 candidate was built under `target/wine-canvas/`, using its pinned
Wine revision `36078f5f947532885a596dabbc7893c048133660` and staging revision
`6cc805ea57132eeaf44764e9213823c9b8d0d300`.
[GE tag and submodule pins](https://github.com/GloriousEggroll/proton-ge-custom/tree/GE-Proton11-5).
Only the copied runtime's Unix `win32u.so` was replaced; installed files and PE
DLLs were preserved. The new flags are `WINE_CANVAS_DPI_SAFE=1` and
`WINE_CANVAS_FOLLOW_HOST=1`. Both default off.

The Unix library built successfully and its 509 exported names match the
installed original. A separate arithmetic test covered 175,224 selected
dimension/DPI cases. Exactly representable fractions stayed exact; the largest
proportional error in that sample was 0.06491 pixels at 8192 pixels. These checks
do not establish runtime ABI or fullscreen correctness.

GE's published patch sequence produced some rejected hunks in unrelated modules,
which are recorded in the retained preparation logs. No rejected hunk affected
win32u or the server protocol. Build commands, source edits, hashes and this
provenance limitation are recorded in `target/wine-canvas/README.md`.


### Fullscreen resize dependencies found in the isolated tests

The passive DPI result did not cover three independent caches in this GE build:

1. `win32u/sysparams.c:add_modes` retains the virtual current mode when the host
   mode changes. The candidate records whether the current and default desktop
   modes follow the host, in the existing volatile per-source cache. Explicit
   non-native modes retain their intent even when the host later reaches the
   same geometry. Mode writes use Wine's existing cross-process display mutex.
2. `winex11.drv/window.c:window_update_client_config` suppresses fullscreen
   ConfigureNotify changes if both rectangles cover the same monitor identity.
   The candidate disables that suppression only for the opted-in canvas session.
3. `win32u/window.c` retains the presentation rectangle supplied through
   `D3DKMT_ESCAPE_SET_PRESENT_RECT_WINE`. Vulkan child geometry prefers that
   rectangle over GetClientRect on every present. Updating only the Win32 client
   and swapchain therefore left the rendered image inside the old destination,
   with black pixels along the enlarged edges. The candidate advances the
   presentation rectangle only when it matched both the old window and client
   rectangles exactly. Custom presentation subregions are preserved.

These paths are in the pinned GE Wine sources, especially the
[X11 fullscreen configuration path](https://github.com/ValveSoftware/wine/blob/36078f5f947532885a596dabbc7893c048133660/dlls/winex11.drv/window.c),
[X11 client surface geometry](https://github.com/ValveSoftware/wine/blob/36078f5f947532885a596dabbc7893c048133660/dlls/winex11.drv/init.c),
and [present rectangle storage](https://github.com/ValveSoftware/wine/blob/36078f5f947532885a596dabbc7893c048133660/dlls/win32u/d3dkmt.c).

The parent fixture passed one complete responsive DXVK sequence with all three
changes, including growth, rotation, shrinkage, restoration, fullscreen exit,
colored corners and edge input. A repeat stalled Win32 resizing while the native
monitor continued changing. This is not a complete fix yet. The next diagnostic
records Wine's pending WM/configure serials to test whether an unacknowledged
window-manager request blocks subsequent ConfigureNotify processing.

The patch is deliberately scoped to a new private runtime. An original or
flag-disabled process sharing the same Wine display cache cannot maintain its
extra mode-intent fields. Tests therefore need multiple processes in one
consistently configured private runtime, plus explicit lower-mode restoration.
Neither a generic WINEDLLPATH overlay nor replacing arbitrary installed Proton
libraries provides that guarantee. Wine's built-in library directory precedes
WINEDLLPATH, and its PE built-in loader opens the paired Unix library there.
[Wine built-in loading](https://github.com/ValveSoftware/wine/blob/36078f5f947532885a596dabbc7893c048133660/dlls/ntdll/unix/loader.c).

## GE-Proton11-6 evidence and packaging status

The exact target is GE-Proton11-6-x86_64, GE commit
`7e88cefffc122ea1584c2156b8d7bae6cf69b2a7`, Wine revision
`9358696fe9a2261329f4a83aa6a65fd436106154`. The source manifest pins archive
hashes, preparation inputs, 151 prepared source/header files and original runtime
files. Both Unix export sets match the original runtime. That comparison checks
the exported interface, not optional library feature parity.

The custom clipping failure came from treating physical and virtual rectangles
as independent horizontal and vertical stretches. Wine presents an emulated
resolution with one uniform scale and centered letterboxing. Mapping each clip
edge through that same transform preserves the application's custom interval.
Public GetClipCursor also needs to exclude physical letterbox bars when returning
virtual desktop bounds after ClipCursor(NULL).

Current evidence is retained under ignored target directories:

- `target/canvas-baseline/ge11-6-lower`: explicit 1280×720 DXVK rendering,
  four corner pixels and edge clicks through physical growth, portrait, shrink
  and restoration passed.
- `target/proton-final-mode-clip-v2/gpu-modes/results.json`: native following,
  explicit lower-mode persistence across convergence/divergence, default-mode
  reset and custom clipping passed in both persistent Wine processes. Custom
  bounds remain within one pixel after growth and portrait changes.
- `target/canvas-baseline/ge11-6-point-trace-2`: proved the missing native click
  was rejected by the game's stale server visible rectangle (1490×910) despite
  its current window/client being 838×1324. Surface preparation had read the old
  presentation destination before the position request committed its new value.
  The correction computes proposed presentation and visible bounds together,
  preserving explicit subrectangles and committing state only after success.
- `target/canvas-baseline/ge11-6-v3-responsive-1` through `-5`: five consecutive
  native fullscreen resize matrices passed after that correction, including
  all corner pixels and edge input, without diagnostic traces.
- `target/proton-final-gdi32/gpu-modes/results.json`: all six 32-bit GDI stages
  passed with libXi and XRender available: initial, growth, portrait, shrink,
  restore and fullscreen exit. Each checks frame/window/client dimensions,
  four corner pixels and normalized bottom-right input.
- `target/proton-gdi32-diagnosis`: original GE11-6 could not load libXi.so.6 on
  the host. Its fullscreen clipping fallback repeatedly released and reacquired
  clipping, starving GetMessage. Supplying only the private Steam libXi library
  restored dispatch without changing Wine or the fixture. The new builder requires
  XInput2/libXi and XRender instead of silently building without these features.
- `target/proton-final-mode-clip-v3/gpu-modes/results.json`: the final candidate
  also passed the two-process mode and custom-clip scenarios.
- `target/proton-final-dxvk32-responsive/gpu-modes/results.json` and
  `target/proton-final-dxvk32-retained/gpu-modes/results.json`: both 32-bit DXVK
  matrices passed all six stages on the NVIDIA RTX 3060 (driver 610.57.4,
  DXVK 3.10), including four colored edges and far-corner input.

The registered tool must route host launches to the original GE installation,
and nested launches to its private patched copy. It must not replace an existing
GE installation, modify Steam's per-game selections, or silently combine two
runtimes in an active prefix. The builder emits host-specific metadata and keeps
the matching source recipe plus configure feature inventories. Portable delivery
requires a Steam Runtime SDK build and separate validation; the current host
build must not be labelled portable.

The reproducible host artifact is `target/wine-canvas-artifact-v3`, built from
fresh verified archives in `target/wine-canvas-reproduce-v3`. Its 151 prepared
source files exactly match the tested candidate after applying the seven patches.
The artifact contains both architectures' win32u/winex11 libraries, wineserver,
source recipe, source pins, patches, configure inventories and private build
dependency hashes. Its required GLIBC floor is 2.38. A private build library
folder was supplied with `--lib32-dir`; this does not install those libraries
or change the host environment. Steam/Protontricks must still provide the normal
GE runtime dependencies when launching the tool.
