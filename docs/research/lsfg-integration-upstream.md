# LSFG integration upstream research

Checked 2026-09-12. This is a feasibility and integration note. No game, installed layer, Steam configuration, or production service was changed. Upstream source was cloned into scratch directories under `/tmp` for inspection.

## Findings that change the implementation plan

lwfa can provide its own controller-friendly LSFG management UI without installing Decky. Decky LSFG is an installer, profile editor, and launch wrapper around a separate Vulkan layer. Its UI is useful reference material, but its current release still targets the older layer/configuration. [Decky source](https://github.com/xXJSONDeruloXx/decky-lsfg-vk/tree/e997a3fb74fa70f5e60b60807fb0897120e98313/py_modules/lsfg_vk)

The current upstream is now **lsfg-vk 2.0.0**, released September 5. It moved from GitHub to self-hosted infrastructure, rewrote the pipeline, changed its configuration and licensing, and requires the `lsfg-vk` branch of the purchased Steam Lossless Scaling application. Updating the Decky plugin alone is not equivalent to migrating to this upstream. [Release](https://lsfg-vk.dev/blog/release-v2.0.0/), [installation](https://lsfg-vk.dev/docs/installation/)

Frame generation can improve visible motion, but “Lossless Scaling” is a product name, not a promise of artifact-free generated frames or zero latency. Its proprietary model estimates intermediate images; flow scale and performance mode explicitly trade quality for cost. The lwfa UI should say “Frame generation” and show both rendered and delivered FPS when measured. [Product](https://store.steampowered.com/app/993090/Lossless_Scaling/), [quality controls](https://lsfg-vk.dev/docs/configuration/configuration-options/)

## Exact upstream state

| Component | Verified version or commit | Meaning |
| --- | --- | --- |
| Decky LSFG plugin | `v0.12.8`, published 2026-08-03 | Latest GitHub release. |
| Decky main | `e997a3fb74fa70f5e60b60807fb0897120e98313` | Version bump to 0.12.8, same day. |
| lsfg-vk stable | `2.0.0`, tag object `6a5450f91f7b2b6b1ad852957a111377d37b9023`, peeled commit `2333707d55b68ddd8066fd95404c3b7d07e00d3a` | Use the release as a candidate to validate, rather than a floating branch. |
| lsfg-vk master | `0e7a3898c1285b13df8596f2bd2cbb8f85b4383b` | September 8, archive compression fix after 2.0.0. Autobuild name `2.0.0.r1.g0e7a389`. |

Sources: [plugin release](https://github.com/xXJSONDeruloXx/decky-lsfg-vk/releases/tag/v0.12.8), [plugin commit](https://github.com/xXJSONDeruloXx/decky-lsfg-vk/commit/e997a3fb74fa70f5e60b60807fb0897120e98313), [upstream refs](https://git.lsfg-vk.dev/lsfg-vk/refs/), [upstream builds](https://builds.lsfg-vk.dev/). Version evidence was cross-checked with the GitHub API and `git ls-remote --tags` on the canonical upstream.

The installed-state audit by the main investigation found Decky **0.12.5**, with an `fp16-test-2` artifact from `xXJSONDeruloXx/lsfg-vk`. That is an older fork artifact, not the current upstream release. Its manifest uses `DISABLE_LSFG`, whereas v2 uses `DISABLE_LSFGVK`. Treat them as different providers when detecting conflicts.

That audit hashed the installed `~/.local/lib/liblsfg-vk.so` as `b3ae5ce9e97aca3b246d69df7368dc0d3932b3c07febece04ad84149984fbad5`, exactly matching the library inside the installed plugin's `bin/lsfg-vk_noui.zip`. The archive hash is `a406b3730144c2011e2c2acd3cf44f3ec6c048ee86099bc9c3ac90aa1515e5ec`. This establishes which local artifact is installed; it does not establish what proportion of presented frames reach the browser.

## Distribution boundaries

The Decky wrapper is BSD-3-Clause with included third-party notices. Its license allows reuse with the notices and no implied endorsement. This does not grant rights over every binary it installs. [Decky license](https://github.com/xXJSONDeruloXx/decky-lsfg-vk/blob/e997a3fb74fa70f5e60b60807fb0897120e98313/LICENSE)

The current lsfg-vk source is **CC BY-NC-ND 4.0**. Earlier v1 was MIT and an earlier v2 phase GPLv3. The maintainer explicitly directs people planning integration or a derivative to contact them. Do not publish a modified current lsfg-vk as “lwfa LSFG” under an assumed permissive license. Keeping the original component separate and exposing configuration is a different design from distributing a modified pipeline, but redistribution/integration terms should be settled before bundling it into public lwfa releases. No contact was made during this research. [License change](https://lsfg-vk.dev/blog/important-changes-to-lsfg-vk/), [integration guidance](https://lsfg-vk.dev/docs/contributing/)

Lossless Scaling is separately purchased proprietary software. Current installation instructions require users to install it through Steam and select its `lsfg-vk` branch, providing `lsfg-vk.dll`. No permission to redistribute that DLL with lwfa was found. Design for detecting a user-owned installation, with a clear missing-dependency state, rather than including the DLL. [Installation requirements](https://lsfg-vk.dev/docs/installation/), [publisher product description](https://store.steampowered.com/app/993090/Lossless_Scaling/)

## Architecture and configuration

The current Vulkan layer intercepts swapchain operations. It reads game images, computes additional images on the GPU, copies generated images into acquired swapchain images, and presents them before the original image. It uses GPU command buffers and semaphores, not a screen-recording CPU pixel loop. Shader extraction from the purchased DLL is part of the implementation. [Vsync implementation](https://git.lsfg-vk.dev/lsfg-vk/tree/lsfg-vk-layer/src/modes/vsync.cpp?id=2333707d55b68ddd8066fd95404c3b7d07e00d3a), [original pipeline explanation](https://lsfg-vk.dev/blog/porting-lsfg-to-native-vulkan/)

Its configuration requires `version = 2`. It rejects unknown keys. Profiles identify Linux executables, Windows executables, process names, or Steam app IDs; `LSFGVK_PROFILE` explicitly selects one. The parser watches the configuration's parent directory for close-write and rename events, so atomic replacement can work. Do not copy the old `version = 1` file into v2. [Configuration implementation](https://git.lsfg-vk.dev/lsfg-vk/tree/lsfg-vk-config/src/config.cpp?id=2333707d55b68ddd8066fd95404c3b7d07e00d3a)

| Control | v2 mechanism | Live change |
| --- | --- | --- |
| Private configuration | `LSFGVK_CONFIG` | Establish at launch. |
| Chosen profile | `LSFGVK_PROFILE` | Establish at launch; do not promise runtime profile switching. |
| Disable layer | `DISABLE_LSFGVK=1` | Launch environment; cannot unload a layer already loaded. |
| Multiplier | profile `multiplier` | Supported hot reload. `1` is bypass. |
| Flow scale | `flow_scale` | Supported hot reload. |
| Performance mode | `performance_mode` | Supported hot reload. |
| FIFO override | `override_present_mode` | Treat as restart-required. |
| DLL and FP16 | global `dll`, `allow_fp16` | Treat as restart-required. |

Environment-only configuration uses `LSFGVK_ENV=1` plus the documented `LSFGVK_*` variables. For lwfa, a private TOML file permits supported live changes without rewriting the global user's profile. Global environment overrides no longer require `LSFGVK_ENV` in 2.0.0. [Environment API](https://lsfg-vk.dev/docs/configuration/environment-variables/), [hot-reload documentation](https://lsfg-vk.dev/docs/configuration/configuration-options/), [release details](https://lsfg-vk.dev/blog/release-v2.0.0/)

HDR must not be migrated by renaming a toggle. v2 has no `hdr_mode` configuration key. The inspected public context creates its pipeline with HDR set to false, despite lower-level shader variants being present. End-to-end HDR also needs a matching capture, encoder, and browser path. This is an implementation limitation, not proof that every possible HDR input will fail. [Context source](https://git.lsfg-vk.dev/lsfg-vk/tree/lsfg-vk-pipeline/src/lsfgvk.cpp?id=2333707d55b68ddd8066fd95404c3b7d07e00d3a)

## Compatibility and performance

Upstream v2 targets Vulkan 1.2 and ships 32-bit support. Native Wayland Vulkan is shown in the getting-started guide; Vulkan-over-Proton is covered by Windows-executable and Steam-ID matching. Xwayland should be evaluated through its actual Vulkan presentation path, not treated as a separate interpolation algorithm. No guarantee follows for non-Vulkan applications without a translation layer. [Getting started](https://lsfg-vk.dev/docs/getting-started/), [release support](https://lsfg-vk.dev/blog/release-v2.0.0/)

NVIDIA is supported, but the large FP16 speedup described for AMD must not be promised for the RTX 3060. The configuration documentation says FP16 does not improve NVIDIA performance and can regress GTX 1000-series. Upstream's RTX 5080 benchmark is not a prediction for this machine. Benchmark later, while no production game is competing for resources. [FP16 behavior](https://lsfg-vk.dev/docs/configuration/configuration-options/)

**Pacing is the most important limitation for lwfa.** v2 currently exposes only `vsync`. It presents frames as soon as ready and relies on FIFO/display cadence to space them. Without that, frames can be skipped. Upstream says this only paces properly when the target equals the monitor refresh, and Vsync can introduce latency and VRR issues. Adaptive generation and dual-GPU processing are future work, not current features. [Pacing explanation](https://lsfg-vk.dev/docs/configuration/pacing-modes/), [current scope](https://lsfg-vk.dev/)

The current user's old profile has multiplier 2 and mailbox presentation. That combination deserves a controlled comparison, not a live configuration change. A loaded `liblsfg-vk.so` proves the layer entered the process, but does not prove the browser received distinct, evenly spaced generated frames. Steam/MangoHud counters may also count before or after LSFG depending on layer order. [Overlay limitations](https://lsfg-vk.dev/docs/troubleshooting/performance-overlays/)

The parallel live audit observed NVENC at 1389x938, roughly 53-58 FPS and 2.3-2.7 ms encoding latency. One GPU snapshot showed 46% GPU load, 12% encoder load, and 7288/12288 MiB VRAM use. The current code has a 60-oriented stream budget, 1/60 encoder timebase and 60000 mHz output refresh; capture timing means that is not proof of a strict universal 60 FPS ceiling. These observations do not measure generated-frame delivery or input latency. They support investigating pacing before promising benefit from a higher multiplier.

## Recommended lwfa integration

These are engineering proposals, not implemented or benchmarked results.

1. Add LSFG management to the requested Gamepad panel tabs, with per-game opt-in and visible detected/selected/loaded versions. Keep the wrapper UI independent of Decky. Do not silently update the user's Decky files or launch script.
2. Install managed files into a versioned lwfa directory. Select the provider only for lwfa game processes, use a private configuration, and disable a conflicting old provider in that child's environment. Preserve host Steam and user global Vulkan manifests. Verify the Steam container can see the selected layer, libraries, DLL, and configuration.
3. Use the loader's additive layer search support rather than replacing all layer discovery or globally rewriting XDG variables. `VK_ADD_IMPLICIT_LAYER_PATH` adds search roots; existing `VK_IMPLICIT_LAYER_PATH` takes precedence. Layer filtering must target only the conflicting provider. Check compatibility with the actual loader inside Proton's container before treating this as working. [Khronos loader rules](https://raw.githubusercontent.com/KhronosGroup/Vulkan-Loader/main/docs/LoaderLayerInterface.md)
4. Make stream cadence part of the profile: for a 60 FPS stream, a candidate is stable 30 real FPS plus 2x generation, not 60 real FPS plus 2x whose surplus may be dropped. At 120 FPS, compare 60-to-120 only if compositor delivery, encoder, connection, browser decoding, and display all sustain it. This arithmetic is an output budget, not a guarantee that a 30 FPS game feels like native 60 FPS input.
5. Measure actual unique delivered frames and timing at the compositor, encoder, and browser. Show base render FPS separately from generated output. Keep queues bounded, retain hardware encoding, and reduce/disable FG if GPU contention lowers base FPS or increases frame age. Avoid changing a running Wine game's monitor geometry to enforce an FG target.
6. Offer 2x first, expose flow/performance tradeoffs, and test fast camera motion, disocclusions, foliage, particles, text, and game cursors. Keep lwfa's own navigation/controller overlay outside interpolation. Generated frames do not run another game simulation/input update, so they must not be described as equivalent to native higher-FPS responsiveness.
7. Treat LSFG and another game-injected FG provider as mutually exclusive unless a specific combined setup is tested. Do not layer both automatically.

There is a deeper future option: v2's public C++ pipeline API exports GPU memory file descriptors and a timeline-semaphore descriptor, plus `dispatch`/`acquire` operations. This could support generation at lwfa's stream cadence and keep pixels on the GPU. It still requires cross-API synchronization, format/modifier validation, correct device selection, handling repeated frames and resize resets, and the upstream integration permission discussed above. It is not a small UI change and should not be added to the compositor during the first managed-layer integration. [Pipeline API](https://git.lsfg-vk.dev/lsfg-vk/tree/lsfg-vk-pipeline/include/lsfg-vk/lsfgvk.hpp?id=2333707d55b68ddd8066fd95404c3b7d07e00d3a)

## Validation before shipping

- Confirm clean install, migration without editing the old profile, rollback, missing DLL, invalid TOML, and duplicate-layer detection.
- Compare FG off/on at fixed stream targets in isolated sessions. Measure base frame time, generated delivery cadence, GPU use, VRAM, encoder delay, browser dropped frames, and input latency.
- Cover DX11, DX12, native Vulkan, 32-bit if offered, Xwayland and native Wayland. Preserve focus/audio/controller regressions, immersive/fullscreen transitions, and black-strip/resize coverage.
- Verify the host desktop still loads its original provider and that lwfa's engine/encoder does not accidentally load the game FG layer.
- Do not benchmark or upgrade the currently running Mortal Shell session as part of this research.

## Initial implementation after approval

The first managed provider uses the **original MIT v1.0.0 release**, source commit `7113d7d02da9fc9df5cb3b03230d1f7de86f7056`. It deliberately does not redistribute a modified v2. The official no-UI archive is pinned to SHA256 `af5ee1626d9543349245520689da107c3ebc5ef3755086441fbb854173b8e096`, and its unmodified library to `de4954bcce6904b62b6c48f1525c7fd78b4c2d7f9a959edf621528d9363ebbfd`. Installation also downloads verified notices for lsfg-vk, dxbc, pe-parse, toml11, and volk. [Original release](https://github.com/PancakeTAS/lsfg-vk/releases/tag/v1.0.0), [original license](https://github.com/PancakeTAS/lsfg-vk/blob/7113d7d02da9fc9df5cb3b03230d1f7de86f7056/LICENSE.md)

`compat/gaming/lsfg.py` writes a private per-game `LSFG_CONFIG`, a private `LSFG_PROCESS`, and a private named implicit-layer manifest. Its launch environment excludes the older global layer and v2 without changing either installed provider. The manifest retains upstream's `DISABLE_LSFG` guard used during internal Vulkan device creation. The manager preflights the purchased DLL's PE resource table for the shader IDs required by v1, because v1's constructor otherwise terminates an incompatible launch. Default presentation is FIFO and HDR is disabled.

Fourteen disposable tests cover shader preflight, malformed profiles, secondary Steam libraries, isolated environment construction, simultaneous game configuration, archive integrity, and failed-download/install rollback. An actual download and install succeeded in an ignored scratch directory. A mount/network-isolated Vulkan probe enabling the game's swapchain device extension loaded only the private layer, extracted the purchased DLL's shaders, and initialized the RTX 3060 device successfully. This is a loading/compatibility check, not a rendered-FPS or latency benchmark.

An initial enumeration-only `vulkaninfo --summary` probe failed because v1 expects swapchain functions on the device. Its failure and the successful game-style probe reinforce that activation must be limited to selected game launches. Neither probe changed a production process or opened a window.
