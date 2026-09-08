# Window scaling investigation index

Historical record. Sharper and More space were removed on 2026-09-08.
See [the removal and regression checks](canvas-sizing-removal.md) for current behavior.

Read this index and the status document when resuming the scaling goal.

## Established decisions

- The corrected user choice is **offer both modes**, not just HiDPI or just
  workspace resizing. All seven factors from 0.5x to 2x are in scope.
- A 1000x500 browser rectangle at 2x means 2000x1000 rendered pixels. HiDPI keeps
  1000x500 application logical size; workspace mode asks for 2000x1000 logical
  space. These are different behaviors and must not be conflated.
- Keep 1x as the default; explicit Auto allows native display density up to 2x.
- Pointer/touch coordinates must be independent of encoded frame dimensions.
- Do not change Xwayland's shared client scale to implement per-window policy.
- A larger buffer or interpolated image alone does not prove sharper text.
- Production and the user's desktop configuration are outside the test scope.

## Artifacts

| File | Purpose |
| --- | --- |
| [Status](window-scaling-status.md) | Decisions, current implementation, proof, and next work |
| [Primary-source research](window-scaling-research.md) | Wayland, Xwayland, display density, and sampling constraints |
| [Dependency audit](dependency-upgrade-audit.md) | Registry checks, migrations, retained versions, and validation |
| [HEVC decoder research](hevc-decoder-capability.md) | Parameter sets, actual-size checks, and verified codec fallback |
| [Hardware codec recovery](codec-resize-recovery.md) | Actual NVENC packets, software decoding, and shell parser checks through 4000x3000 |
| [Correctness review](window-scaling-review.md) | Independent findings and their resolution |
| [Real-app measurements](fixtures/window-scaling-measurements.json) | Pixel density, workspace sizes, input, edges, and popup checks |
