/**
 * The scrollable strip.
 *
 * This is lwfa's layout policy, and it lives here rather than in the engine.
 * Columns sit on an infinite horizontal strip and the output is a viewport onto
 * it. See docs/architecture.md section 2.3 for why this model.
 *
 * # Everything here is a pure function
 *
 * No DOM, no clock, no `WebSocket`. State goes in, target geometry comes out.
 * That matters for three reasons:
 *
 * 1. The same code has to produce the same layout under the local backend and
 *    the remote one, or the desktop looks different depending on where you are
 *    sitting.
 * 2. It is testable without a compositor or a browser, which is why
 *    `test/strip.test.ts` can cover the geometry properly.
 * 3. It can move to a worker later without restructuring.
 *
 * When text measurement arrives (window titles in the overview), it goes
 * through PreTeXt.js for the same reason: `getBoundingClientRect` would make
 * this impure and force a reflow per frame.
 *
 * # This module never animates
 *
 * It computes *target* geometry only. The engine integrates the springs, at its
 * own refresh rate, using the parameters sent alongside the target. A shell
 * that animated by sending a new rect per frame would bake its own scheduling
 * jitter into the motion and look different locally and remotely. See
 * `crates/lwfa-proto` for the rule and `crates/lwfa-spring` for the integrator.
 */

import type { Rect, WindowId, WindowLayout } from "@lwfa/proto"

export interface Output {
  width: number
  height: number
}

export interface StripConfig {
  /** Gap between columns, and between a column and the output edge. */
  gap: number
  /** Column width as a fraction of the viewport. */
  widthFraction: number
  /** Floor on column width, so a phone-width viewport stays usable. */
  minWidth: number
}

export const DEFAULT_CONFIG: StripConfig = {
  gap: 12,
  widthFraction: 0.5,
  minWidth: 240,
}

export interface StripState {
  /** Window ids in strip order, left to right. */
  columns: WindowId[]
  /** Index into `columns`. Clamped by every operation below. */
  focus: number
  /**
   * How far the viewport has scrolled right, in logical pixels.
   *
   * Always a *target*. The engine holds the in-between values while a spring is
   * running; this never holds a partially-scrolled position.
   */
  viewOffset: number
}

export const EMPTY: StripState = { columns: [], focus: 0, viewOffset: 0 }

export function columnWidth(output: Output, config: StripConfig): number {
  return Math.max(Math.round(output.width * config.widthFraction), config.minWidth)
}

export function columnHeight(output: Output, config: StripConfig): number {
  return Math.max(output.height - config.gap * 2, 1)
}

/** Absolute x of column `index` in strip coordinates, before the view offset. */
export function columnX(index: number, width: number, config: StripConfig): number {
  return config.gap + index * (width + config.gap)
}

/** Total width of the strip's content, including the trailing gap. */
export function stripWidth(count: number, width: number, config: StripConfig): number {
  return count === 0 ? 0 : config.gap + count * (width + config.gap)
}

/**
 * Where the viewport should sit for `focus` to be fully visible, scrolling the
 * minimum distance to get there.
 *
 * A column already fully in view does not move, which is what makes focusing a
 * neighbour feel like a small nudge rather than a re-centre.
 */
export function targetOffset(state: StripState, output: Output, config: StripConfig): number {
  if (state.columns.length === 0) return 0

  const width = columnWidth(output, config)
  const focus = clampIndex(state.focus, state.columns.length)
  const left = columnX(focus, width, config) - config.gap
  const right = columnX(focus, width, config) + width + config.gap
  const viewport = output.width

  // Wider than the viewport: pin the left edge, since no offset shows all of it.
  if (right - left >= viewport) return left
  if (left < state.viewOffset) return left
  if (right > state.viewOffset + viewport) return right - viewport
  return state.viewOffset
}

/**
 * Target geometry for every column.
 *
 * `z` ascends with strip order so overlapping columns (possible once columns
 * can be wider than the viewport) stack predictably.
 */
export function layout(state: StripState, output: Output, config: StripConfig): WindowLayout[] {
  const width = columnWidth(output, config)
  const height = columnHeight(output, config)
  const offset = state.viewOffset

  return state.columns.map((id, index) => {
    const rect: Rect = {
      x: columnX(index, width, config) - offset,
      y: config.gap,
      width,
      height,
    }
    return { id, rect, z: index }
  })
}

// ---------------------------------------------------------------------------
// Transitions
//
// Each returns a new state; none mutate. The caller re-derives `viewOffset`
// through `scrollFocusIntoView` so focus and offset can never disagree.
// ---------------------------------------------------------------------------

function clampIndex(index: number, length: number): number {
  if (length === 0) return 0
  return Math.min(Math.max(index, 0), length - 1)
}

export function scrollFocusIntoView(
  state: StripState,
  output: Output,
  config: StripConfig,
): StripState {
  return { ...state, viewOffset: targetOffset(state, output, config) }
}

/**
 * Append a column and focus it.
 *
 * Appending rather than inserting beside the focus keeps this simple; niri
 * inserts adjacent, which is a refinement that does not change the model.
 */
export function addWindow(
  state: StripState,
  id: WindowId,
  output: Output,
  config: StripConfig,
): StripState {
  if (state.columns.includes(id)) return state
  const columns = [...state.columns, id]
  return scrollFocusIntoView({ ...state, columns, focus: columns.length - 1 }, output, config)
}

export function removeWindow(
  state: StripState,
  id: WindowId,
  output: Output,
  config: StripConfig,
): StripState {
  const index = state.columns.indexOf(id)
  if (index === -1) return state

  const columns = state.columns.filter((c) => c !== id)
  // Keep focus on the neighbour that slid into this slot. Removing a column to
  // the left of the focus would otherwise shift focus to a different window.
  let focus = state.focus
  if (index < state.focus) focus -= 1
  focus = clampIndex(focus, columns.length)

  return scrollFocusIntoView({ ...state, columns, focus }, output, config)
}

export function focusIndex(
  state: StripState,
  index: number,
  output: Output,
  config: StripConfig,
): StripState {
  if (state.columns.length === 0) return state
  return scrollFocusIntoView(
    { ...state, focus: clampIndex(index, state.columns.length) },
    output,
    config,
  )
}

export function focusWindow(
  state: StripState,
  id: WindowId,
  output: Output,
  config: StripConfig,
): StripState {
  const index = state.columns.indexOf(id)
  return index === -1 ? state : focusIndex(state, index, output, config)
}

export function focusLeft(state: StripState, output: Output, config: StripConfig): StripState {
  return focusIndex(state, state.focus - 1, output, config)
}

export function focusRight(state: StripState, output: Output, config: StripConfig): StripState {
  return focusIndex(state, state.focus + 1, output, config)
}

/** The focused window id, or null on an empty strip. */
export function focusedWindow(state: StripState): WindowId | null {
  return state.columns[state.focus] ?? null
}

/**
 * Re-derive the offset after the viewport changes.
 *
 * Resizing changes what is visible without resizing any column, which is the
 * property the whole layout model is chosen for.
 */
export function reflow(state: StripState, output: Output, config: StripConfig): StripState {
  return scrollFocusIntoView(state, output, config)
}

/**
 * Does this column intersect the viewport at all?
 *
 * Only intersecting columns are worth streaming pixels for, which is what
 * bounds the encoder budget by viewport width rather than by how many windows
 * are open. See docs/architecture.md section 2.3.
 */
export function intersectsViewport(rect: Rect, viewportWidth: number): boolean {
  return rect.x + rect.width > 0 && rect.x < viewportWidth
}
