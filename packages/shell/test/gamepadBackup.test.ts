import { describe, expect, it } from "vitest"
import {
  BACKUP_KIND,
  backupFilename,
  makeBackup,
  readBackup,
  type GamepadSettings,
} from "../src/gamepad/backup"
import { DEFAULT_LAYOUT } from "../src/gamepad/model"

const SETTINGS: GamepadSettings = {
  skin: "xbox",
  opacity: 0.6,
  haptics: false,
  mode: "controller",
}

const AT = new Date("2026-08-04T15:04:05.000Z")

describe("gamepad backup", () => {
  it("round-trips a layout and its settings", () => {
    const text = JSON.stringify(makeBackup(DEFAULT_LAYOUT, SETTINGS, AT))
    const result = readBackup(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backup.settings).toEqual(SETTINGS)
    expect(result.backup.pads).toHaveLength(DEFAULT_LAYOUT.length)
    expect(result.backup.pads[0]).toMatchObject({ id: DEFAULT_LAYOUT[0]!.id })
  })

  it("names the file by date, so backups sort in a folder", () => {
    expect(backupFilename(AT)).toBe("lwfa-controller-2026-08-04-15-04-05.json")
  })

  it("still accepts a bare array, which is what the old copy button produced", () => {
    const result = readBackup(JSON.stringify(DEFAULT_LAYOUT))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backup.pads).toHaveLength(DEFAULT_LAYOUT.length)
    // No settings in that format, so the defaults stand rather than throwing.
    expect(result.backup.settings.skin).toBe("neutral")
  })

  it("keeps the good pads and drops the malformed ones", () => {
    const mixed = [DEFAULT_LAYOUT[0], { id: "broken" }, DEFAULT_LAYOUT[1]]
    const result = readBackup(JSON.stringify(mixed))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backup.pads).toHaveLength(2)
  })

  it("clamps a pad that would sit off the play area", () => {
    const runaway = [{ ...DEFAULT_LAYOUT[0], x: 400, y: -80, size: 900 }]
    const result = readBackup(JSON.stringify(runaway))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const pad = result.backup.pads[0]!
    expect(pad.x).toBeLessThanOrEqual(97)
    expect(pad.y).toBeGreaterThanOrEqual(3)
    expect(pad.size).toBeLessThanOrEqual(40)
  })

  it("falls back per setting rather than discarding the rest", () => {
    const text = JSON.stringify({
      kind: BACKUP_KIND,
      version: 1,
      pads: DEFAULT_LAYOUT,
      settings: { skin: "nonsense", opacity: 0.4, haptics: "yes", mode: "keyboard" },
    })
    const result = readBackup(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backup.settings).toEqual({
      skin: "neutral",
      opacity: 0.4,
      haptics: true,
      mode: "keyboard",
    })
  })

  it("explains itself rather than throwing on rubbish", () => {
    for (const bad of ["", "not json", "42", '{"pads":"nope"}', "[]"]) {
      const result = readBackup(bad)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.problem.length).toBeGreaterThan(0)
    }
  })

  it("refuses a backup from another application", () => {
    const text = JSON.stringify({ kind: "something.else", pads: DEFAULT_LAYOUT })
    const result = readBackup(text)
    expect(result.ok).toBe(false)
  })
})
