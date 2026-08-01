/**
 * A short in-memory log of what the shell saw.
 *
 * Not the engine's log. This is the browser's own view: connects, disconnects,
 * windows opening, permission refusals. It answers "what just happened" from
 * the device in your hand, which is exactly the moment you cannot get at the
 * machine's terminal to read the real one.
 *
 * Bounded and not persisted. An unbounded log in a tab that stays open for a
 * week is a memory leak with a nice UI.
 */

import { useSyncExternalStore } from "react"

export type LogLevel = "info" | "warn" | "error"

export interface LogEntry {
  at: string
  level: LogLevel
  message: string
}

const LIMIT = 200

let entries: LogEntry[] = []
const listeners = new Set<() => void>()

export function log(level: LogLevel, message: string): void {
  const at = new Date().toLocaleTimeString(undefined, { hour12: false })
  // Newest first, so the interesting end is the one you land on.
  entries = [{ at, level, message }, ...entries].slice(0, LIMIT)
  for (const listener of listeners) listener()
}

export function clearLog(): void {
  entries = []
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = () => entries

export function useLog(): LogEntry[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
