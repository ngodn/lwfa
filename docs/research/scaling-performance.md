# Scaling performance

Investigated on 2026-09-07 alongside the Proton fix for 1.5.2.

## Capture and encoding paths

Window capture is rendered with GLES. With the default `stream.gpu_direct`,
the GL texture is copied on the GPU through CUDA and encoded by NVIDIA NVENC.
H.264 and HEVC do not have a CPU resizing stage in this path.

If CUDA capture fails, the engine can read pixels back through a pixel buffer,
copy them on the CPU, and upload them for NVENC. JPEG is a separate CPU encoder:
when capture supplies a CUDA frame, `CapturedFrame::cpu_pixels` downloads it
before JPEG encoding. A codec fallback can therefore increase CPU and transfer
work without a CUDA failure.

Source: `capture.rs`, `cuda.rs`, and `encode.rs` under
`crates/lwfa-engine/src/`.

## Running session logs

The journal for production engine PID 2893165 showed:

- 20:29:40 local time: direct GPU capture initialized successfully and HEVC
  NVENC sessions opened.
- No CUDA-disable, CUDA-unavailable, encoding-failure, or NVENC-session-limit
  warnings in the available journal for this process.
- 21:32:38: codec negotiation selected JPEG because no video codec was common
  to the active viewers. This uses CPU JPEG encoding.

The current info log does not identify the codec offers behind that last
change. It cannot establish whether a browser decoder rejected a stream,
someone selected JPEG, or viewers advertised incompatible codecs. Do not
attribute that switch to scaling or a driver failure without more evidence.
No production process, settings, or streams were changed by this inspection.

## Fixed: unnecessary Auto stream rebuilding

Every accepted browser viewport change called `refresh_auto_scaling`, which
destroyed capture buffers and encoder sessions for Auto Sharp windows even
when their own size and effective density were unchanged.

The fix compares the bounded effective density using the previous and new
display scales. Unchanged density retains the stream. Real density changes
still invalidate it, and capture/encoder geometry checks remain in place.

Measured with a native Wayland Chromium fixture, a fixed 1000x640 app, Auto
Sharp at DPR 2, and H.264 NVENC over direct GPU capture:

| Operation | Before | After |
| --- | --- | --- |
| Ten viewport-only resizes, encoder reopens | 10 | 0 |
| Video dimensions throughout those resizes | 2000x1280 | 2000x1280 |
| Subsequent DPR change to 1 | 1000x640, input passes | 1000x640, input passes |

All twelve phases checked decoded frames, codec, logical geometry, mouse,
and touch, including the bottom-right edge. Run the maintained harness with
`LWFA_TEST_AUTO_VIEWPORT=1` and the isolated-engine environment documented in
`scripts/e2e-scaling-rendering.mjs`. Phase timestamps and window IDs correlate
with the existing encoder-open info logs.

Evidence is under `target/proton-dpi-investigation/`: the
`auto-resize-before` and `auto-resize-after` JSON and engine logs, and
`auto-resize-comparison.json`. These counts measure avoided initialization,
not a general frame-rate or latency improvement for every app.

## Remaining profiling candidates

These are source findings, not measured causes of the user's slowdown:

- Known JPEG streams still take the CUDA capture route before downloading;
  compare it with the existing pipelined readback route.
- Failed NVENC session creation retries on subsequent frames. Repeated
  initialization may delay the shared encoder worker at unsupported sizes.
- CUDA errors disable direct capture for the rest of the process. Distinguish
  recoverable allocation pressure from persistent interop failures before
  adding retries.

Larger workspaces also increase the app's rendering work. Doubling both
dimensions means four times as many pixels, even on the direct GPU path.
