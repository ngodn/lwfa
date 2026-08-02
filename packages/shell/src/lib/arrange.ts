/**
 * Whether the desktop is in arrange mode.
 *
 * # What the mode is
 *
 * The strip zooms out until every column fits, and each window grows controls
 * that act on it. Under scrollable tiling the columns run off both edges, so
 * this is the only view in which the whole desktop is visible at once, which
 * is what makes rearranging it by hand possible at all.
 *
 * # Why this is a store and not `useState` in a component
 *
 * The flag is read by the desktop, set by the navigation rail, and set again by
 * the windows panel. Held as component state it would have to live above all
 * three, which is `App`, and every change to it would re-render every streaming
 * window surface underneath. An external store read with `useSyncExternalStore`
 * lets exactly the components that care subscribe, the same reasoning as
 * preferences and the gamepad.
 *
 * # Why it does not persist
 *
 * Coming back to a desktop already zoomed out, with no memory of having asked
 * for it, is a puzzle rather than a convenience. Same call as the gamepad's
 * edit mode.
 */

import { useSyncExternalStore } from "react"
import type { WindowId } from "@lwfa/proto"

let active = false

/**
 * The window being dragged right now, if any.
 *
 * Lives here rather than in the layer that owns the drag because the workspace
 * chips are drawn by a different component entirely, and a chip has to know
 * both that a drag is in progress and which window it is holding in order to
 * be a drop target. Passing it down would mean threading a live drag through
 * the desktop, which re-renders it on every pointer move.
 */
let carried: WindowId | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Enter or leave arrange mode. */
export function setArrange(next: boolean): void {
  if (next === active) return
  active = next
  // Leaving mid-drag would otherwise strand a window as "being carried" with
  // nothing to drop it on.
  if (!next) carried = null
  emit()
}

export function toggleArrange(): void {
  setArrange(!active)
}

/** Say what is being dragged, or `null` when nothing is. */
export function setCarried(id: WindowId | null): void {
  if (id === carried) return
  carried = id
  emit()
}

export function useCarried(): WindowId | null {
  return useSyncExternalStore(subscribe, () => carried, () => carried)
}

/** Read without subscribing, for event handlers that only need the value. */
export function arranging(): boolean {
  return active
}

/**
 * Exported because it is the store's contract, not an implementation detail:
 * `useSyncExternalStore` calls it, and a test that wants to prove the store
 * does not notify twice has to call the same function the hook does.
 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): boolean => active

export function useArranging(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Drop the mode. Called when the thing being arranged goes away. */
export function resetArrange(): void {
  carried = null
  setArrange(false)
}
