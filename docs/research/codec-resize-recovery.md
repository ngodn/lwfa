# Hardware codec resize and recovery

Verified on 2026-09-07 with lwfa 1.5.0 and host FFmpeg 9.0.1. The ignored
`encode::tests::hardware_codec_resize_and_recovery` test uses the engine's real
NVENC sessions, independently from the running engine or desktop.

Both H.264 and HEVC passed the same sequence: 1000×640, 4000×3000, then
1000×640 again, using the same window ID. At each size, the test checks the
initial keyframe, an inter frame, and a requested recovery keyframe. Each of
the 12 keyframe packets decodes alone, without earlier parameter sets or
reference frames. Decoded sizes match exactly; sampled quadrants and all
four edges differ from the source by at most 1 out of 255 per RGB channel.

| Codec | 1000×640 profile / level | 4000×3000 profile / level |
| --- | --- | --- |
| H.264 | High / 4.1 (`level=41`) | High / 6.0 (`level=60`) |
| HEVC | Main / 4.1 (`level=123`) | Main / 6.0 (`level=180`) |

The large HEVC frame exercises a real SPS above the former browser decoder
configuration's fixed level 5.1. NVENC already chooses the appropriate level
and repeats parameter sets on recovery; this probe required no production
encoder changes. Browser HEVC decoding remains unverified on this host,
whose browser only advertises H.264 support. This evidence covers real
hardware encoding and independent software decoding.

The shell's actual `codecFromAnnexB` parser also read all 12 hardware packets
under Node 24.15.0. HEVC returned `hvc1.1.6.H123.90`, then
`hvc1.1.6.L180.90`, then `hvc1.1.6.H123.90`, matching FFprobe's levels.
At the probe's 20 Mbps allocation NVENC selected High tier at level 4.1
and Main tier at level 6.0; the parser preserves that distinction.
H.264 returned `avc1.640029`, `avc1.64003C`, `avc1.640029`.

Run alone to avoid concurrent NVENC diagnostics:

```sh
LWFA_CODEC_PROBE_DIR=/tmp/lwfa-codec-recovery-1.5.0 mise exec -- \
  cargo test -p lwfa-engine hardware_codec_resize_and_recovery --offline -- \
  --ignored --test-threads=1 --nocapture
```

The test requires working NVENC, `ffprobe`, and `ffmpeg`. It writes the small
elementary-stream packets and `results.json` to the chosen directory. Committed
measurements are in [codec-resize-recovery.json](fixtures/codec-resize-recovery.json).
Profile, level, and dimensions come from the actual bitstream through
[FFprobe stream inspection](https://ffmpeg.org/ffprobe.html), not from requested
encoder options.
