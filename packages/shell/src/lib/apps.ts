/**
 * The installed-application list, cached for the session.
 *
 * Scanning desktop entries is cheap but not free, and the launcher is opened
 * and closed repeatedly. Caching here means the second open is instant, and the
 * list is small enough that holding it costs nothing.
 *
 * A store rather than component state so the cache survives the panel being
 * unmounted, which is exactly what happens every time the sheet closes.
 */

import { useSyncExternalStore } from "react"
import type { AppEntry } from "@lwfa/proto"

let apps: AppEntry[] = []
let loading = false
let snapshot: { apps: AppEntry[]; loading: boolean } = { apps, loading }
const listeners = new Set<() => void>()

function emit(): void {
  // Replaced, not mutated: React compares by identity.
  snapshot = { apps, loading }
  for (const listener of listeners) listener()
}

/** Called when the engine answers with its application list. */
export function setApps(next: AppEntry[]): void {
  apps = next
  loading = false
  emit()
}

/** Called when a request goes out, so the panel can show it is working. */
export function appsRequested(): void {
  if (apps.length > 0) return
  loading = true
  emit()
}

/** Dropped on disconnect: another machine has a different list. */
export function clearApps(): void {
  apps = []
  loading = false
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const get = () => snapshot

export function useApps(): { apps: AppEntry[]; loading: boolean } {
  return useSyncExternalStore(subscribe, get, get)
}
