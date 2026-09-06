# Streaming adaptation investigation

Investigated 2026-09-06 using Rust 1.95.0, edition 2024, as pinned by the
workspace and confirmed with `mise current`.

## Confirmed and fixed

### Recovery could become unreachable

The bitrate controller lowers its remembered ceiling on every new congestion
episode, even during the two-second settling period when it cannot reduce the
actual bitrate. If congestion clears before settling ends, the bitrate can sit
above that ceiling. Neither recovery branch accepted this state: one required
the rate below the ceiling and the other required exact equality.

Two deterministic reproductions exercise the real controller:

- Congestion at one second into startup, then a clear connection for ten
  simulated minutes. Before the fix the budget remained at 4 Mbit/s.
- A cut followed by another short congestion episode during that cut's hold,
  then ten simulated clear minutes. Before the fix the budget remained at
  2 Mbit/s.

Both expected recovery to the 32 Mbit/s ceiling. The failing command was
`cargo test -p lwfa-engine does_not_stop_recovery -- --nocapture`:
two failed assertions, zero passed. After the fix both pass. A surviving rung
above the remembered ceiling can now earn another probe after the existing
clear-period requirement. Congestion backoff and the queue-drain hold still
apply. This prevents a permanent recovery stall without removing protection
against repeated unsuccessful probes.

Implementation and regressions: [bitrate.rs](../../crates/lwfa-engine/src/bitrate.rs).

### The highest congestion cut never reached the encoder

The controller's 32 to 24 Mbit/s cut changes the budget by exactly 25 percent.
The encoder rebuild guard required a change strictly greater than 25 percent,
so it ignored that cut and retained the old encoding rate.

`cargo test -p lwfa-engine every_congestion_cut -- --nocapture` failed before
the change with: `the controller cut from 32000000 to 24000000, but the encoder
kept its old rate`. The boundary is now inclusive. The regression checks every
adjacent downward transition in the actual bitrate ladder.

Implementation and regression: [encode.rs](../../crates/lwfa-engine/src/encode.rs).

## Validation

- `cargo test -p lwfa-engine bitrate:: -- --nocapture`: 58 passed, including
  the existing relay simulation, recovery, backoff, allocation and pacing tests.
- `cargo test -p lwfa-engine encode:: -- --nocapture`: 20 passed, one
  hardware diagnostic ignored. The final workspace run passed 315 tests, with
  three ignored (two kernel integration tests and the NVENC diagnostic).
- These unit tests verify decisions in the actual controller and encoder
  rebuild predicate. They do not measure iPad decoding or the user's current
  cellular connection.
- A fresh isolated engine also passed the live TCP throttling check below.
- No production process or system network configuration was changed for these
  tests.

## History and remaining limits

Claude's `memory/cellular-path-is-relayed.md`, dated 2026-08-19, records a
relayed cellular path and much higher jitter with the VPN detour. Those are
historical measurements, not a fresh check of today's route. They justify
retaining conservative probe backoff rather than assuming the link is a LAN.

The stream's Auto setting selects a mutually decodable video codec. Rate
adaptation runs on the engine separately. JPEG fallback retains the configured image quality. It now uses actual encoded
bytes to lower capture cadence when necessary, as measured below. It does not
reduce resolution. A large independent frame can still cause a one-frame burst;
this is not a packet-level traffic shaper.

The ping estimator and backpressure gates were exercised against a live
throttled socket. The
[e2e-adaptation.mjs](../../scripts/e2e-adaptation.mjs) harness applies a byte
limit through a local TCP proxy to the dev engine on port 6734. It records
delivered bytes, video frames and budget decisions, requiring a congestion
response and subsequent recovery. It needs an independently launched,
continuously animating dev window. It does not decode video or test audio.

```bash
AUTH_PASS="$DEV_AUTH_PASS" ENGINE_LOG=/tmp/lwfa-reliability-dev.log \
  node scripts/e2e-adaptation.mjs
```

The harness passed on the freshly rebuilt dev engine, using a private native
Wayland Chromium window drawing a continuously changing 1000x700 pattern.
An initial harness run correctly failed its motion assertion because it had
not placed the window in the layout. The final harness explicitly places the
selected dev window before subscribing.

| Phase | Capacity | Duration | Frames received | Delivered payload and protocol |
| --- | ---: | ---: | ---: | ---: |
| Clear | 64 Mbit/s | 15 s | 850 | 474.94 Mbit |
| Limited | 1 Mbit/s | 20 s | 47 | 19.82 Mbit |
| Recovered | 64 Mbit/s | 45 s | 674 | 141.26 Mbit |

During throttling the real engine budget moved from 32 through 24, 16, 2, 1
and 0.5 Mbit/s. The engine log confirms NVENC sessions rebuilt, including
after the previously ignored 32-to-24 cut. After capacity returned, the budget
rose to 1 and then 2 Mbit/s, with measured queue excess of 7 and 4 milliseconds.
The socket stayed connected throughout all three phases. The harness closed
its proxy and the fixture launcher closed its private Chromium context.

This is evidence of automatic reduction and recovery, not of quick recovery
to full quality. The budget was only 2 Mbit/s after 45 seconds of restored
capacity. The 141 Mbit delivered during that phase motivated the followup
below. The harness does not timestamp decoded/presented frames, so it cannot
measure the user's input-to-display latency. Its packet limitation
models application-visible TCP backpressure, not a particular Wi-Fi or DERP
implementation. No claim is made that the user's actual cellular behavior is
fully fixed.

### Followup: delivered video exceeds the chosen budget

A second run enabled `ADAPTATION_TRACE=1` and recorded five-second bins of
video bytes, keyframe bytes, frame counts, JavaScript socket queues and the
dev connection's TCP transmit/receive queues. The
[captured measurements](reliability-adaptation-trace.json) contain no tokens
and refer only to loopback dev connections.

This distinguishes two effects:

- During throttling, the proxy's TCP receive queue held about 1.1 MB, with
  roughly 130 KB or less in the engine's TCP transmit queue. This is a real
  backlog in the test path and contributes delay. The JavaScript queue was
  about 140-170 KB, rather than an unbounded application buffer.
- Once capacity returned and these queues drained, video continued exceeding
  the advertised budget. Recovery seconds 10-15 delivered 13.176 Mbit of
  video, 61 frames and **zero keyframes**, while the budget remained
  500 kbit/s. Both TCP queues were zero at the sample boundary; JavaScript
  held only 26.8 KB. The preceding five seconds delivered 13.229 Mbit with
  all three measured queues empty at its boundary.

The latter is about 2.64 Mbit/s of video at a 0.5 Mbit/s budget, more than
five times the budget. A later all-delta interval at the 1 Mbit/s budget
delivered 11.405 Mbit over five seconds, with all measured queues empty.
Therefore neither old backlog nor encoder keyframes alone explains the
excess. The NVENC session reopened at the budget cuts, and the engine logged
no encoding failures in this run. This is a confirmed gap between the chosen
budget and the encoder's actual output under this difficult motion fixture.

The excess does not by itself establish a lwfa encoder bug. The same
1000x700 RGB0 block pattern through standalone FFmpeg 9.0.1 produced
12.685 Mbit/s at a 500 kbit/s target, even with explicit CBR, maximum rate
500 kbit/s and an 8,333-bit VBV. FFmpeg reported a final quantizer of 50.
The engine's actual codec context had `qmin=-1`, `qmax=-1`; no accidental
generic quantization cap was found. Adding a maximum rate, CBR, a one-frame
VBV, or an explicit 60fps setting did not make the isolated engine fixture
conform either. These ineffective changes and diagnostic FFI reads were
removed. No rate-control tuning change is retained.

This is consistent with an entropy/quantization limitation at the chosen
resolution, rather than a lost bitrate option. FFmpeg 9's NVENC setup
defaults to VBR when no rate mode is supplied,
sets average bitrate from `bit_rate`, takes an explicit maximum only from
`rc_max_rate`, and defaults VBV to twice the average bitrate. See
[FFmpeg 9 NVENC rate-control source](https://github.com/FFmpeg/FFmpeg/blob/n9.0/libavcodec/nvenc.c#L919).
That explains why treating the chosen average as a strict ceiling is unsafe;
it does not establish that a particular rate-control option will cure the
measured overshoot. NVIDIA recommends small VBV buffers for low latency, but
that advice did not make this difficult fixed-resolution input fit the budget.
See [NVIDIA's FFmpeg rate-control guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/ffmpeg-with-nvidia-gpu/index.html).

### Practical motion and JPEG fallback

The ignored hardware diagnostic `measure_motion_fixture_bitrates` exercises
the actual engine encoder on both the difficult block pattern and a scrolling
desktop pattern (fixed sidebar and toolbar, dark glyph-like lines on a light
page). It prints measurements; it does not impose an impossible universal
bitrate assertion on arbitrary fixed-resolution noise.

```bash
cargo test -p lwfa-engine measure_motion_fixture_bitrates -- \
  --ignored --test-threads=1 --nocapture
```

Each result samples 120 frames after 30 warmup frames, at 1000x700, expressed
at the encoder's nominal 60fps timebase. NVENC diagnostics run alone because
the existing repository documents driver instability with concurrent sessions
in tests.

| Pattern | Codec | Requested budget | Measured nominal bitrate |
| --- | --- | ---: | ---: |
| Scrolling desktop | H.264 | 500 kbit/s | 325 kbit/s |
| Scrolling desktop | H.264 | 2 Mbit/s | 303 kbit/s |
| Scrolling desktop | JPEG quality 70 | 500 kbit/s | 42.26 Mbit/s |
| Block noise | H.264 | 500 kbit/s | 12.67 Mbit/s |
| Block noise | H.264 | 2 Mbit/s | 12.66 Mbit/s |

The practical H.264 content fits the constrained budget. A separate FFmpeg
`testsrc2` moving-video reference averaged 658 kbit/s at a 500 kbit/s target,
including startup, with the existing preset and default rate control. That
does not show the fivefold sustained excess seen with block noise.

JPEG is the more actionable limitation: the scrolling desktop requires about
7 Mbit/s even at ten frames per second. The previous floor was roughly ten fps
(tick quantization can make it faster), so choosing a 500 kbit/s budget could not
make this JPEG stream fit a slow link. Quality stayed fixed and actual frame
bytes did not influence capture pacing.

### Fixed: admit JPEG captures using actual encoded bytes

The encoder worker now records the last JPEG's wire size and completion time
per window. Before consuming surface damage, capture waits for that frame's
bytes to fit the current per-window budget. This also applies to an automatic
hardware-encoder fallback to JPEG. It can go below the old ten-fps floor,
retaining readable pixels by reducing cadence. It does not bank idle credits
or accumulate a queue of old captures.

Only one capture/encode job per window may be pending. Failures release that
reservation. Unique job tickets prevent a retired window's old completion from
clearing a replacement job's reservation. Codec generations prevent an old
JPEG completion from restoring JPEG pacing after a codec change. Repeating an
unchanged codec negotiation does not reset byte pacing. Budget and window
allocation changes affect the next admission immediately.

The CPU readback path previously prefetched the following frame while returning
the current one. Holding that snapshot during a long JPEG pacing interval
would make the next frame old. Paced JPEG now avoids that speculative prefetch;
switching from pipelined video discards only the speculative snapshot and
invalidates its damage cache so even a final static update is captured fresh.
Normal asynchronous readback completion and video pipelining remain intact.
The capture regression failed before this fix and its two policy tests pass.
Live tests below measure bytes, not decoded image age.

Ten deterministic admission tests cover actual-byte conformance, changing
budgets, multiple windows, idle bursts, failed jobs, retirement/re-admission,
codec changes and prefetch mode. Before admission was implemented, the
large-JPEG simulation sent 54 MB over ten seconds against a roughly 715 KB
allowance, and the budget-change regression also failed.

The real scrolling-document fixture was then tested through the same 1 Mbit/s
TCP proxy before and after. Both runs used 1000x700 JPEG quality 70. The final
run explicitly used CPU readback to exercise the newly paced capture path.
The earlier run used the original GPU-direct configuration, so raw maximum
capture throughput is not a controlled comparison. Per-budget byte conformance
is the direct assertion. [Saved before/after samples](reliability-adaptation-jpeg.json)
include all five-second bins and phase totals.

| Run | Clear, 15 s | Limited to 1 Mbit/s, 20 s | Recovered, 45 s |
| --- | ---: | ---: | ---: |
| Before | 89 frames / 85.64 Mbit | 20 / 19.72 Mbit | 283 / 271.85 Mbit |
| After | 60 frames / 57.42 Mbit | 20 / 19.71 Mbit | 44 / 41.95 Mbit |

Before the fix, a recovered five-second interval at a 1 Mbit/s budget sent
30.07 Mbit despite drained queues. Afterward, every tested recovered interval
beyond the first backlog-drain bin fit its current budget plus one independent
frame (with 5 percent timing tolerance). At 1 Mbit/s, successive intervals
sent about 3.80 and 3.82 Mbit over five seconds, with empty measured queues.
The actual controller cut to 500 kbit/s under pressure and climbed to 1 and
then 2 Mbit/s after recovery. The connection remained alive throughout.

Reproduce with a private dev engine and installed Playwright:

```bash
AUTH_PASS="$DEV_AUTH_PASS" ENGINE_LOG=/tmp/lwfa-reliability-dev-cpu.log \
  LWFA_TEST_WAYLAND=wayland-3 ADAPTATION_CODEC=jpeg \
  ADAPTATION_EXPECT_PACING=1 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
  mise exec node@24.15.0 -- node scripts/e2e-adaptation-fixture.mjs
```

A following H.264 block-motion smoke on the same CPU-readback engine also
passed the congestion/recovery assertions. Recovery climbed from 500 kbit/s to
8 Mbit/s. Its final five-second bin delivered 285 frames (57 fps), confirming
that ordinary video pipelining still reaches near the 60fps target. This
fixture retained the previously characterized entropy overshoot; the smoke
does not claim H.264 byte conformance. Both fixture contexts and proxy sockets
closed after testing. [H.264 final samples](reliability-adaptation-h264-final.json)
record the full run.

Remaining limits are deliberate. Large JPEGs still arrive as individual bursts,
and low budgets can mean less than one frame per second. The minimum global
ladder is 500 kbit/s, before audio and protocol overhead, so links below that
cannot generally converge without additional spatial or codec changes.
Difficult H.264 content can still exceed its nominal bitrate, as the FFmpeg
comparison demonstrates. Recovery remains conservative, and this loopback
proxy test does not establish behavior on every cellular or relayed route.

## Primary-source context

Excessive queues can raise latency on a shared bottleneck; observing a higher
budget alone is not evidence that latency improved. See
[IETF RFC 9743, congestion control guidance](https://www.rfc-editor.org/rfc/rfc9743.html).
FFmpeg documents video bitrate in bits per second. The numerical unit used by
the controller and encoder is therefore consistent; the confirmed issue was
the dropped transition, not a unit conversion. See
[FFmpeg codec options](https://www.ffmpeg.org/ffmpeg-codecs.html).
