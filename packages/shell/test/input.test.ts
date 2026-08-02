/**
 * Which keystrokes belong to the machine and which belong to the shell.
 *
 * Keys are captured on `window`, in the capture phase, and forwarded to the
 * compositor, because keyboard focus lives there and no DOM element
 * corresponds to it. That is right for the desktop and catastrophic for the
 * shell's own text fields, which is the bug this suite exists to keep fixed:
 * the app drawer's search box stayed empty while every letter typed into it
 * was delivered to whatever window had focus on the far end.
 */

import { describe, expect, it } from "vitest"
import { isTextEntry, shouldForwardKeydown, windowPoint } from "../src/input"

/** A DOM-free stand-in, since these run in node. */
class FakeElement {
  tagName: string
  type: string
  isContentEditable: boolean

  constructor(tagName: string, options: { type?: string; editable?: boolean } = {}) {
    this.tagName = tagName
    this.type = options.type ?? "text"
    this.isContentEditable = options.editable ?? false
  }
}

// `isTextEntry` narrows with `instanceof HTMLElement`, which does not exist in
// node, so the fakes are made to satisfy it.
Object.assign(globalThis, { HTMLElement: FakeElement })

const key = (target: unknown, extra: Record<string, unknown> = {}) =>
  ({ code: "KeyA", repeat: false, target, ...extra }) as unknown as KeyboardEvent

describe("isTextEntry", () => {
  it("claims text inputs, textareas and rich text", () => {
    expect(isTextEntry(new FakeElement("INPUT") as unknown as EventTarget)).toBe(true)
    expect(
      isTextEntry(new FakeElement("INPUT", { type: "password" }) as unknown as EventTarget),
    ).toBe(true)
    expect(
      isTextEntry(new FakeElement("INPUT", { type: "search" }) as unknown as EventTarget),
    ).toBe(true)
    expect(isTextEntry(new FakeElement("TEXTAREA") as unknown as EventTarget)).toBe(true)
    expect(isTextEntry(new FakeElement("SELECT") as unknown as EventTarget)).toBe(true)
    expect(
      isTextEntry(new FakeElement("DIV", { editable: true }) as unknown as EventTarget),
    ).toBe(true)
  })

  it("leaves inputs that take no text alone", () => {
    // A checkbox wants Space to toggle it and the arrows to move between
    // radios. Swallowing keys for those would make the shell's own switches
    // deaf and would gain nothing, since there is no caret to feed.
    for (const type of ["checkbox", "radio", "range", "button", "submit", "reset"]) {
      expect(isTextEntry(new FakeElement("INPUT", { type }) as unknown as EventTarget)).toBe(
        false,
      )
    }
  })

  it("does not claim ordinary elements or nothing at all", () => {
    expect(isTextEntry(new FakeElement("DIV") as unknown as EventTarget)).toBe(false)
    expect(isTextEntry(new FakeElement("BUTTON") as unknown as EventTarget)).toBe(false)
    expect(isTextEntry(null)).toBe(false)
    expect(isTextEntry({} as EventTarget)).toBe(false)
  })
})

describe("shouldForwardKeydown", () => {
  it("forwards a press aimed at the desktop", () => {
    expect(shouldForwardKeydown(key(new FakeElement("DIV")))).toBe(true)
  })

  it("does not forward what is being typed into the shell", () => {
    // The app drawer's search box, the run-a-command box, account names and
    // passwords: all of these were being emptied by the capture-phase listener
    // and delivered to the remote machine instead.
    expect(shouldForwardKeydown(key(new FakeElement("INPUT")))).toBe(false)
    expect(shouldForwardKeydown(key(new FakeElement("TEXTAREA")))).toBe(false)
  })

  it("still keeps the browser's own two keys", () => {
    // F11 and F12 stay with the browser, or the page becomes hard to escape.
    expect(shouldForwardKeydown(key(new FakeElement("DIV"), { code: "F11" }))).toBe(false)
    expect(shouldForwardKeydown(key(new FakeElement("DIV"), { code: "F12" }))).toBe(false)
  })

  it("drops browser autorepeat", () => {
    // Wayland advertises a repeat rate and clients generate their own, so
    // forwarding the browser's as well repeats a held key two or three times.
    expect(shouldForwardKeydown(key(new FakeElement("DIV"), { repeat: true }))).toBe(false)
  })
})

describe("windowPoint", () => {
  const element = (box: { x: number; y: number; width: number; height: number }) =>
    ({ getBoundingClientRect: () => ({ ...box, left: box.x, top: box.y }) }) as unknown as Element

  it("maps a click through the pixels actually on screen", () => {
    // The window is drawn in a 600x400 box, but the image in it is 1200x800:
    // the shell scales whatever the client rendered to fill the box.
    const box = element({ x: 100, y: 50, width: 600, height: 400 })
    const point = windowPoint({ clientX: 400, clientY: 250 }, box, {
      width: 1200,
      height: 800,
    })
    // Dead centre of the box is dead centre of the image.
    expect(point).toEqual({ x: 600, y: 400 })
  })

  it("does not map through the size the shell asked for", () => {
    // The bug this pins. A client that has not resized yet renders at its own
    // size; using the requested one sent clicks to a window that was not the
    // one on screen. Measured: a 1192x814 image inside an 1172x1122 box put a
    // click near the bottom about three hundred pixels too high.
    const box = element({ x: 0, y: 0, width: 1172, height: 1122 })
    const nearBottom = { clientX: 586, clientY: 1000 }

    const throughContent = windowPoint(nearBottom, box, { width: 1192, height: 814 })
    const throughLayout = windowPoint(nearBottom, box, { width: 1172, height: 1122 })

    expect(throughContent!.y).toBeCloseTo(725.4, 0)
    expect(throughLayout!.y).toBe(1000)
    expect(Math.abs(throughLayout!.y - throughContent!.y)).toBeGreaterThan(250)
  })

  it("refuses a box or a frame with no area", () => {
    // Dividing by either would produce NaN and send it to the compositor.
    const zero = element({ x: 0, y: 0, width: 0, height: 0 })
    expect(windowPoint({ clientX: 1, clientY: 1 }, zero, { width: 10, height: 10 })).toBeNull()

    const box = element({ x: 0, y: 0, width: 100, height: 100 })
    expect(windowPoint({ clientX: 1, clientY: 1 }, box, { width: 0, height: 0 })).toBeNull()
  })
})
