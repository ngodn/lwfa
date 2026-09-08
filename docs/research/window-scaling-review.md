# Window scaling correctness review

Historical record. Sharper and More space were removed on 2026-09-08.
See [the removal and regression checks](canvas-sizing-removal.md) for current behavior.

Reviewed 2026-09-07 while scaling integration and the isolated Xwayland output fix were in progress. This is an independent review of the Rust implementation and wire/input contract. It does not certify live iPad behavior. No implementation files or production processes were changed by this review.

## Findings

### 1. Host preview must use actual committed geometry (P1)

The initial implementation used `fit / layout.workspace_scale(id)` in `preview_elements`, and multiplied host input coordinates by the same requested workspace factor. Browser capture instead takes the actual `window.geometry().size`, and the browser stretches the complete frame into the unchanged layout rectangle.

Concrete scenario: a 1000×500 tile requests 2× workspace, but the app retains a 1000×500 buffer because it is fixed-size, still processing the configure, or refusing it. The browser still displays the complete buffer in 1000×500. The host preview projects it into 500×250 and leaves the rest empty. If the app enforces a larger minimum, the host crops pixels that remain visible remotely. Different width and height constraints require separate axis ratios.

Evidence: [preview projection](../../crates/lwfa-engine/src/winit.rs#L77), [preview input](../../crates/lwfa-engine/src/input.rs#L215), [actual capture dimensions](../../crates/lwfa-engine/src/state.rs#L2043), [normalized remote mapping](../../crates/lwfa-engine/src/scaling.rs#L134). This follows directly from the two coordinate formulas; it was not inferred from a screenshot.

Status: fixed and verified in focused tests. The current worktree calls `preview_scale(rect.size, window.geometry().size, fit)` and uses its inverse for input. The test cases cover unchanged committed geometry after a larger workspace request, a 1200x800 minimum inside a 1000x500 tile, height-only character-cell rounding, CSD offsets, and drag coordinates beyond the window. Eight preview/input tests pass. These simulate committed geometry directly; they are not claims that a live configure-refusing app or host framebuffer was inspected.

The older fit-as-opacity defect is also removed. `preview_elements` supplies alpha 1.0 when creating native surface elements, applies fitting with `RescaleRenderElement`, and calls the damage tracker's renderer directly. The opaque-render regression checks that a 2000x1000 source fits into 1000x500 with alpha still 1.0. No remaining preview call passes `fit` to an alpha argument.

### 2. Workspace `effectiveScale` reports the requested limit, not actual application scale (P2)

`effective_scale` bases workspace mode on the shell's base rectangle and requested factor. It does not compare the application's committed size to that rectangle. Therefore, the same configure-refusing app reports `effectiveScale: 2` while retaining its original workspace, and the panel says `Applied: 2×`.

Evidence: [effective scale calculation](../../crates/lwfa-engine/src/scaling.rs#L50), [panel label](../../packages/shell/src/panels/WindowScalingControls.tsx#L82). This is independent of the host-preview correction. It also matters for apps with character-cell rounding or asymmetric minimum sizes, where one scalar may not describe both axes accurately.

Resolve by reporting actual geometry/dimensions or separate axis factors, or by clearly labeling the existing field as the configured/request-limited factor and explaining that the app can decline that size. The display must distinguish a selected request from what the app actually produced. A test should hold committed geometry constant while changing the requested factor.

Status: fixed. The panel now labels workspace metadata as `Workspace request`, labels sharp metadata as `Capture density`, and explains that apps may round or limit a requested workspace size. The real-panel browser fixture verifies the distinction between selected 2× and bounded 1.75× without claiming actual app acceptance, along with unchanged browser layout and the existing mode/permission checks.

### 3. Encoder cleanup waits indefinitely for another frame (P2, existing lifetime defect)

The encoding worker blocks on `frames_rx.recv()` and drains control messages only after receiving a video job. `forget` removes admission state synchronously but sends encoder destruction through that control queue. Closing the final streaming window leaves no next frame to wake the worker, so its encoder session and associated GPU allocations remain until another frame arrives or the worker exits. The control channel has capacity 16 and `try_send` errors are ignored, so an idle burst can also discard cleanup requests.

Evidence: [worker receive and control drain](../../crates/lwfa-engine/src/encode.rs#L1085), [forget delivery](../../crates/lwfa-engine/src/encode.rs#L1199), [window retirement](../../crates/lwfa-engine/src/state.rs#L607), [actual encoder-session removal](../../crates/lwfa-engine/src/encode.rs#L138).

This behavior predates render scaling. Larger captures make its retained resources more expensive. The capture texture itself is removed synchronously, so this finding should not be described as every allocation leaking. Fix control wakeup/reliable delivery without losing the existing requirement that pending control is processed before the first frame after reconnect. Verify closing the last window frees its session with no replacement frame, plus more than 16 queued cleanup operations.

Status: fixed and verified. Frames and controls now share a condition-variable work queue. Controls wake an idle worker, coalesce by desired state, and apply before any frame returned in the same batch. Forget operations cannot overflow the old 16-slot channel. Admission tickets are still checked before encoding and again before delivery, so cleanup cannot resurrect a queued or in-flight old frame.

`mise exec -- cargo test -p lwfa-engine work_queue_tests --offline` passes all three tests: an idle worker processes forget without receiving another frame, a full frame queue retains 64 distinct cleanup operations while coalescing 1000 updates, and shutdown wakes an empty worker. The idle test applies cleanup to actual `Encoders` fallback/retirement state. It does not measure driver allocation release on a hardware encoder; that conclusion is limited to the tested queue behavior and the existing encoder-removal path.

### 4. Allowed scaled frame sizes exceed the declared HEVC capability (P2 validation gap)

Capture accepts up to 16,777,216 pixels, but the browser decoder always declares HEVC Main level 5.1 (`hvc1.1.6.L153.B0`). Its initial capability probe only checks 1920×1080. A 2000×1500 window at 2× produces 4000×3000, which is within the capture cap but exceeds level 5.1's 8,912,896 maximum luma-picture samples. FFmpeg's level table confirms this boundary. [FFmpeg 9.0.1 level table](https://github.com/FFmpeg/FFmpeg/blob/n9.0.1/libavcodec/h265_profile_level.c#L32).

Evidence: [capture limits](../../crates/lwfa-engine/src/scaling.rs#L13), [hardcoded HEVC codec](../../packages/shell/src/decode.ts#L57), [capability probe size](../../packages/shell/src/lib/codecs.ts#L66), [decoder creation](../../packages/shell/src/decode.ts#L239). Decoder errors reset the local decoder but do not currently tell the engine to choose another codec or smaller frame for this window.

The incorrect coverage assumption is established from code and the codec limit. A device-specific decode failure has not been reproduced, so this is not a claim that every browser rejects the stream. Parse the actual parameter sets or negotiate a correct profile/level and dimensions, then verify a frame above the old 4K envelope and a decoder that rejects that size. Failure must produce a usable fallback or an explicit limitation. HEVC codec strings and Annex B configuration are described by the [WebCodecs HEVC registration](https://www.w3.org/TR/webcodecs-hevc-codec-registration/).

Status: fixed and covered by unit and browser negotiation tests. HEVC now derives its actual codec string from SPS, configuration includes coded dimensions, actual-stream support is checked, and decoder rejection immediately renegotiates another format. See [HEVC capability implementation and validation](hevc-decoder-capability.md). This remains distinct from a demonstrated iPad-specific failure.

## Paths checked without finding another concrete regression

- Scaling state is keyed by `WindowId`, included in live metadata/hello, and removed on window retirement. New windows default to Sharp 1×. Existing windows retain their scaling across browser reconnects.
- Only the primary interactive session can change window scaling. Followers and view-only sessions cannot bypass the engine check with a raw command. Existing per-app permissions govern spawning rather than visibility of already shared windows.
- Auto reads the primary viewport's finite, bounded display ratio. Changing the viewport refreshes Auto windows. Explicit factors do not follow another display accidentally.
- Browser pointer and touch coordinates are normalized in layout space, then projected into the engine's actual window geometry. Analog/controller traffic does not pass through this mapping.
- Capture invalidates a target when size or density changes before harvesting old readback. Encoding admission tickets are invalidated by a scale change, and an in-flight old job is checked again before frame handoff.
- Browser decoder reconfiguration invalidates pending bitmap delivery; closing a window removes its decoder and published frame. Reconnect hello also retires windows that closed while disconnected, preserving surviving windows. The CPU frame pool now retains at most eight buffers and 64 MiB of padded pixel data, with eviction and oversized-buffer regression tests.

These are code-path observations. They do not substitute for the separate Wayland/Xwayland, capture, browser, and hardware validation recorded for the implementation.
