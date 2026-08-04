/**
 * Taking the whole controller off a device, and putting it back.
 *
 * # Why this exists
 *
 * The arrangement lives in one browser's `localStorage` and nowhere else. That
 * is the right place for it, because the right layout depends on the hands and
 * the screen holding it, so it is per device by design rather than by accident.
 *
 * The cost is that a layout somebody spent an evening dragging into shape is
 * one cleared cache, one reinstalled PWA or one new tablet away from gone, with
 * no console to open and no file to reach on the device it lives on. "Copy
 * layout" already answered half of that: it puts the pads on the clipboard. It
 * did not carry the skin, the opacity, the haptics switch or the mode, so
 * restoring from it still left the controller looking and behaving like a fresh
 * install.
 *
 * So this carries **everything the controller is**: every pad with its
 * position, size, kind and bindings, and every setting from the panel.
 *
 * # Why a file and not only the clipboard
 *
 * Because the clipboard is not backup. It survives until the next copy. A file
 * goes to iCloud Drive or Files or a laptop and is still there next year, and
 * on iPadOS a download from Safari lands somewhere the user chose.
 *
 * Both are offered: the clipboard for moving a layout to the device next to
 * you, a file for keeping one.
 *
 * # Compatibility
 *
 * `version` is written and checked, but a mismatch is not fatal: pads are
 * validated individually and the store's own migrations then add anything that
 * did not exist when the backup was taken, exactly as they do for a layout
 * restored from storage. A backup from an older shell restores and gains the
 * newer controls rather than being refused.
 */

import { clampPad, type Pad } from "@/gamepad/model"
import type { GamepadSkin } from "@/lib/prefs"

/** What the panel can set, and therefore what a backup has to carry. */
export interface GamepadSettings {
  skin: GamepadSkin
  opacity: number
  haptics: boolean
  mode: "controller" | "keyboard"
}

export interface GamepadBackup {
  /** Identifies the file, so restoring the wrong JSON fails clearly. */
  kind: "lwfa.gamepad"
  version: 1
  /** Informational, for telling two backups apart in a folder. */
  savedAt: string
  settings: GamepadSettings
  pads: Pad[]
}

export const BACKUP_KIND = "lwfa.gamepad"
export const BACKUP_VERSION = 1

export function makeBackup(
  pads: Pad[],
  settings: GamepadSettings,
  now: Date = new Date(),
): GamepadBackup {
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    savedAt: now.toISOString(),
    settings,
    pads,
  }
}

/** A filename that sorts by date and says what it is. */
export function backupFilename(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-")
  return `lwfa-controller-${stamp}.json`
}

export type RestoreResult =
  | { ok: true; backup: GamepadBackup }
  | { ok: false; problem: string }

const SKINS = new Set(["playstation", "xbox", "neutral"])
const MODES = new Set(["controller", "keyboard"])
const KINDS = new Set(["button", "dpad", "stick", "trigger"])

/**
 * Parse and validate text that claims to be a backup.
 *
 * Everything is checked rather than trusted, because this text came from a
 * file picker or a paste box: it can be any JSON in the world, and a bad one
 * must produce a message rather than a controller that will not render. A pad
 * missing its geometry is dropped; the rest still restore.
 */
export function readBackup(text: string): RestoreResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, problem: "That is not valid JSON." }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, problem: "That file does not contain a backup." }
  }
  const raw = parsed as Partial<GamepadBackup> & { [key: string]: unknown }

  // A bare array is what the old "Copy layout" button produced. Accept it, so
  // anyone holding one of those can still restore it; it just carries no
  // settings.
  const padsIn = Array.isArray(parsed) ? parsed : raw.pads
  if (!Array.isArray(padsIn)) {
    return { ok: false, problem: "That file has no controller layout in it." }
  }
  if (!Array.isArray(parsed) && raw.kind !== undefined && raw.kind !== BACKUP_KIND) {
    return { ok: false, problem: "That backup is from a different application." }
  }

  const pads = padsIn.filter(isPad).map(clampPad)
  if (pads.length === 0) {
    return { ok: false, problem: "That layout has no usable controls in it." }
  }

  return {
    ok: true,
    backup: {
      kind: BACKUP_KIND,
      version: BACKUP_VERSION,
      savedAt: typeof raw.savedAt === "string" ? raw.savedAt : "",
      settings: readSettings(Array.isArray(parsed) ? undefined : raw.settings),
      pads,
    },
  }
}

function isPad(value: unknown): value is Pad {
  if (typeof value !== "object" || value === null) return false
  const pad = value as Partial<Pad>
  return (
    typeof pad.id === "string" &&
    typeof pad.x === "number" &&
    Number.isFinite(pad.x) &&
    typeof pad.y === "number" &&
    Number.isFinite(pad.y) &&
    typeof pad.size === "number" &&
    Number.isFinite(pad.size) &&
    typeof pad.face === "string" &&
    typeof pad.kind === "string" &&
    KINDS.has(pad.kind)
  )
}

/**
 * Settings from a backup, falling back per field rather than wholesale.
 *
 * One unrecognised value should not throw away the other three, and a backup
 * from before a setting existed should restore everything it does have.
 */
function readSettings(value: unknown): GamepadSettings {
  const fallback: GamepadSettings = {
    skin: "neutral",
    opacity: 0.85,
    haptics: true,
    mode: "controller",
  }
  if (typeof value !== "object" || value === null) return fallback
  const raw = value as Partial<GamepadSettings>
  return {
    skin: typeof raw.skin === "string" && SKINS.has(raw.skin) ? raw.skin : fallback.skin,
    opacity:
      typeof raw.opacity === "number" && Number.isFinite(raw.opacity)
        ? Math.min(1, Math.max(0.2, raw.opacity))
        : fallback.opacity,
    haptics: typeof raw.haptics === "boolean" ? raw.haptics : fallback.haptics,
    mode: typeof raw.mode === "string" && MODES.has(raw.mode) ? raw.mode : fallback.mode,
  }
}
