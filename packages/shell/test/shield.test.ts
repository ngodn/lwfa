/**
 * The tap shield, and the four things that have to be true before it appears.
 *
 * A floating controller lets pointers through the gaps between its pads on
 * purpose, so a tap on the game behind it still reaches the game. That is the
 * right default for a desktop and the wrong one for a game: many titles switch
 * to mouse control the instant they see a click, drop their gamepad prompts,
 * and stop reading the pad until something switches them back. Wuchang and
 * Assassin's Creed Odyssey both do it. A thumb landing a few millimetres wide
 * of a button therefore does not merely miss, it takes the controller away.
 *
 * Swallowing input is a serious thing for a shell to do, so the conditions are
 * pinned here rather than left as four `&&` in a component nobody reads.
 */

import { describe, expect, it } from "vitest"
import { shieldActive, type ShieldInput } from "../src/gamepad/shield"

/** Everything true, so each test can turn exactly one thing off. */
const on: ShieldInput = {
  dock: "gamepad",
  placement: "overlay",
  shield: true,
  editing: false,
}

describe("the tap shield", () => {
  it("is on when the controller is floating and it was asked for", () => {
    expect(shieldActive(on)).toBe(true)
  })

  it("is off by default", () => {
    // The whole point of the default: today's behaviour is unchanged for
    // anyone who never goes looking for this.
    expect(shieldActive({ ...on, shield: false })).toBe(false)
  })

  it("is off while the pad layout is being edited", () => {
    // Dragging a pad is a pointer gesture over the same area the shield
    // covers, and two claimants to one gesture is how editing breaks.
    expect(shieldActive({ ...on, editing: true })).toBe(false)
  })

  it("is off for a stacked controller", () => {
    // Stacked gives the pad its own row and the desktop shrinks to fit, so
    // there is nothing behind it. A shield there guards empty space.
    expect(shieldActive({ ...on, placement: "stacked" })).toBe(false)
  })

  it("is off when the controller is not up", () => {
    // The feature is scoped to the controller being on screen. With no
    // controller there are no gaps to miss, and a desktop that silently ate
    // taps would be a bug report.
    expect(shieldActive({ ...on, dock: "none" })).toBe(false)
  })

  it("is off under the keyboard", () => {
    // A keyboard is a solid strip of keys with no gaps to fall through, and
    // it is not what the games in question are being played with.
    expect(shieldActive({ ...on, dock: "keyboard" })).toBe(false)
  })

  it("needs every condition, not a majority of them", () => {
    // Guards against someone rewriting this as a count or an `||`.
    const offs: ShieldInput[] = [
      { ...on, shield: false },
      { ...on, editing: true },
      { ...on, placement: "stacked" },
      { ...on, dock: "none" },
    ]
    for (const input of offs) expect(shieldActive(input)).toBe(false)
  })
})
