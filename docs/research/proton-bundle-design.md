# Self-contained lwfa Proton

Research date: 2026-09-12. This is a design review. No runtime, Steam registration, prefix, service, game, or host setting was changed.

## Recommendation

Provide one lwfa Proton installation that contains a verified original GE runtime and our matching patched runtime. Users should not have to install GE separately. Keep the original runtime available inside that installation for host launches, with the patched runtime selected only for lwfa launches. Do not replace the user's existing GE installation.

Deliver the same component through the settings panel and an optional offline package. The online install can download the pinned official GE archive and compose the tool locally; the offline package can include that exact archive and the existing patch payload. Both paths should use the same verifier and installer. This removes the separate manual installation without adding roughly half a gigabyte to every ordinary lwfa update.

This recommendation preserves the tested distinction between original host Wine and patched nested Wine. Disabling patch environment flags while loading rebuilt Wine libraries is not equivalent to running the original GE libraries.

## Upstream version and payload

The official release API still identifies **GE-Proton11-6** as latest, published **2026-08-28 21:37:07 UTC**. That matches our source manifest. Its x86_64 archive is **533,700,853 bytes**, about **509 MiB**. Upstream also publishes an aarch64 archive, but our current engine, launcher and Wine artifact target Linux x86_64 with both x86_64 and i386 Wine components. The aarch64 asset is not a supported substitute. [Release](https://github.com/GloriousEggroll/proton-ge-custom/releases/tag/GE-Proton11-6), [release metadata](https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases/tags/GE-Proton11-6).

Pinned download identity obtained from that metadata and its checksum asset:

```text
asset: GE-Proton11-6-x86_64.tar.gz
url: https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-6/GE-Proton11-6-x86_64.tar.gz
sha256: 659f8d71f2f78659340120b20c1c5a1464aa138939332a1376dea22f6d2dc2e4
sha512: 543e3af57bb138b1be5a5b98bba4d39ca59340bfa34ec8c12144f3e16d7434ed75bd7a68eafc228b16695884629595af0905156e5227c1898f93cdbc92cb5fcb
```

The checksum file was fetched; the 509 MiB archive was not downloaded again or hashed in this investigation. These are upstream metadata values, not a new local archive verification.

The component installer should pin the archive size and digest in a reviewed manifest. Discovering a newer release must not automatically apply the 11-6 patch payload to it. Our build pins the original entrypoints, replaced libraries, Wine server protocol, prepared source files and SDK. Updating GE requires rebasing and rebuilding the matching artifact, then repeating compatibility tests.

## Existing implementation and gaps

| Area | Current behavior | Required change |
| --- | --- | --- |
| `compat/wine-canvas/manage.py:23` | Requires the original GE under Steam's `compatibilitytools.d` | Accept a verified bundled archive or managed original snapshot |
| `manage.py:48` | Copies GE into a private real tree and replaces selected components | Keep this approach, with the original also owned by this installation |
| `manage.py:58` | Facade symlinks point to the external GE installation | Point only to the retained internal original tree |
| `manage.py:35` | One registration per GE version; changed payload refuses replacement | Include the lwfa patch revision in the tool identity; install beside old versions |
| `manage.py:93` | Removal checks ownership but not running processes or game selections | Refuse removal while referenced by running tools; report installed selections before cleanup |
| `router.py:141` | Original host/private nested routing plus prefix-server ownership checks | Preserve all front doors, path remapping and checks |
| `install.sh:545` | Steam discovery requires an existing `compatibilitytools.d` | Detect initialized Steam roots independently and create the missing tools directory |
| `scripts/package.sh:152` | Packages only the patch artifact and manager | Add the optional original archive with full verification and explicit component metadata |

The original snapshot and patched snapshot must survive lwfa engine upgrades and uninstall, as registered tools already do. Game launches must never depend on an extraction directory that the `.run` installer deletes afterward.

## Proposed layout and update behavior

One concrete registration could be `lwfa-GE-Proton11-6-canvas-r2`, displayed as **lwfa Proton 11-6 (r2)**. Its tree contains the native facade entrypoints, routing metadata, `.original/`, `.runtime/` and `.artifact/`.

Use reflink copies where supported, with a full copy fallback. Do not use shared writable hardlinks for original and patched files. Preserve symlinks, executable permissions and empty directories from the verified archive. Validate archive paths and link targets before extraction so files cannot escape staging. Use an installation lock, a staging directory on the destination filesystem, and a final rename after all verification succeeds. Corruption, cancellation, network failure or low disk space must leave the previously installed version usable.

Keep the downloaded original archive once in a digest-addressed cache. The installer should report measured space requirements for the archive, extraction and both runtime trees. Do not assume reflink support when checking free space. A later implementation can deduplicate immutable original snapshots between patch revisions, but a self-contained version directory is easier to validate initially.

Installing a new revision does not edit Steam's per-game tool selection or replace files used by an existing Wine process. Steam discovery may require a user-controlled restart. Old versions remain available for rollback. Cleanup should be a separate action with usage checks, not part of an ordinary update.

The current Wine server lock check prevents joining an already-running prefix owned by a different runtime. It is not a global lock respected by every Wine launcher, so simultaneous unwrapped launches still require care. Bundling does not remove that limitation.

## Runtime boundary

Bundling GE does not make it a standalone system Wine replacement. GE documents Steam's containerized environment as its supported Steam execution path, and umu as the supported path for non-Steam games. Keep the upstream `toolmanifest.vdf`, library tree and helper files intact. Do not globally export its library paths or install patched libraries in system locations. [GE installation and runtime guidance](https://github.com/GloriousEggroll/proton-ge-custom/blob/GE-Proton11-6/README.md).

The installed original 11-6 `toolmanifest.vdf` currently declares `require_tool_appid` **4183110**, `use_sessions` **1**, and the Proton compatibility layer. Preserve that manifest rather than guessing a runtime generation from older Proton versions. Our build SDK is separately pinned to Steam Runtime 4 image tag `4.0.20260714.251823-0` and digest in `compat/wine-canvas/sdk.json`; that is the build environment, not an instruction to bundle the 2.34 GB SDK into a gaming installer. [Pinned upstream Makefile](https://github.com/GloriousEggroll/proton-ge-custom/blob/7e88cefffc122ea1584c2156b8d7bae6cf69b2a7/Makefile.in).

Native Steam should remain the first supported installation target. Flatpak and Snap use different tool directories and containment rules. Supporting their paths in a picker is not evidence that the existing native launcher and runtime routing work inside their sandboxes. Validate those paths separately before advertising them.

## Distribution and sources

GE/Proton is a collection of differently licensed components. Retain upstream license files, notices, font licenses and patent notices from the exact archive, and identify our build as an lwfa derivative. GE's top-level license does not replace the licenses of Wine, vkd3d-proton, media libraries and other bundled components. [Top-level license](https://github.com/GloriousEggroll/proton-ge-custom/blob/GE-Proton11-6/LICENSE), [distribution notices](https://github.com/GloriousEggroll/proton-ge-custom/blob/GE-Proton11-6/dist.LICENSE).

The existing `export-source.py` exports the prepared Wine source and our recipe. That remains appropriate for the replaced Wine components, but it is not a complete corresponding-source artifact for every component in a redistributed full GE binary archive. Before offering a full offline bundle, inventory the exact GE submodule revisions and component licenses, retain their build recipes, and provide matching sources where required. A bare GitHub top-level source tarball omits submodule contents. [GE submodules](https://github.com/GloriousEggroll/proton-ge-custom/blob/GE-Proton11-6/.gitmodules).

For Wine, LGPL 2.1 section 4 specifies corresponding source for distributed object code and permits equivalent source download access at the same distribution location. Continue publishing the matching prepared source alongside our binary release. Extend source packaging for the original full runtime rather than treating the existing Wine-only archive as covering everything. [Wine's pinned LGPL text](https://github.com/ValveSoftware/wine/blob/9358696fe9a2261329f4a83aa6a65fd436106154/COPYING.LIB).

## Implementation acceptance checks

- Install from an empty initialized Steam root with no GE tool and no `compatibilitytools.d`.
- Install the same pinned revision twice without changing the first installation.
- Reject truncated, corrupt, wrong-architecture, wrong-version and escaping archives before registration.
- Verify host launches execute the internal original files, including Wine and wineserver calls from helper launchers.
- Verify nested launches use the exact matching patched files and preserve current fullscreen, input, DPI, focus and audio regressions.
- Remove the external GE installation in a disposable test fixture and verify the bundled tool still works.
- Install a new revision while an old test process runs; verify the old tree and selected runtime do not change.
- Preserve user-owned Steam tools, game selections and prefixes on install, failure and cleanup.
- Verify Steam/pressure-vessel paths and both architectures in an isolated smoke test; repeat with Protontricks.
- Produce an offline artifact whose source inventory matches all redistributed binaries.

No new runtime tests were run for this design because production Mortal Shell is active and the proposed installer has not been implemented.

## GE 11-6 frame limiter compatibility

The legacy `DXVK_FRAME_RATE=60` setting in the current LSFG wrapper does **not** impose a cap through either of GE 11-6's pinned rendering libraries. GE pins DXVK at `70d7508c01201ed3d4bfb33da42ba834eafe3857` and vkd3d-proton at `c9c6bf2e9c18252dce304272e7ea47d524287b6c`. Both source archives were searched: neither implementation reads `DXVK_FRAME_RATE`. vkd3d's changelog records its removal. [GE tree identities](https://api.github.com/repos/GloriousEggroll/proton-ge-custom/git/trees/7e88cefffc122ea1584c2156b8d7bae6cf69b2a7), [pinned vkd3d changelog](https://github.com/HansKristian-Work/vkd3d-proton/blob/c9c6bf2e9c18252dce304272e7ea47d524287b6c/CHANGELOG.md).

The exact vkd3d revision **still supports `VKD3D_FRAME_RATE`**. Its swapchain initializer reads this variable, accepts positive values and gives them priority over later DXGI target-rate updates. For this revision, `VKD3D_FRAME_RATE=60` is a valid D3D12 cap, whereas `DXVK_FRAME_RATE=60` is not. Issue 2711 proposing removal does not establish that it was removed from this build. [Pinned implementation](https://github.com/HansKristian-Work/vkd3d-proton/blob/c9c6bf2e9c18252dce304272e7ea47d524287b6c/libs/vkd3d/swapchain.c#L3863), [removal discussion](https://github.com/HansKristian-Work/vkd3d-proton/issues/2711).

DXVK's supported configuration controls include `dxvk.maxFrameRate`, `dxgi.maxFrameRate` and `d3d9.maxFrameRate`, supplied through a configuration file or `DXVK_CONFIG`. Its DXGI swapchain forwards the selected rate through `IDXGIVkSwapChain2::SetTargetFrameRate`, which this vkd3d revision implements. However, the pinned DXVK configuration explicitly recommends external limiters over its built-in limiter for pacing. [Pinned configuration](https://github.com/doitsujin/dxvk/blob/70d7508c01201ed3d4bfb33da42ba834eafe3857/dxvk.conf#L75), [DXGI forwarding](https://github.com/doitsujin/dxvk/blob/70d7508c01201ed3d4bfb33da42ba834eafe3857/src/dxgi/dxgi_swapchain.cpp#L1048).

Read-only inspection of installed GE 11-6 DLL strings corroborates this: the x86_64 vkd3d-proton `d3d12core.dll` contains `VKD3D_FRAME_RATE`; DXVK `dxgi.dll` contains both `dxvk.maxFrameRate` and `dxgi.maxFrameRate`. These checks do not measure the game's actual frame rate or exclude another active limiter. They establish that the legacy wrapper variable itself is ineffective with these libraries.

For lwfa integration, prefer a tested per-game base-frame limiter and verify its measured output before enabling interpolation. Do not assume an exported environment variable was honored. Any fallback to runtime-specific controls should be versioned with the Proton component. Do not combine several independent caps without testing which stage each limits. No live limiter or game setting was changed.
