# HEVC stream capability and fallback

Checked and implemented 2026-09-07. This fixes the browser's stream configuration and negotiation. It does not establish that every browser or iPad can decode the maximum permitted capture size.

## What was wrong

The decoder always declared HEVC Main level 5.1, even though density scaling can generate frames above that level's picture-size limit. The initial family probe also paired HEVC level 3.1 and H.264 level 3.0 with 1920×1080, larger than those declared levels accommodate. A successful small-stream probe cannot establish support for a different profile, level, or resolution. WebCodecs checks those codec-string fields explicitly. [WebCodecs configuration support](https://www.w3.org/TR/webcodecs/#config-support)

## Change

Both video families now derive their codec string from the keyframe's Annex B SPS. HEVC reads the fixed general profile/tier/level prefix after removing emulation-prevention bytes. Compatibility flags are reversed into RFC 6381 order, profile space and tier are preserved, and trailing zero constraint bytes are omitted. The prefix layout is confirmed by [FFmpeg's HEVC SPS parser](https://github.com/FFmpeg/FFmpeg/blob/n9.0.1/libavcodec/hevc/ps.c#L1141); codec-string construction is cross-checked against [GPAC's sample entry implementation](https://github.com/gpac/mp4box.js/blob/main/src/boxes/sampleentries/sampleentry.ts#L113). No HEVC decoder implementation or third-party parser dependency was added.

The initial 1080p family probes use Main profile level 4. When an actual stream changes profile, level, or dimensions, FrameDecoder configures and probes those exact values. With no `description`, the stream remains Annex B as required by the [WebCodecs HEVC registration](https://www.w3.org/TR/webcodecs-hevc-codec-registration/).

The actual-stream probe runs alongside the decoder's ordered configure/decode queue, avoiding a separate compressed-frame backlog or dropped reference frames while the support promise resolves. Confirmed unsupported configurations report a failed codec to App. Operational decoder errors get one fresh-decoder attempt per configuration before reporting failure. A current keyframe is replayed immediately; after a delta failure the decoder waits for a fresh keyframe rather than skipping reference frames. App removes that family from its advertised codecs and immediately resends `setStreams`. Auto can fall from HEVC to H.264 to JPEG. A pinned codec falls to JPEG if it fails. This applies to the connection's shared stream preference, not an independent encoder for each browser or window.

Probe results are scoped to the active configuration and invalidated by resize, codec replacement, JPEG transition, close, or window retirement. Retired decoder callbacks cannot clear a replacement. A delayed initial family probe cannot re-enable a codec that already failed. A repeated failure stays blocked for that configuration. An explicit stream-format change clears rejected capabilities and invalidates pending decoder callbacks. A different-sized JPEG for the failed window, or closing that window, retries the affected families. Identical fallback frames do not start a retry loop.

## Validation

- TypeScript 7 typecheck passed.
- All 679 Vitest tests passed across 38 files. Decoder and codec coverage includes level 6 HEVC, three- and four-byte start codes, escaped SPS bytes, profile space/tier/constraints, truncated SPS, unsupported resolution, constructor/configuration exceptions, asynchronous errors after a codec-family switch, stale support results, and retired decoder callbacks.
- `scripts/e2e-codec-fallback.mjs` passed all five scenarios using the real App and FrameDecoder with an intercepted local engine socket: Auto fallback, pinned HEVC fallback, delayed initial probe, synchronous configuration failure, and asynchronous decoder failure. Each checks immediate negotiation without a layout change and then verifies that an actual JPEG reaches the real window surface.
- The browser fixture intentionally substitutes decoder capability and failure behavior, so it is a regression test of negotiation and lifecycle, not evidence of native HEVC hardware support. Native engine/decoder checks are recorded separately by the rendering harness.

The [hardware recovery check](codec-resize-recovery.md) subsequently verified
12 real NVENC packets through resize and forced-IDR recovery, including HEVC at
4000x3000. The actual shell parser matched every packet's profile, tier, and
level. This closes the real-bitstream parser check; the test browser still does
not advertise HEVC, so playback on the user's iPad remains a separate check.

## Reconnect resource reconciliation

`hello` now reconciles the connection's known window IDs before replacing UI state. IDs missing from the new snapshot have their decoder forgotten, pending bitmap conversion invalidated, displayed frame closed, and blank-window status removed. Surviving IDs retain their decoder and pixels, including when `hello` is a permission update on an existing socket.

A sixth scenario in `scripts/e2e-codec-fallback.mjs` verifies this with the real App: it publishes two actual bitmaps through decoder callbacks, starts another conversion for the first window, checks that a permission update preserves both, then closes and reconnects the intercepted socket with only the second window in the snapshot. The first decoder and stored bitmap close; its pending conversion is discarded and closed on completion. The second decoder and bitmap remain unchanged. Typecheck and all six browser scenarios pass.

## Recovery after scaling (1.5.1)

The previous fallback policy also blocked manual format changes: after both
families failed, selecting HEVC still sent `setStreams` with an empty codec
list. `scripts/e2e-codec-fallback.mjs` reproduced that failure before the fix.
The browser harness now verifies format selection, resize, and failed-window
closure restore video without reloading. Session logs include the rejected
window, dimensions, and decoder error.

Engine negotiation now excludes clients that request no video windows and
recomputes the common codec when a viewer disconnects or is replaced. Six
handler tests cover inactive viewers, pausing, disconnecting, replacement,
first JPEG viewer, and preservation of cached encoders during reconnect grace.

The hardware probe now also covers fractional dimensions and odd dimensions.
Both codecs produced all 36 standalone keyframes. NVENC rounds odd 4:2:0
output dimensions upward; source and bitstream sizes are recorded separately.
`scripts/e2e-codec-packets.mjs` decoded all 22 H.264 cases in native Chromium,
including odd source headers, with no fallback and sampled pixel error at most
1/255. The real App also retained selected H.264 through nine hardware packet
sizes. This host cannot decode HEVC in the browser, so HEVC pixel validation
uses FFmpeg and does not establish browser playback support.

A full `setWindowScaling` capture test used an isolated engine under headless
Weston with GL/CUDA capture on the RTX 3060. All 18 Wayland/X11 cases passed
at 1x, 1.25x, 1.5x, 1.75x, and 2x, including both modes, reset, and Auto.
The corrected decoder received 718 H.264 frames with no JPEG or decoder errors.
Repeating with the pre-fix decoder also passed, with 726 H.264 frames. This
rules out the new retry masking a failure in that fixture. It does not
reproduce the user's initial desktop Chrome/iPad failure; the permanent
fallback and ignored manual selection were reproduced independently.

For a transient error after a delta frame, the shell repeats `setStreams` to
request a fresh capture and IDR. Waiting for ordinary app damage would leave
an idle window frozen. The intercepted-engine browser test sends nothing
until this request arrives, then verifies video recovery without JPEG.
