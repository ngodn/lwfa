# Frame generation integration upstream research

Checked 2026-09-12. This is an upstream assessment and implementation record, not a claim that frame generation quality has been validated in a game. Research began with source and release metadata. Subsequent validation downloaded the pinned archive and ran synthetic DLL probes in disposable fixtures. No production processes, game files, launch options, or host configuration were changed.

## What to integrate

Decky-Framegen is a manager for OptiScaler and related DLLs, not a frame interpolation implementation itself. Its React/Decky interface and Python backend are replaceable by native lwfa controls. OptiScaler intercepts an existing temporal upscaler or frame generation interface inside the game; this provides different inputs and compatibility constraints from a Vulkan presentation-layer solution such as LSFG. Keep the two approaches separate in settings and select one frame generation provider per game. [Decky-Framegen](https://github.com/xXJSONDeruloXx/Decky-Framegen), [OptiScaler architecture](https://github.com/optiscaler/OptiScaler#how-it-works)

## Versions and reproducibility

GitHub's latest stable release endpoints returned these versions. A component's independent latest version is not proof that it is the version inside another project's bundle.

| Component | Latest stable observed | Published | Integration implication |
| --- | --- | --- | --- |
| Decky-Framegen | v0.17 | 2026-07-26 | Plugin archive is 199,550,246 bytes. |
| OptiScaler | v0.9.4 | 2026-07-18 | Upstream archive is 55,016,448 bytes. |
| Nukem dlssg-to-fsr3 | 0.130 | 2025-03-16 | Already supported through OptiScaler. |
| fakenvapi | v1.4.1 | 2026-04-24 | Now part of the OptiScaler organization. |
| Intel XeSS SDK | v3.0.2 | 2026-07-24 | Independently newer than the OptiScaler release. |

Sources: [Decky release](https://github.com/xXJSONDeruloXx/Decky-Framegen/releases/tag/v0.17), [OptiScaler release](https://github.com/optiscaler/OptiScaler/releases/tag/v0.9.4), [Nukem releases](https://github.com/Nukem9/dlssg-to-fsr3/releases), [fakenvapi releases](https://github.com/optiscaler/fakenvapi/releases), [XeSS releases](https://github.com/intel/xess/releases).

Inspected Decky main commit `96eb17b0a9f2cfd2b00ad082bef893f4efc229f7` and OptiScaler master commit `5c5e424dd137d69ef36c4231fd45b760b4c65cc8`. OptiScaler master already contains configuration changes beyond v0.9.4, so use the selected release's INI schema. Decky's manifest pins `Optiscaler_0.9.4-final.20260718._MM.7z` with SHA-256 `575cb4df866116093df75af607e37fd70e10f5163e0f23fd5c804142e80ef0ad`. Preserve exact assets and hashes rather than silently tracking nightly builds. [Decky asset manifest](https://github.com/xXJSONDeruloXx/Decky-Framegen/blob/96eb17b0a9f2cfd2b00ad082bef893f4efc229f7/main.py), [release INI](https://github.com/optiscaler/OptiScaler/blob/v0.9.4/OptiScaler.ini)

## Compatibility and RTX 3060

OptiScaler supports games exposing DLSS2+, FSR2+, or XeSS inputs; the exact game implementation matters. DX11 upscaling support is not equivalent to DX11 frame generation support. Unreal Engine's XeSS input lacks depth for several replacement paths. A game list or detected DLL is a candidate indication, not a guarantee. [OptiScaler supported interfaces](https://github.com/optiscaler/OptiScaler#about), [compatibility list](https://github.com/optiscaler/OptiScaler/wiki/Compatibility-List)

The preferred order is a working native FG interface, then experimental OptiFG when a suitable game has no native FG. DLSSG via Streamline requires DX12 and Streamline 2+. Older Streamline 1 games, including A Plague Tale Requiem, require the Nukem route for DLSSG conversion. Nukem supports DX12 and Vulkan but produces FSR3 FG. XeFG requires DP4a hardware, supports DX12 rather than Vulkan, and requires a borderless mode. Its multi-frame generation is limited to Intel Arc in the documented OptiScaler integration. Both FG input and output selections need saving and a game restart. [Frame Generation Options](https://github.com/optiscaler/OptiScaler/wiki/Frame-Generation-Options)

RTX 3060 is within Nukem's explicitly supported RTX 3000 family. A sensible initial NVIDIA profile preserves native DLSS upscaling and evaluates FSR3 FG or XeFG where the game supports the required inputs. Do not assume AMD's FSR4 compatibility DLLs improve this GPU. FSR4 FG is selected for RDNA4 in the documented OptiScaler path. Do not force FakeNVAPI on NVIDIA; its own installation instructions caution against that configuration. [Nukem requirements](https://github.com/Nukem9/dlssg-to-fsr3), [fakenvapi installation](https://github.com/optiscaler/fakenvapi#installation)

## Controller and rendering implications

OptiFG is experimental and DX12-only. It attempts to recover a HUD-free image from upscaler resources; failure causes HUD artifacts. Upstream documents startup/exit hangs and crashes when toggling settings. It also disables several overlays for compatibility and explicitly reports that Steam Input may be blocked. `DisableOverlays=false` is a documented workaround, but restoring an overlay may reintroduce the original compatibility issue. lwfa must test controller-only Big Picture launches and overlay behavior rather than applying either setting universally. [OptiFG limitations](https://github.com/optiscaler/OptiScaler/wiki/OptiFG)

Generated frames improve presentation smoothness, not the rate at which the game samples input or simulates the world. AMD recommends at least 60 FPS before FSR3 interpolation for best results. Intel recommends at least 40 FPS for its documented XeSS-FG input specification. These are provider guidance, not a promised minimum for every game through Proton. Track base FPS, generated/presented FPS, encoded FPS, dropped frames, and input latency separately. [AMD FSR3 guidance](https://gpuopen.com/fidelityfx-super-resolution-3/), [Intel XeSS-FG guide](https://github.com/intel/xess/blob/main/doc/xess_fg_developer_guide_english.md)

For lwfa, frame generation should target the actual stream cadence and measured client decode capacity. Generating 120 FPS that lwfa encodes at 60 can waste GPU work and produce inconsistent sampling. This is an integration inference to verify with capture timestamps and pacing measurements. Neither frame generation nor the name “Lossless Scaling” promises artifact-free images or lossless video compression.

## Installation and host isolation

The standard installation places OptiScaler files beside the actual game executable, often the Unreal shipping executable in `Binaries/Win64`, renames the injector to a supported proxy such as `dxgi.dll`, and adds `WINEDLLOVERRIDES=dxgi=n,b` for Wine. Keep `OptiScaler.ini` under its original name. Other proxy names exist for compatibility with existing mods. [Manual installation](https://github.com/optiscaler/OptiScaler/wiki/Manual-Installation)

Decky's backend uses `~/fgmod`, copies DLLs into game directories, backs up some existing files as `.b`, and creates a `FRAMEGEN_PATCH` marker. It manages shared Steam launch options. Its defaults include Nukem FG, ASI loading, and an RDNA2/3 runtime variant. Its unpatch routine removes broad DLL lists and recursively removes `plugins`. These defaults and cleanup operations must not be reused unchanged in lwfa. [Inspected backend](https://github.com/xXJSONDeruloXx/Decky-Framegen/blob/96eb17b0a9f2cfd2b00ad082bef893f4efc229f7/main.py)

Design consequence: a private lwfa display does not isolate writes to shared game files or Steam launch options from the host desktop. Prefer a per-launch filesystem overlay or namespace presenting managed DLLs only to lwfa games. Prototype this with Steam's runtime and Wine DLL lookup before promising isolation. A separate Proton installation alone does not isolate a mod installed beside a shared executable.

If direct per-game installation is needed, present that shared scope explicitly and track every managed file's original content, installed hash, mode, and owning installation. Refuse to overwrite unknown mods. Restore only files that still match lwfa's installed content. Never delete an entire existing `plugins` directory. Preserve unrelated launch options and DLL overrides. Install/update/remove only when the game is stopped; disabling injection and uninstalling files are distinct operations.

OptiScaler's documented shader compiler failures on Linux can affect sharpening and output scaling. Prefer its precompiled shader option or a targeted runtime fix after a reproduced failure, rather than changing every Wine prefix. [Known issues](https://github.com/optiscaler/OptiScaler/blob/master/Issues.md)

## Redistribution boundaries

Decky-Framegen's own code declares BSD-3-Clause with attribution and disclaimer requirements. OptiScaler and Nukem use GPL-3.0; distributing their binaries requires the corresponding license/source arrangements. fakenvapi and OptiPatcher declare MIT. These licenses do not automatically cover every bundled vendor DLL. [Decky license](https://github.com/xXJSONDeruloXx/Decky-Framegen/blob/main/LICENSE), [OptiScaler license](https://github.com/optiscaler/OptiScaler/blob/master/LICENSE), [Nukem license](https://github.com/Nukem9/dlssg-to-fsr3/blob/master/LICENSE.md), [fakenvapi license](https://github.com/optiscaler/fakenvapi/blob/master/LICENSE), [OptiPatcher](https://github.com/optiscaler/OptiPatcher)

Intel's binary SDK permits redistribution without modification, with its notices and conditions. Preserve the actual archive's third-party notices and audit its inventory before bundling. Prefer the upstream OptiScaler release to repackaging Decky's larger mixed bundle of additional vendor runtimes. [Intel license](https://github.com/intel/xess/blob/main/LICENSE.txt)

OptiScaler warns that DLL injection can trigger game anti-cheat. Keep this per-game and opt-in, with unsupported anti-cheat configurations excluded from automatic activation. This is a documented compatibility constraint, not a reason to change any host service. [Upstream installation warning](https://github.com/optiscaler/OptiScaler/wiki/Installation)

## Native lwfa panel proposal

Within the user's requested Gamepad panel tabs, provide a Framegen tab with: selected game, detected provider and version, compatibility status, install/update/remove, provider selection, pending restart indication, and a diagnostics/overlay shortcut. Keep provider names visible so bug reports identify OptiScaler rather than implying lwfa authored its interpolation algorithms.

The initial implementation should manage a pinned tested bundle, preserve native NVIDIA upscaling, protect existing Steam Input behavior, and allow only one FG provider per game. Validate host launches without lwfa activation, normal and controller-only Steam launches, immersive/fullscreen resizing, focus/audio recovery, HUD stability, frame pacing, and uninstall restoration before making it a default recommendation. No new configuration was applied to the running Mortal Shell session during this research.

## Implemented launch mechanism and validation

`compat/gaming/framegen.py` installs the pinned release under the private gaming component directory after SHA-256 verification. It validates archive paths and sizes before extracting with 7-Zip, preserves the bundled notices, and records per-file hashes. Launch verifies those hashes again.

The launcher uses Bubblewrap's sparse overlay support to merge the existing executable directory with a private injector. Existing files and subdirectories remain visible. The host directory receives no injector or INI. Files the game writes in this overlaid directory persist in a private per-game upper layer; ordinary saves elsewhere in the Wine prefix retain their existing paths. Support libraries load from the managed component directory, so existing game-side XeSS or DLSS DLLs are not replaced. This is a filesystem overlay, not an isolated copy of the entire Wine prefix.

Host launches bypass the module unless both lwfa Wine session flags are present. Existing graphics injectors, conflicting DLL overrides, an active Wine server for the prefix, unsupported Z: mappings, and incompatible Vulkan layer filters cause an explicit refusal. UE4SS's separate `dwmapi.dll` and existing `plugins` remain intact. LSFG providers are disabled in the framegen launch environment. Steam Input and overlay environment variables are preserved; OptiScaler's own overlay blocking is disabled.

Validation completed on this host:

- 19 Python tests passed, covering archive safety, incomplete installation, checksums, host bypass, existing mods, Wine-prefix guards, conflicting providers, and a real kernel overlay mount.
- The actual upstream 55,016,448-byte archive matched its pinned SHA-256, extracted successfully, and passed runtime inventory validation in `target/framegen-prototype/component-test`.
- A synthetic Windows DLL exported a marker function. System Wine loaded it only through the overlay. An immediate unwrapped launch returned the expected missing-marker result.
- The same injection path survived Steam's real pressure-vessel boundary and GE-Proton11-6's Wine loader.
- Full GE-Proton11-6 through SteamLinuxRuntime_4 and a namespace-isolated Xvfb ran the GUI-subsystem probe. The probe wrote `injected` into the private overlay, establishing that the DLL was loaded rather than inferring success from the launcher exit status. Scratch evidence is in `target/framegen-prototype/proton/isolated-xvfb-full-proton-result.json`.
- The counterfactual full-Proton run with lwfa flags absent wrote `builtin` into the disposable game's directory and returned the expected code 3. This verified host bypass through the same launcher stack. Evidence is in `target/framegen-prototype/proton/isolated-xvfb-full-proton-host-result.json`.

The Xvfb test used separate mount and network namespaces, private `/tmp` and `/run`, a read-only host root, and writable disposable fixture paths. The Steam runtime's lock file was replaced by a scratch file inside that namespace. Headless full-Proton attempts had waited during GUI startup; Xvfb resolved that fixture limitation. Expected GLX/Xalia warnings from the deliberately minimal display do not establish anything about game rendering quality.

Actual OptiScaler interpolation, HUD quality, end-to-end streaming latency, and controller behavior in a real game remain to be tested. The implemented framegen option should remain experimental until those checks pass.
