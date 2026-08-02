/**
 * Entering and leaving arrange mode.
 *
 * A mode is only safe to add if every way out is covered. This one can be left
 * by the Done button, by Escape, and by losing control of the layout to another
 * device, and the last is the one that would otherwise strand somebody in a
 * zoomed-out desktop whose controls all silently do nothing.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { arranging, resetArrange, setArrange, subscribe, toggleArrange } from "../src/lib/arrange"

afterEach(() => resetArrange())

describe("arrange mode", () => {
  it("starts off", () => {
    expect(arranging()).toBe(false)
  })

  it("enters and leaves", () => {
    setArrange(true)
    expect(arranging()).toBe(true)
    setArrange(false)
    expect(arranging()).toBe(false)
  })

  it("toggles", () => {
    toggleArrange()
    expect(arranging()).toBe(true)
    toggleArrange()
    expect(arranging()).toBe(false)
  })

  it("does not persist across a reload", async () => {
    // Coming back to a desktop already zoomed out, with no memory of asking
    // for it, is a puzzle rather than a convenience. Same call as the
    // gamepad's edit mode, and the test exists so nobody "helpfully" adds
    // storage later.
    setArrange(true)
    vi.resetModules()
    const fresh = await import("../src/lib/arrange")
    expect(fresh.arranging()).toBe(false)
  })
})

describe("what subscribers are told", () => {
  it("notifies on a real change", () => {
    const seen = vi.fn()
    // The same function `useSyncExternalStore` calls, so this is the contract
    // the components actually rely on.
    const unsubscribe = subscribe(seen)
    setArrange(true)
    expect(seen).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("says nothing when set to the value it already has", () => {
    // Every listener is a render. Entering a mode already entered must not
    // re-render the desktop and every streaming window under it.
    setArrange(true)
    const seen = vi.fn()
    const unsubscribe = subscribe(seen)
    setArrange(true)
    expect(seen).not.toHaveBeenCalled()
    unsubscribe()
  })

  it("stops telling a listener that has gone", () => {
    const seen = vi.fn()
    subscribe(seen)()
    setArrange(true)
    expect(seen).not.toHaveBeenCalled()
  })
})
