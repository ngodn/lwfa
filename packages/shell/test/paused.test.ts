/**
 * Pausing a window's stream.
 *
 * Nothing happens to the application: it keeps running on the desktop and keeps
 * playing whatever it is playing. This device stops asking for its pixels, so
 * its share of the encoder budget goes to the windows still being watched.
 *
 * The ids are the sharp edge. They are unique only within a run of the engine,
 * so one left behind after a window closes, or across a reconnect, would freeze
 * an unrelated window later and look like a bug in something else entirely.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import type { WindowId } from "@lwfa/proto"
import {
  clearPaused,
  forgetPaused,
  pausedNow,
  setPaused,
  subscribe,
  togglePaused,
} from "../src/lib/paused"

const A = 1 as WindowId
const B = 2 as WindowId

afterEach(() => clearPaused())

describe("pausing", () => {
  it("starts with nothing paused", () => {
    expect(pausedNow().size).toBe(0)
  })

  it("pauses and resumes", () => {
    setPaused(A, true)
    expect(pausedNow().has(A)).toBe(true)
    setPaused(A, false)
    expect(pausedNow().has(A)).toBe(false)
  })

  it("toggles", () => {
    togglePaused(A)
    expect(pausedNow().has(A)).toBe(true)
    togglePaused(A)
    expect(pausedNow().has(A)).toBe(false)
  })

  it("keeps windows independent", () => {
    setPaused(A, true)
    expect(pausedNow().has(B)).toBe(false)
  })
})

describe("forgetting", () => {
  it("forgets a window that closed", () => {
    // Ids are reused by the engine, so a leftover would pause a future window
    // that has nothing to do with this one.
    setPaused(A, true)
    forgetPaused(A)
    expect(pausedNow().has(A)).toBe(false)
  })

  it("forgets everything on disconnect", () => {
    setPaused(A, true)
    setPaused(B, true)
    clearPaused()
    expect(pausedNow().size).toBe(0)
  })

  it("clearing an empty set is harmless", () => {
    expect(() => clearPaused()).not.toThrow()
  })
})

describe("what subscribers are told", () => {
  it("notifies on a real change", () => {
    const seen = vi.fn()
    const stop = subscribe(seen)
    setPaused(A, true)
    expect(seen).toHaveBeenCalledTimes(1)
    stop()
  })

  it("says nothing when set to what it already is", () => {
    // Every listener is a render, and this is read by the desktop.
    setPaused(A, true)
    const seen = vi.fn()
    const stop = subscribe(seen)
    setPaused(A, true)
    expect(seen).not.toHaveBeenCalled()
    stop()
  })

  it("says nothing when clearing what is already clear", () => {
    const seen = vi.fn()
    const stop = subscribe(seen)
    clearPaused()
    expect(seen).not.toHaveBeenCalled()
    stop()
  })

  it("hands out a new set rather than mutating the old one", () => {
    // `useSyncExternalStore` compares snapshots by identity, so mutating in
    // place would leave the desktop showing a stale answer.
    const before = pausedNow()
    setPaused(A, true)
    expect(pausedNow()).not.toBe(before)
    expect(before.has(A)).toBe(false)
  })
})
