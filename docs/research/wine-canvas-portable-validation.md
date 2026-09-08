# Wine canvas portable validation

Validated on 9 September 2026 using the SDK-built GE-Proton11-6 canvas components
and the extracted Debian 11 build of lwfa 1.5.5. The final tagged rebuild has the
same five Wine payload hashes and manifest as the tested SDK candidate. Its
packaged launcher and engine also passed the final smoke test below.

## Inputs and isolation

- Engine SHA-256: `d5f35cd6b8f1a9ec9d1d78ce695857866ecb0687e30242cce636c4381ed695c4`.
- Wine artifact manifest SHA-256: `6c5e856dd1be03af620f6b3d587effc91b5189b669d990b38b84c957974d6fb7`.
- SDK: Steam Runtime 4, pinned by [sdk.json](../../compat/wine-canvas/sdk.json).
- Original runtime: `GE-Proton11-6-x86_64`, verified against the artifact manifest.
- Each suite used a fresh Wine prefix and an independently owned headless Weston
  and lwfa engine on loopback port 6757 (6756 for the 32-bit suites).
- A disposable Steam directory registered the compatibility tool. Tests launched
  its actual native `files/bin/wine` and `files/bin/wineserver` front doors.
- Direct Wine tests supplied Steam's 32-bit XInput/Xrender libraries explicitly.
  This does not establish that a direct launch works without GE's runtime dependencies.

## Results

| Check | Result |
| --- | --- |
| Responsive 64-bit DXVK fullscreen buffers | Pass |
| Retained 64-bit DXVK fullscreen buffers | Pass |
| Explicit 1280×720 DXVK display mode | Pass |
| Explicit mode across host changes, native follow and reset | Pass |
| Custom pointer clip across growth and portrait, then release | Pass |
| DPI during window growth and browser resize | Pass |
| 32-bit GDI, responsive DXVK and retained DXVK matrices | Pass |
| Private Wine mappings inside lwfa, original GE mappings on host | Pass |
| Reject active shared-prefix attachment from the other runtime | Pass in both directions |
| Canvas mode-intent flags absent from disk after server exit | Pass |
| Original GE file hashes unchanged | Pass |

All three DXVK suites exercised 1324×838, 1490×910, 838×1324, 640×480,
1324×838 and fullscreen exit. Each checked the four rendered corners and
bottom-right mouse input. Host routing was checked after the private server had
exited, using the same disposable prefix.

The first DPI run completed all queries without an assertion. Its cleanup was
incorrectly marked failed because Wine returns status 1 for `wineserver -k` when
the server has already exited. The harness now accepts that specific case only
after `wineserver -w` confirms exit. The DPI-only rerun passed with this check.

## Local evidence

- Full suites and routing: `target/portable-router-integration/run-3kr46wu_/`.
- DPI rerun: `target/portable-router-integration/run-pm1pvcbc/dpi/results.json`.
- 32-bit suites: `target/sdk-proton32-validation/run-m73di8p7/results.json`.
- Runner: `target/portable-router-integration/run.py`.

The runner records the engine and manifest hashes, actual process mappings,
prefix-guard results, suite exit codes and per-suite measurements. All owned
test engines, Weston instances and Wine servers were stopped afterward.
The separate 32-bit runner used the same engine and Wine manifest hashes. Its
three suites each passed six measured phases and verified the original base
runtime remained unchanged.

## Final tagged package

- Tag commit: `8e6ae32633fe13a04748a697c483387a6c259345`.
- Portable `.run` SHA-256: `e3b5b7d60009665a03cfbed4a580a918b17faf7e2b13d1cfc17d734b8016a336`.
- Packaged launcher SHA-256: `93f4055348884c3e5fdc4e861d3108131b81bb6195214d587da96aa636ece551`.
- Smoke evidence: `target/portable-router-integration/run-5oefcnky/results.json`.

The final smoke used `manage.py`, `router.py`, the native launcher, Wine artifact
and engine extracted from the portable package. Host/private library mappings,
both directions of the prefix guard and the full responsive 64-bit DXVK
resize/input/fullscreen-exit matrix passed. The packaged artifact matches the
final SDK build byte-for-byte. All 15 source-recipe files match the release tag.
The original GE hashes remained unchanged and all owned test processes stopped.

Comparison records are `target/portable-router-integration/final-source-comparison.json`
and `target/portable-router-integration/final-package-comparison.json`.
