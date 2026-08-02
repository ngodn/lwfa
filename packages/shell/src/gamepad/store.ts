/**
 * Gamepad visibility, edit mode, and the saved layout.
 *
 * An external store rather than context for the same reason preferences are:
 * the overlay sits on top of live video, and the panel that configures it must
 * not be able to re-render the desktop. Only the overlay and the panel
 * subscribe.
 *
 * The layout persists; visibility and edit mode do not. Reopening the shell
 * with a controller stuck over the screen, or in edit mode, would be a puzzle
 * rather than a convenience.
 */

import { useCallback, useSyncExternalStore } from "react"
import { DEFAULT_LAYOUT, type Pad } from "@/gamepad/model"

export interface GamepadStore {
  visible: boolean
  editing: boolean
  pads: Pad[]
}

const STORAGE_KEY = "lwfa.gamepad.layout"

function readPads(): Pad[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed: unknown = JSON.parse(raw)
    // Validated rather than trusted: a layout from an older version, or a
    // half-written one, must not leave the overlay unable to render.
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_LAYOUT
    const kept = parsed.filter(
      (pad): pad is Pad =>
        typeof pad === "object" &&
        pad !== null &&
        typeof (pad as Pad).id === "string" &&
        typeof (pad as Pad).x === "number" &&
        typeof (pad as Pad).y === "number",
    )
    return withPadsAddedSince(kept)
  } catch {
    return DEFAULT_LAYOUT
  }
}

/**
 * Give a saved layout the controls that did not exist when it was saved.
 *
 * The layout is stored whole, so anyone who had ever opened the gamepad kept
 * the exact set of pads from that day forever. L3 and R3 were added and simply
 * never appeared, which reads as the feature having been forgotten rather than
 * as a stale file. Start and Select would have done the same to anyone from
 * before those, and the next control added would do it again.
 *
 * Only missing ids are added, so an arrangement somebody has dragged into
 * shape is left exactly as they left it. Order does not matter here, unlike
 * the nav rail: pads are positioned absolutely, so a newcomer lands where it
 * was designed to go no matter where it sits in the array.
 */
function withPadsAddedSince(stored: Pad[]): Pad[] {
  const present = new Set(stored.map((pad) => pad.id))
  const missing = DEFAULT_LAYOUT.filter((pad) => !present.has(pad.id))
  return missing.length === 0 ? stored : [...stored, ...missing]
}

let current: GamepadStore = { visible: false, editing: false, pads: readPads() }
const listeners = new Set<() => void>()

export function setGamepad(patch: Partial<GamepadStore>): void {
  const next = { ...current, ...patch }
  if (
    next.visible === current.visible &&
    next.editing === current.editing &&
    next.pads === current.pads
  ) {
    return
  }
  current = next
  if (patch.pads) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(patch.pads))
    } catch {
      // Applies for this session even if it cannot be saved.
    }
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): GamepadStore => current

export function useGamepad(): GamepadStore {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Replace the layout, e.g. after a drag in the editor. */
export function useSetPads(): (pads: Pad[]) => void {
  return useCallback((pads: Pad[]) => setGamepad({ pads }), [])
}

/**
 * Read the stored layout again, for tests.
 *
 * `readPads` runs once at import, so a test that sets `localStorage` after the
 * module is loaded would be testing the value from before it did.
 */
export function __readForTest(): { pads: Pad[] } {
  return { pads: readPads() }
}
