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

/** A column as it appears on screen, with the windows tiled inside it. */
export interface ColumnBox {
  index: number
  left: number
  right: number
  cells: CellBox[]
}

/**
 * One window's box inside a column.
 *
 * A full rectangle rather than a top and a bottom. Windows in a group used to
 * be full-width bands, so a height was enough to say which one a finger was
 * over; they are tiled in two dimensions now (see `tile` in strip.ts), and two
 * windows can share the same band of height while sitting side by side.
 */
export interface CellBox {
  id: WindowId
  left: number
  right: number
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
      return { kind: "column", index: column.index, row: cellAt(point, column.cells) }
    }

    // In the space between this column and the next.
    if (next && point.x > column.right && point.x < next.left) {
      return { kind: "newColumn", index: next.index }
    }
  }

  return null
}

/**
 * Which slot in a group a drop here lands on.
 *
 * This used to compare a height against a list of bands, which worked only
 * while windows in a group were stacked full width. They are tiled in two
 * dimensions now, so a y on its own cannot tell the left half of a row from
 * the right half of it.
 *
 * The pointer is matched to the nearest cell by centre, and then goes before
 * or after that cell depending on which side of the centre it fell. Which
 * side is judged along whichever axis the pointer is further from the middle
 * on, so the answer follows however that particular pair happens to be split:
 * a side-by-side pair reads left and right, a stacked pair reads up and down,
 * without either being hard-coded.
 *
 * Centres rather than edges, as before, so the gap between two windows is
 * never ambiguous and the insertion point does not flicker as a finger
 * crosses it.
 */
export function cellAt(point: { x: number; y: number }, cells: CellBox[]): number {
  if (cells.length === 0) return 0

  let nearest = 0
  let best = Infinity
  const centres = cells.map((cell) => ({
    x: (cell.left + cell.right) / 2,
    y: (cell.top + cell.bottom) / 2,
  }))

  centres.forEach((centre, at) => {
    const dx = point.x - centre.x
    const dy = point.y - centre.y
    const distance = dx * dx + dy * dy
    if (distance < best) {
      best = distance
      nearest = at
    }
  })

  const centre = centres[nearest]!
  const dx = point.x - centre.x
  const dy = point.y - centre.y
  const after = Math.abs(dx) > Math.abs(dy) ? dx > 0 : dy > 0
  return after ? nearest + 1 : nearest
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
