/**
 * "I asked, and I am waiting."
 *
 * # Why this is not just a boolean
 *
 * Everything the shell asks the engine for is fire and forget: there is no
 * request id on the wire, so nothing can correlate a reply with the press that
 * caused it. What the shell *can* observe is the world changing: a window
 * opens, the account list arrives, a session disappears. So "pending" here
 * means "I have asked and the thing I expected has not happened yet", and it
 * clears when the expected change shows up.
 *
 * # Why it times out
 *
 * Because the expected change might never come. An application can fail to
 * start, be killed by the OOM killer, or simply not have a window. A spinner
 * that never stops is worse than no spinner: it says the shell is broken when
 * the truth is that the thing you asked for did not happen. So each entry has
 * a deadline, after which it clears itself and the button goes back to being
 * pressable. The user tries again, which is the correct next move.
 *
 * Not a React state store per component, because the same key is often watched
 * from two places at once (the launcher tile and the app list row), and two
 * copies would disagree.
 */

import { useSyncExternalStore } from "react"

/** How long to wait before assuming the thing is not going to happen. */
const DEFAULT_TIMEOUT_MS = 15_000

const pending = new Map<string, number>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()

/**
 * Bumped on every change, and returned as the store snapshot.
 *
 * `useSyncExternalStore` compares snapshots with `Object.is`, so returning the
 * `Map` would compare equal to itself after a mutation and nothing would
 * re-render. A version number changes when the map does.
 */
let version = 0

function emit(): void {
  version++
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): number => version

/** Mark a key as awaited. Calling it again extends the deadline. */
export function markPending(key: string, timeoutMs = DEFAULT_TIMEOUT_MS): void {
  clearTimeout(timers.get(key))
  pending.set(key, Date.now())
  timers.set(
    key,
    setTimeout(() => {
      // Timed out rather than resolved. The button goes back to normal so it
      // can be pressed again, which is the only useful thing left to do.
      resolvePending(key)
    }, timeoutMs),
  )
  emit()
}

/** The awaited thing happened, or gave up. */
export function resolvePending(key: string): void {
  if (!pending.has(key) && !timers.has(key)) return
  clearTimeout(timers.get(key))
  timers.delete(key)
  pending.delete(key)
  emit()
}

/** Clear everything. Used when the connection goes away. */
export function resetPending(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  pending.clear()
  emit()
}

/** Whether this key is currently awaited. Re-renders when that changes. */
export function usePending(key: string): boolean {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  return pending.has(key)
}

/** Whether any key with this prefix is awaited, for a group of controls. */
export function usePendingPrefix(prefix: string): boolean {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  for (const key of pending.keys()) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

/** Read once, outside React. */
export function isPending(key: string): boolean {
  return pending.has(key)
}

/** Awaited keys with this prefix, oldest first. */
export function pendingKeys(prefix: string): string[] {
  return [...pending.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .sort((a, b) => a[1] - b[1])
    .map(([key]) => key)
}
