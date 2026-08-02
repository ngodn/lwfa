/**
 * Windows whose pixels this device has stopped asking for.
 *
 * # What pausing actually does
 *
 * Nothing to the application. The window keeps running on the desktop, keeps
 * playing its video and keeps doing its work; this device simply stops asking
 * the engine to send its pixels. The last frame received stays on screen, so a
 * paused window is a still picture rather than a gap.
 *
 * That makes it the cheapest control in the shell. A video playing in a column
 * you are not watching is the single most expensive thing a session can carry,
 * and it costs the engine an encoder session, the network its share of the
 * budget, and the tablet the power to decode it, all for something nobody is
 * looking at. Pausing hands every one of those to the window you *are* looking
 * at, because the budget is divided between the windows being streamed. See
 * `bitrate::allocate` in the engine.
 *
 * # Why this lives in the shell
 *
 * The engine already streams only what a client asks for, and the shell already
 * decides that list from what the viewport can see. Pausing is one more filter
 * on that list, so it needs nothing new on the wire and nothing new in the
 * engine.
 *
 * # Why per device
 *
 * Two people on two devices are looking at different things. A window paused on
 * a phone to save its battery has no business freezing on the laptop next to
 * it, and the engine sends each client its own set anyway.
 */

import { useSyncExternalStore } from "react"
import type { WindowId } from "@lwfa/proto"

let paused: ReadonlySet<WindowId> = new Set()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Stop asking for this window's pixels, or start again. */
export function setPaused(id: WindowId, value: boolean): void {
  if (paused.has(id) === value) return
  const next = new Set(paused)
  if (value) next.add(id)
  else next.delete(id)
  paused = next
  emit()
}

export function togglePaused(id: WindowId): void {
  setPaused(id, !paused.has(id))
}

/**
 * Forget a window.
 *
 * Called when one closes, or ids from a previous session would keep windows
 * paused that have nothing to do with them: they are only unique within a run
 * of the engine.
 */
export function forgetPaused(id: WindowId): void {
  setPaused(id, false)
}

/** Forget all of them, on disconnect. */
export function clearPaused(): void {
  if (paused.size === 0) return
  paused = new Set()
  emit()
}

/** Read without subscribing, for the code that builds the stream list. */
export function pausedNow(): ReadonlySet<WindowId> {
  return paused
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): ReadonlySet<WindowId> => paused

export function usePaused(): ReadonlySet<WindowId> {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
