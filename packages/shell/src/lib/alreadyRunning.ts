/**
 * The state of "that application is already open on the desktop".
 *
 * # The situation
 *
 * Applications that key "one instance" on their profile directory, which is
 * every Electron application and both major browsers, do not start a second
 * copy. The one already running is handed the request and opens a window
 * wherever it is. lwfa being a second session for the same user, that is the
 * other screen, so from a tablet the launch appears to do nothing at all.
 *
 * The engine notices and says so rather than spawning. This holds what happens
 * next.
 *
 * # Why the states are named rather than booleans
 *
 * Three flags would allow six impossible combinations, and the one that
 * matters, "we asked it to quit and it has not", is exactly the state a pair
 * of booleans loses. It is not a failure: an application with unsaved work
 * answers a polite request by opening a dialog, on the screen nobody is
 * looking at. Only that state may offer to force the issue.
 */

import { useSyncExternalStore } from "react"

export type Phase =
  /** The engine has told us, and nobody has decided anything yet. */
  | "asking"
  /** It has been asked to quit, and we are waiting. */
  | "closing"
  /** The grace period ended and it is still there. */
  | "stubborn"

export interface Blocked {
  /** The command to run once the way is clear, unchanged. */
  command: string
  terminal: boolean
  /** What to call it. */
  program: string
  pid: number
  phase: Phase
}

let current: Blocked | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * The engine says this application is already running.
 *
 * Arriving while we are already waiting on the same program means the grace
 * period ended and it is still there, so this is also how `closing` becomes
 * `stubborn`. That keeps the transition in one place rather than requiring the
 * caller to know which of two meanings a message has.
 */
export function blocked(next: Omit<Blocked, "phase">): void {
  const stubborn = current?.phase === "closing" && current.program === next.program
  current = { ...next, phase: stubborn ? "stubborn" : "asking" }
  emit()
}

/** The user asked for it to be closed. */
export function closing(): void {
  if (!current) return
  current = { ...current, phase: "closing" }
  emit()
}

/** Done with, either because it worked or because the user backed out. */
export function clearBlocked(): void {
  if (!current) return
  current = null
  emit()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): Blocked | null => current

export function useBlocked(): Blocked | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Read without subscribing. */
export function blockedNow(): Blocked | null {
  return current
}
