/**
 * Which input surface is docked, if any.
 *
 * # Why this is not a panel
 *
 * The keyboard and the gamepad are not settings screens, they are *input
 * devices*. A device you type on has to be where your thumbs are: across the
 * bottom, full width, with the thing you are typing into visible above it. That
 * is where every on-screen keyboard on every platform puts itself, and it is
 * not a stylistic choice, it is the only place a two-thumb reach works.
 *
 * Putting them in the side sheet, which is what this used to do, gave the
 * keyboard a 26rem column to lay 60 keys out in and left the window you were
 * typing into hidden behind the overlay. Unusable for the exact job it exists
 * to do.
 *
 * So the rail's keyboard and gamepad buttons toggle this instead of opening a
 * panel, and the panels those buttons used to open now hold only settings,
 * reachable from the gear inside the dock.
 */

import { useSyncExternalStore } from "react"

export type DockSurface = "none" | "keyboard" | "gamepad" | "mouse"

let current: DockSurface = "none"
const listeners = new Set<() => void>()

export function setDock(next: DockSurface): void {
  if (next === current) return
  current = next
  for (const listener of listeners) listener()
}

/** Toggle one surface, closing whichever was open. */
export function toggleDock(surface: Exclude<DockSurface, "none">): void {
  setDock(current === surface ? "none" : surface)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): DockSurface => current

export function useDock(): DockSurface {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
