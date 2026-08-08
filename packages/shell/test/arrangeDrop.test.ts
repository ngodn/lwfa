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
import { EDGE_BAND, dropTarget, isNoop, cellAt, type ColumnBox } from "../src/lib/arrangeDrop"

/** One window's box inside a column. */
const cell = (id: number, left: number, right: number, top: number, bottom: number) => ({
  id: id as WindowId,
  left,
  right,
  top,
  bottom,
})


/** Three columns, 200 wide, 20 apart, one window each unless stacked. */
const columns: ColumnBox[] = [
  { index: 0, left: 0, right: 200, cells: [cell(1, 0, 200, 0, 400)] },
  { index: 1, left: 220, right: 420, cells: [cell(2, 220, 420, 0, 400)] },
  { index: 2, left: 440, right: 640, cells: [cell(3, 440, 640, 0, 400)] },
]

const at = (x: number, y = 200) => dropTarget({ x, y }, columns)

describe("dropping on a column", () => {
  it("joins the column under the pointer", () => {
    // The slot is whichever side of the window the pointer fell on. Here it
    // is ten pixels left of a centre it is level with vertically, so it goes
    // before. Which side used to be a question about height alone; a group is
    // tiled in two dimensions now, so both axes are asked.
    expect(at(310)).toEqual({ kind: "column", index: 1, row: 0 })
    expect(at(330)).toEqual({ kind: "column", index: 1, row: 1 })
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
      { index: 0, left: 0, right: 60, cells: [cell(1, 0, 60, 0, 100)] },
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
      cells: [
        cell(1, 0, 200, 0, 100),
        cell(2, 0, 200, 110, 210),
        cell(3, 0, 200, 220, 320),
      ],
    },
  ]

  it("goes above a window when the pointer is in its top half", () => {
    expect(cellAt({ x: 100, y: 40 }, stacked[0]!.cells)).toBe(0)
    expect(cellAt({ x: 100, y: 150 }, stacked[0]!.cells)).toBe(1)
  })

  it("goes below when the pointer is in the bottom half", () => {
    // Measured against midpoints, so the gap between two windows is never
    // ambiguous and the insertion point does not flicker crossing it.
    expect(cellAt({ x: 100, y: 60 }, stacked[0]!.cells)).toBe(1)
    expect(cellAt({ x: 100, y: 105 }, stacked[0]!.cells)).toBe(1)
  })

  it("goes last below everything", () => {
    expect(cellAt({ x: 100, y: 400 }, stacked[0]!.cells)).toBe(3)
  })

  it("reads left and right when the pair is side by side", () => {
    // The case a height alone could never answer, and the one that arrives
    // with two-dimensional groups: two windows sharing a band of height.
    const pair: ColumnBox["cells"] = [
      cell(1, 0, 100, 0, 200),
      cell(2, 110, 210, 0, 200),
    ]
    expect(cellAt({ x: 20, y: 100 }, pair)).toBe(0)
    expect(cellAt({ x: 80, y: 100 }, pair)).toBe(1)
    expect(cellAt({ x: 130, y: 100 }, pair)).toBe(1)
    expect(cellAt({ x: 200, y: 100 }, pair)).toBe(2)
  })

  it("picks the nearest cell in a quadrant, not the nearest row", () => {
    // Four windows as quadrants, which is what a group of four looks like now.
    // Under the old rule the left and right of each band were indistinguishable,
    // so half of these drops landed on the wrong window.
    const quad: ColumnBox["cells"] = [
      cell(1, 0, 100, 0, 100),
      cell(2, 0, 100, 110, 210),
      cell(3, 110, 210, 0, 100),
      cell(4, 110, 210, 110, 210),
    ]

    // The property, rather than the tie-break: a drop inside a quadrant lands
    // in one of the two slots either side of that quadrant's own window. Which
    // of the two depends on where in the cell the pointer fell, and at exactly
    // 45 degrees from its centre either answer is as good.
    const brackets = (point: { x: number; y: number }, index: number) => {
      const slot = cellAt(point, quad)
      expect(slot === index || slot === index + 1).toBe(true)
    }

    brackets({ x: 30, y: 30 }, 0)
    brackets({ x: 30, y: 180 }, 1)
    brackets({ x: 180, y: 30 }, 2)
    brackets({ x: 180, y: 180 }, 3)

    // And the corners resolve to the far ends, which a y-only rule could not
    // do: bottom-right is last, top-left is first.
    expect(cellAt({ x: 0, y: 0 }, quad)).toBe(0)
    expect(cellAt({ x: 210, y: 210 }, quad)).toBe(4)
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
