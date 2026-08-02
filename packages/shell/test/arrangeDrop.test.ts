/**
 * Where a dragged window lands.
 *
 * This is the one part of dragging that can be wrong rather than merely ugly.
 * A window that ends up one column left of the highlight reads as the whole
 * feature being broken, and it is exactly the kind of off-by-one that survives
 * being stared at.
 */

import { describe, expect, it } from "vitest"
import type { WindowId } from "@lwfa/proto"
import { EDGE_BAND, dropTarget, isNoop, rowAt, type ColumnBox } from "../src/lib/arrangeDrop"

/** Three columns, 200 wide, 20 apart, one window each unless stacked. */
const columns: ColumnBox[] = [
  { index: 0, left: 0, right: 200, rows: [{ id: 1 as WindowId, top: 0, bottom: 400 }] },
  { index: 1, left: 220, right: 420, rows: [{ id: 2 as WindowId, top: 0, bottom: 400 }] },
  { index: 2, left: 440, right: 640, rows: [{ id: 3 as WindowId, top: 0, bottom: 400 }] },
]

const at = (x: number, y = 200) => dropTarget({ x, y }, columns)

describe("dropping on a column", () => {
  it("joins the column under the pointer", () => {
    expect(at(310)).toEqual({ kind: "column", index: 1, row: 1 })
  })

  it("uses the middle of the column, away from both edges", () => {
    // 220..420 with a 44 band each side leaves 264..376 as "on the column".
    expect(at(270)).toMatchObject({ kind: "column", index: 1 })
    expect(at(370)).toMatchObject({ kind: "column", index: 1 })
  })
})

describe("dropping between columns", () => {
  it("makes a new column in the gap", () => {
    // 200..220 is the space between the first two columns.
    expect(at(210)).toEqual({ kind: "newColumn", index: 1 })
  })

  it("treats a band inside each edge as between, not on", () => {
    // Otherwise the only way to make a new column is to hit a gap that is a
    // couple of pixels wide once the strip is zoomed out.
    expect(at(225)).toEqual({ kind: "newColumn", index: 1 })
    expect(at(415)).toEqual({ kind: "newColumn", index: 2 })
  })

  it("puts it before everything past the left end", () => {
    expect(at(-50)).toEqual({ kind: "newColumn", index: 0 })
  })

  it("puts it after everything past the right end", () => {
    expect(at(900)).toEqual({ kind: "newColumn", index: 3 })
  })

  it("keeps the band proportional on a narrow column", () => {
    // A fixed 44px band on a 60px column would make the whole column a gap, so
    // there would be no way to drop *into* it at all.
    const narrow: ColumnBox[] = [
      { index: 0, left: 0, right: 60, rows: [{ id: 1 as WindowId, top: 0, bottom: 100 }] },
    ]
    expect(EDGE_BAND).toBeGreaterThan(60 / 4)
    expect(dropTarget({ x: 30, y: 50 }, narrow)).toMatchObject({ kind: "column", index: 0 })
  })

  it("makes a column when there is nothing there at all", () => {
    expect(dropTarget({ x: 100, y: 100 }, [])).toEqual({ kind: "newColumn", index: 0 })
  })
})

describe("choosing a row in a stacked column", () => {
  const stacked: ColumnBox[] = [
    {
      index: 0,
      left: 0,
      right: 200,
      rows: [
        { id: 1 as WindowId, top: 0, bottom: 100 },
        { id: 2 as WindowId, top: 110, bottom: 210 },
        { id: 3 as WindowId, top: 220, bottom: 320 },
      ],
    },
  ]

  it("goes above a window when the pointer is in its top half", () => {
    expect(rowAt(40, stacked[0]!.rows)).toBe(0)
    expect(rowAt(150, stacked[0]!.rows)).toBe(1)
  })

  it("goes below when the pointer is in the bottom half", () => {
    // Measured against midpoints, so the gap between two windows is never
    // ambiguous and the insertion point does not flicker crossing it.
    expect(rowAt(60, stacked[0]!.rows)).toBe(1)
    expect(rowAt(105, stacked[0]!.rows)).toBe(1)
  })

  it("goes last below everything", () => {
    expect(rowAt(400, stacked[0]!.rows)).toBe(3)
  })

  it("reports the row through dropTarget too", () => {
    expect(dropTarget({ x: 100, y: 250 }, stacked)).toEqual({
      kind: "column",
      index: 0,
      row: 2,
    })
  })
})

describe("a drag that changed nothing", () => {
  const from = { column: 1, row: 0 }

  it("is a no-op landing on its own row", () => {
    expect(isNoop({ kind: "column", index: 1, row: 0 }, from)).toBe(true)
  })

  it("is a no-op landing just after itself", () => {
    // Lifting the window out shifts every later row up by one, so row + 1 puts
    // it back exactly where it was.
    expect(isNoop({ kind: "column", index: 1, row: 1 }, from)).toBe(true)
  })

  it("is a real move to another row", () => {
    expect(isNoop({ kind: "column", index: 1, row: 2 }, from)).toBe(false)
  })

  it("is a real move to another column", () => {
    expect(isNoop({ kind: "column", index: 0, row: 0 }, from)).toBe(false)
  })

  it("is always a real move into a column of its own", () => {
    // Even from a column it already sits alone in: the user asked for it, and
    // the strip op handles putting it back safely.
    expect(isNoop({ kind: "newColumn", index: 1 }, from)).toBe(false)
  })
})
