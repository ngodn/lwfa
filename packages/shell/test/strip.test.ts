/**
 * Strip layout: columns, stacks, widths and workspaces.
 *
 * This is lwfa's layout policy and it is pure, so it can be tested properly
 * rather than eyeballed in a screenshot. Several cases pin behaviour that was
 * verified against the real compositor.
 */

import { describe, expect, it } from "vitest"
import type { WindowId } from "@lwfa/proto"
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
  fullscreenWindow,
  WIDTH_PRESETS,
  intersectsViewport,
  isFullscreen,
  layout,
  moveToWorkspace,
  presetWidth,
  reflow,
  removeWindow,
  stackedHeight,
  fillsOutput,
  fitsOnScreen,
  fittedWidth,
  isFitted,
  liveWindows,
  moveWindow,
  sendToWorkspace,
  setColumnLive,
  setColumnWidth,
  setFit,
  setFullscreen,
  streamList,
  stripBounds,
  toggleFullscreen,
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
    expect(intersectsViewport({ x: -700, y: 0, width: 631, height: 100 }, landscape, config)).toBe(false)
    expect(intersectsViewport({ x: -25, y: 0, width: 631, height: 100 }, landscape, config)).toBe(true)
    expect(intersectsViewport({ x: 1300, y: 0, width: 631, height: 100 }, landscape, config)).toBe(false)

    // Portrait tests the other axis: the same rect is judged by y, not x.
    const portrait = { width: 800, height: 1261 }
    expect(intersectsViewport({ x: 0, y: -700, width: 100, height: 631 }, portrait, config)).toBe(false)
    expect(intersectsViewport({ x: 0, y: -25, width: 100, height: 631 }, portrait, config)).toBe(true)
    expect(intersectsViewport({ x: 0, y: 1300, width: 100, height: 631 }, portrait, config)).toBe(false)
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

describe("fullscreen", () => {
  it("gives the focused window the whole output, with no gap", () => {
    const state = toggleFullscreen(withWindows([1, 2, 3]), wide, config)
    expect(isFullscreen(state)).toBe(true)

    const rects = layout(state, wide, config)
    expect(rects).toEqual([
      { id: 3, rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0 },
    ])
  })

  it("reaches 100%, which no width preset does", () => {
    // The complaint that prompted this: cycling widths tops out below the
    // viewport, because a column is a fraction of the strip and still sits
    // inside the gaps.
    const widest = presetWidth(3, wide, config)
    expect(widest).toBeLessThan(wide.width)

    const [only] = layout(toggleFullscreen(withWindows([1]), wide, config), wide, config)
    expect(only!.rect.width).toBe(wide.width)
    expect(only!.rect.height).toBe(wide.height)
  })

  it("hides everything else, rather than laying it out underneath", () => {
    const state = toggleFullscreen(withWindows([1, 2, 3]), wide, config)
    expect(layout(state, wide, config).map((w) => w.id)).toEqual([3])
  })

  it("toggles back to the strip it came from", () => {
    const strip = withWindows([1, 2, 3])
    const state = toggleFullscreen(toggleFullscreen(strip, wide, config), wide, config)
    expect(isFullscreen(state)).toBe(false)
    expect(layout(state, wide, config)).toEqual(layout(strip, wide, config))
  })

  it("drops out when focus moves, since nothing else is drawn", () => {
    // Leaving it set would look like the shell had frozen: focus would move
    // and the same single window would still be filling the screen.
    const state = focusLeft(toggleFullscreen(withWindows([1, 2, 3]), wide, config), wide, config)
    expect(isFullscreen(state)).toBe(false)
    expect(layout(state, wide, config).length).toBe(3)
  })

  it("drops out when the fullscreen window closes", () => {
    const state = removeWindow(
      toggleFullscreen(withWindows([1, 2]), wide, config),
      2,
      wide,
      config,
    )
    expect(isFullscreen(state)).toBe(false)
    expect(layout(state, wide, config).map((w) => w.id)).toEqual([1])
  })

  it("survives a trip to another workspace and back", () => {
    // Per workspace, not global: coming back to a fullscreen video should find
    // it as you left it.
    let state = toggleFullscreen(withWindows([1, 2]), wide, config)
    state = focusWorkspace(state, 1, wide, config)
    expect(isFullscreen(state)).toBe(false)
    state = focusWorkspace(state, -1, wide, config)
    expect(isFullscreen(state)).toBe(true)
  })

  it("does nothing on an empty workspace", () => {
    expect(toggleFullscreen(EMPTY, wide, config)).toBe(EMPTY)
  })

  it("follows the client viewport, whatever shape it is", () => {
    for (const output of [wide, nested, scrollable, { width: 390, height: 844 }]) {
      const [only] = layout(toggleFullscreen(withWindows([1], output), output, config), output, config)
      expect(only!.rect).toEqual({ x: 0, y: 0, width: output.width, height: output.height })
    }
  })

  it("names the window it is showing", () => {
    expect(fullscreenWindow(withWindows([1, 2]))).toBe(null)
    expect(fullscreenWindow(toggleFullscreen(withWindows([1, 2]), wide, config))).toBe(2)
  })
})

/**
 * The stream list: which windows this device asks the engine for pixels for.
 *
 * This is where both performance rules actually happen, so they are pinned
 * here. Pause-inactive keeps the list to the focused window; fullscreen works
 * because `layout` emits one window and nothing else, so the others are not
 * asked for and their share of the encoder budget goes to the one being
 * watched. No pause state is written anywhere in either round trip, which is
 * what makes resume automatic and unable to leak.
 */
/**
 * Windows 1, 3 and 2 stacked into a single column, in that order, focused on
 * the first. Built with the real transitions rather than as a literal, so the
 * cases below also prove the flag survives being moved around.
 */
function stackOfThree(): StripState {
  const apart = withWindows([1, 2, 3])
  const joined = moveWindow(apart, 3 as WindowId, { kind: "column", index: 0 }, wide, config)
  const all = moveWindow(joined, 2 as WindowId, { kind: "column", index: 0 }, wide, config)
  return focusWindow(all, 1 as WindowId, wide, config)
}

describe("streamList", () => {
  it("streams every visible window when pause-inactive is off", () => {
    const placed = layout(withWindows([1, 2]), wide, config)
    expect(streamList(placed, wide, config, 1 as WindowId, false, null)).toEqual([1, 2])
  })

  it("streams only the focused window when pause-inactive is on", () => {
    const placed = layout(withWindows([1, 2]), wide, config)
    expect(streamList(placed, wide, config, 1 as WindowId, true, null)).toEqual([1])
    expect(streamList(placed, wide, config, 2 as WindowId, true, null)).toEqual([2])
  })

  it("streams everything visible when nothing is focused yet", () => {
    // A session with no focus must not open on a wall of stills.
    const placed = layout(withWindows([1, 2]), wide, config)
    expect(streamList(placed, wide, config, null, true, null)).toEqual([1, 2])
  })

  it("does not ask for columns beyond the viewport", () => {
    const off = { id: 9 as WindowId, rect: { x: 2000, y: 8, width: 600, height: 1000 }, z: 1 }
    const on = { id: 1 as WindowId, rect: { x: 8, y: 8, width: 600, height: 1000 }, z: 0 }
    expect(streamList([on, off], wide, config, null, false, null)).toEqual([1])
    // Off screen beats focused: pixels for a window the viewport cannot show
    // are pixels wasted, whatever the focus says.
    expect(streamList([on, off], wide, config, 9 as WindowId, true, null)).toEqual([])
  })

  it("streams only the fullscreen window while one is up, and all of them after", () => {
    // Two windows, because both share the viewport at this width. Three do
    // not, and one being scrolled off is the other filter doing its job.
    const strip = withWindows([1, 2])
    const up = toggleFullscreen(strip, wide, config)
    expect(
      streamList(layout(up, wide, config), wide, config, null, false, fullscreenWindow(up)),
    ).toEqual([2])

    const down = toggleFullscreen(up, wide, config)
    expect(
      streamList(layout(down, wide, config), wide, config, null, false, fullscreenWindow(down)),
    ).toEqual([1, 2])
  })

  it("streams a live column's windows alongside the focused one", () => {
    const state = setColumnLive(stackOfThree(), 1 as WindowId, true)
    const placed = layout(state, wide, config)
    expect(
      streamList(placed, wide, config, 1 as WindowId, true, null, liveWindows(state)),
    ).toEqual([1, 3, 2])
  })

  it("still refuses a live window the viewport cannot show", () => {
    // The flag widens the *pause* rule and nothing else. Pixels for a column
    // scrolled off the strip are wasted however it is marked.
    const off = { id: 9 as WindowId, rect: { x: 2000, y: 8, width: 600, height: 1000 }, z: 1 }
    const on = { id: 1 as WindowId, rect: { x: 8, y: 8, width: 600, height: 1000 }, z: 0 }
    expect(
      streamList([on, off], wide, config, 1 as WindowId, true, null, [1, 9] as WindowId[]),
    ).toEqual([1])
  })

  it("cannot narrow what the global setting already streams", () => {
    // Passing a live list while the pause is off must not turn the list into
    // "only these". The flag has one direction.
    const placed = layout(withWindows([1, 2]), wide, config)
    expect(
      streamList(placed, wide, config, 1 as WindowId, false, null, [1] as WindowId[]),
    ).toEqual([1, 2])
  })

  it("always streams the fullscreen window, whatever focus says", () => {
    // The fullscreen window is the only one in the layout; anything that
    // dropped it from the list would freeze the entire screen.
    const up = toggleFullscreen(withWindows([1, 2]), wide, config)
    expect(
      streamList(
        layout(up, wide, config),
        wide,
        config,
        1 as WindowId,
        true,
        fullscreenWindow(up),
      ),
    ).toEqual([2])
  })
})

/**
 * A fullscreen window kept its rounded corners and its focus ring, so the
 * desktop showed through four corners of something meant to be edge to edge.
 * The window was never told it was fullscreen; the fix asks geometrically.
 */
describe("fillsOutput", () => {
  const out: Output = { width: 1920, height: 1080 }

  it("is true for a window covering the whole output", () => {
    expect(fillsOutput({ x: 0, y: 0, width: 1920, height: 1080 }, out)).toBe(true)
  })

  it("is true a pixel over, since rects are rounded on the way here", () => {
    expect(fillsOutput({ x: 0, y: 0, width: 1921, height: 1081 }, out)).toBe(true)
  })

  it("is false while any of the strip is still visible", () => {
    // The widest preset still leaves gaps, so it stays a card and keeps its
    // corners. This is the case the fix must not sweep up.
    expect(fillsOutput({ x: 12, y: 12, width: 1896, height: 1056 }, out)).toBe(false)
    expect(fillsOutput({ x: 0, y: 0, width: 1919, height: 1080 }, out)).toBe(false)
    expect(fillsOutput({ x: 0, y: 0, width: 1920, height: 1079 }, out)).toBe(false)
  })

  it("is false for a full-size window scrolled off the origin", () => {
    expect(fillsOutput({ x: 40, y: 0, width: 1920, height: 1080 }, out)).toBe(false)
  })

  it("agrees with the layout fullscreen actually produces", () => {
    // Pinned against the real thing, so a change to how fullscreen lays out
    // cannot silently stop matching.
    const state = toggleFullscreen(withWindows([1, 2], out), out, config)
    const placed = layout(state, out, config)
    expect(placed).toHaveLength(1)
    expect(fillsOutput(placed[0]!.rect, out)).toBe(true)
  })

  it("says no for every window in an ordinary strip", () => {
    const placed = layout(withWindows([1, 2, 3], out), out, config)
    expect(placed.length).toBeGreaterThan(1)
    for (const w of placed) expect(fillsOutput(w.rect, out)).toBe(false)
  })
})

/**
 * Arrange mode has to show the whole strip, and under scrollable tiling the
 * strip is not the viewport: columns run off both ends. Rearranging a desktop
 * you can only see part of is the problem the mode exists to solve, so getting
 * this box wrong makes the whole thing pointless.
 */
describe("stripBounds", () => {
  const out: Output = { width: 1000, height: 800 }

  it("is the output when there is nothing placed", () => {
    expect(stripBounds([], out)).toEqual({ x: 0, y: 0, width: 1000, height: 800 })
  })

  it("never shrinks below the output", () => {
    // One narrow window must not scale up to fill the screen.
    const placed = [{ id: 1 as WindowId, rect: { x: 10, y: 10, width: 100, height: 80 }, z: 0 }]
    expect(stripBounds(placed, out)).toEqual({ x: 0, y: 0, width: 1000, height: 800 })
  })

  it("reaches past the right edge to include a column off-screen", () => {
    const placed = [
      { id: 1 as WindowId, rect: { x: 0, y: 0, width: 600, height: 800 }, z: 0 },
      { id: 2 as WindowId, rect: { x: 620, y: 0, width: 600, height: 800 }, z: 1 },
    ]
    expect(stripBounds(placed, out)).toMatchObject({ x: 0, width: 1220 })
  })

  it("reaches past the left edge for a column scrolled off the start", () => {
    // Negative x is normal here: the strip scrolls, so the focused column sits
    // at the centre and its neighbours run off behind the origin.
    const placed = [
      { id: 1 as WindowId, rect: { x: -400, y: 0, width: 600, height: 800 }, z: 0 },
      { id: 2 as WindowId, rect: { x: 220, y: 0, width: 600, height: 800 }, z: 1 },
    ]
    // Width is 1400, not 1220: the right edge is the output's, since the
    // output is always included and reaches further than the last column.
    expect(stripBounds(placed, out)).toEqual({ x: -400, y: 0, width: 1400, height: 800 })
  })

  it("covers a real strip of five windows completely", () => {
    // Pinned against the actual layout rather than hand-written rects, so a
    // change to how columns are placed cannot silently leave one outside.
    const placed = layout(withWindows([1, 2, 3, 4, 5], out), out, config)
    const bounds = stripBounds(placed, out)
    for (const w of placed) {
      expect(w.rect.x).toBeGreaterThanOrEqual(bounds.x)
      expect(w.rect.y).toBeGreaterThanOrEqual(bounds.y)
      expect(w.rect.x + w.rect.width).toBeLessThanOrEqual(bounds.x + bounds.width)
      expect(w.rect.y + w.rect.height).toBeLessThanOrEqual(bounds.y + bounds.height)
    }
  })
})

/**
 * Moving a window somewhere chosen, which is what a drag does.
 *
 * `consumeIntoColumn` and `expelFromColumn` move the focused window one step in
 * a fixed direction, which is right for a keyboard and useless for a pointer
 * that already knows where it is going. Expressing a drag as a run of those
 * would flash intermediate arrangements and could not say "third row of that
 * column" at all.
 */
describe("moveWindow", () => {
  const out: Output = { width: 1200, height: 800 }
  const columnsOf = (s: StripState) => currentWorkspace(s).columns.map((c) => c.windows)

  it("joins an existing column", () => {
    const state = withWindows([1, 2, 3], out)
    const moved = moveWindow(state, 3 as WindowId, { kind: "column", index: 0 }, out, config)
    expect(columnsOf(moved)).toEqual([[1, 3], [2]])
  })

  it("puts it in the row asked for, not just at the end", () => {
    const state = moveWindow(
      withWindows([1, 2, 3], out),
      3 as WindowId,
      { kind: "column", index: 0, row: 0 },
      out,
      config,
    )
    expect(columnsOf(state)).toEqual([[3, 1], [2]])
  })

  it("gives it a column of its own at the index asked for", () => {
    const state = withWindows([1, 2, 3], out)
    const moved = moveWindow(state, 3 as WindowId, { kind: "newColumn", index: 0 }, out, config)
    expect(columnsOf(moved)).toEqual([[3], [1], [2]])
  })

  it("closes up the column it left", () => {
    // Two columns, the second holding only window 2. Moving 2 away must not
    // leave an empty column behind, which would show as a gap you cannot fill.
    const state = moveWindow(
      withWindows([1, 2], out),
      2 as WindowId,
      { kind: "column", index: 0 },
      out,
      config,
    )
    expect(columnsOf(state)).toEqual([[1, 2]])
  })

  it("indexes the target against the strip after the gap has closed", () => {
    // The off-by-one this design exists to avoid. Window 1 is alone in column
    // 0; dropping it after column 1 must land it last, not back where it was.
    const state = withWindows([1, 2, 3], out)
    const moved = moveWindow(state, 1 as WindowId, { kind: "newColumn", index: 2 }, out, config)
    expect(columnsOf(moved)).toEqual([[2], [3], [1]])
  })

  it("keeps focus on the window that moved", () => {
    const moved = moveWindow(
      withWindows([1, 2, 3], out),
      1 as WindowId,
      { kind: "column", index: 1 },
      out,
      config,
    )
    expect(focusedWindow(moved)).toBe(1)
  })

  it("does not lose a window dropped onto the column it was alone in", () => {
    // Lifting it out empties that column, so the target no longer exists.
    // Naively indexing into the emptied list would drop the window entirely.
    const state = withWindows([1], out)
    const moved = moveWindow(state, 1 as WindowId, { kind: "column", index: 0 }, out, config)
    expect(columnsOf(moved)).toEqual([[1]])
    expect(allWindows(moved)).toEqual([1])
  })

  it("never loses or duplicates a window, wherever it is dropped", () => {
    const state = withWindows([1, 2, 3, 4], out)
    const targets = [
      { kind: "column", index: 0 },
      { kind: "column", index: 2, row: 0 },
      { kind: "newColumn", index: 0 },
      { kind: "newColumn", index: 99 },
      { kind: "column", index: 99 },
    ] as const
    for (const target of targets) {
      const moved = moveWindow(state, 2 as WindowId, target, out, config)
      expect(allWindows(moved).sort()).toEqual([1, 2, 3, 4])
    }
  })

  it("ignores a window that is not there", () => {
    const state = withWindows([1, 2], out)
    expect(moveWindow(state, 99 as WindowId, { kind: "column", index: 0 }, out, config)).toBe(state)
  })

  it("drops fullscreen, since the result would otherwise be invisible", () => {
    const state = toggleFullscreen(withWindows([1, 2], out), out, config)
    expect(isFullscreen(state)).toBe(true)
    const moved = moveWindow(state, 1 as WindowId, { kind: "column", index: 0 }, out, config)
    expect(isFullscreen(moved)).toBe(false)
  })

  it("keeps the width of the column it came from", () => {
    // A window pulled out of a half-width column should not snap to a third.
    let state = withWindows([1, 2], out)
    state = cycleWidth(state, out, config)
    const width = currentWorkspace(state).columns[currentWorkspace(state).focus]!.width
    const moved = moveWindow(state, focusedWindow(state)!, { kind: "newColumn", index: 0 }, out, config)
    expect(currentWorkspace(moved).columns[0]!.width).toBe(width)
  })
})

/**
 * Dragging a window onto a workspace chip.
 *
 * Deliberately not the same as the keyboard's `moveToWorkspace`: that follows
 * the window, because a keyboard has no other way to show you what happened.
 * A drag is the opposite. You are tidying, and being thrown onto another
 * workspace on every flick turns organising three windows into three journeys
 * back.
 */
describe("sendToWorkspace", () => {
  const out: Output = { width: 1200, height: 800 }

  /** Just the workspace being looked at, since `allWindows` spans all of them. */
  const here = (s: StripState, at = s.focus) =>
    s.workspaces[at]!.columns.flatMap((c) => c.windows)

  it("moves the named window, not the focused one", () => {
    const state = withWindows([1, 2, 3], out)
    expect(focusedWindow(state)).toBe(3)
    const moved = sendToWorkspace(state, 1 as WindowId, 1, out, config)
    expect(here(moved, 0)).not.toContain(1)
    expect(here(moved, 1)).toContain(1)
  })

  it("leaves you on the workspace you were arranging", () => {
    const state = withWindows([1, 2], out)
    const moved = sendToWorkspace(state, 1 as WindowId, 1, out, config)
    expect(moved.focus).toBe(0)
    expect(here(moved)).toEqual([2])
  })

  it("does nothing sending a window where it already is", () => {
    const state = withWindows([1, 2], out)
    expect(sendToWorkspace(state, 1 as WindowId, 0, out, config)).toBe(state)
  })

  it("ignores a window that does not exist", () => {
    const state = withWindows([1], out)
    expect(sendToWorkspace(state, 99 as WindowId, 1, out, config)).toBe(state)
  })

  it("never loses the window", () => {
    const state = withWindows([1, 2, 3], out)
    for (const target of [0, 1, 5, -1]) {
      const moved = sendToWorkspace(state, 2 as WindowId, target, out, config)
      const everywhere = moved.workspaces.flatMap((ws) => ws.columns.flatMap((c) => c.windows))
      expect(everywhere.sort()).toEqual([1, 2, 3])
    }
  })

  it("keeps you looking at the same windows when workspaces renumber", () => {
    // Workspaces are dynamic: emptying one drops it and the rest shift down.
    // Holding the old index would silently land you somewhere else, so the
    // check is on what you can see, not on the number.
    let state = withWindows([1], out)
    state = focusWorkspace(state, 1, out, config)
    state = addWindow(state, 2 as WindowId, out, config)
    const before = here(state)
    // Pull window 1 over from the workspace that then becomes empty.
    const moved = sendToWorkspace(state, 1 as WindowId, state.focus, out, config)
    expect(here(moved)).toEqual([...before, 1])
  })
})

/**
 * Fitting the columns to the screen.
 *
 * The strip could always *express* a grid, since a column of windows is a row
 * of cells, but it could not hold one: the width presets are fractions of the
 * whole viewport and ignore the gaps, so two halves overflow and the strip
 * scrolls, and centring then slides the arrangement about on every focus
 * change. These pin both halves of the fix.
 */
describe("fitting to the screen", () => {
  it("divides the viewport exactly, gaps included", () => {
    // The arithmetic the presets do not do. Three columns and the four gaps
    // around and between them must add up to the viewport itself.
    for (const count of [1, 2, 3, 4]) {
      const width = fittedWidth(count, wide, config)
      const total = config.gap * (count + 1) + width * count
      expect(total).toBeLessThanOrEqual(wide.width)
      // Within a pixel per column, which is all the flooring can cost.
      expect(total).toBeGreaterThan(wide.width - count - 1)
    }
  })

  it("lays four windows out as quadrants", () => {
    // The case this exists for: four videos at once. Two columns of two.
    const apart = withWindows([1, 2, 3, 4])
    const left = moveWindow(apart, 3 as WindowId, { kind: "column", index: 0 }, wide, config)
    const pairs = moveWindow(left, 4 as WindowId, { kind: "column", index: 1 }, wide, config)
    const grid = setFit(pairs, true, wide, config)

    const placed = layout(grid, wide, config)
    expect(placed).toHaveLength(4)

    // Two distinct columns and two distinct rows, and nothing off screen.
    const xs = [...new Set(placed.map((w) => w.rect.x))].sort((a, b) => a - b)
    const ys = [...new Set(placed.map((w) => w.rect.y))].sort((a, b) => a - b)
    expect(xs).toHaveLength(2)
    expect(ys).toHaveLength(2)
    for (const { rect } of placed) {
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.y).toBeGreaterThanOrEqual(0)
      expect(rect.x + rect.width).toBeLessThanOrEqual(wide.width)
      expect(rect.y + rect.height).toBeLessThanOrEqual(wide.height)
    }
    // Each one really is about a quarter of the screen, not a sliver.
    for (const { rect } of placed) {
      expect(rect.width).toBeGreaterThan(wide.width / 2 - 3 * config.gap)
      expect(rect.height).toBeGreaterThan(wide.height / 2 - 3 * config.gap)
    }
  })

  it("fits along the axis the strip actually runs on", () => {
    // Portrait, so the strip is a stack of rows and "fitting" is about
    // height. Measuring the wrong axis here would give every window a sliver
    // of a tall screen on the device this is mostly used from.
    const portrait: Output = { width: 834, height: 1194 }
    const state = setFit(withWindows([1, 2], portrait), true, portrait, config)
    const placed = layout(state, portrait, config)

    expect(placed).toHaveLength(2)
    // Two rows, one column: they differ in y and share x and width.
    expect(new Set(placed.map((w) => w.rect.x)).size).toBe(1)
    expect(new Set(placed.map((w) => w.rect.y)).size).toBe(2)
    for (const { rect } of placed) {
      expect(rect.x + rect.width).toBeLessThanOrEqual(portrait.width)
      expect(rect.y + rect.height).toBeLessThanOrEqual(portrait.height)
      // Each takes about half the height, which is what fitting the long
      // axis means here.
      expect(rect.height).toBeGreaterThan(portrait.height / 2 - 3 * config.gap)
    }
    expect(currentWorkspace(state).viewOffset).toBe(0)
  })

  it("does not scroll, whatever has focus", () => {
    // The other half of the fix. Centring would slide a grid that is meant to
    // stay still every time a different video was clicked.
    const three = setFit(withWindows([1, 2, 3]), true, wide, config)
    expect(currentWorkspace(three).viewOffset).toBe(0)
    const moved = focusWindow(three, 1 as WindowId, wide, config)
    expect(currentWorkspace(moved).viewOffset).toBe(0)
    expect(layout(moved, wide, config)[0]!.rect.x).toBe(config.gap)
  })

  it("keeps the columns usable when too many are open to fit", () => {
    // Twenty columns on a 1920 screen is 84px each. Rather than slivers, they
    // floor at `minWidth` and the strip goes back to scrolling, which is a
    // worse fit but still a usable desktop.
    const many = Array.from({ length: 20 }, (_, i) => i + 1)
    const state = setFit(withWindows(many), true, wide, config)
    expect(fitsOnScreen(20, wide, config)).toBe(false)
    expect(fittedWidth(20, wide, config)).toBe(config.minWidth)
    // Scrolling is back, so the focused column can still be reached.
    expect(currentWorkspace(state).viewOffset).not.toBe(0)
  })

  it("streams everything in the fitted workspace", () => {
    const apart = withWindows([1, 2])
    const grid = setFit(apart, true, wide, config)
    expect(liveWindows(grid)).toEqual([1, 2])
    expect(
      streamList(
        layout(grid, wide, config),
        wide,
        config,
        1 as WindowId,
        true,
        null,
        liveWindows(grid),
      ),
    ).toEqual([1, 2])
  })

  it("drops out of fullscreen on the way in", () => {
    // `layout` short-circuits on fullscreen, so fitting under one would do
    // nothing at all and look like the button was broken.
    const up = toggleFullscreen(withWindows([1, 2]), wide, config)
    expect(isFullscreen(up)).toBe(true)
    const grid = setFit(up, true, wide, config)
    expect(isFullscreen(grid)).toBe(false)
    expect(isFitted(grid)).toBe(true)
    expect(layout(grid, wide, config)).toHaveLength(2)
  })

  it("gives the columns their own widths back on the way out", () => {
    const state = withWindows([1, 2])
    const before = layout(state, wide, config)
    const after = layout(setFit(setFit(state, true, wide, config), false, wide, config), wide, config)
    expect(after).toEqual(before)
  })

  it("is the same state when it is already what was asked for", () => {
    const state = withWindows([1])
    expect(setFit(state, false, wide, config)).toBe(state)
    const fitted = setFit(state, true, wide, config)
    expect(setFit(fitted, true, wide, config)).toBe(fitted)
  })

  it("is per workspace", () => {
    // A video wall on one workspace must not turn the next one into a grid.
    const state = setFit(withWindows([1]), true, wide, config)
    const moved = moveToWorkspace(state, 1, wide, config)
    expect(isFitted(moved)).toBe(false)
  })
})

/**
 * Streaming a whole column instead of only its focused window.
 *
 * A column shows its windows side by side, so freezing all but one of them is
 * the one place the global pause is visibly wrong. The flag is per column and
 * only ever widens the stream list; the bound that makes it affordable is that
 * only the *focused* column's flag counts, so no amount of marking can cost
 * more than the tallest stack.
 */
describe("liveWindows", () => {
  it("is empty for a column nobody marked", () => {
    expect(liveWindows(stackOfThree())).toEqual([])
  })

  it("is the whole column once it is marked", () => {
    const live = setColumnLive(stackOfThree(), 3 as WindowId, true)
    expect(liveWindows(live)).toEqual([1, 3, 2])
  })

  it("is empty again when focus leaves that column", () => {
    // The bound. A marked column that is not focused costs nothing, which is
    // what stops the flag accumulating into "stream everything".
    const apart = withWindows([1, 2, 3])
    const stacked = moveWindow(apart, 2 as WindowId, { kind: "column", index: 0 }, wide, config)
    const live = setColumnLive(stacked, 1 as WindowId, true)
    expect(liveWindows(live)).toEqual([1, 2])
    expect(liveWindows(focusWindow(live, 3 as WindowId, wide, config))).toEqual([])
  })

  it("ignores the flag on a column of one", () => {
    // Otherwise this would be a way to keep one named window awake for the
    // whole session, which is the per-window pause control that was removed.
    const live = setColumnLive(withWindows([1, 2]), 1 as WindowId, true)
    expect(liveWindows(focusWindow(live, 1 as WindowId, wide, config))).toEqual([])
  })

  it("is empty on an empty workspace", () => {
    expect(liveWindows(EMPTY)).toEqual([])
  })
})

describe("setColumnLive", () => {
  it("acts on the named window's column, not the focused one", () => {
    const apart = withWindows([1, 2, 3])
    const stacked = moveWindow(apart, 2 as WindowId, { kind: "column", index: 0 }, wide, config)
    const focused = focusWindow(stacked, 3 as WindowId, wide, config)
    const live = setColumnLive(focused, 1 as WindowId, true)

    expect(currentWorkspace(live).columns[0]!.live).toBe(true)
    expect(currentWorkspace(live).columns[1]!.live).toBeUndefined()
  })

  it("does not move focus", () => {
    const state = stackOfThree()
    expect(focusedWindow(setColumnLive(state, 2 as WindowId, true))).toBe(
      focusedWindow(state),
    )
  })

  it("is the same state when nothing would change", () => {
    // Identity is what callers use to decide whether to re-push, so a toggle
    // pressed twice must not send two identical layouts.
    const state = stackOfThree()
    expect(setColumnLive(state, 1 as WindowId, false)).toBe(state)
    const live = setColumnLive(state, 1 as WindowId, true)
    expect(setColumnLive(live, 1 as WindowId, true)).toBe(live)
  })

  it("ignores a window that is not there", () => {
    const state = stackOfThree()
    expect(setColumnLive(state, 99 as WindowId, true)).toBe(state)
  })

  it("survives the column being resized and restacked", () => {
    // The flag belongs to the column, like its width, so the operations that
    // rebuild a column must carry it rather than quietly dropping it.
    const live = setColumnLive(stackOfThree(), 1 as WindowId, true)
    const wider = setColumnWidth(live, 1 as WindowId, 0, wide, config)
    expect(liveWindows(wider)).toEqual([1, 3, 2])

    // Expelling one leaves the remainder marked, and the window that left in
    // a column of its own that is not.
    const expelled = expelFromColumn(
      focusWindow(wider, 3 as WindowId, wide, config),
      wide,
      config,
    )
    expect(currentWorkspace(expelled).columns[0]!.live).toBe(true)
    expect(currentWorkspace(expelled).columns[1]!.live).toBeUndefined()
  })
})

/**
 * Choosing a width, rather than stepping to one.
 *
 * The panel offers the presets as four buttons, so it has a destination.
 * Reaching it with `cycleWidth` would push a layout per step and animate the
 * column through every width in between on the way to the one asked for.
 */
describe("setColumnWidth", () => {
  const out: Output = { width: 1200, height: 800 }
  const widthOf = (s: StripState, column = currentWorkspace(s).focus) =>
    currentWorkspace(s).columns[column]!.width

  it("goes straight to the preset asked for", () => {
    const state = withWindows([1, 2], out)
    expect(widthOf(setColumnWidth(state, 2 as WindowId, 3, out, config))).toBe(3)
    expect(widthOf(setColumnWidth(state, 2 as WindowId, 0, out, config))).toBe(0)
  })

  it("acts on the named window's column, not the focused one", () => {
    const state = withWindows([1, 2], out)
    expect(focusedWindow(state)).toBe(2)
    const moved = setColumnWidth(state, 1 as WindowId, 3, out, config)
    expect(widthOf(moved, 0)).toBe(3)
    // And the focused column is left alone.
    expect(widthOf(moved, 1)).toBe(widthOf(state, 1))
  })

  it("does not move focus", () => {
    const state = withWindows([1, 2], out)
    expect(focusedWindow(setColumnWidth(state, 1 as WindowId, 3, out, config))).toBe(2)
  })

  it("is a no-op at the width it already has", () => {
    const state = withWindows([1], out)
    const width = widthOf(state)
    expect(setColumnWidth(state, 1 as WindowId, width, out, config)).toBe(state)
  })

  it("clamps a preset off either end", () => {
    const state = withWindows([1], out)
    expect(widthOf(setColumnWidth(state, 1 as WindowId, 99, out, config))).toBe(
      WIDTH_PRESETS.length - 1,
    )
    expect(widthOf(setColumnWidth(state, 1 as WindowId, -5, out, config))).toBe(0)
  })

  it("ignores a window that is not there", () => {
    const state = withWindows([1], out)
    expect(setColumnWidth(state, 99 as WindowId, 2, out, config)).toBe(state)
  })
})

/**
 * A client asking to be fullscreen: the button inside a video player.
 *
 * The engine forwards it because the arrangement is decided here, and a window
 * the engine put fullscreen alone would be moved straight back to its column
 * width by the next layout.
 */
describe("setFullscreen", () => {
  const out: Output = { width: 1200, height: 800 }

  it("puts the named window fullscreen", () => {
    const state = setFullscreen(withWindows([1, 2], out), 1 as WindowId, true, out, config)
    expect(isFullscreen(state)).toBe(true)
    expect(layout(state, out, config)).toHaveLength(1)
    expect(layout(state, out, config)[0]!.id).toBe(1)
  })

  it("focuses it as well", () => {
    // A video filling the screen without the keyboard cannot be paused with
    // the space bar, which is the first thing anybody tries.
    const state = setFullscreen(withWindows([1, 2], out), 1 as WindowId, true, out, config)
    expect(focusedWindow(state)).toBe(1)
  })

  it("is not a toggle", () => {
    // A player asking to enter fullscreen while already fullscreen must stay
    // fullscreen. Treating the request as a toggle would drop it out.
    let state = setFullscreen(withWindows([1, 2], out), 1 as WindowId, true, out, config)
    state = setFullscreen(state, 1 as WindowId, true, out, config)
    expect(isFullscreen(state)).toBe(true)
  })

  it("leaves fullscreen when asked to", () => {
    let state = setFullscreen(withWindows([1, 2], out), 1 as WindowId, true, out, config)
    state = setFullscreen(state, 1 as WindowId, false, out, config)
    expect(isFullscreen(state)).toBe(false)
  })

  it("ignores a window asking to leave that was not the one fullscreen", () => {
    // Two players, one fullscreen: the other one exiting must not drop it.
    let state = setFullscreen(withWindows([1, 2], out), 1 as WindowId, true, out, config)
    state = setFullscreen(state, 2 as WindowId, false, out, config)
    expect(isFullscreen(state)).toBe(true)
  })

  it("ignores a window that is not here", () => {
    const state = withWindows([1], out)
    expect(setFullscreen(state, 99 as WindowId, true, out, config)).toBe(state)
  })
})
