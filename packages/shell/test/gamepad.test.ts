/**
 * The numbers the drawn controller and the engine have to agree on.
 *
 * A press travels as a bare integer: the shell sends button 4, the engine looks
 * up index 4 in its own enum and asks the kernel for `BTN_TL`. Nothing on the
 * wire carries the name, so the two tables are held together by nothing except
 * having been typed the same way twice. Get one wrong and the pad still works,
 * still feels right, and presses the wrong thing, which is the kind of bug that
 * gets blamed on the game.
 *
 * So the order is pinned here against the W3C standard mapping, which is what
 * `lwfa-proto`'s `GamepadButton` is declared in and what a browser reports for
 * a real controller. `crates/lwfa-engine/src/gamepad.rs` pins the other half.
 *
 * https://w3c.github.io/gamepad/#remapping
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_LAYOUT,
  DPAD_BUTTONS,
  FACE_TO_BUTTON,
  STICK_AXES,
  TRIGGER_AXES,
} from "../src/gamepad/model"

/** The standard mapping, in order, exactly as the specification lists it. */
const W3C_BUTTONS = [
  "south",
  "east",
  "west",
  "north",
  "l1",
  "r1",
  "l2",
  "r2",
  "select",
  "start",
  "l3",
  "r3",
  "dpadUp",
  "dpadDown",
  "dpadLeft",
  "dpadRight",
  "guide",
] as const

describe("the button indices the engine will receive", () => {
  it("places every face at its standard-mapping index", () => {
    for (const [index, name] of W3C_BUTTONS.entries()) {
      // The d-pad is one drawn control rather than four faces, so it is
      // checked separately below.
      if (name.startsWith("dpad")) continue
      expect(FACE_TO_BUTTON[name as keyof typeof FACE_TO_BUTTON], name).toBe(index)
    }
  })

  it("sends the d-pad as up, right, down, left", () => {
    // Written in the order the drawn d-pad's quadrants are read, which is not
    // the order the specification numbers them: right is 15, between down and
    // left. Transcribing the spec's order straight into the array would put a
    // press of "right" onto "down".
    expect(DPAD_BUTTONS).toEqual([12, 15, 13, 14])
    expect(W3C_BUTTONS[12]).toBe("dpadUp")
    expect(W3C_BUTTONS[15]).toBe("dpadRight")
    expect(W3C_BUTTONS[13]).toBe("dpadDown")
    expect(W3C_BUTTONS[14]).toBe("dpadLeft")
  })

  it("never sends two faces as the same button", () => {
    const sent = [...Object.values(FACE_TO_BUTTON), ...DPAD_BUTTONS]
    expect(new Set(sent).size).toBe(sent.length)
  })

  it("stays inside the range the engine accepts", () => {
    // `GamepadButton::from_index` returns nothing past 16 and the engine drops
    // the message, so an index off the end is a button that silently does
    // nothing rather than an error anybody would see.
    for (const index of [...Object.values(FACE_TO_BUTTON), ...DPAD_BUTTONS]) {
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThanOrEqual(16)
    }
  })
})

describe("the axis indices", () => {
  it("gives the sticks the four standard axes", () => {
    expect(STICK_AXES.lstick).toEqual([0, 1])
    expect(STICK_AXES.rstick).toEqual([2, 3])
  })

  it("gives the triggers their own analog axes", () => {
    // A racing game reads the axis and never looks at the button, so a trigger
    // that only reported the button would do nothing at all in one.
    expect(TRIGGER_AXES.l2).toBe(4)
    expect(TRIGGER_AXES.r2).toBe(5)
  })

  it("stays inside the range the engine accepts", () => {
    const all = [...Object.values(STICK_AXES).flat(), ...Object.values(TRIGGER_AXES)]
    for (const index of all) {
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThanOrEqual(5)
    }
  })
})

describe("the default layout", () => {
  it("draws every button the engine can send", () => {
    // A control the engine supports but nothing draws is a button that does
    // not exist as far as anyone using a tablet is concerned. This is how L3
    // and R3 were missing for as long as they were.
    const drawn = new Set<string>()
    for (const pad of DEFAULT_LAYOUT) {
      if (pad.face === "dpad") {
        drawn.add("dpadUp")
        drawn.add("dpadDown")
        drawn.add("dpadLeft")
        drawn.add("dpadRight")
      } else if (pad.face !== "lstick" && pad.face !== "rstick") {
        drawn.add(pad.face)
      }
    }
    const missing = W3C_BUTTONS.filter((name) => !drawn.has(name))
    expect(missing, `not drawn anywhere: ${missing.join(", ")}`).toEqual([])
  })

  it("draws both sticks", () => {
    const sticks = DEFAULT_LAYOUT.filter((pad) => pad.kind === "stick")
    expect(sticks.map((pad) => pad.face).sort()).toEqual(["lstick", "rstick"])
  })

  it("draws L3 and R3 as their own buttons", () => {
    // They used to be a click on the stick. On a touchscreen there is no way
    // to tell a click from the beginning of a push, so sprinting and moving
    // were the same gesture. Every shooter needs both.
    const stickClicks = DEFAULT_LAYOUT.filter((pad) => pad.face === "l3" || pad.face === "r3")
    expect(stickClicks).toHaveLength(2)
    for (const pad of stickClicks) {
      expect(pad.kind).toBe("button")
    }
  })

  it("gives every drawn control a face the engine knows", () => {
    const known = new Set([...Object.keys(FACE_TO_BUTTON), "dpad", "lstick", "rstick"])
    for (const pad of DEFAULT_LAYOUT) {
      expect(known.has(pad.face), `${pad.id} has face ${pad.face}`).toBe(true)
    }
  })
})

/**
 * A saved layout is stored whole, so it is a snapshot of which controls existed
 * the day it was saved. Without a migration, anyone who had ever opened the
 * gamepad kept that day's set of pads forever: L3 and R3 were added and simply
 * never appeared, which reads as the feature having been forgotten.
 */
describe("a layout saved by an older version", () => {
  const KEY = "lwfa.gamepad.layout"
  const store: Record<string, string> = {}

  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key]
    vi.resetModules()
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
          store[k] = v
        },
      },
      configurable: true,
    })
  })

  it("gains the controls added since, keeping the ones it has where they are", async () => {
    // A layout from before L3, R3, Start and Select, with the face buttons
    // dragged somewhere the user liked.
    store[KEY] = JSON.stringify([
      { id: "south", kind: "button", face: "south", x: 11, y: 22, size: 12, code: 57 },
      { id: "lstick", kind: "stick", face: "lstick", x: 30, y: 40, size: 26, directions: [17, 32, 31, 30] },
    ])

    const { pads } = (await import("../src/gamepad/store")).__readForTest()
    const byId = new Map(pads.map((pad) => [pad.id, pad]))

    // The newcomers arrived, at their designed positions.
    for (const id of ["l3", "r3", "start", "select", "guide"]) {
      expect(byId.has(id), `${id} should have been added`).toBe(true)
    }
    // And the arrangement the user made was left alone.
    expect(byId.get("south")).toMatchObject({ x: 11, y: 22 })
    expect(byId.get("lstick")).toMatchObject({ x: 30, y: 40 })
  })

  it("ends up with the full set of controls", async () => {
    store[KEY] = JSON.stringify([
      { id: "south", kind: "button", face: "south", x: 11, y: 22, size: 12, code: 57 },
    ])
    const { pads } = (await import("../src/gamepad/store")).__readForTest()
    expect(pads.map((pad) => pad.id).sort()).toEqual(DEFAULT_LAYOUT.map((pad) => pad.id).sort())
  })

  it("does not duplicate anything for an up-to-date layout", async () => {
    store[KEY] = JSON.stringify(DEFAULT_LAYOUT)
    const { pads } = (await import("../src/gamepad/store")).__readForTest()
    expect(pads).toHaveLength(DEFAULT_LAYOUT.length)
    expect(new Set(pads.map((pad) => pad.id)).size).toBe(DEFAULT_LAYOUT.length)
  })

  it("falls back completely when the stored layout is nonsense", async () => {
    store[KEY] = "{ not json"
    const { pads } = (await import("../src/gamepad/store")).__readForTest()
    expect(pads).toEqual(DEFAULT_LAYOUT)
  })
})
