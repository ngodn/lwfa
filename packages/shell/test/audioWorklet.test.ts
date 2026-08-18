/**
 * The audio worklet's ring buffer.
 *
 * This runs on the audio thread in a browser, where it cannot be inspected,
 * cannot log without causing the glitch it would be reporting, and where every
 * mistake is audible rather than visible. So it is tested here instead, by
 * loading the same file with the two globals the browser would provide.
 *
 * The cases are the ones that produce noise rather than silence: sample
 * conversion at the extremes, wrapping around the end of the buffer, and what
 * happens when the network delivers faster than the speakers consume.
 */

import { beforeAll, describe, expect, it } from "vitest"

/** The processor class, as the browser would register it. */
let Processor: new () => {
  port: { onmessage: (event: { data: unknown }) => void; postMessage: (data: unknown) => void }
  /** `outputs[output][channel]`, which for one stereo output is `[[L, R]]`. */
  process: (inputs: unknown[], outputs: Float32Array[][]) => boolean
  available: number
  priming: boolean
}

beforeAll(async () => {
  // The two globals a worklet scope provides. Set before the import, because
  // the file subclasses one and calls the other at module scope.
  Object.assign(globalThis, {
    AudioWorkletProcessor: class {
      port = {
        onmessage: (_event: { data: unknown }) => {},
        postMessage: (_data: unknown) => {},
      }
    },
    registerProcessor: (_name: string, processor: unknown) => {
      Processor = processor as typeof Processor
    },
  })
  // The real file, not a copy of its logic. A test of a paraphrase would pass
  // while the thing that runs in the browser was broken. Untyped on purpose:
  // it is a worklet, so it has no module surface to describe.
  // @ts-expect-error -- plain JS with no declarations, loaded for its side effect
  await import("../public/audio-worklet.js")
})

/** One chunk of interleaved stereo, as it arrives off the socket. */
function chunk(frames: number, fill: (i: number, channel: number) => number): ArrayBuffer {
  const samples = new Int16Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    samples[i * 2] = fill(i, 0)
    samples[i * 2 + 1] = fill(i, 1)
  }
  return samples.buffer
}

/**
 * The shape `process` is handed: outputs, each of which is a list of channels.
 *
 * Nested twice on purpose. A node can have several outputs and each has its own
 * channels, so `outputs[0][1]` is the right channel of the first output. Losing
 * one level here makes the tests pass against nothing.
 */
function block(frames: number): Float32Array[][] {
  return [[new Float32Array(frames), new Float32Array(frames)]]
}

describe("the audio worklet", () => {
  it("converts full-scale samples without clipping", () => {
    const player = new Processor()
    // Enough to get past priming, all at the extremes. -32768 is the one that
    // matters: dividing by 32767 would take it past -1.0 and clip.
    player.port.onmessage({
      data: chunk(3000, (_i, c) => (c === 0 ? 32767 : -32768)),
    })
    expect(player.priming).toBe(false)

    const out = block(128)
    player.process([], out)
    const [left, right] = out[0]!
    for (const value of left!) expect(value).toBeLessThanOrEqual(1)
    for (const value of right!) expect(value).toBeGreaterThanOrEqual(-1)
    expect(left![0]).toBeCloseTo(32767 / 32768, 5)
    expect(right![0]).toBe(-1)
  })

  it("is silent until it has a cushion, rather than stuttering through it", () => {
    const player = new Processor()
    // Less than the prebuffer.
    player.port.onmessage({ data: chunk(100, () => 20000) })
    expect(player.priming).toBe(true)

    const out = block(128)
    player.process([], out)
    expect([...out[0]![0]!].every((v) => v === 0)).toBe(true)
  })

  it("gives back a cushion it does not need, once the sound is quiet", () => {
    // The bug: the only thing that ever removed a frame was the 250ms
    // emergency ceiling, so the burst a recovering connection delivers filled
    // the ring to that ceiling and it stayed there. Sound is produced and
    // consumed at exactly the same rate, so nothing was ever going to bring it
    // back down, and every network hiccup added a fifth of a second of lag
    // permanently.
    const player = new Processor()
    // A burst, as a stalled socket delivers when it comes back. Silent, which
    // is what makes it safe to shorten.
    player.port.onmessage({ data: chunk(11000, () => 0) })
    expect(player.priming).toBe(false)
    const swollen = player.available

    // Fed at exactly the rate it plays, so the ring can only shrink by a
    // deliberate drop rather than by being drained.
    for (let i = 0; i < 100; i++) {
      player.process([], block(128))
      player.port.onmessage({ data: chunk(128, () => 0) })
    }

    expect(player.available).toBeLessThan(swollen)
    // Back to roughly the cushion it wanted, not emptied: an empty ring is an
    // underrun on the next late chunk.
    expect(player.available).toBeLessThanOrEqual(2880 * 2 + 128)
    expect(player.available).toBeGreaterThan(0)
  })

  it("does not cut into audible sound to do it", () => {
    // Discarding samples mid-note is a click, which is worse than the delay it
    // saves. A desktop is quiet between keystrokes, so waiting costs nothing.
    const player = new Processor()
    player.port.onmessage({ data: chunk(11000, () => 20000) })
    const swollen = player.available

    // Consume and refill at exactly the rate it plays, so the only thing that
    // could shorten the ring is a deliberate drop.
    for (let i = 0; i < 50; i++) {
      player.process([], block(128))
      player.port.onmessage({ data: chunk(128, () => 20000) })
    }

    expect(player.available).toBe(swollen)
  })

  it("leaves an ordinary cushion alone", () => {
    // Normal jitter has to stay absorbed. Trimming a healthy buffer would turn
    // the next late chunk into a dropout, which is the thing the cushion is
    // for in the first place.
    const player = new Processor()
    player.port.onmessage({ data: chunk(3000, () => 0) })
    const settled = player.available

    for (let i = 0; i < 5; i++) player.process([], block(128))

    // Only what was played, nothing extra thrown away.
    expect(player.available).toBe(settled - 5 * 128)
  })

  it("reports how much sound it is holding", () => {
    // Latency you can hear and nothing else measures. Without it, a buffer
    // sitting at its ceiling is indistinguishable from a slow network.
    const player = new Processor()
    const seen: unknown[] = []
    player.port.postMessage = (data: unknown) => seen.push(data)
    player.port.onmessage({ data: chunk(3000, () => 0) })

    player.port.onmessage({ data: "report" })
    expect(seen.at(-1)).toMatchObject({ buffered: 3000 })
  })

  it("plays samples back in order across a buffer wrap", () => {
    const player = new Processor()
    // A ramp long enough to run past the ring's capacity, pushed in pieces.
    let next = 0
    const push = (frames: number) =>
      player.port.onmessage({
        data: chunk(frames, () => {
          // A slow triangle, so every sample is distinguishable from its
          // neighbours without relying on exact float equality.
          const value = ((next++ % 2000) - 1000) * 30
          return value
        }),
      })

    push(3000)
    const heard: number[] = []
    for (let i = 0; i < 20; i++) {
      const out = block(128)
      player.process([], out)
      heard.push(...out[0]![0]!)
      // Keep it fed, so it never re-primes and the sequence stays continuous.
      push(200)
    }

    // Strictly monotonic within each rising leg, which only holds if reads and
    // writes wrap consistently. A misaligned wrap shows up as a jump.
    let jumps = 0
    for (let i = 1; i < heard.length; i++) {
      const delta = Math.abs(heard[i]! - heard[i - 1]!)
      if (delta > 0.05) jumps++
    }
    // One legitimate jump per triangle period, not one per wrap.
    expect(jumps).toBeLessThan(5)
  })

  it("drops the oldest audio rather than letting the delay grow without bound", () => {
    const player = new Processor()
    // Far more than the ceiling: a burst after a stall, or a producer faster
    // than the consumer. Playing all of it would mean being seconds behind and
    // never catching up.
    for (let i = 0; i < 30; i++) {
      player.port.onmessage({ data: chunk(2000, () => 1000) })
    }
    // 60000 frames pushed; the ceiling is 12000.
    expect(player.available).toBeLessThanOrEqual(12000)
  })

  it("re-primes after an underrun instead of clicking every callback", () => {
    const player = new Processor()
    player.port.onmessage({ data: chunk(3000, () => 5000) })

    // Drain it dry.
    for (let i = 0; i < 40; i++) player.process([], block(128))
    expect(player.priming).toBe(true)

    // And stays silent until the cushion is back, rather than playing the
    // dribble that arrives next.
    player.port.onmessage({ data: chunk(100, () => 5000) })
    const out = block(128)
    player.process([], out)
    expect([...out[0]![0]!].every((v) => v === 0)).toBe(true)
  })
})
