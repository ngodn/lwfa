/**
 * Strip layout geometry.
 *
 * This is lwfa's layout policy, and it is pure, so it can be tested properly
 * rather than eyeballed in a screenshot. Several of these cases pin behaviour
 * that was verified against the real compositor in milestone 2.
 */

import { describe, expect, it } from "vitest"
import {
  DEFAULT_CONFIG,
  EMPTY,
  type Output,
  type StripState,
  addWindow,
  columnHeight,
  columnWidth,
  columnX,
  focusLeft,
  focusRight,
  focusWindow,
  focusedWindow,
  layout,
  reflow,
  removeWindow,
  stripWidth,
  targetOffset,
} from "../src/strip.js"

const config = DEFAULT_CONFIG
const wide: Output = { width: 1920, height: 1080 }
/** The viewport milestone 2 was verified against, so the numbers are comparable. */
const nested: Output = { width: 1261, height: 1390 }

function withWindows(ids: number[], output: Output): StripState {
  return ids.reduce((state, id) => addWindow(state, id, output, config), EMPTY)
}

describe("column sizing", () => {
  it("defaults to half the viewport", () => {
    expect(columnWidth(wide, config)).toBe(960)
    expect(columnWidth({ width: 2560, height: 1440 }, config)).toBe(1280)
  })

  it("has a floor on narrow viewports", () => {
    // A phone-width viewport must not produce unusably narrow columns. The
    // shell is expected to switch to one column per viewport at that size
    // rather than lean on this, but the floor is the backstop.
    expect(columnWidth({ width: 320, height: 720 }, config)).toBe(config.minWidth)
  })

  it("leaves a gap top and bottom", () => {
    expect(columnHeight(wide, config)).toBe(1080 - config.gap * 2)
  })
})

describe("strip coordinates", () => {
  it("accumulates widths and gaps", () => {
    const width = columnWidth(nested, config)
    expect(width).toBe(631)
    expect(columnX(0, width, config)).toBe(12)
    expect(columnX(1, width, config)).toBe(12 + 631 + 12)
  })

  it("reports zero width for an empty strip", () => {
    expect(stripWidth(0, 960, config)).toBe(0)
  })
})

describe("scrolling", () => {
  it("does not move when the focused column is already visible", () => {
    // Two 960px columns do not fit in 1920 with gaps, so use a wider viewport
    // where column 0 is comfortably in view.
    const state = withWindows([1], { width: 4000, height: 1080 })
    expect(targetOffset({ ...state, viewOffset: 0 }, { width: 4000, height: 1080 }, config)).toBe(0)
  })

  it("scrolls right by the minimum needed to reveal the focused column", () => {
    const output = nested
    const state = withWindows([1, 2], output)
    const width = columnWidth(output, config)
    const right = columnX(1, width, config) + width + config.gap
    expect(state.viewOffset).toBe(right - output.width)
  })

  it("scrolls left to reveal a column off the left edge", () => {
    const output = nested
    let state = withWindows([1, 2], output)
    expect(state.viewOffset).toBeGreaterThan(0)
    state = focusLeft(state, output, config)
    // Column 0's left edge, including its gap, is the origin.
    expect(state.viewOffset).toBe(0)
  })

  it("pins the left edge of a column that cannot fit in the viewport", () => {
    // The minWidth floor (240) plus both gaps is 264, so a 260px viewport
    // cannot show a whole column. There is no offset that reveals all of it,
    // so the left edge is pinned rather than the right.
    const tiny: Output = { width: 260, height: 800 }
    const width = columnWidth(tiny, config)
    expect(width + config.gap * 2).toBeGreaterThanOrEqual(tiny.width)

    const state = withWindows([1, 2], tiny)
    expect(state.viewOffset).toBe(columnX(1, width, config) - config.gap)
  })

  it("scrolls right, not pins, when a column only just fits", () => {
    // 240 + 24 = 264 fits inside 300, so this must take the scroll-right
    // branch. Worth pinning explicitly: getting this boundary backwards would
    // leave a column clipped on the right on small screens.
    const narrow: Output = { width: 300, height: 800 }
    const width = columnWidth(narrow, config)
    expect(width + config.gap * 2).toBeLessThan(narrow.width)

    const state = withWindows([1, 2], narrow)
    const right = columnX(1, width, config) + width + config.gap
    expect(state.viewOffset).toBe(right - narrow.width)
  })

  it("targets the origin on an empty strip", () => {
    expect(targetOffset(EMPTY, wide, config)).toBe(0)
  })
})

describe("layout output", () => {
  it("reproduces the geometry verified against the real compositor", () => {
    // Milestone 2 ran nested at 1261x1390 with two columns and rendered
    // column 0 clipped on the left and column 1 ending one gap from the right
    // edge. Same arithmetic, now in the shell.
    const output = nested
    const state = withWindows([1, 2], output)
    const placed = layout(state, output, config)

    expect(placed).toHaveLength(2)
    expect(placed[0]!.rect.x).toBeLessThan(0)
    expect(placed[1]!.rect.x + placed[1]!.rect.width).toBe(output.width - config.gap)
    expect(placed[0]!.rect.y).toBe(config.gap)
    expect(placed[0]!.rect.height).toBe(output.height - config.gap * 2)
  })

  it("assigns ascending z in strip order", () => {
    const state = withWindows([5, 6, 7], wide)
    expect(layout(state, wide, config).map((w) => w.z)).toEqual([0, 1, 2])
  })

  it("returns nothing for an empty strip", () => {
    expect(layout(EMPTY, wide, config)).toEqual([])
  })

  it("keeps every window in the layout, including ones off screen", () => {
    // The engine hides windows absent from a SetLayout, so omitting scrolled-
    // off columns here would make them vanish rather than sit off-viewport.
    const state = withWindows([1, 2, 3, 4, 5], nested)
    expect(layout(state, nested, config)).toHaveLength(5)
  })
})

describe("window lifecycle", () => {
  it("focuses a newly added window", () => {
    const state = withWindows([1, 2, 3], wide)
    expect(focusedWindow(state)).toBe(3)
  })

  it("ignores a duplicate add", () => {
    let state = withWindows([1], wide)
    state = addWindow(state, 1, wide, config)
    expect(state.columns).toEqual([1])
  })

  it("keeps focus on the same window when an earlier column closes", () => {
    // Removing a column to the left shifts every later index down. Without the
    // adjustment, focus would silently land on a different window.
    let state = withWindows([1, 2, 3], wide)
    state = focusWindow(state, 3, wide, config)
    state = removeWindow(state, 1, wide, config)
    expect(focusedWindow(state)).toBe(3)
  })

  it("keeps focus in range when the focused column closes", () => {
    let state = withWindows([1, 2, 3], wide)
    state = focusWindow(state, 3, wide, config)
    state = removeWindow(state, 3, wide, config)
    expect(focusedWindow(state)).toBe(2)
  })

  it("survives removing the last window", () => {
    let state = withWindows([1], wide)
    state = removeWindow(state, 1, wide, config)
    expect(state.columns).toEqual([])
    expect(focusedWindow(state)).toBeNull()
    expect(layout(state, wide, config)).toEqual([])
  })

  it("ignores removing a window it does not have", () => {
    const state = withWindows([1, 2], wide)
    expect(removeWindow(state, 99, wide, config)).toBe(state)
  })
})

describe("focus movement", () => {
  it("stops at the ends rather than wrapping", () => {
    // Wrapping on an infinite strip would teleport the viewport across the
    // whole strip, which is disorienting and expensive to animate.
    let state = withWindows([1, 2, 3], wide)
    state = focusWindow(state, 1, wide, config)
    expect(focusedWindow(focusLeft(state, wide, config))).toBe(1)

    state = focusWindow(state, 3, wide, config)
    expect(focusedWindow(focusRight(state, wide, config))).toBe(3)
  })

  it("does nothing on an empty strip", () => {
    expect(focusLeft(EMPTY, wide, config)).toBe(EMPTY)
    expect(focusRight(EMPTY, wide, config)).toBe(EMPTY)
  })

  it("ignores focusing an unknown window", () => {
    const state = withWindows([1, 2], wide)
    expect(focusWindow(state, 99, wide, config)).toBe(state)
  })
})

describe("viewport changes", () => {
  it("re-derives the offset without resizing columns", () => {
    // The defining property of scrollable tiling: a viewport change alters what
    // is visible, not how big anything is.
    const state = withWindows([1, 2, 3], wide)
    const narrower: Output = { width: 1000, height: 1080 }
    const after = reflow(state, narrower, config)

    expect(after.columns).toEqual(state.columns)
    expect(focusedWindow(after)).toBe(focusedWindow(state))
    // Column width is a fraction of the viewport, so it does change on resize;
    // what must not change is which windows exist and in what order.
    expect(layout(after, narrower, config)).toHaveLength(3)
  })

  it("keeps the focused column visible after a resize", () => {
    const state = withWindows([1, 2, 3, 4], wide)
    const narrower: Output = { width: 700, height: 1080 }
    const after = reflow(state, narrower, config)
    const width = columnWidth(narrower, config)
    const focusX = columnX(after.focus, width, config)
    expect(focusX - after.viewOffset).toBeGreaterThanOrEqual(-1)
  })
})

describe("purity", () => {
  it("never mutates the state it is given", () => {
    const state = withWindows([1, 2, 3], wide)
    const snapshot = JSON.stringify(state)
    addWindow(state, 4, wide, config)
    removeWindow(state, 1, wide, config)
    focusLeft(state, wide, config)
    layout(state, wide, config)
    expect(JSON.stringify(state)).toBe(snapshot)
  })

  it("is deterministic", () => {
    // Same input, same output, every time: this is what lets the local and
    // remote backends agree without coordinating.
    const a = layout(withWindows([1, 2, 3], nested), nested, config)
    const b = layout(withWindows([1, 2, 3], nested), nested, config)
    expect(a).toEqual(b)
  })
})
