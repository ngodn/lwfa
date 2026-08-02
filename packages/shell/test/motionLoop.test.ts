/**
 * The animator itself, driven frame by frame.
 *
 * `motion.test.ts` checks the spring's parameters. This checks the loop that
 * runs it: that a window never passes the place it is going, including when the
 * move is redirected while it is still in flight, which is what happens every
 * time focus moves again before the last scroll finished. That case is the one
 * the parameters alone cannot rule out, and it is the bounce that was reported.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"

/** Frames the fake `requestAnimationFrame` is holding. */
let queued: ((now: number) => void)[] = []
let clock = 0

/** A DOM element as far as the animator is concerned: something with a style. */
function fakeElement() {
  return { style: {} as Record<string, string> } as unknown as HTMLElement
}

/** Read back the x the animator wrote, in the same units it was given. */
function xOf(element: HTMLElement): number {
  const match = /translate3d\(([-\d.]+)px/.exec(element.style.transform ?? "")
  if (!match) throw new Error(`no transform written: ${element.style.transform}`)
  return Number(match[1])
}

async function loadMotion() {
  const module = await import("../src/lib/motion")
  return module.motion
}

beforeEach(() => {
  queued = []
  clock = 0
  Object.assign(globalThis, {
    requestAnimationFrame: (cb: (now: number) => void) => {
      queued.push(cb)
      return queued.length
    },
    performance: { now: () => clock },
    // No preference either way; the animator asks, and reduced motion would
    // skip every animation and make these tests pass for the wrong reason.
    matchMedia: () => ({ matches: false }),
  })
})

afterEach(() => {
  queued = []
})

/** Advance one frame at 120Hz and return the positions written. */
function frame(): void {
  clock += 1000 / 120
  const due = queued
  queued = []
  for (const cb of due) cb(clock)
}

const rect = (x: number) => ({ x, y: 0, width: 400, height: 300 })

describe("the animator", () => {
  it("moves a window without ever passing its target", async () => {
    const motion = await loadMotion()
    const element = fakeElement()

    motion.set([{ id: 1, rect: rect(0), z: 0 }], false)
    motion.attach(1, element, rect(0), 0)
    motion.set([{ id: 1, rect: rect(1000), z: 0 }], true)

    const seen: number[] = []
    for (let i = 0; i < 400 && queued.length > 0; i++) {
      frame()
      seen.push(xOf(element))
    }

    expect(seen.length).toBeGreaterThan(5)
    for (const x of seen) expect(x).toBeLessThanOrEqual(1000)
    expect(seen.at(-1)).toBe(1000)
  })

  it("does not bounce when the move is redirected in flight", async () => {
    // The reported bug: focus another window while the strip is still
    // scrolling, and the window sails past where it was going and springs
    // back off the edge of the viewport.
    const motion = await loadMotion()
    const element = fakeElement()

    motion.set([{ id: 2, rect: rect(0), z: 0 }], false)
    motion.attach(2, element, rect(0), 0)
    motion.set([{ id: 2, rect: rect(1000), z: 0 }], true)

    // Part way there, and still moving fast.
    for (let i = 0; i < 8; i++) frame()
    const midway = xOf(element)
    expect(midway).toBeGreaterThan(0)
    expect(midway).toBeLessThan(1000)

    // Change our mind: a nearer target, in the same direction, so the carried
    // velocity is pointing straight past it.
    motion.set([{ id: 2, rect: rect(midway + 40), z: 0 }], true)
    const limit = midway + 40

    const seen: number[] = []
    for (let i = 0; i < 400 && queued.length > 0; i++) {
      frame()
      seen.push(xOf(element))
    }

    for (const x of seen) expect(x).toBeLessThanOrEqual(limit)
    expect(seen.at(-1)).toBe(limit)
  })

  it("snaps a window it has never seen before rather than flying it in", async () => {
    const motion = await loadMotion()
    const element = fakeElement()

    motion.set([{ id: 3, rect: rect(640), z: 0 }], true)
    motion.attach(3, element, rect(640), 0)

    expect(xOf(element)).toBe(640)
    expect(queued).toHaveLength(0)
  })

  it("leaves the box size alone, because pixels arrive at one size only", async () => {
    const motion = await loadMotion()
    const element = fakeElement()

    motion.set([{ id: 4, rect: rect(0), z: 0 }], false)
    motion.attach(4, element, rect(0), 0)
    motion.set([{ id: 4, rect: { x: 0, y: 0, width: 900, height: 700 }, z: 0 }], true)

    // Immediately, on the same tick, with no frames run.
    expect(element.style.width).toBe("900px")
    expect(element.style.height).toBe("700px")
  })
})
