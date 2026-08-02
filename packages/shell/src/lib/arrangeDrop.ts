/**
 * Turning a pointer position into somewhere a window can go.
 *
 * # Why this is separate from the component
 *
 * It is the only part of dragging with a right answer and a wrong one. Where a
 * finger is relative to a set of boxes decides whether a window joins a column
 * or gets one of its own, and an off-by-one here means a window that lands one
 * column left of the highlight, which reads as the drag being broken rather
 * than as an arithmetic mistake. Pulled out, it is testable without a DOM.
 *
 * Everything else about the drag is bookkeeping: capture the pointer, write a
 * transform, commit on release.
 *
 * # Coordinates
 *
 * Screen pixels throughout, because that is what a pointer event carries and
 * what the on-screen boxes are measured in. The scene's scale never appears:
 * the boxes are already scaled, so comparing a pointer to them needs no
 * conversion at all. Converting to strip coordinates first would mean undoing
 * the transform and would gain nothing.
 */

import type { WindowId } from "@lwfa/proto"
import type { MoveTarget } from "@/strip"

/** A column as it appears on screen, with the windows stacked inside it. */
export interface ColumnBox {
  index: number
  left: number
  right: number
  rows: RowBox[]
}

export interface RowBox {
  id: WindowId
  top: number
  bottom: number
}

/**
 * How close to a column's edge counts as "between columns" rather than "on it".
 *
 * Without a band like this the only way to make a new column would be to hit
 * the literal gap between two of them, which at a zoomed-out scale can be a
 * couple of pixels wide. A quarter of the column, capped, so it stays reachable
 * on a narrow column and does not swallow a wide one.
 */
export const EDGE_BAND = 44

function bandFor(column: ColumnBox): number {
  return Math.min(EDGE_BAND, (column.right - column.left) / 4)
}

/**
 * Where would a window dropped here go?
 *
 * `null` when the pointer is nowhere meaningful, which the caller should treat
 * as "put it back", not as "guess". Silently landing a window somewhere the
 * user was not pointing is worse than the drag doing nothing.
 */
export function dropTarget(
  point: { x: number; y: number },
  columns: ColumnBox[],
): MoveTarget | null {
  if (columns.length === 0) return { kind: "newColumn", index: 0 }

  const ordered = [...columns].sort((a, b) => a.left - b.left)
  const first = ordered[0]!
  const last = ordered[ordered.length - 1]!

  // Past either end of the strip: a column of its own, at that end.
  if (point.x < first.left) return { kind: "newColumn", index: first.index }
  if (point.x > last.right) return { kind: "newColumn", index: last.index + 1 }

  for (let at = 0; at < ordered.length; at++) {
    const column = ordered[at]!
    const next = ordered[at + 1]

    if (point.x >= column.left && point.x <= column.right) {
      const band = bandFor(column)
      // Near an edge means between columns, not on this one.
      if (point.x < column.left + band) return { kind: "newColumn", index: column.index }
      if (point.x > column.right - band) return { kind: "newColumn", index: column.index + 1 }
      return { kind: "column", index: column.index, row: rowAt(point.y, column.rows) }
    }

    // In the space between this column and the next.
    if (next && point.x > column.right && point.x < next.left) {
      return { kind: "newColumn", index: next.index }
    }
  }

  return null
}

/**
 * Which row a drop at this height lands on.
 *
 * Measured against each row's midpoint rather than its edges: above the middle
 * means before it, below means after. Using edges would leave the space between
 * two windows ambiguous and make the insertion point flicker as a finger
 * crossed the gap.
 */
export function rowAt(y: number, rows: RowBox[]): number {
  for (let at = 0; at < rows.length; at++) {
    const row = rows[at]!
    if (y < (row.top + row.bottom) / 2) return at
  }
  return rows.length
}

/**
 * Is this target where the window already is?
 *
 * A drag that ends where it started should do nothing at all. Committing it
 * anyway is not harmless: `moveWindow` clears fullscreen and re-settles the
 * strip, so a stray tap that wobbled a few pixels would visibly rearrange a
 * desktop nobody asked to rearrange.
 */
export function isNoop(
  target: MoveTarget,
  from: { column: number; row: number },
): boolean {
  if (target.kind === "newColumn") return false
  if (target.index !== from.column) return false
  // Removing the window first shifts every later row up by one, so landing on
  // its own row or the one after it both put it back where it was.
  return target.row === undefined || target.row === from.row || target.row === from.row + 1
}
