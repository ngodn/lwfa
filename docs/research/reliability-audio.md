# Audio reliability investigation

Date: 2026-09-06. Scope: browser audio lifecycle and decoder recovery. This does not certify iPad speakers, Bluetooth, or capture on the running production engine.

## Pipeline checked

`crates/lwfa-engine/src/audio.rs` runs `parec` with stereo signed 16-bit 48 kHz PCM in 20 ms chunks. It builds Opus, PCM, or both according to listener capabilities. `Shell::send_audio` fans the appropriate encoding into each client's bounded outgoing queue. Browser `Connection` delivers the framed payload to `App.tsx`, which forwards PCM to `audio.play` or Opus to the persistent `OpusStream`. Decoded float planes go to `audio.playPlanar`. Playback uses `public/audio-worklet.js` when available and scheduled `AudioBufferSourceNode`s otherwise.

The App audio preference effect calls `start()` again when the session ID changes. Its disable and cleanup paths call asynchronous `stop()` without waiting. These are real callers of the races exercised below.

History was searched with targeted `rg` and `jq`, including session `92d64322-a6e8-42d6-a438-5a7da042ff6b`. Earlier changes removed a zero-duration silent WAV busy loop, avoided redundant sample conversion, and added worklet drift shedding. Those changes already exist. They do not cover scheduled-player lifecycle and asynchronous decoder errors.

## Reproductions and fixes

`pnpm exec vitest run packages/shell/test/audio.test.ts` initially failed all five initial tests:

| Trigger | Observed failure | Fix |
| --- | --- | --- |
| Reconnect calls start on HTTP fallback | Two contexts constructed instead of one | Reuse the context independently of worklet availability |
| Two callers start fallback together | Results were `[true, false]` | Share the complete setup result |
| Audio disabled during worklet module load | Start later returned true and republished a live graph | Publish context ownership before awaiting module load; invalidate stale setup with a generation counter |
| Audio enabled while old context close is pending | Old stop cleared the replacement graph | Detach globals synchronously before awaiting close |
| Flush while fallback sound is queued | No scheduled sources stopped, so new and stale audio overlap | Track unfinished sources, stop and disconnect them on flush, remove finished sources on `ended` |

Two added Opus regressions also failed before their fixes:

- Native decoder asynchronous error left the decoder path `none` forever. It now switches once to WASM so later packets can play.
- A long WASM startup retained packets 0 through 49 and discarded all fresher arrivals. With 100 packets, the last decoded was 49 instead of 99. The bounded queue now evicts the oldest packet.

An additional lifecycle test verifies setup returns while an autoplay-blocked `resume()` promise remains pending. Setup starts resumption without awaiting it, so it can return to the preference effect that enables capture. `unlock()` still resumes on a user gesture.

A follow-up integration review reproduced an overlap during worklet startup:
while `addModule()` is pending, the published context can already receive packets
and schedule fallback sources. Assigning the loaded worklet left those sources
playing alongside fresh worklet audio. A failing test exercised `start()`, eight
real `play()` calls at that seam, and resolution of the deferred module load.
The worklet now flushes scheduled sources immediately before taking ownership.
The existing generation check runs before this transition. A second test confirms
an abandoned module load cannot flush a replacement graph's sources.

Scheduled playback diagnostics now report buffered milliseconds from its playhead, making the common HTTP fallback observable as well as the worklet path.

## Primary references

- [Web Audio specification](https://www.w3.org/TR/webaudio-1.0/): context resumption can wait for permission to start; source stop cancels playback. This supports separating graph setup from autoplay readiness and cancelling queued sources before re-priming.
- [WebCodecs specification, AudioDecoder](https://www.w3.org/TR/webcodecs/#audiodecoder-interface): configuration support is checked asynchronously; unsupported configuration closes the decoder and calls its error callback. Catching only a synchronous `configure()` exception is insufficient.

These references establish API behavior. They do not identify which condition occurred on the user's iPad.

## Verification

- Follow-up ownership checks: `pnpm exec vitest run packages/shell/test/audio.test.ts packages/shell/test/opus.test.ts` passed 17 tests (8 lifecycle, 9 decoder). The added worklet handoff test failed before its fix; the stale-generation preservation test passed both before and after.

- `pnpm exec vitest run packages/shell/test/audio.test.ts packages/shell/test/audioWorklet.test.ts packages/shell/test/opus.test.ts packages/shell/test/silentWav.test.ts`: 27 tests pass, including eight newly added regressions.
- `PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node scripts/e2e-audio-playback.mjs`: passed with installed Chromium. The script serves a temporary loopback page with the actual transpiled audio module and actual worklet. Both scheduled and worklet paths produced the expected sine waveform at a real Web Audio analyser, reused one context across repeated starts, flushed, and closed the context. Measured peak was 0.305 for each path. The server and browser are closed afterwards; no engine or audio routing is touched.
- TypeScript checking initially reported only the existing missing `windowless` field in `apps.ts`, outside this change. Root agent owns its correction and final combined verification.

## Browser probe timing

During combined build/test activity, one run of the original playback probe
sampled the scheduled player at a fixed 250ms and found peak 0. An isolated retry
immediately afterwards passed both players at peak 0.305. That run exposed a
measurement timing weakness; it does not establish an audio product failure or
performance improvement.

The probe now keeps feeding PCM and observes the actual analyser waveform every
20ms for up to five seconds. Success requires three consecutive observations
matching the supplied sine's amplitude and RMS, so merely creating a running
context cannot pass. Before checking flush it supplies fresh queued audio to
avoid a timing race with previously ended scheduled sources.

An isolated run after the harness change passed:

```text
scheduled: peak 0.305, RMS 0.217, observed after 323ms
worklet:   peak 0.305, RMS 0.215, observed after 81ms
```

Both reused one context and passed flush/teardown checks. The observed times are
from one functional run, not a startup-latency benchmark.

## Remaining limits

No production engine was restarted or modified during this investigation. Capture timing and codec performance were traced in source, not profiled against real streamed application audio here. The browser probe measures PCM at a Chromium Web Audio node, not speakers, network delivery, Safari behavior, or CPU improvement on a physical tablet. It therefore establishes the corrected browser behavior without claiming the reported audio complaint is fully resolved.

The worklet still waits for quiet audio before shedding a moderate excess cushion. Continuous loud material may stay at elevated latency until the hard ceiling is reached. Native decoder queue pressure and shared TCP head-of-line delay remain separate transport/performance questions. The existing engine audio E2E script checks PCM capture only; it must not be presented as a playback or Opus test.
