# Dependency upgrade audit

Checked 2026-09-07 against the worktree manifests, installed workspace graph, Cargo.lock, npm registry dist-tags, crates.io stable versions, and primary release notes. This records the baseline before upgrades; verification results will be appended after migration. No production processes or system packages are changed.

## JavaScript baseline and latest stable

Node stays pinned to 24.15.0 in `.mise.toml`. All proposed JavaScript packages support that runtime. `@types/node` stays on 24.13.3, the latest 24.x types, rather than adopting 26.x APIs that the project runtime does not provide.

| Direct dependency | Current | Latest stable | Registry |
| --- | --- | --- | --- |
| `@types/node` | 24.13.3 | 26.4.1 | [metadata](https://registry.npmjs.org/%40types%2Fnode) |
| `smol-toml` | 1.7.1 | 1.8.0 | [metadata](https://registry.npmjs.org/smol-toml) |
| `typescript` | 5.9.3 | 7.0.2 | [metadata](https://registry.npmjs.org/typescript) |
| `vitest` | 3.2.4 | 5.0.0 | [metadata](https://registry.npmjs.org/vitest) |
| `@fontsource-variable/inter` | 5.3.0 | 5.3.0 | [metadata](https://registry.npmjs.org/%40fontsource-variable%2Finter) |
| `@fontsource-variable/jetbrains-mono` | 5.3.0 | 5.3.0 | [metadata](https://registry.npmjs.org/%40fontsource-variable%2Fjetbrains-mono) |
| `@noble/hashes` | 2.3.0 | 2.4.0 | [metadata](https://registry.npmjs.org/%40noble%2Fhashes) |
| `@radix-ui/react-dialog` | 1.1.23 | 1.1.23 | [metadata](https://registry.npmjs.org/%40radix-ui%2Freact-dialog) |
| `@radix-ui/react-dropdown-menu` | 2.1.24 | 2.1.24 | [metadata](https://registry.npmjs.org/%40radix-ui%2Freact-dropdown-menu) |
| `@radix-ui/react-label` | 2.1.15 | 2.1.15 | [metadata](https://registry.npmjs.org/%40radix-ui%2Freact-label) |
| `@radix-ui/react-popover` | 1.1.23 | 1.1.23 | [metadata](https://registry.npmjs.org/%40radix-ui%2Freact-popover) |
| `@radix-ui/react-scroll-area` | 1.2.18 | 1.2.18 | [metadata](https://registry.npmjs.org/%40radix-ui%2Freact-scroll-area) |
| `@radix-ui/react-select` | 2.3.7 | 2.3.7 | [metadata](https://registry.npmjs.org/%40radix-ui%2Freact-select) |
| `@radix-ui/react-separator` | 1.1.15 | 1.1.15 | [metadata](https://registry.npmjs.org/%40radix-ui%2Freact-separator) |
| `@radix-ui/react-slider` | 1.4.7 | 1.4.7 | [metadata](https://registry.npmjs.org/%40radix-ui%2Freact-slider) |
| `@radix-ui/react-slot` | 1.3.3 | 1.3.3 | [metadata](https://registry.npmjs.org/%40radix-ui%2Freact-slot) |
| `@radix-ui/react-switch` | 1.3.7 | 1.3.7 | [metadata](https://registry.npmjs.org/%40radix-ui%2Freact-switch) |
| `@radix-ui/react-tabs` | 1.1.21 | 1.1.21 | [metadata](https://registry.npmjs.org/%40radix-ui%2Freact-tabs) |
| `@radix-ui/react-toggle-group` | 1.1.19 | 1.1.19 | [metadata](https://registry.npmjs.org/%40radix-ui%2Freact-toggle-group) |
| `@radix-ui/react-tooltip` | 1.2.16 | 1.2.16 | [metadata](https://registry.npmjs.org/%40radix-ui%2Freact-tooltip) |
| `@xyflow/react` | 12.11.2 | 12.11.6 | [metadata](https://registry.npmjs.org/%40xyflow%2Freact) |
| `class-variance-authority` | 0.7.1 | 0.7.1 | [metadata](https://registry.npmjs.org/class-variance-authority) |
| `clsx` | 2.1.1 | 2.1.1 | [metadata](https://registry.npmjs.org/clsx) |
| `lucide-react` | 1.28.0 | 1.41.0 | [metadata](https://registry.npmjs.org/lucide-react) |
| `opus-decoder` | 0.7.11 | 0.7.12 | [metadata](https://registry.npmjs.org/opus-decoder) |
| `radix-ui` | 1.6.7 | 1.6.7 | [metadata](https://registry.npmjs.org/radix-ui) |
| `react` | 19.2.0 | 19.2.8 | [metadata](https://registry.npmjs.org/react) |
| `react-dom` | 19.2.0 | 19.2.8 | [metadata](https://registry.npmjs.org/react-dom) |
| `tailwind-merge` | 3.6.0 | 3.6.0 | [metadata](https://registry.npmjs.org/tailwind-merge) |
| `@tailwindcss/vite` | 4.3.3 | 4.3.3 | [metadata](https://registry.npmjs.org/%40tailwindcss%2Fvite) |
| `@types/react` | 19.2.2 | 19.2.18 | [metadata](https://registry.npmjs.org/%40types%2Freact) |
| `@types/react-dom` | 19.2.1 | 19.2.7 | [metadata](https://registry.npmjs.org/%40types%2Freact-dom) |
| `@vitejs/plugin-react` | 5.0.4 | 6.1.1 | [metadata](https://registry.npmjs.org/%40vitejs%2Fplugin-react) |
| `tailwindcss` | 4.3.3 | 4.3.3 | [metadata](https://registry.npmjs.org/tailwindcss) |
| `tw-animate-css` | 1.4.0 | 1.4.0 | [metadata](https://registry.npmjs.org/tw-animate-css) |
| `vite` | 7.1.12 | 8.2.2 | [metadata](https://registry.npmjs.org/vite) |
| `motion-dom` | 12.43.0 | 13.2.0 | [metadata](https://registry.npmjs.org/motion-dom) |

## Rust baseline and latest stable

Rust stays pinned to 1.95.0 in `.mise.toml`, `rust-toolchain.toml`, workspace MSRV, and `deploy/build/Dockerfile`. Additional older versions listed in Cargo.lock are transitive copies; the current column below uses the direct compatible version.

| Direct dependency | Locked version(s) | Latest stable | Registry |
| --- | --- | --- | --- |
| `argon2` | 0.5.3 | 0.6.0 | [metadata](https://crates.io/api/v1/crates/argon2) |
| `calloop` | 0.13.0, 0.14.4 | 0.14.4 | [metadata](https://crates.io/api/v1/crates/calloop) |
| `calloop-wayland-source` | 0.3.0, 0.4.1 | 0.4.1 | [metadata](https://crates.io/api/v1/crates/calloop-wayland-source) |
| `ffmpeg-next` | 9.0.0 | 9.0.0 | [metadata](https://crates.io/api/v1/crates/ffmpeg-next) |
| `futures-channel` | 0.3.33 | 0.3.34 | [metadata](https://crates.io/api/v1/crates/futures-channel) |
| `image` | 0.25.10 | 0.25.10 | [metadata](https://crates.io/api/v1/crates/image) |
| `input-linux` | 0.7.1 | 0.7.1 | [metadata](https://crates.io/api/v1/crates/input-linux) |
| `libc` | 0.2.189 | 0.2.189 | [metadata](https://crates.io/api/v1/crates/libc) |
| `opus` | 0.3.1 | 0.4.0 | [metadata](https://crates.io/api/v1/crates/opus) |
| `rusqlite` | 0.40.1 | 0.40.2 | [metadata](https://crates.io/api/v1/crates/rusqlite) |
| `rustix` | 0.38.44, 1.1.4 | 1.1.4 | [metadata](https://crates.io/api/v1/crates/rustix) |
| `serde` | 1.0.229 | 1.0.229 | [metadata](https://crates.io/api/v1/crates/serde) |
| `serde_json` | 1.0.151 | 1.0.151 | [metadata](https://crates.io/api/v1/crates/serde_json) |
| `sha2` | 0.10.9, 0.11.0 | 0.11.0 | [metadata](https://crates.io/api/v1/crates/sha2) |
| `smithay` | 0.7.0 | 0.7.0 | [metadata](https://crates.io/api/v1/crates/smithay) |
| `toml` | 0.9.12+spec-1.1.0 | 1.1.5+spec-1.1.0 | [metadata](https://crates.io/api/v1/crates/toml) |
| `tracing` | 0.1.44 | 0.1.44 | [metadata](https://crates.io/api/v1/crates/tracing) |
| `tracing-subscriber` | 0.3.23 | 0.3.23 | [metadata](https://crates.io/api/v1/crates/tracing-subscriber) |
| `tungstenite` | 0.30.0 | 0.30.0 | [metadata](https://crates.io/api/v1/crates/tungstenite) |
| `wayland-client` | 0.31.15 | 0.31.15 | [metadata](https://crates.io/api/v1/crates/wayland-client) |
| `wayland-protocols` | 0.32.13 | 0.32.13 | [metadata](https://crates.io/api/v1/crates/wayland-protocols) |
| `wayland-protocols-wlr` | 0.3.12 | 0.3.12 | [metadata](https://crates.io/api/v1/crates/wayland-protocols-wlr) |
| `x11rb` | 0.13.2 | 0.14.0 | [metadata](https://crates.io/api/v1/crates/x11rb) |
| `zbus` | 5.18.0 | 5.19.0 | [metadata](https://crates.io/api/v1/crates/zbus) |

## Migration plan and concrete benefit

1. Update React and React DOM together to 19.2.8, their React type packages, and the compatible updates to XYFlow, icons, noble hashes and the TOML generator. Retest focus restoration and controller UI because these depend on real React lifecycle behavior. Published React patch notes primarily concern server components; lwfa is client-rendered, so this is maintenance rather than evidence of a streaming improvement. [React changelog](https://github.com/facebook/react/blob/main/CHANGELOG.md).

2. Update `opus-decoder` to 0.7.12. Its release fixes decoder `free()` handling and constructor properties being incorrectly minified. Those are directly relevant to audio decoder teardown and production bundles. Verify the real WASM decoder and browser audio playback fixture. [Release](https://github.com/eshaz/wasm-audio-decoders/releases/tag/opus-decoder/0.7.12).

3. Move Vite to 8.2.2 and plugin-react to 6.1.1 together. Vite 8 replaces Rollup/esbuild with Rolldown/Oxc and improves the build pipeline. The project uses plain `react()` with no Babel plugins, so plugin-react 6 removing embedded Babel does not require a replacement Babel stack. Update browser fixture JSX config from `esbuild` to `oxc`; preserve the existing browser build targets explicitly because Vite 8 changes its defaults. Test both production bundling and isolated browser harnesses. These are build-time changes, not proof of increased stream frame rate. [Vite migration](https://vite.dev/guide/migration), [plugin-react changelog](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/CHANGELOG.md), [supported Vite releases](https://vite.dev/releases).

4. Move Vitest to 5.0.0, released September 3. Node 24.15.0 and Vite 8 meet its prerequisites. Version 4 changes mock construction and module runners; version 5 clears mock histories between tests by default. Check actual failures rather than disabling new defaults preemptively. This project has no custom pool or deprecated runner entrypoint. [Vitest 5 release](https://main.vitest.dev/blog/vitest-5), [migration guide](https://main.vitest.dev/guide/migration/).

5. Move TypeScript to official `typescript@7.0.2`, whose `tsc` CLI uses the native compiler. Keep type checking in the existing CLI workflow. Remove the obsolete `baseUrl` setting and make the existing path mapping relative explicitly. `scripts/e2e-audio-playback.mjs` calls the old JavaScript compiler API; replace that type-stripping use with Node 24 `stripTypeScriptTypes` before upgrading. TypeScript 7 currently lacks the stable programmatic API needed by that old call. The native compiler can reduce type-check turnaround; measure locally instead of repeating upstream speedup claims. [Official 7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [removed options](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html), [Node type stripping API](https://nodejs.org/download/release/v24.15.0/docs/api/module.html#modulestriptypescripttypescode-options).

6. Try `motion-dom` 13.2.0 against the existing three-way Rust/TypeScript/upstream spring parity suite. Motion 13 changes optional React prop validation, while 13.2 includes spring implementation optimizations. The dependency is a test oracle here, not a reason to change spring behavior silently. Preserve the numerical tolerance; if its equations changed, port deliberately in both languages before accepting a new oracle. [Motion changelog](https://github.com/motiondivision/motion/blob/main/CHANGELOG.md).

## Rust recommendations for the engine owner

- `futures-channel` 0.3.34 and `rusqlite` 0.40.2 are patch updates. Upgrade their compatible lockfile graph and run the full engine suite, including account and portal fixtures.
- `zbus` 5.19 adds explicit connection-failure reporting and removes unnecessary clones. This can improve portal error handling without introducing another async runtime. Check exhaustive error matches and portal integration tests. [Release](https://github.com/z-galaxy/zbus/releases/tag/zbus-5.19.0).
- `opus` 0.4 replaces the old `audiopus_sys` binding with maintained `opusic-sys`, bundling Opus 1.5.2 according to the migration commit. This is a concrete audio maintenance improvement. Inspect dynamic/static linking and portable-bundle output, then run packet decode and audio lifecycle checks; do not promise lower latency from the version alone. [Version diff](https://github.com/SpaceManiac/opus-rs/compare/v0.3.1...v0.4.0).
- `argon2` 0.6 detects allocation failures and fixes parameter validation, but removes the `std` feature and changes to password-hash 0.6. Adapt salt generation and PHC API usage in `accounts.rs`, then verify existing stored 0.5 PHC hashes still authenticate. Keep password parameters stable. Do not enable parallel hashing merely because the feature is new. [Changelog](https://github.com/RustCrypto/password-hashes/blob/master/argon2/CHANGELOG.md).
- `toml` 1.1.5 is the newest stable. The project uses `toml::Table` and `from_str`, so assess the parser/Serde upgrade with configuration fixtures, including errors and unknown fields. Retain the current parse/serde feature selection. [Crate](https://crates.io/crates/toml/1.1.5+spec-1.1.0).
- `x11rb` 0.14 must not be upgraded independently without checking Smithay integration: the project passes Smithay XWM connection types into its own focus helper, and Smithay 0.7 depends on 0.13. A second direct 0.14 copy can produce incompatible connection traits/types. Prefer Smithay-compatible 0.13 unless the direct dependency is removed in favor of a Smithay re-export or the boundary is adapted with evidence. [Smithay manifest](https://github.com/Smithay/smithay/blob/v0.7.0/Cargo.toml), [x11rb crate](https://crates.io/crates/x11rb/0.14.0).

## Rendering and transport boundaries

Smithay 0.7.0, ffmpeg-next 9.0.0, tungstenite 0.30.0, image 0.25.10, and the direct Wayland crates are already the latest stable registry versions. There is no newer released Smithay to install to fix per-window scaling automatically. Prefer the protocol/capture/input changes being verified in this goal over pinning an unreviewed Smithay master revision. [Smithay releases](https://github.com/Smithay/smithay/releases), [FFmpeg binding releases](https://github.com/zmwangx/rust-ffmpeg/releases), [tungstenite crate](https://crates.io/crates/tungstenite).

WebCodecs is a browser API, not an npm library update. Keep capability probes, explicit decoder cleanup, bounded decode queues, and fallback paths; dependency refresh does not change iPad WebKit support. Any stream improvement must be demonstrated with frame-size, queue, or audio evidence. [WebCodecs specification](https://www.w3.org/TR/webcodecs/).

The portable Docker build already pins FFmpeg 9.0.1, the newest stable tag found; 9.1-dev is not a release candidate to ship. NV codec headers have newer n13.0.19.1 and n13.1.15.0 tags beyond pinned n13.0.19.0. Inspect minimum driver/API changes before updating the bundled encoder interface because the release runs against the end-user driver. The Debian 11 base intentionally preserves the glibc 2.31 floor; changing to a newer base would narrow portable compatibility. [FFmpeg tags](https://github.com/FFmpeg/FFmpeg/tags), [NV codec header tags](https://github.com/FFmpeg/nv-codec-headers/tags).

## JavaScript migration verification

Completed the planned JavaScript upgrades, including `motion-dom` 13.2.0. Its existing three-way numerical parity checks pass without changing either spring implementation or tolerances. The only remaining `pnpm outdated -r --format json` entry is `@types/node` 26.4.1, deliberately excluded because the runtime remains Node 24.15.0.

The project package-manager pin also moved from pnpm 11.1.1 to 12.3.4. The official v12 notes preserve frozen compatibility with existing lockfiles and describe stricter workspace-setting validation. The frozen install succeeded with pnpm 12.3.4 and checked all 237 lock entries. This changed the project pin, not the machine's global pnpm installation. The obsolete esbuild build-script exception was removed because the new graph no longer installs esbuild. [pnpm 12 notes](https://github.com/pnpm/pnpm/releases/tag/v12.0.0), [12.3.4 fixes](https://github.com/pnpm/pnpm/releases/tag/v12.3.4).

TypeScript 7 detected previously undeclared CSS side-effect imports. Added the standard shell `vite/client` declaration instead of disabling the compiler's check. Vite's existing browser floor stays explicit: Chrome/Edge 107, Firefox 104 and Safari 16. The browser fixtures now use the supported Oxc JSX configuration.

Verified on Node 24.15.0:

- `pnpm exec vitest run`: 663 tests pass across 38 files, including spring parity and protocol fixtures.
- `pnpm typecheck`: passes with TypeScript 7.0.2.
- `pnpm build`: Vite 8.2.2 production build passes.
- `scripts/e2e-window-scaling-panel.mjs`: all seven factors and both modes, Auto, server-confirmed selection, applied scale, Xwayland restrictions, follower restrictions, old-engine restrictions, touch targets, narrow layout and no focus commands pass.
- `scripts/e2e-scaling-input.mjs`: real browser pointer/touch alignment and stable 1000×500 CSS layout pass at all seven factors on DPR 1 and DPR 2.
- `scripts/e2e-focus-restoration.mjs`: panel/dialog restoration and replacement/queued dialog checks pass.
- `scripts/e2e-follower-focus.mjs`: interactive and view-only follower resynchronization remains passive; deliberate focus respects permissions.
- `scripts/e2e-controller-recovery.mjs`: real reset, blur releases and neutral rearming pass.
- `scripts/e2e-gamepad-visibility.mjs`: physical/touch output parity, held-input cleanup, hidden-controller behavior and toolbar targets pass.
- `scripts/e2e-audio-playback.mjs`: scheduled and AudioWorklet paths produce real PCM waveform output and pass flush/teardown checks after replacing the removed TypeScript compiler API.
- New `scripts/e2e-opus-decoder.mjs`: a production-minified build of the actual `OpusStream` imports the real WASM decoder, consumes browser-encoded synthetic stereo PCM packets and verifies distinct decoded channels across 12 create/decode/free cycles. No microphone, engine or system capture is used.

Browser commands use `PLAYWRIGHT_MODULE` and `CHROMIUM_EXECUTABLE` to select the installed Playwright module and Chromium. No production app or engine was restarted for this migration.

## Rust migration and verification

Updated the engine to `argon2` 0.6.0, `futures-channel` 0.3.34, `opus` 0.4.0, `rusqlite` 0.40.2, `toml` 1.1.5+spec-1.1.0 and `zbus` 5.19.0. Cargo.lock includes their compatible supporting crates. Retained direct `x11rb` 0.13.2 because Smithay 0.7.0 exposes that version's connection types. Rust 1.95.0, edition 2024 and the Debian 11 portable base remain unchanged.

Argon2 0.6 uses `password_hash::phc::PasswordHash` and generates the random salt inside `hash_password`. Removed the obsolete `std` feature and `rand_core::OsRng` import. The account regression test inserts a PHC string actually generated with 0.5.3 before migration, authenticates it through the account database, rejects a wrong password, and checks that new hashes retain Argon2id v19 with `m=19456,t=2,p=1`. No user database was opened or migrated. The maintained release fixes allocation-failure handling and parameter validation; parallel hashing remains disabled. [Argon2 0.6 source and usage](https://github.com/RustCrypto/password-hashes/blob/argon2-v0.6.0/argon2/src/lib.rs), [release changelog](https://github.com/RustCrypto/password-hashes/blob/argon2-v0.6.0/argon2/CHANGELOG.md).

Correction to the initial Opus recommendation: the current resolved `opusic-sys` is 0.7.5, bundling **Opus 1.6.1**, rather than the 1.5.2 bundled when the Rust migration was first authored. Its default `bundled` feature builds a static library with CMake 3.16 or later, which the Debian 11 build image satisfies. The crate's runtime CPU detection stays enabled; optional DRED and OSCE features stay disabled. The actual encoder test reports `linked libopus 1.6.1` and encodes/decodes 48 kHz stereo 20 ms packets while changing 64, 128 and 192 kbit/s rates, checking frame count and non-silent decoded output. This demonstrates codec operation, not an end-to-end latency or listening-quality improvement. [Binding source](https://github.com/DoumanAsh/opusic-sys), [Opus release and compatibility](https://www.opus-codec.org/demo/opus-1.6/).

Advanced the portable NV codec headers from n13.0.19.0 to n13.0.19.1. The version diff adds CUDA interface declarations/loading and leaves the NVENC interface header unchanged. Its declared minimum driver remains 570.0. Retained the 13.0 SDK line because 13.1.15.0 raises the driver requirement to 610.0, which would unnecessarily narrow the release's hardware compatibility. FFmpeg remains 9.0.1. [13.0 patch diff](https://github.com/FFmpeg/nv-codec-headers/compare/n13.0.19.0...n13.0.19.1), [13.0 driver requirement](https://github.com/FFmpeg/nv-codec-headers/blob/n13.0.19.1/README), [13.1 driver requirement](https://github.com/FFmpeg/nv-codec-headers/blob/n13.1.15.0/README).

Verification after migration: `mise exec -- cargo test --workspace --offline` passed 296 engine tests (4 hardware/isolation tests ignored), 23 protocol tests, both TypeScript-to-Rust fixture checks and 11 spring tests. This includes the legacy account test, real Opus packet test, shipped configuration parsing, unknown-field diagnostics and existing portal tests. A separate `audio::tests::opus_packets_stay_decodable_while_the_rate_changes -- --nocapture` run confirmed the linked library version. Portable build/ELF compatibility and real streaming checks are separate acceptance checks and are recorded after they actually run.

## Final acceptance

After the scaling, HEVC, and resource-lifetime corrections, final typecheck and
all 679 JavaScript tests pass. The nine browser harnesses for focus, followers,
controllers, visibility, audio playback, real WASM Opus, scaling input, the
scaling panel, and codec fallback pass. The fallback harness additionally
verifies reconnect cleanup without discarding surviving window resources.

The updated Rust graph built successfully in the Debian 11 portable image,
including bundled Opus 1.6.1 and the Argon2/TOML migrations. All seven packaged
ELF files require at most GLIBC 2.30, within the 2.31 target floor. Debian 13
resolves every packaged dependency except the documented host `libdrm.so.2`.
The final `.run` was executed inside a disposable Debian 13 container and
cancelled at the write step, exiting successfully. Its frontend assets and
bundled documentation match the final build and source files.

Native rendering and input evidence is recorded in
[scaling status](window-scaling-status.md). The package was built locally for
validation; no public release, system dependency installation, production
engine restart, or user account migration was performed.
