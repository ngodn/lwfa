/**
 * Right-clicking with a finger.
 *
 * A mouse and a touchpad need none of this: the operating system turns a
 * two-finger tap into `button === 2` before the browser sees it. A touchscreen
 * has no second button, and iOS Safari has not fired `contextmenu` on a long
 * press since iOS 13, so on the devices this project exists for the gesture has
 * to be measured rather than waited for.
 *
 * The failure modes are both bad and both easy to write by accident: a press
 * that fires too readily turns every slow tap into a menu, and one that fires
 * during a drag turns scrolling into a menu halfway down the page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LONG_PRESS_MS, LongPress, MOVE_TOLERANCE, movedTooFar } from "../src/lib/longPress"

const at = (x: number, y: number) => ({ clientX: x, clientY: y })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("deciding it is a drag", () => {
  it("allows the wobble of a finger held still", () => {
    // Nobody holds a finger perfectly still and the screen reports every bit
    // of it, so a strict test would almost never fire.
    expect(movedTooFar(at(100, 100), at(103, 104))).toBe(false)
  })

  it("calls a deliberate movement a drag", () => {
    expect(movedTooFar(at(100, 100), at(140, 100))).toBe(true)
  })

  it("measures the straight line, not each axis", () => {
    // Ten each way is fourteen pixels of travel. Per-axis tests let that
    // through, and it is a drag.
    expect(movedTooFar(at(0, 0), at(MOVE_TOLERANCE, MOVE_TOLERANCE))).toBe(true)
  })
})

describe("holding still", () => {
  it("fires once the finger has been down long enough", () => {
    const press = new LongPress()
    const fired = vi.fn()
    press.start(at(10, 10), fired)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it("does not fire early", () => {
    // Every ordinary tap passes through this window. Firing here would mean a
    // menu instead of opening the thing you tapped.
    const press = new LongPress()
    const fired = vi.fn()
    press.start(at(10, 10), fired)
    vi.advanceTimersByTime(LONG_PRESS_MS - 50)
    expect(fired).not.toHaveBeenCalled()
  })

  it("does not fire after the finger lifts", () => {
    const press = new LongPress()
    const fired = vi.fn()
    press.start(at(10, 10), fired)
    vi.advanceTimersByTime(200)
    press.finish()
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).not.toHaveBeenCalled()
  })

  it("does not fire once the finger has wandered", () => {
    // A slow drag must stay a drag. Firing partway through would open a menu
    // in the middle of scrolling.
    const press = new LongPress()
    const fired = vi.fn()
    press.start(at(10, 10), fired)
    vi.advanceTimersByTime(200)
    press.move(at(60, 10))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).not.toHaveBeenCalled()
  })

  it("tolerates a wobble without cancelling", () => {
    const press = new LongPress()
    const fired = vi.fn()
    press.start(at(10, 10), fired)
    vi.advanceTimersByTime(200)
    press.move(at(13, 12))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).toHaveBeenCalledTimes(1)
  })
})

describe("swallowing the release", () => {
  it("reports that it fired, so the tap is not sent as well", () => {
    // Otherwise the right click opens a menu and the tap that follows picks
    // something from it.
    const press = new LongPress()
    press.start(at(10, 10), () => {})
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(press.finish()).toBe(true)
  })

  it("reports that it did not fire for an ordinary tap", () => {
    const press = new LongPress()
    press.start(at(10, 10), () => {})
    vi.advanceTimersByTime(100)
    expect(press.finish()).toBe(false)
  })

  it("reports that it did not fire for a drag", () => {
    const press = new LongPress()
    press.start(at(10, 10), () => {})
    press.move(at(90, 10))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(press.finish()).toBe(false)
  })

  it("forgets after finishing, so the next tap starts clean", () => {
    const press = new LongPress()
    press.start(at(10, 10), () => {})
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(press.finish()).toBe(true)
    expect(press.finish()).toBe(false)
  })
})

describe("a second finger", () => {
  it("restarts rather than stacking two timers", () => {
    // A second `start` without a `finish` happens whenever a second finger
    // lands. Two live timers would fire two right clicks.
    const press = new LongPress()
    const first = vi.fn()
    const second = vi.fn()
    press.start(at(10, 10), first)
    vi.advanceTimersByTime(300)
    press.start(at(80, 80), second)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("measures movement from wherever it restarted", () => {
    const press = new LongPress()
    const fired = vi.fn()
    press.start(at(10, 10), () => {})
    press.start(at(200, 200), fired)
    press.move(at(203, 202))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).toHaveBeenCalledTimes(1)
  })
})
