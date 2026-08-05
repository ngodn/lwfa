/**
 * What the rail shows when it runs out of room, and what it shows when it does
 * not.
 *
 * The tiers are coarse on purpose: each one gives up a whole distinction. The
 * consequence is that the first tier that fits often fits with a lot of room
 * left, and the rail used to stop there, merging the keyboard and the gamepad
 * on a phone that had space for both. That matters more than it sounds: those
 * two buttons put a surface on screen with one tap, and merged they open a
 * settings panel instead.
 *
 * So the rail picks a tier and then spends whatever is left un-merging groups,
 * and both halves are worth pinning.
 */

import { describe, expect, it } from "vitest"
import { expandGroups, slotsForTier, type NavGroupId } from "../src/nav/registry"
import type { NavItemId } from "../src/lib/prefs"

const ORDER: NavItemId[] = [
  "info",
  "connections",
  "access",
  "theme",
  "settings",
  "apps",
  "escape",
  "keyboard",
  "gamepad",
  "workspaces",
]

/** The rail's own arithmetic: buttons, the gaps between them, and some slack. */
const fitsIn = (available: number, button = 44, gap = 6, pad = 10) =>
  (count: number) =>
    count === 0 || count * button + (count - 1) * gap + 12 <= available - pad * 2

const ids = (tier: number, expanded?: ReadonlySet<NavGroupId>) =>
  slotsForTier(tier, ORDER, [], expanded).map((slot) => slot.id)

describe("rail tiers", () => {
  it("lays everything out individually at tier 0", () => {
    expect(ids(0)).toEqual(ORDER)
  })

  it("merges the input surfaces first, then the management panels", () => {
    expect(ids(1)).toContain("input")
    expect(ids(1)).not.toContain("more")
    // `more` leads, because a group takes the position of its first member and
    // the session button is first in the user's order.
    expect(ids(2)).toEqual(["more", "apps", "escape", "input", "workspaces"])
  })
})

describe("spending the room a tier leaves over", () => {
  it("un-merges the input surfaces on a phone that has space for them", () => {
    // A phone in portrait: 390px along the bottom. Tier 2's five buttons need
    // 256 of the 370 usable, which leaves room for two more.
    const fits = fitsIn(390)
    const expanded = expandGroups(2, ORDER, [], fits)

    expect([...expanded]).toEqual(["input"])
    expect(ids(2, expanded)).toEqual([
      "more",
      "apps",
      "escape",
      "keyboard",
      "gamepad",
      "workspaces",
    ])
    expect(fits(ids(2, expanded).length)).toBe(true)
  })

  it("leaves them merged when there is genuinely no room", () => {
    // 300px: tier 2's five buttons fit and nothing else does.
    const fits = fitsIn(300)
    expect([...expandGroups(2, ORDER, [], fits)]).toEqual([])
  })

  it("prefers the input surfaces to the management panels", () => {
    // Enough for one group but not both: input wins, because its buttons put a
    // surface on screen rather than opening a panel either way.
    const fits = fitsIn(390)
    expect([...expandGroups(2, ORDER, [], fits)]).not.toContain("more")
  })

  it("never expands past what fits", () => {
    for (const width of [200, 260, 300, 340, 390, 500, 700, 900]) {
      const fits = fitsIn(width)
      for (const tier of [1, 2, 3]) {
        const expanded = expandGroups(tier, ORDER, [], fits)
        const count = ids(tier, expanded).length
        // The floor tier can overflow a very short rail on its own; expanding
        // must never be what does it.
        if (fits(ids(tier).length)) expect(fits(count)).toBe(true)
      }
    }
  })

  it("keeps the user's order when it un-merges", () => {
    const order: NavItemId[] = [...ORDER]
    order[7] = "gamepad"
    order[8] = "keyboard"
    const expanded = new Set<NavGroupId>(["input"])
    const laid = slotsForTier(2, order, [], expanded).map((slot) => slot.id)
    expect(laid.indexOf("gamepad")).toBeLessThan(laid.indexOf("keyboard"))
  })

  it("does not expand a group whose members are hidden", () => {
    const hidden: NavItemId[] = ["keyboard", "gamepad"]
    const expanded = expandGroups(2, ORDER, hidden, fitsIn(900))
    expect(ids(2, expanded)).not.toContain("input")
  })
})
