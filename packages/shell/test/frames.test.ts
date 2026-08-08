/**
 * The frame store's lifetime rules, and the race they create.
 *
 * An `ImageBitmap` holds GPU memory and is not collected in any useful
 * timeframe, so the store closes every bitmap it replaces or drops. That is
 * right and must stay, but it means a bitmap can be closed while a React
 * render is still holding it: the render reads the store, and the effect that
 * draws runs after paint, so anything arriving in between detaches the very
 * bitmap that is about to be drawn.
 *
 * Drawing a detached bitmap throws `InvalidStateError`, and from a passive
 * effect React treats that as a render error, so it reached the error boundary
 * and took the whole shell down. What the user saw was touch dying, because
 * there was no shell left to send any. `WindowSurface` therefore checks a
 * frame's dimensions before drawing it; a detached bitmap reports zero.
 *
 * These pin the store behaviour that check depends on.
 */

import { beforeEach, describe, expect, it } from "vitest"
import type { WindowId } from "@lwfa/proto"
import { clearFrames, dropFrame, publishFrame } from "../src/lib/frames"

/**
 * A stand-in for `ImageBitmap` that behaves the way a real one does when it is
 * closed: the dimensions go to zero. That is the only signal there is, since
 * there is no `closed` property to ask.
 */
function bitmap(width = 320, height = 240): ImageBitmap {
  const fake = {
    width,
    height,
    close(): void {
      fake.width = 0
      fake.height = 0
    },
  }
  return fake as unknown as ImageBitmap
}

const W = 1 as WindowId

describe("the frame store", () => {
  beforeEach(() => clearFrames())

  it("closes the frame it replaces", () => {
    // The anti-leak rule. An hour of streaming is thousands of bitmaps.
    const first = bitmap()
    publishFrame(W, first)
    publishFrame(W, bitmap())
    expect(first.width).toBe(0)
  })

  it("closes a dropped frame", () => {
    const only = bitmap()
    publishFrame(W, only)
    dropFrame(W)
    expect(only.width).toBe(0)
  })

  it("leaves a replaced frame detectable rather than merely invalid", () => {
    // The property `WindowSurface` relies on. If a closed bitmap reported its
    // old dimensions there would be no way to know not to draw it, and the
    // only remaining defence would be catching the exception.
    const stale = bitmap(640, 480)
    publishFrame(W, stale)
    publishFrame(W, bitmap())
    expect(stale.width === 0 || stale.height === 0).toBe(true)
  })

  it("closes everything when the connection goes", () => {
    const a = bitmap()
    const b = bitmap()
    publishFrame(W, a)
    publishFrame(2 as WindowId, b)
    clearFrames()
    expect(a.width).toBe(0)
    expect(b.width).toBe(0)
  })
})
