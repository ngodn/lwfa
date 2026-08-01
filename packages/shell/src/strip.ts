/**
 * The scrollable strip.
 *
 * lwfa's layout policy, following niri. Three nested levels:
 *
 * - **Workspaces** stack vertically. Each has its own strip.
 * - **Columns** sit on an infinite horizontal strip within a workspace.
 * - **Windows** stack vertically inside a column.
 *
 * Only the focused workspace is laid out. Everything else is simply absent from
 * the result, and because `SetLayout` is *total* the engine hides whatever it is
 * not told about. Workspaces therefore need no protocol support at all: they
 * fall out of a decision made back in milestone 3.
 *
 * # Everything here is a pure function
 *
 * No DOM, no clock, no `WebSocket`. State in, target geometry out. That matters
 * for three reasons:
 *
 * 1. The same code must produce the same layout under the local backend and the
 *    remote one, or the desktop looks different depending on where you sit.
 * 2. It is testable without a compositor or a browser.
 * 3. It can move to a worker later without restructuring.
 *
 * When text measurement arrives (window titles in an overview), it goes through
 * PreTeXt.js for the same reason: `getBoundingClientRect` would make this impure
 * and force a reflow per frame.
 *
 * # This module never animates
 *
 * It computes *target* geometry only. The engine integrates the springs at its
 * own refresh rate from parameters sent alongside. A shell that animated by
 * sending a rect per frame would bake its own scheduling jitter into the motion
 * and look different locally and remotely.
 */

import type { Rect, WindowId, WindowLayout } from "@lwfa/proto"

export interface Output {
  width: number
  height: number
}

// Layout defaults come from configs/defaults.toml, via a generated module, so
// the engine and the shell cannot disagree about them. See scripts/gen-config.mjs.
export { WIDTH_PRESETS } from "./generated/config.ts"
import { DEFAULT_WIDTH, GAP, MIN_WIDTH, WIDTH_PRESETS } from "./generated/config.ts"

export type WidthPreset = 0 | 1 | 2

export interface StripConfig {
  /** Gap between columns, between stacked windows, and at the output edge. */
  gap: number
  /** Which preset a new column gets. */
  defaultWidth: WidthPreset
  /** Floor on column width, so a phone-width viewport stays usable. */
  minWidth: number
}

export const DEFAULT_CONFIG: StripConfig = {
  gap: GAP,
  defaultWidth: DEFAULT_WIDTH as WidthPreset,
  minWidth: MIN_WIDTH,
}

/** A vertical stack of windows sharing one slot on the strip. */
export interface Column {
  windows: WindowId[]
  /** Index into `windows`. Clamped by every operation here. */
  focus: number
  width: WidthPreset
}

export interface Workspace {
  columns: Column[]
  /** Index into `columns`. */
  focus: number
  /**
   * How far this workspace has scrolled right, in logical pixels.
   *
   * Always a *target*. The engine holds in-between values while a spring runs;
   * this never holds a partially-scrolled position. Kept per workspace so
   * switching away and back returns you where you were.
   */
  viewOffset: number
}

export interface StripState {
  workspaces: Workspace[]
  /** Index into `workspaces`. */
  focus: number
}

const emptyWorkspace = (): Workspace => ({ columns: [], focus: 0, viewOffset: 0 })

/**
 * Workspaces are dynamic, niri-style: there is always exactly one empty one at
 * the end, so a new workspace is always one move away and none linger empty.
 */
export const EMPTY: StripState = { workspaces: [emptyWorkspace()], focus: 0 }

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.min(Math.max(index, 0), length - 1)
}

export function presetWidth(
  preset: WidthPreset,
  output: Output,
  config: StripConfig,
): number {
  return Math.max(Math.round(output.width * WIDTH_PRESETS[preset]!), config.minWidth)
}

export function columnWidth(column: Column, output: Output, config: StripConfig): number {
  return presetWidth(column.width, output, config)
}

/** Height available to a column, before any internal stacking. */
export function columnHeight(output: Output, config: StripConfig): number {
  return Math.max(output.height - config.gap * 2, 1)
}

/**
 * Height of each window in a column of `count` windows.
 *
 * Equal shares. niri allows per-window heights; that is a refinement and, like
 * column widths, every change is a `configure`, so equal shares keep it rare.
 */
export function stackedHeight(count: number, output: Output, config: StripConfig): number {
  if (count <= 1) return columnHeight(output, config)
  const available = columnHeight(output, config) - config.gap * (count - 1)
  return Math.max(Math.floor(available / count), 1)
}

/** Absolute x of column `index`, before the view offset. Widths vary per column. */
export function columnX(
  columns: Column[],
  index: number,
  output: Output,
  config: StripConfig,
): number {
  let x = config.gap
  for (let i = 0; i < index && i < columns.length; i++) {
    x += columnWidth(columns[i]!, output, config) + config.gap
  }
  return x
}

export function currentWorkspace(state: StripState): Workspace {
  return state.workspaces[clampIndex(state.focus, state.workspaces.length)] ?? emptyWorkspace()
}

/**
 * Where the viewport should sit for the focused column to be fully visible,
 * scrolling the minimum distance to get there.
 *
 * A column already fully in view does not move, which is what makes focusing a
 * neighbour feel like a nudge rather than a re-centre.
 */
export function targetOffset(state: StripState, output: Output, config: StripConfig): number {
  const ws = currentWorkspace(state)
  if (ws.columns.length === 0) return 0

  const index = clampIndex(ws.focus, ws.columns.length)
  const column = ws.columns[index]!
  const left = columnX(ws.columns, index, output, config) - config.gap
  const right = left + columnWidth(column, output, config) + config.gap * 2

  // Wider than the viewport: pin the left edge, since no offset shows all of it.
  if (right - left >= output.width) return left
  if (left < ws.viewOffset) return left
  if (right > ws.viewOffset + output.width) return right - output.width
  return ws.viewOffset
}

/**
 * Target geometry for the focused workspace.
 *
 * Windows on other workspaces are omitted entirely. `SetLayout` is total, so the
 * engine hides them, which is exactly what switching workspaces should do.
 */
export function layout(state: StripState, output: Output, config: StripConfig): WindowLayout[] {
  const ws = currentWorkspace(state)
  const offset = ws.viewOffset
  const out: WindowLayout[] = []
  let z = 0

  ws.columns.forEach((column, index) => {
    const width = columnWidth(column, output, config)
    const x = columnX(ws.columns, index, output, config) - offset
    const height = stackedHeight(column.windows.length, output, config)

    column.windows.forEach((id, row) => {
      const rect: Rect = {
        x,
        y: config.gap + row * (height + config.gap),
        width,
        height,
      }
      out.push({ id, rect, z: z++ })
    })
  })

  return out
}

/** Does this column intersect the viewport, and so deserve pixels? */
export function intersectsViewport(rect: Rect, viewportWidth: number): boolean {
  return rect.x + rect.width > 0 && rect.x < viewportWidth
}

// ---------------------------------------------------------------------------
// Transitions
//
// All pure. Each returns a new state and re-derives the view offset, so focus
// and offset can never disagree.
// ---------------------------------------------------------------------------

function withWorkspace(
  state: StripState,
  fn: (ws: Workspace) => Workspace,
): StripState {
  const index = clampIndex(state.focus, state.workspaces.length)
  const workspaces = state.workspaces.map((ws, i) => (i === index ? fn(ws) : ws))
  return { ...state, workspaces }
}

/**
 * Keep exactly one trailing empty workspace, and drop any others.
 *
 * Without this, closing the last window on a middle workspace leaves a hole you
 * have to scroll past forever.
 */
function normaliseWorkspaces(state: StripState): StripState {
  const nonEmpty = state.workspaces.filter((ws) => ws.columns.length > 0)
  const focused = state.workspaces[clampIndex(state.focus, state.workspaces.length)]

  const workspaces = [...nonEmpty, emptyWorkspace()]
  // Follow the workspace that had focus, if it survived; otherwise clamp.
  const kept = focused && focused.columns.length > 0 ? nonEmpty.indexOf(focused) : -1
  const focus = kept >= 0 ? kept : clampIndex(state.focus, workspaces.length)
  return { workspaces, focus: clampIndex(focus, workspaces.length) }
}

export function scrollFocusIntoView(
  state: StripState,
  output: Output,
  config: StripConfig,
): StripState {
  const offset = targetOffset(state, output, config)
  return withWorkspace(state, (ws) => ({ ...ws, viewOffset: offset }))
}

function settle(state: StripState, output: Output, config: StripConfig): StripState {
  return scrollFocusIntoView(normaliseWorkspaces(state), output, config)
}

/**
 * Add a window as a new column, immediately right of the focused one.
 *
 * niri inserts adjacent rather than appending, so a window you open while
 * reading something lands next to it instead of at the far end of the strip.
 */
export function addWindow(
  state: StripState,
  id: WindowId,
  output: Output,
  config: StripConfig,
): StripState {
  if (findWindow(state, id)) return state

  const next = withWorkspace(state, (ws) => {
    const at = ws.columns.length === 0 ? 0 : clampIndex(ws.focus, ws.columns.length) + 1
    const columns = [...ws.columns]
    columns.splice(at, 0, { windows: [id], focus: 0, width: config.defaultWidth })
    return { ...ws, columns, focus: at }
  })
  return settle(next, output, config)
}

export function removeWindow(
  state: StripState,
  id: WindowId,
  output: Output,
  config: StripConfig,
): StripState {
  const found = findWindow(state, id)
  if (!found) return state

  const workspaces = state.workspaces.map((ws, wsIndex) => {
    if (wsIndex !== found.workspace) return ws

    const columns = ws.columns
      .map((column, colIndex) => {
        if (colIndex !== found.column) return column
        const windows = column.windows.filter((w) => w !== id)
        // Removing a window above the focus shifts the rest up.
        const focus =
          found.row < column.focus ? column.focus - 1 : column.focus
        return { ...column, windows, focus: clampIndex(focus, windows.length) }
      })
      .filter((column) => column.windows.length > 0)

    // Same for columns: removing one to the left shifts the rest.
    let focus = ws.focus
    const columnEmptied = ws.columns[found.column]!.windows.length === 1
    if (columnEmptied && found.column < ws.focus) focus -= 1
    return { ...ws, columns, focus: clampIndex(focus, columns.length) }
  })

  return settle({ ...state, workspaces }, output, config)
}

export interface WindowLocation {
  workspace: number
  column: number
  row: number
}

export function findWindow(state: StripState, id: WindowId): WindowLocation | null {
  for (const [workspace, ws] of state.workspaces.entries()) {
    for (const [column, col] of ws.columns.entries()) {
      const row = col.windows.indexOf(id)
      if (row !== -1) return { workspace, column, row }
    }
  }
  return null
}

/** The focused window, or null if the focused workspace is empty. */
export function focusedWindow(state: StripState): WindowId | null {
  const ws = currentWorkspace(state)
  const column = ws.columns[clampIndex(ws.focus, ws.columns.length)]
  if (!column) return null
  return column.windows[clampIndex(column.focus, column.windows.length)] ?? null
}

export function focusWindow(
  state: StripState,
  id: WindowId,
  output: Output,
  config: StripConfig,
): StripState {
  const found = findWindow(state, id)
  if (!found) return state

  const workspaces = state.workspaces.map((ws, wsIndex) =>
    wsIndex !== found.workspace
      ? ws
      : {
          ...ws,
          focus: found.column,
          columns: ws.columns.map((column, colIndex) =>
            colIndex === found.column ? { ...column, focus: found.row } : column,
          ),
        },
  )
  return scrollFocusIntoView(
    { ...state, workspaces, focus: found.workspace },
    output,
    config,
  )
}

function focusColumn(
  state: StripState,
  delta: number,
  output: Output,
  config: StripConfig,
): StripState {
  const next = withWorkspace(state, (ws) => ({
    ...ws,
    focus: clampIndex(ws.focus + delta, ws.columns.length),
  }))
  return scrollFocusIntoView(next, output, config)
}

export const focusLeft = (s: StripState, o: Output, c: StripConfig) => focusColumn(s, -1, o, c)
export const focusRight = (s: StripState, o: Output, c: StripConfig) => focusColumn(s, 1, o, c)

/** Move focus within the focused column's stack. */
function focusRow(state: StripState, delta: number): StripState {
  return withWorkspace(state, (ws) => ({
    ...ws,
    columns: ws.columns.map((column, i) =>
      i !== clampIndex(ws.focus, ws.columns.length)
        ? column
        : { ...column, focus: clampIndex(column.focus + delta, column.windows.length) },
    ),
  }))
}

export const focusUp = (s: StripState) => focusRow(s, -1)
export const focusDown = (s: StripState) => focusRow(s, 1)

/** Cycle the focused column between the width presets. */
export function cycleWidth(
  state: StripState,
  output: Output,
  config: StripConfig,
): StripState {
  const next = withWorkspace(state, (ws) => ({
    ...ws,
    columns: ws.columns.map((column, i) =>
      i !== clampIndex(ws.focus, ws.columns.length)
        ? column
        : { ...column, width: ((column.width + 1) % WIDTH_PRESETS.length) as WidthPreset },
    ),
  }))
  return scrollFocusIntoView(next, output, config)
}

/**
 * Pull the focused window into the column on its left, stacking it.
 *
 * niri calls this "consume". It is how a stack gets built without a separate
 * mode: you open windows normally and merge the ones that belong together.
 */
export function consumeIntoColumn(
  state: StripState,
  output: Output,
  config: StripConfig,
): StripState {
  const ws0 = currentWorkspace(state)
  const at0 = clampIndex(ws0.focus, ws0.columns.length)
  // Nothing to consume into. Returning the same object matters: callers use
  // identity to decide whether to re-push a layout.
  if (at0 === 0 || ws0.columns.length < 2) return state

  const next = withWorkspace(state, (ws) => {
    const at = clampIndex(ws.focus, ws.columns.length)
    const source = ws.columns[at]!
    const id = source.windows[clampIndex(source.focus, source.windows.length)]
    if (id === undefined) return ws

    const columns = ws.columns
      .map((column, i) => {
        if (i === at - 1) {
          return { ...column, windows: [...column.windows, id], focus: column.windows.length }
        }
        if (i === at) {
          const windows = column.windows.filter((w) => w !== id)
          return { ...column, windows, focus: clampIndex(column.focus, windows.length) }
        }
        return column
      })
      .filter((column) => column.windows.length > 0)

    return { ...ws, columns, focus: clampIndex(at - 1, columns.length) }
  })
  return settle(next, output, config)
}

/**
 * Push the focused window out of its stack into a column of its own.
 *
 * The inverse of {@link consumeIntoColumn}. niri calls it "expel".
 */
export function expelFromColumn(
  state: StripState,
  output: Output,
  config: StripConfig,
): StripState {
  const ws0 = currentWorkspace(state)
  const source0 = ws0.columns[clampIndex(ws0.focus, ws0.columns.length)]
  // A column of one is already expelled.
  if (!source0 || source0.windows.length < 2) return state

  const next = withWorkspace(state, (ws) => {
    const at = clampIndex(ws.focus, ws.columns.length)
    const source = ws.columns[at]!

    const id = source.windows[clampIndex(source.focus, source.windows.length)]
    if (id === undefined) return ws

    const remaining = source.windows.filter((w) => w !== id)
    const columns = [...ws.columns]
    columns[at] = {
      ...source,
      windows: remaining,
      focus: clampIndex(source.focus, remaining.length),
    }
    columns.splice(at + 1, 0, { windows: [id], focus: 0, width: source.width })

    return { ...ws, columns, focus: at + 1 }
  })
  return settle(next, output, config)
}

/** Switch workspace. Clamped, and the trailing empty one is always reachable. */
export function focusWorkspace(
  state: StripState,
  delta: number,
  output: Output,
  config: StripConfig,
): StripState {
  const focus = clampIndex(state.focus + delta, state.workspaces.length)
  return scrollFocusIntoView({ ...state, focus }, output, config)
}

/**
 * Move the focused window to another workspace, following it there.
 *
 * Done in one step rather than as remove-then-add. Removing normalises the
 * workspace list, and if that collapses the workspace being left, every later
 * index shifts and the window lands back where it started.
 */
export function moveToWorkspace(
  state: StripState,
  delta: number,
  output: Output,
  config: StripConfig,
): StripState {
  const id = focusedWindow(state)
  if (id === null) return state

  const from = clampIndex(state.focus, state.workspaces.length)
  const to = clampIndex(from + delta, state.workspaces.length)
  if (to === from) return state

  const workspaces = state.workspaces.map((ws, index) => {
    if (index === from) return detach(ws, id)
    if (index === to) return attach(ws, id, config)
    return ws
  })

  // Normalise once, at the end, when both sides are already correct.
  const moved = normaliseWorkspaces({ ...state, workspaces, focus: to })
  // Focus the workspace the window actually ended up on, since normalising may
  // have renumbered them.
  const landed = findWindow(moved, id)
  return scrollFocusIntoView(
    landed ? { ...moved, focus: landed.workspace } : moved,
    output,
    config,
  )
}

/** Remove a window from a workspace, dropping any column it empties. */
function detach(ws: Workspace, id: WindowId): Workspace {
  const columns = ws.columns
    .map((column) => {
      if (!column.windows.includes(id)) return column
      const windows = column.windows.filter((w) => w !== id)
      return { ...column, windows, focus: clampIndex(column.focus, windows.length) }
    })
    .filter((column) => column.windows.length > 0)
  return { ...ws, columns, focus: clampIndex(ws.focus, columns.length) }
}

/** Add a window to a workspace as a new column beside its focus. */
function attach(ws: Workspace, id: WindowId, config: StripConfig): Workspace {
  const at = ws.columns.length === 0 ? 0 : clampIndex(ws.focus, ws.columns.length) + 1
  const columns = [...ws.columns]
  columns.splice(at, 0, { windows: [id], focus: 0, width: config.defaultWidth })
  return { ...ws, columns, focus: at }
}

/**
 * Re-derive the offset after the viewport changes.
 *
 * Column widths are fractions of the viewport, so they do change on resize.
 * What must not change is which windows exist, their order, or their stacking.
 */
export function reflow(state: StripState, output: Output, config: StripConfig): StripState {
  return scrollFocusIntoView(state, output, config)
}

/** Every window in the whole strip, across all workspaces. */
export function allWindows(state: StripState): WindowId[] {
  return state.workspaces.flatMap((ws) => ws.columns.flatMap((c) => c.windows))
}
