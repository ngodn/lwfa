# Managed Proton and frame generation in lwfa

Research and read-only production inspection: 2026-09-12.

The requested home is the existing Gamepad/controller settings panel, with
Proton, LSFG, and Framegen tabs. The user confirmed this placement. No game
configuration, Steam launch option, installed component, service, or host
display was changed during this investigation.

## Recommendation

Build native lwfa management around separately versioned gaming components.
Users should not need Decky or a manual GE-Proton installation. Retain the
upstream component names and versions in diagnostics, even when the controls
are labelled lwfa Proton, lwfa LSFG, and lwfa Framegen.

Treat frame generation as a per-game choice. A game uses its native frame
generation, LSFG, or an OptiScaler FG backend, not several multipliers at once.
Native DLSS upscaling can remain available with a compatible FG provider.
The expected gain is smoother delivered motion; interpolation does not provide
the input response of a game rendering every frame, nor guarantee perfect
images. Lossless Scaling is a product name.

Detailed upstream reviews:

- [Self-contained Proton design](proton-bundle-design.md)
- [LSFG versions, interfaces, and restrictions](lsfg-integration-upstream.md)
- [OptiScaler/Decky-Framegen integration](framegen-integration-upstream.md)

## What is installed and running

| Item | Observed installation | Current upstream checked |
| --- | --- | --- |
| GE-Proton base | GE-Proton11-6, with separate lwfa Canvas tool | GE-Proton11-6 |
| Decky LSFG plugin | 0.12.5 | 0.12.8 |
| Decky Framegen plugin | 0.16.3-pre | 0.17 |
| lsfg-vk layer | Plugin's custom `fp16-test-2` v1-style artifact | Independent upstream 2.0.0 |
| OptiScaler | Not identified in the inspected game process | 0.9.4 |

Installed plugin versions came from `~/homebrew/plugins/*/package.json`.
Upstream release references and hashes are in the linked reviews. The installed
LSFG library exactly matches the plugin's bundled ZIP, SHA-256
`b3ae5ce9e97aca3b246d69df7368dc0d3932b3c07febece04ad84149984fbad5`.
The ZIP hash is
`a406b3730144c2011e2c2acd3cf44f3ec6c048ee86099bc9c3ac90aa1515e5ec`.
Neither plugin was updated.

The running game identifies as **Mortal Shell II**, Steam app 2584270. Its
shipping process uses lwfa's private X display `:1`, the Canvas Proton runtime,
and maps the installed LSFG layer. It also maps D3D12/vkd3d and NVIDIA DLSS/
Streamline libraries. A loaded library is not proof that its corresponding
feature is active or that generated frames reach the browser.

`~/lsfg` selects profile `3060` and exports `DXVK_FRAME_RATE=60` plus
`DISABLE_VKBASALT=1`. That LSFG profile requests multiplier 2, flow scale 0.5,
performance mode off, HDR mode on, and mailbox presentation. The exact GE11-6
DXVK/vkd3d sources no longer read `DXVK_FRAME_RATE`, so that wrapper setting
does not enforce the intended cap through those libraries. GE11-6's vkd3d still
supports `VKD3D_FRAME_RATE`. This does not prove the game is uncapped, since it
may have its own limiter. See the pinned-source check in the Proton review.
The profile
also contains `enable_wsi=true`, but the inspected launch wrapper does not
apply a matching WSI setting.

The game already loads a game-directory `dwmapi.dll` identifying itself as
UE4SS. A framegen installer must detect and preserve this existing proxy/mod,
not overwrite it or delete the game's plugin directory.

During inspection, the active lwfa NVENC session was HEVC at 1389x938, averaging
53-58 FPS with roughly 2.3-2.7 ms encoder latency. These are encoder statistics,
not end-to-end input latency or proof of generated-frame delivery. One GPU
snapshot showed RTX 3060, driver 610.57.04, 46% GPU utilization, 12% encoder
utilization, and 7288/12288 MiB used. A snapshot cannot predict 120 FPS headroom.

## Where lwfa can improve

The current stream is built around 60 FPS: `bitrate.rs` has `MAX_FPS=60`,
`encode.rs` uses a 1/60 time base, and `winit.rs` advertises 60 Hz modes. Capture
uses a threshold on compositor/redraw ticks, so these constants alone are not
a universal measured frame-rate ceiling. They are also not a negotiated 120 Hz
stream path. Sending 120 generated frames into a roughly 60 FPS stream does not
give the browser 120 FPS.

Start with an explicit delivered-frame target. For a 60 FPS client, compare
native 60 rendering against a stable 30 real frames plus 2x generation, measuring
both image artifacts and control response. A 60-to-120 mode needs coordinated
capture scheduling, output refresh, codec timestamps, decode/presentation
capacity, bitrate, and browser display capability. It cannot be implemented by
only changing the LSFG multiplier or the MAX_FPS constant.

Keep rendering, interpolation, and encoder input on the GPU. Existing capture
can pass a GL texture through CUDA into NVENC, and the production startup log
reported that path ready. A CPU fallback remains possible; this log does not
prove every later frame used GPU capture. Add per-window counters for actual
capture path, source commits, captured/encoded frames, queue age, decoder drops,
and browser presentations so performance claims are based on delivery.

The existing capture uses 8-bit ABGR/RGB0. There is no complete HDR negotiation
and tone-mapping path to the browser in this integration. An old LSFG HDR flag
must not become a UI claim that lwfa streams HDR. Begin with SDR and validate
color handling before exposing HDR as supported.

Use sustained measurements before adjusting a gaming profile. Do not switch
Proton, presentation mode, or FG backends automatically during a session.
Changes requiring a game restart should show a pending state. Quality and
flow-scale changes may apply live only where the selected provider supports it.

## Installation and host boundaries

For Proton, ship or download the pinned original GE archive and the matching
Canvas patch through one component installer. A full offline bundle adds about
509 MiB compressed for GE alone. Keep an immutable original runtime for host
launches and a separate patched snapshot for lwfa. Updates create a new versioned
registration; they never replace a running Wine server's files. Preserve existing
Steam selections and prefix ownership checks. Full binary redistribution needs
the corresponding component source/license inventory beyond the current
Wine-only source archive.

For LSFG, use private profiles and per-launch activation, separate from the
user's existing Decky files and global Vulkan configuration. The old v1 and
new v2 schemas are different. v2's CC BY-NC-ND licence and integration request
need resolving before distributing a modified lwfa integration. A pinned
compatible MIT-era provider is a separate option, not a claim to provide v2.
Users still need their own purchased Lossless Scaling DLL; no permission to
redistribute that proprietary file was established.

For OptiScaler, prototype a per-launch mod overlay visible only inside the lwfa
game's process namespace. Verify it through Steam's runtime and Wine DLL lookup
before calling it isolated. Installing DLLs beside a shared game executable
affects host launches too. If shared installation is ever offered, make that
scope explicit and keep per-file backups/hashes; restore only owned unchanged
files. Do not copy Decky's broad deletion routine.

OptiFG can block Steam overlays and thereby Steam Input. Keep it experimental
and test physical/virtual controllers and controller-only launches. Preserve
native NVIDIA upscaling on the RTX 3060 rather than copying AMD handheld presets.

## Panel and implementation order

Use the existing Tabs components within GamepadPanel: **Controller**, **Proton**,
**LSFG**, **Framegen**. Keep controller layout and recovery controls in the first
tab. Show the selected game on gaming tabs; component installation is machine
state, while per-game profiles belong in the backend rather than browser-only
preferences. Window titles alone are not stable game identities. Resolve a
trusted process/Steam app ID before applying a profile.

1. Build component inventory, immutable installs, self-contained Proton, and
   native tabs with truthful installed/active/pending/error states.
2. Add isolated LSFG profiles and a measured 60 FPS path, preserving the current
   game and existing Decky installation as comparison baselines.
3. Add negotiated higher-rate streaming only after capture, encoder, decoder,
   display, and network tests pass together.
4. Add game-specific OptiScaler integration after proving host/mod isolation,
   rollback, Steam Input, focus, audio, and fullscreen behavior.

Acceptance requires clean-machine installation, interrupted-download recovery,
hash verification, active-runtime update protection, unchanged host launches,
mod conflict detection, restoration after removal, and both pointer-driven and
controller-only game launches. Test resize/immersive transitions and connection
loss while checking delivered frame pacing and black-edge regressions.

## Implementation, 2026-09-12

Native Controller, Proton, LSFG, and Framegen tabs now use owner-only engine
requests. Component work runs on a background worker with bounded output and
timeouts. Profiles are stored atomically per Steam app ID outside the replaceable
engine payload, under `$XDG_DATA_HOME/lwfa-gaming`.

The Proton manager supports verified base download or a bundled offline archive,
plus the matching Canvas artifact. Installs create self-contained versioned
tools and preserve host/runtime routing. Small packages can acquire the pinned
published Canvas artifact without executing its installer.

LSFG uses the verified MIT 1.0.0 provider, private per-game configuration, a
separate Vulkan layer name, DLL shader preflight, and SDR/FIFO defaults. Framegen
uses verified OptiScaler 0.9.4 and a persistent process-local game-directory
overlay. Existing graphics injectors and active prefixes are rejected. The
launch wrapper is explicitly configured once in Steam and passes host launches
through unchanged. It does not alter game launch options automatically.

Capture logs now report actual GPU-direct and CPU-copy counts per window every
five seconds. Existing geometry, damage handling, pacing, and codecs are unchanged.
Higher-rate negotiation and automatic frame-rate changes have not been enabled.

Disposable tests cover packaging, archive validation, host passthrough, concurrent
profile saves, upgrade persistence, component activation, Wine DLL loading,
private overlays, permissions, protocol parity, worker timeouts, reconnects, and
mobile-width panel interactions. Actual pinned LSFG and OptiScaler installations
were verified in scratch directories. LSFG initialized on the RTX 3060 inside an
isolated Vulkan probe. These checks do not establish real-game generated-frame
quality, Steam Input compatibility, or end-to-end latency. Framegen remains
experimental pending gameplay tests after upgrade. Production was not restarted
or reconfigured during implementation.

User instructions: [Proton and frame generation](../gaming.md).
