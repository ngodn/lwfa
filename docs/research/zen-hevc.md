# Zen HEVC decoding

Verified 2026-09-08. Zen can decode lwfa HEVC packets on this machine, but its
WebCodecs H.265 preference is disabled by default. An isolated one-preference
comparison confirmed the cause. No existing browser profile or system library
was changed.

## Installed browser and upstream behavior

The installed Arch package is `zen-browser-bin 1.21.15b-1`. `/usr/bin/zen-browser`
executes `/opt/zen-browser-bin/zen-bin`. The browser reports `Mozilla Zen 1.21.15b`,
Firefox platform 154.0, build `20260818101929`.

Zen's official Linux instructions also describe Flatpak and a tarball installed
under `~/.tarball-installations/zen`. The installed AUR wrapper matches its
published launcher. [Zen installation guide](https://docs.zen-browser.app/guides/install-linux),
[AUR launcher](https://aur.archlinux.org/cgit/aur.git/tree/zen-browser.sh?h=zen-browser-bin).

Mozilla enabled Linux H.265 WebCodecs implementation in Firefox 138. That does
not mean every release exposes it by default. The separate
`dom.media.webcodecs.h265.enabled` preference defaults to Nightly builds in the
upstream source. Ordinary HEVC playback has its own `media.hevc.enabled`
preference. [WebCodecs implementation bug](https://bugzilla.mozilla.org/show_bug.cgi?id=1949917),
[preference definitions](https://github.com/mozilla-firefox/firefox/blob/release/modules/libpref/init/StaticPrefList.yaml),
[Linux playback enablement](https://bugzilla.mozilla.org/show_bug.cgi?id=1950032).

## Measurements

`scripts/probe-zen-codecs.mjs` serves a temporary loopback page, starts a separate
Zen process with `--no-remote` and a fresh profile, and receives the page's JSON
report over HTTP. This avoids requiring Playwright's patched Firefox protocol.
The process and profile are removed afterward. Headed tests use the owned test
Weston socket, not either live desktop. [Mozilla command-line documentation](https://firefox-source-docs.mozilla.org/browser/CommandLineParameters.html).

Each run checked two H.264 codec strings and eight HEVC strings at 1920×1080,
with `no-preference`, `prefer-hardware` and `prefer-software`. The HEVC strings
include lwfa's `hvc1.1.6.L120.B0` capability probe, the real packet's
`hvc1.1.6.H123.90`, low and high levels, and equivalent `hev1` spellings.

| Configuration | H.264 supported | HEVC supported | Actual HEVC packet |
| --- | --- | --- | --- |
| Headless, default codec preferences | 6/6 | 0/24 | No frame, `NotSupportedError` |
| Headed test Weston, default codec preferences | 6/6 | 0/24 | No frame, `NotSupportedError` |
| Headed test Weston, H.265 WebCodecs preference enabled | 6/6 | 24/24 | One 1000×640 frame, no errors |

The successful comparison changes only `dom.media.webcodecs.h265.enabled=true`
in its temporary profile. Capability success with a hardware preference is not
evidence of hardware decoding. This test has not established NVIDIA decoding.

The packet came from the engine's NVENC regression fixture:
`target/codec-odd-dimension-probe/hevc-0-0.hevc`, 325 bytes,
SHA-256 `537c82c205629a38d0401c66fe12d330acff273e5d29388e421f57c7651c010e`.
The actual shell codec parser identifies `hvc1.1.6.H123.90`.

Private `PlatformDecoderModule` and `FFmpegVideo` logs show the installed browser
initializing system FFmpeg with libavcodec major 63, finding the software HEVC
decoder, and advertising `HEVC SWDEC`. Therefore missing FFmpeg 9 support is not
the cause of these WebCodecs rejections. The installed system has
`ffmpeg 2:9.0.1-1`, `/usr/lib/libavcodec.so.63` and `/usr/lib/libavutil.so.61`.
No compatibility-library replacement was needed. [Mozilla logging documentation](https://firefox-source-docs.mozilla.org/xpcom/logging.html).

## Reproduction and limits

Default headless probe:

```sh
mise exec -- node scripts/probe-zen-codecs.mjs
```

For the experimental codec path, add `LWFA_TEST_ENABLE_H265=1` and optionally
`LWFA_TEST_HEVC_PACKET=/absolute/path/to/keyframe.hevc`. The helper records the
preference override in the results. Headed runs additionally require
`LWFA_TEST_HEADED=1`, `LWFA_ISOLATED_TEST=1`, an owned temporary `XDG_RUNTIME_DIR`
and explicit `LWFA_TEST_WAYLAND`.

Reports and private decoder logs are in `target/zen-codecs/`, particularly
`headed-packet-results.json`, `headed-decoder-log-results.json` and
`headed-h265-enabled-results.json`.

## Full shell decoder and live stream

The same helper can bundle the current production-minified `FrameDecoder` and
replay a hardware fixture manifest through one persistent window decoder.
With `LWFA_TEST_HEVC_MANIFEST=target/codec-odd-dimension-probe/results.json`, all
18 HEVC keyframes passed across nine stages, including 4000×3000, returning to
1000×640, odd source dimensions and forced recovery keyframes. Every stage
verified coded dimensions, 16 quadrant/edge samples and zero fully black rows
or columns along the right and bottom. No unsupported-codec callbacks,
decoder errors or recovery requests occurred.

A separate development engine on loopback port 6756 then ran
`scripts/fixtures/zen-hevc-window.c`, an animated native X11 quadrant fixture.
The engine had its own runtime, database and authentication secret. The Zen
viewer used the owned test Weston socket and the temporary H.265 preference.
No production engine or user application was involved.

The live sequence passed every stage:

| Requested canvas | Decoded HEVC frame | Maximum channel error | Black right/bottom strips |
| --- | --- | --- | --- |
| 1000×640 | 1000×640 | 1 | 0 / 0 |
| 1324×838 | 1324×838 | 1 | 0 / 0 |
| 838×1324 | 838×1324 | 1 | 0 / 0 |
| 1324×838 | 1324×838 | 1 | 0 / 0 |
| 1000×640 | 1000×640 | 1 | 0 / 0 |

Each stage waited for three newly decoded frames. Every received video packet
used HEVC format 2, with no JPEG fallback or decoder errors. The test engine,
Zen process, temporary profiles, runtime and authentication secret were removed
afterward. This proves the current native capture, HEVC transport and real shell
decoder path through resize and rotation in the isolated test.

Reproduce the live decoder part with `LWFA_TEST_LIVE_HEVC=1`,
`LWFA_TEST_ENABLE_H265=1`, `LWFA_ISOLATED_TEST=1`, and the explicit isolated
`LWFA_TEST_URL`, `AUTH_PASS` and `LWFA_TEST_ENGINE_PID`. The helper requires an
empty engine and closes its fixture window. It does not start or restart the
engine. Add the headed environment above when needed.

Committed measurements are in
[zen-hevc-measurements.json](fixtures/zen-hevc-measurements.json).
The full local reports are `target/zen-codecs/frame-decoder-matrix.json` and
`target/zen-hevc/live-results.json`. These tests establish browser decoding and
stream correctness, not NVIDIA hardware decoding or production-profile behavior.
