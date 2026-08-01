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
import type { AppEntry, AppIcon } from "@lwfa/proto"
import { objectUrlFor, readCached, revokeAll, writeCached } from "@/lib/iconCache"

let apps: AppEntry[] = []
let icons = new Map<string, string>()
let loading = false
let snapshot: { apps: AppEntry[]; icons: Map<string, string>; loading: boolean } = {
  apps,
  icons,
  loading,
}
const listeners = new Set<() => void>()

function emit(): void {
  // Replaced, not mutated: React compares by identity.
  snapshot = { apps, icons, loading }
  for (const listener of listeners) listener()
}

/**
 * Icons arriving from the engine.
 *
 * Merged rather than replacing, so a partial answer cannot briefly blank every
 * icon. Written to the device cache so the next connect asks for nothing, and
 * converted to blob URLs so the DOM holds a handle rather than a megabyte of
 * base64. See `lib/iconCache.ts`.
 */
export function setAppIcons(next: AppIcon[]): void {
  const merged = new Map(icons)
  for (const icon of next) merged.set(icon.id, objectUrlFor(icon.id, icon.data))
  icons = merged
  emit()

  // Remember the misses as well as the hits. Roughly a sixth of desktop
  // entries name an icon that is not installed anywhere, and without a
  // tombstone the shell asks the engine to resolve those same sixteen names on
  // every single reload, forever.
  const returned = new Set(next.map((icon) => icon.id))
  const tombstones = [...requested]
    .filter((id) => !returned.has(id))
    .map((id) => ({ id, data: MISSING }))
  requested.clear()

  void writeCached([...next, ...tombstones])
}

/**
 * Recorded when a request goes out, so the reply can tell which ids came back
 * empty. See the tombstones in `setAppIcons`.
 */
const requested = new Set<string>()

export function iconsRequested(ids: string[]): void {
  for (const id of ids) requested.add(id)
}

/** Cached value meaning "the engine has no icon for this". */
const MISSING = ""

/**
 * Fill in from the device cache, and report which ids are still missing.
 *
 * Called as soon as the application list arrives, so the launcher paints with
 * icons on the second visit without waiting for the network at all.
 */
export async function hydrateIcons(ids: string[]): Promise<string[]> {
  const cached = await readCached(ids)
  const usable = [...cached].filter(([, data]) => data !== MISSING)
  if (usable.length > 0) {
    const merged = new Map(icons)
    for (const [id, data] of usable) merged.set(id, objectUrlFor(id, data))
    icons = merged
    emit()
  }
  // A tombstone counts as known: do not ask again.
  return ids.filter((id) => !cached.has(id))
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
  icons = new Map()
  loading = false
  // Every one of these holds its bytes alive until revoked.
  revokeAll()
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const get = () => snapshot

export function useApps(): {
  apps: AppEntry[]
  icons: Map<string, string>
  loading: boolean
} {
  return useSyncExternalStore(subscribe, get, get)
}
