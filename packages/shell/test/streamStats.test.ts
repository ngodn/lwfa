/**
 * The stream meter.
 *
 * Exists because "it feels laggy" had no number behind it. A poor stream can be
 * fewer frames, smaller frames, or no frames at all, those have unrelated
 * causes, and the panel can only tell them apart if this counts honestly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearStats, noteFrame, statsNow, subscribe } from "../src/lib/streamStats"

/** One second of frames at a given rate, ending just past the window. */
function play(fps: number, bytes: number, keyframeEvery = 0): void {
  const step = Math.floor(1000 / fps)
  for (let i = 0; i < fps; i++) {
    noteFrame(bytes, 1280, 720, keyframeEvery > 0 && i % keyframeEvery === 0)
    vi.advanceTimersByTime(step)
  }
  // The window is published on the first frame *after* a full second, and
  // `fps * floor(1000/fps)` can land just short of one, so make sure it is
  // crossed before the closing frame.
  vi.advanceTimersByTime(1000 - fps * step + 1)
  noteFrame(bytes, 1280, 720, false)
}

describe("the stream meter", () => {
  beforeEach(() => {
    // `performance` explicitly: the meter times its window with
    // `performance.now()` for monotonicity, and vitest does not fake that by
    // default, so without this every frame lands in the same instant and no
    // window ever closes.
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date", "performance"],
    })
    clearStats()
  })
  afterEach(() => {
    clearStats()
    vi.useRealTimers()
  })

  it("says nothing before a window has closed", () => {
    noteFrame(1000, 640, 480, true)
    expect(statsNow().fps).toBe(0)
    expect(statsNow().kbits).toBe(0)
  })

  it("measures the frame rate", () => {
    play(30, 4000)
    // Not exact: the window closes on the frame that crosses a second, so the
    // count can be one either side. Close enough to tell 30 from 10.
    expect(statsNow().fps).toBeGreaterThanOrEqual(28)
    expect(statsNow().fps).toBeLessThanOrEqual(32)
  })

  it("measures the bitrate", () => {
    // 30 frames of 4000 bytes in a second is 960 kbit/s.
    play(30, 4000)
    expect(statsNow().kbits).toBeGreaterThan(800)
    expect(statsNow().kbits).toBeLessThan(1100)
  })

  it("tells a paced-down stream from a compressed one", () => {
    // The whole point. Both of these are "the engine cut the budget", and they
    // look identical on screen, but one is answered by a better link and the
    // other by a better encoder.
    play(10, 4000)
    const paced = statsNow()
    clearStats()
    play(30, 1000)
    const squeezed = statsNow()

    expect(paced.fps).toBeLessThan(squeezed.fps)
    expect(paced.kbits).toBeGreaterThan(0)
    expect(squeezed.kbits).toBeGreaterThan(0)
  })

  it("reports the largest frame it saw", () => {
    noteFrame(1000, 640, 480, true)
    vi.advanceTimersByTime(500)
    noteFrame(1000, 1920, 1080, false)
    vi.advanceTimersByTime(600)
    noteFrame(1000, 640, 480, false)
    expect(statsNow().size).toBe("1920×1080")
  })

  it("counts keyframes, so an all-keyframe stream is recognisable", () => {
    // Every frame a keyframe is JPEG by another name, and a burst of them is
    // an encoder being rebuilt over and over.
    play(20, 4000, 1)
    expect(statsNow().keyframes).toBeGreaterThan(15)
  })

  it("goes back to nothing when the stream stops", () => {
    // A readout that cannot be wrong. A stopped stream used to have no way of
    // being noticed at all, so the last figure would stand for the rest of the
    // session and claim twenty megabits over a dead link.
    play(30, 4000)
    expect(statsNow().kbits).toBeGreaterThan(0)

    const stop = subscribe(() => {})
    vi.advanceTimersByTime(5000)
    expect(statsNow().kbits).toBe(0)
    expect(statsNow().fps).toBe(0)
    stop()
  })

  it("holds no timer while nobody is watching", () => {
    // The panel showing this is usually closed, and a session left open all
    // day should not be paying for a reading nobody is looking at.
    const stop = subscribe(() => {})
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
