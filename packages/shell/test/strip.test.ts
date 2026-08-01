/**
 * Strip layout: columns, stacks, widths and workspaces.
 *
 * This is lwfa's layout policy and it is pure, so it can be tested properly
 * rather than eyeballed in a screenshot. Several cases pin behaviour that was
 * verified against the real compositor.
 */

import { describe, expect, it } from "vitest"
import {
  DEFAULT_CONFIG,
  EMPTY,
  type Output,
  type StripConfig,
  type StripState,
  addWindow,
  allWindows,
  columnX,
  consumeIntoColumn,
  currentWorkspace,
  cycleWidth,
  expelFromColumn,
  findWindow,
  focusDown,
  focusLeft,
  focusRight,
  focusUp,
  focusWindow,
  focusWorkspace,
  focusedWindow,
  WIDTH_PRESETS,
  intersectsViewport,
  layout,
  orientationOf,
  moveToWorkspace,
  presetWidth,
  reflow,
  removeWindow,
  stackedHeight,
} from "../src/strip.js"

const config = DEFAULT_CONFIG

/**
 * The minimal-scroll behaviour, which is no longer the default.
 *
 * Both modes are supported and both are worth testing: centring is what a
 * tablet wants, minimal scrolling is what a wide display wants.
 */
const minimalScroll = { ...DEFAULT_CONFIG, centreFocused: false }
const wide: Output = { width: 1920, height: 1080 }
/** The viewport milestone 2 was verified against, so numbers are comparable. */
const nested: Output = { width: 1261, height: 1390 }
/**
 * A landscape viewport for the scrolling suite.
 *
 * `nested` is 1261x1390, which is *portrait*, so since the strip follows the
 * long axis it scrolls vertically there. Reusing it for horizontal-scroll
 * assertions tested the wrong axis.
 */
const scrollable: Output = { width: 1261, height: 800 }

function withWindows(
  ids: number[],
  output: Output = wide,
  cfg: StripConfig = config,
): StripState {
  return ids.reduce((state, id) => addWindow(state, id, output, cfg), EMPTY)
}

describe("column sizing", () => {
  it("uses the preset fractions", () => {
    expect(presetWidth(0, wide, config)).toBe(640) // 1/3
    expect(presetWidth(1, wide, config)).toBe(960) // 1/2
    expect(presetWidth(2, wide, config)).toBe(1280) // 2/3
    expect(presetWidth(3, wide, config)).toBe(1728) // 90%
  })

  it("has a floor on narrow viewports", () => {
    // A phone-width viewport must not produce unusably narrow columns.
    expect(presetWidth(0, { width: 320, height: 720 }, config)).toBe(config.minWidth)
  })

  it("cycles the focused column through the presets and wraps", () => {
    let state = withWindows([1])
    const widthOf = (s: StripState) => currentWorkspace(s).columns[0]!.width
    expect(widthOf(state)).toBe(config.defaultWidth)

    // Wraps back to 0 after the last preset, whatever the list length, so
    // adding a preset does not need this test rewritten.
    const presets = WIDTH_PRESETS.length
    for (let step = 1; step <= presets; step++) {
      state = cycleWidth(state, wide, config)
      expect(widthOf(state)).toBe((config.defaultWidth + step) % presets)
    }
    expect(widthOf(state)).toBe(config.defaultWidth)
  })

  it("only resizes the focused column", () => {
    // Every width change is an xdg_shell configure, and native apps re-layout
    // rather than reflow. Resizing a neighbour would be a free configure.
    let state = withWindows([1, 2])
    state = cycleWidth(state, wide, config)
    const columns = currentWorkspace(state).columns
    expect(columns[0]!.width).toBe(config.defaultWidth)
    expect(columns[1]!.width).not.toBe(config.defaultWidth)
  })

  it("offsets later columns by the actual width of earlier ones", () => {
    // Widths vary per column now, so x cannot be index * fixed width.
    let state = withWindows([1, 2])
    state = focusWindow(state, 1, wide, config)
    state = cycleWidth(state, wide, config) // column 0 becomes 2/3
    const columns = currentWorkspace(state).columns
    expect(columnX(columns, 1, wide, config)).toBe(
      config.gap + presetWidth(columns[0]!.width, wide, config) + config.gap,
    )
  })
})

describe("stacking within a column", () => {
  it("splits height equally, accounting for gaps", () => {
    const full = stackedHeight(1, wide, config)
    const half = stackedHeight(2, wide, config)
    expect(full).toBe(wide.height - config.gap * 2)
    expect(half * 2 + config.gap).toBeLessThanOrEqual(full)
  })

  it("consumes the focused window into the column on its left", () => {
    let state = withWindows([1, 2])
    state = consumeIntoColumn(state, wide, config)

    const columns = currentWorkspace(state).columns
    expect(columns).toHaveLength(1)
    expect(columns[0]!.windows).toEqual([1, 2])
    expect(focusedWindow(state)).toBe(2)
  })

  it("expels a stacked window back into its own column", () => {
    let state = withWindows([1, 2])
    state = consumeIntoColumn(state, wide, config)
    state = expelFromColumn(state, wide, config)

    const columns = currentWorkspace(state).columns
    expect(columns).toHaveLength(2)
    expect(columns[0]!.windows).toEqual([1])
    expect(columns[1]!.windows).toEqual([2])
    expect(focusedWindow(state)).toBe(2)
  })

  it("will not consume from the leftmost column", () => {
    let state = withWindows([1, 2])
    state = focusWindow(state, 1, wide, config)
    expect(consumeIntoColumn(state, wide, config)).toBe(state)
  })

  it("will not expel the only window in a column", () => {
    const state = withWindows([1])
    expect(expelFromColumn(state, wide, config)).toBe(state)
  })

  it("stacks windows vertically in the layout", () => {
    let state = withWindows([1, 2])
    state = consumeIntoColumn(state, wide, config)
    const placed = layout(state, wide, config)

    expect(placed).toHaveLength(2)
    // Same column: same x and width, different y.
    expect(placed[0]!.rect.x).toBe(placed[1]!.rect.x)
    expect(placed[0]!.rect.width).toBe(placed[1]!.rect.width)
    expect(placed[1]!.rect.y).toBeGreaterThan(placed[0]!.rect.y)
    // And they must not overlap.
    expect(placed[1]!.rect.y).toBeGreaterThanOrEqual(
      placed[0]!.rect.y + placed[0]!.rect.height,
    )
  })

  it("moves focus up and down within a stack", () => {
    let state = withWindows([1, 2, 3])
    state = consumeIntoColumn(state, wide, config) // 3 joins 2
    expect(focusedWindow(state)).toBe(3)
    state = focusUp(state)
    expect(focusedWindow(state)).toBe(2)
    state = focusDown(state)
    expect(focusedWindow(state)).toBe(3)
  })

  it("stops at the ends of a stack rather than wrapping", () => {
    let state = withWindows([1, 2])
    state = consumeIntoColumn(state, wide, config)
    state = focusUp(state)
    expect(focusedWindow(focusUp(state))).toBe(1)
  })
})

describe("workspaces", () => {
  it("always keeps exactly one empty workspace at the end", () => {
    expect(EMPTY.workspaces).toHaveLength(1)
    const state = withWindows([1])
    expect(state.workspaces).toHaveLength(2)
    expect(state.workspaces.at(-1)!.columns).toHaveLength(0)
  })

  it("lays out only the focused workspace", () => {
    // Windows elsewhere are simply absent, and because SetLayout is total the
    // engine hides them. That is what makes switching workspaces work with no
    // protocol support at all.
    let state = withWindows([1, 2])
    state = moveToWorkspace(state, 1, wide, config)

    const placed = layout(state, wide, config)
    expect(placed.map((w) => w.id)).toEqual([2])
    expect(allWindows(state).sort()).toEqual([1, 2])
  })

  it("moves a window to the next workspace and follows it", () => {
    let state = withWindows([1, 2])
    const before = state.focus
    state = moveToWorkspace(state, 1, wide, config)
    expect(state.focus).toBeGreaterThan(before)
    expect(focusedWindow(state)).toBe(2)
    expect(findWindow(state, 2)!.workspace).toBe(state.focus)
  })

  it("remembers each workspace's scroll position", () => {
    // Offset is per workspace, so switching away and back returns you where
    // you were rather than snapping to the start of the strip.
    let state = withWindows([1, 2, 3, 4], nested)
    const firstOffset = currentWorkspace(state).viewOffset
    expect(firstOffset).toBeGreaterThan(0)

    state = focusWorkspace(state, 1, nested, config)
    expect(currentWorkspace(state).viewOffset).toBe(0)

    state = focusWorkspace(state, -1, nested, config)
    expect(currentWorkspace(state).viewOffset).toBe(firstOffset)
  })

  it("does not strand an empty workspace in the middle", () => {
    // Emptying a middle workspace would otherwise leave a hole you have to
    // scroll past forever.
    let state = withWindows([1])
    state = addWindow(state, 2, wide, config)
    state = focusWorkspace(state, 1, wide, config)
    state = addWindow(state, 3, wide, config)
    // [1,2] | [3] | empty
    expect(state.workspaces).toHaveLength(3)

    state = removeWindow(state, 1, wide, config)
    state = removeWindow(state, 2, wide, config)

    // [3] | empty, with no hole where the first workspace was.
    expect(state.workspaces).toHaveLength(2)
    expect(state.workspaces[0]!.columns.flatMap((c) => c.windows)).toEqual([3])
    expect(state.workspaces.filter((w) => w.columns.length === 0)).toHaveLength(1)
  })

  it("collapses a workspace emptied by moving its last window away", () => {
    // Moving the only window off a workspace leaves nothing behind, so the
    // workspace should go too rather than linger as a blank one to scroll past.
    let state = withWindows([1])
    expect(state.workspaces).toHaveLength(2)
    state = moveToWorkspace(state, 1, wide, config)
    expect(state.workspaces).toHaveLength(2)
    expect(focusedWindow(state)).toBe(1)
  })

  it("clamps rather than wrapping at the ends", () => {
    const state = withWindows([1])
    expect(focusWorkspace(state, -5, wide, config).focus).toBe(0)
    const last = focusWorkspace(state, 99, wide, config)
    expect(last.focus).toBe(state.workspaces.length - 1)
  })
})

describe("scrolling", () => {
  it("scrolls right by the minimum needed to reveal the focused column", () => {
    const state = withWindows([1, 2], scrollable, minimalScroll)
    const ws = currentWorkspace(state)
    const width = presetWidth(ws.columns[1]!.width, scrollable, minimalScroll)
    const right = columnX(ws.columns, 1, scrollable, minimalScroll) + width + minimalScroll.gap
    expect(ws.viewOffset).toBe(right - scrollable.width)
  })

  it("scrolls left to reveal a column off the left edge", () => {
    let state = withWindows([1, 2], scrollable, minimalScroll)
    expect(currentWorkspace(state).viewOffset).toBeGreaterThan(0)
    state = focusLeft(state, scrollable, minimalScroll)
    expect(currentWorkspace(state).viewOffset).toBe(0)
  })

  it("centres the focused column by default", () => {
    // The property that makes a strip navigable without a keyboard: focus is
    // always in the same place, so moving is a predictable motion.
    const state = withWindows([1, 2], scrollable)
    const ws = currentWorkspace(state)
    const width = presetWidth(ws.columns[1]!.width, scrollable, config)
    const left = columnX(ws.columns, 1, scrollable, config)
    const centreOfColumn = left + width / 2
    expect(ws.viewOffset + scrollable.width / 2).toBeCloseTo(centreOfColumn, 6)
  })

  it("keeps focus centred at both ends of the strip", () => {
    // Deliberately not clamped: if the first column snapped to the left edge
    // the ends would behave differently from the middle, which is exactly the
    // unpredictability centring removes.
    let state = withWindows([1, 2, 3], scrollable)
    state = focusLeft(state, scrollable, config)
    state = focusLeft(state, scrollable, config)
    const ws = currentWorkspace(state)
    expect(ws.focus).toBe(0)
    const width = presetWidth(ws.columns[0]!.width, scrollable, config)
    const centreOfColumn = columnX(ws.columns, 0, scrollable, config) + width / 2
    expect(ws.viewOffset + scrollable.width / 2).toBeCloseTo(centreOfColumn, 6)
  })

  it("does not move when the focused column is already visible", () => {
    // Minimal mode only: centring moves it on purpose, even when it already
    // fits, which is the whole point of centring.
    const roomy: Output = { width: 4000, height: 1080 }
    const state = withWindows([1], roomy, minimalScroll)
    expect(currentWorkspace(state).viewOffset).toBe(0)
  })

  it("pins the left edge of a column that cannot fit", () => {
    // Wider than the viewport, so no offset shows all of it. Pinning the left
    // edge beats centring, which would cut off both sides instead of one.
    // Landscape and narrow, so `minWidth` forces the column past the viewport:
    // 0.9 x 200 is 180, floored to 240, which is wider than the 200 available.
    const tiny: Output = { width: 200, height: 150 }
    const state = withWindows([1, 2], tiny)
    const ws = currentWorkspace(state)
    expect(ws.viewOffset).toBe(columnX(ws.columns, 1, tiny, config) - config.gap)
  })

  it("targets the origin on an empty workspace", () => {
    expect(currentWorkspace(EMPTY).viewOffset).toBe(0)
  })
})

describe("window lifecycle", () => {
  it("inserts a new window beside the focused column, not at the end", () => {
    // niri's behaviour: a window opened while reading something lands next to
    // it rather than at the far end of the strip.
    let state = withWindows([1, 2])
    state = focusWindow(state, 1, wide, config)
    state = addWindow(state, 3, wide, config)

    expect(currentWorkspace(state).columns.map((c) => c.windows)).toEqual([[1], [3], [2]])
    expect(focusedWindow(state)).toBe(3)
  })

  it("ignores a duplicate add", () => {
    const state = withWindows([1])
    expect(addWindow(state, 1, wide, config)).toBe(state)
  })

  it("keeps focus on the same window when an earlier column closes", () => {
    let state = withWindows([1, 2, 3])
    state = focusWindow(state, 3, wide, config)
    state = removeWindow(state, 1, wide, config)
    expect(focusedWindow(state)).toBe(3)
  })

  it("keeps focus in the column when a stacked sibling closes", () => {
    let state = withWindows([1, 2])
    state = consumeIntoColumn(state, wide, config)
    state = removeWindow(state, 2, wide, config)
    expect(focusedWindow(state)).toBe(1)
    expect(currentWorkspace(state).columns).toHaveLength(1)
  })

  it("drops a column when its last window closes", () => {
    let state = withWindows([1, 2])
    state = removeWindow(state, 1, wide, config)
    expect(currentWorkspace(state).columns).toHaveLength(1)
    expect(focusedWindow(state)).toBe(2)
  })

  it("survives removing every window", () => {
    let state = withWindows([1, 2])
    state = removeWindow(state, 1, wide, config)
    state = removeWindow(state, 2, wide, config)
    expect(allWindows(state)).toEqual([])
    expect(focusedWindow(state)).toBeNull()
    expect(layout(state, wide, config)).toEqual([])
    expect(state.workspaces).toHaveLength(1)
  })

  it("ignores removing a window it does not have", () => {
    const state = withWindows([1, 2])
    expect(removeWindow(state, 99, wide, config)).toBe(state)
  })

  it("finds a window across workspaces and stacks", () => {
    let state = withWindows([1, 2])
    state = consumeIntoColumn(state, wide, config)
    state = addWindow(state, 3, wide, config)
    state = moveToWorkspace(state, 1, wide, config)

    expect(findWindow(state, 1)).toEqual({ workspace: 0, column: 0, row: 0 })
    expect(findWindow(state, 2)).toEqual({ workspace: 0, column: 0, row: 1 })
    expect(findWindow(state, 99)).toBeNull()
  })
})

describe("focus movement", () => {
  it("stops at the ends rather than wrapping", () => {
    // Wrapping on an infinite strip teleports the viewport across the whole
    // strip, which is disorienting and expensive to animate.
    let state = withWindows([1, 2, 3])
    state = focusWindow(state, 1, wide, config)
    expect(focusedWindow(focusLeft(state, wide, config))).toBe(1)

    state = focusWindow(state, 3, wide, config)
    expect(focusedWindow(focusRight(state, wide, config))).toBe(3)
  })

  it("does nothing on an empty workspace", () => {
    expect(focusedWindow(focusLeft(EMPTY, wide, config))).toBeNull()
    expect(focusedWindow(focusUp(EMPTY))).toBeNull()
  })

  it("ignores focusing an unknown window", () => {
    const state = withWindows([1, 2])
    expect(focusWindow(state, 99, wide, config)).toBe(state)
  })

  it("follows a window across workspaces when focused by id", () => {
    let state = withWindows([1, 2])
    state = moveToWorkspace(state, 1, wide, config)
    state = focusWindow(state, 1, wide, config)
    expect(state.focus).toBe(0)
    expect(focusedWindow(state)).toBe(1)
  })
})

describe("viewport changes", () => {
  it("keeps windows, order and stacking across a resize", () => {
    let state = withWindows([1, 2, 3])
    state = consumeIntoColumn(state, wide, config)
    const before = currentWorkspace(state).columns.map((c) => c.windows)

    const narrower: Output = { width: 1000, height: 1080 }
    const after = reflow(state, narrower, config)
    expect(currentWorkspace(after).columns.map((c) => c.windows)).toEqual(before)
    expect(focusedWindow(after)).toBe(focusedWindow(state))
  })

  it("keeps the focused column visible after a resize", () => {
    const state = withWindows([1, 2, 3, 4])
    const narrower: Output = { width: 700, height: 1080 }
    const after = reflow(state, narrower, config)
    const ws = currentWorkspace(after)
    const x = columnX(ws.columns, ws.focus, narrower, config)
    expect(x - ws.viewOffset).toBeGreaterThanOrEqual(-1)
  })
})

describe("viewport intersection", () => {
  it("excludes columns entirely off screen", () => {
    // This is what bounds the encoder budget by viewport width rather than by
    // how many windows are open.
    const landscape = { width: 1261, height: 800 }
    expect(intersectsViewport({ x: -700, y: 0, width: 631, height: 100 }, landscape)).toBe(false)
    expect(intersectsViewport({ x: -25, y: 0, width: 631, height: 100 }, landscape)).toBe(true)
    expect(intersectsViewport({ x: 1300, y: 0, width: 631, height: 100 }, landscape)).toBe(false)

    // Portrait tests the other axis: the same rect is judged by y, not x.
    const portrait = { width: 800, height: 1261 }
    expect(intersectsViewport({ x: 0, y: -700, width: 100, height: 631 }, portrait)).toBe(false)
    expect(intersectsViewport({ x: 0, y: -25, width: 100, height: 631 }, portrait)).toBe(true)
    expect(intersectsViewport({ x: 0, y: 1300, width: 100, height: 631 }, portrait)).toBe(false)
  })
})

describe("purity", () => {
  it("never mutates the state it is given", () => {
    let state = withWindows([1, 2, 3])
    state = consumeIntoColumn(state, wide, config)
    const snapshot = JSON.stringify(state)

    addWindow(state, 4, wide, config)
    removeWindow(state, 1, wide, config)
    focusLeft(state, wide, config)
    focusUp(state)
    cycleWidth(state, wide, config)
    expelFromColumn(state, wide, config)
    moveToWorkspace(state, 1, wide, config)
    layout(state, wide, config)

    expect(JSON.stringify(state)).toBe(snapshot)
  })

  it("is deterministic", () => {
    // Same input, same output: this is what lets the local and remote backends
    // agree without coordinating.
    const a = layout(withWindows([1, 2, 3], nested), nested, config)
    const b = layout(withWindows([1, 2, 3], nested), nested, config)
    expect(a).toEqual(b)
  })
})
