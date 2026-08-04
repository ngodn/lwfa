import { describe, expect, it } from "vitest"
import { chordLabel, clampPad, DEFAULT_LAYOUT, KEY_NAMES, type Pad } from "../src/gamepad/model"
import { readBackup } from "../src/gamepad/backup"
import { MODIFIER_CODES } from "../src/keyboard/layout"

const ALT_H: Pad = {
  id: "key-abc",
  kind: "key",
  face: "key",
  x: 50,
  y: 62,
  size: 11,
  chord: [MODIFIER_CODES.alt, 35],
}

describe("custom key buttons", () => {
  it("names a chord in the order it is sent", () => {
    expect(chordLabel(ALT_H.chord!)).toBe("Alt+H")
    expect(chordLabel([MODIFIER_CODES.ctrl, MODIFIER_CODES.shift, 45])).toBe("Ctrl+Shift+X")
    expect(chordLabel([1])).toBe("Esc")
  })

  it("shows the number for a key it has no name for, rather than nothing", () => {
    expect(chordLabel([9999])).toBe("#9999")
  })

  it("has a name for every modifier the picker can add", () => {
    for (const code of Object.values(MODIFIER_CODES)) {
      expect(KEY_NAMES[code]).toBeDefined()
    }
  })

  it("is not in the default layout, which stays a controller", () => {
    expect(DEFAULT_LAYOUT.some((pad) => pad.kind === "key")).toBe(false)
  })

  it("survives a backup round trip", () => {
    const text = JSON.stringify([...DEFAULT_LAYOUT, ALT_H])
    const result = readBackup(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const restored = result.backup.pads.find((pad) => pad.id === ALT_H.id)
    expect(restored).toBeDefined()
    expect(restored?.kind).toBe("key")
    expect(restored?.chord).toEqual([MODIFIER_CODES.alt, 35])
  })

  it("is clamped into the play area like any other pad", () => {
    const runaway = clampPad({ ...ALT_H, x: 500, y: -20, size: 99 })
    expect(runaway.x).toBeLessThanOrEqual(97)
    expect(runaway.y).toBeGreaterThanOrEqual(3)
    expect(runaway.size).toBeLessThanOrEqual(40)
    // The binding is untouched by geometry clamping.
    expect(runaway.chord).toEqual(ALT_H.chord)
  })
})
