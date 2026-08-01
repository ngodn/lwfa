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
    return parsed.filter(
      (pad): pad is Pad =>
        typeof pad === "object" &&
        pad !== null &&
        typeof (pad as Pad).id === "string" &&
        typeof (pad as Pad).x === "number" &&
        typeof (pad as Pad).y === "number",
    )
  } catch {
    return DEFAULT_LAYOUT
  }
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
