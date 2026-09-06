# HEVC stream capability and fallback

Checked and implemented 2026-09-07. This fixes the browser's stream configuration and negotiation. It does not establish that every browser or iPad can decode the maximum permitted capture size.

## What was wrong

The decoder always declared HEVC Main level 5.1, even though density scaling can generate frames above that level's picture-size limit. The initial family probe also paired HEVC level 3.1 and H.264 level 3.0 with 1920×1080, larger than those declared levels accommodate. A successful small-stream probe cannot establish support for a different profile, level, or resolution. WebCodecs checks those codec-string fields explicitly. [WebCodecs configuration support](https://www.w3.org/TR/webcodecs/#config-support)

## Change

Both video families now derive their codec string from the keyframe's Annex B SPS. HEVC reads the fixed general profile/tier/level prefix after removing emulation-prevention bytes. Compatibility flags are reversed into RFC 6381 order, profile space and tier are preserved, and trailing zero constraint bytes are omitted. The prefix layout is confirmed by [FFmpeg's HEVC SPS parser](https://github.com/FFmpeg/FFmpeg/blob/n9.0.1/libavcodec/hevc/ps.c#L1141); codec-string construction is cross-checked against [GPAC's sample entry implementation](https://github.com/gpac/mp4box.js/blob/main/src/boxes/sampleentries/sampleentry.ts#L113). No HEVC decoder implementation or third-party parser dependency was added.

The initial 1080p family probes use Main profile level 4. When an actual stream changes profile, level, or dimensions, FrameDecoder configures and probes those exact values. With no `description`, the stream remains Annex B as required by the [WebCodecs HEVC registration](https://www.w3.org/TR/webcodecs-hevc-codec-registration/).

The actual-stream probe runs alongside the decoder's ordered configure/decode queue, avoiding a separate compressed-frame backlog or dropped reference frames while the support promise resolves. Constructor, configuration, decode, and asynchronous decoder failures all report a failed codec to App. App removes that family from its advertised codecs and immediately resends `setStreams`. Auto can fall from HEVC to H.264 to JPEG. A pinned codec falls to JPEG if it fails. This applies to the connection's shared stream preference, not an independent encoder for each browser or window.

Probe results are scoped to the active configuration and invalidated by resize, codec replacement, JPEG transition, close, or window retirement. Retired decoder callbacks cannot clear a replacement. A delayed initial family probe cannot re-enable a codec that already failed. A codec failure is retained for the current App lifetime; reloading allows a fresh capability check.

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
