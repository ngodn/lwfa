/**
 * The probe that measures the black band down the right of VS Code.
 *
 * The measurement has to be trustworthy before any capture code is changed on
 * the strength of it, and the two ways it could lie are both easy to write by
 * accident: calling a dark window "unpainted" and reporting a band that is not
 * there, or requiring pure black on every channel and missing a band that is.
 */

import { describe as group, expect, it } from "vitest"
import { describe, measure, probeEnabled, type CaptureReading } from "../src/lib/captureProbe"

/**
 * A fake canvas whose pixels are painted by a callback.
 *
 * `measure` only needs `width`, `height` and a 2d context that can hand back
 * an ImageData, so that is all this provides. Running in node, there is no
 * real canvas to use.
 */
function fakeCanvas(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): HTMLCanvasElement {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y)
      const i = (y * width + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return {
    width,
    height,
    getContext: () => ({ getImageData: () => ({ data, width, height }) }),
  } as unknown as HTMLCanvasElement
}

/** An ordinary window: opaque, mid-grey, painted everywhere. */
const painted = (): [number, number, number, number] => [40, 44, 52, 255]

group("probeEnabled", () => {
  it("is off unless asked for", () => {
    expect(probeEnabled("")).toBe(false)
    expect(probeEnabled("?debug=other")).toBe(false)
    expect(probeEnabled("?engine=ws://x:1")).toBe(false)
  })

  it("is on for ?debug=capture", () => {
    expect(probeEnabled("?debug=capture")).toBe(true)
    expect(probeEnabled("?engine=ws://x:1&debug=capture")).toBe(true)
  })
})

group("measuring a frame", () => {
  it("reports a fully painted window as having no dead edges", () => {
    const reading = measure(fakeCanvas(100, 60, painted), { width: 200, height: 120 })
    expect(reading?.dead).toEqual({ left: 0, right: 0, top: 0, bottom: 0 })
    expect(reading?.frame).toEqual({ width: 100, height: 60 })
    expect(reading?.box).toEqual({ width: 200, height: 120 })
  })

  it("finds a black band down the right edge", () => {
    // The reported bug: full height, roughly a twentieth of the width.
    const canvas = fakeCanvas(100, 60, (x) => (x >= 95 ? [0, 0, 0, 255] : painted()))
    expect(measure(canvas, { width: 100, height: 60 })?.dead.right).toBe(5)
  })

  it("finds a transparent band as well as a black one", () => {
    // Which of the two arrives depends on whether the frame kept its alpha,
    // and the bug is the same either way.
    const canvas = fakeCanvas(100, 60, (x) => (x >= 95 ? [9, 9, 9, 0] : painted()))
    expect(measure(canvas, { width: 100, height: 60 })?.dead.right).toBe(5)
  })

  it("does not call a dark window a dead edge", () => {
    // A terminal is nearly black. Testing "dark" rather than "unpainted" would
    // report its entire width as a band and send me off fixing nothing.
    const canvas = fakeCanvas(100, 60, () => [1, 1, 1, 255])
    expect(measure(canvas, { width: 100, height: 60 })?.dead).toEqual({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    })
  })

  it("needs the whole column dead, not just some of it", () => {
    // Black along the bottom of the right edge only, which is content rather
    // than an unpainted strip.
    const canvas = fakeCanvas(100, 60, (x, y) =>
      x >= 95 && y > 30 ? [0, 0, 0, 255] : painted(),
    )
    expect(measure(canvas, { width: 100, height: 60 })?.dead.right).toBe(0)
  })

  it("counts a blank window once rather than from both sides", () => {
    // Otherwise a window that has never painted reports left 100 and right 100
    // on a 100px frame, which reads as nonsense.
    const canvas = fakeCanvas(20, 10, () => [0, 0, 0, 0])
    const dead = measure(canvas, { width: 20, height: 10 })!.dead
    expect(dead.left).toBe(20)
    expect(dead.right).toBe(0)
  })

  it("finds bands on the other edges too", () => {
    const canvas = fakeCanvas(100, 60, (x, y) =>
      x < 3 || y < 4 ? [0, 0, 0, 255] : painted(),
    )
    const dead = measure(canvas, { width: 100, height: 60 })!.dead
    expect(dead.left).toBe(3)
    expect(dead.top).toBe(4)
    expect(dead.right).toBe(0)
    expect(dead.bottom).toBe(0)
  })

  it("gives up quietly on a frame it may not read", () => {
    const tainted = {
      width: 10,
      height: 10,
      getContext: () => ({
        getImageData: () => {
          throw new Error("tainted canvas")
        },
      }),
    } as unknown as HTMLCanvasElement
    expect(measure(tainted, { width: 10, height: 10 })).toBeNull()
  })

  it("gives up on a canvas with no pixels", () => {
    expect(measure(fakeCanvas(0, 0, painted), { width: 10, height: 10 })).toBeNull()
  })
})

group("reporting", () => {
  const reading: CaptureReading = {
    frame: { width: 1192, height: 814 },
    box: { width: 1172, height: 1122 },
    dead: { left: 0, right: 58, top: 0, bottom: 0 },
  }

  it("says the size it got, the size it asked for, and what is missing", () => {
    expect(describe("Code", reading)).toBe(
      "Code: frame 1192x814, box 1172x1122, unpainted: right 58px",
    )
  })

  it("says so plainly when there is nothing wrong", () => {
    expect(describe("Code", { ...reading, dead: { left: 0, right: 0, top: 0, bottom: 0 } })).toBe(
      "Code: frame 1192x814, box 1172x1122, fully painted",
    )
  })
})
