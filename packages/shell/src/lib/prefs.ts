/**
 * User preferences: what the shell looks like and where its chrome sits.
 *
 * # Why an external store rather than context
 *
 * Preferences change rarely and are read almost everywhere. Putting them in a
 * React context means every provider re-render walks every consumer, and the
 * consumers here include the surfaces showing live video. `useSyncExternalStore`
 * subscribes each component directly, so changing the nav edge re-renders the
 * nav and nothing else. React 19 is happy to tear down a lot of work for one
 * `setState`; this makes sure it never has the excuse.
 *
 * # Why localStorage and not the server
 *
 * These are per-device, not per-account. A phone wants the bar along the bottom
 * where a thumb is; the same person on a 27" display wants it down the side.
 * Syncing them would make one device's ergonomics fight the other's. Things
 * that *are* per-account, like which machines you may connect to, live in the
 * engine's database instead.
 */

import { useSyncExternalStore } from "react"

export type NavEdge = "left" | "right" | "top" | "bottom"
export type ThemeMode = "light" | "dark" | "system"
export type GamepadSkin = "playstation" | "xbox" | "neutral"

/** Every button the nav can hold. Order here is only the factory default. */
export const NAV_ITEM_IDS = [
  "info",
  "connections",
  "access",
  "theme",
  "settings",
  "apps",
  "gamepad",
  "keyboard",
  "workspaces",
] as const

export type NavItemId = (typeof NAV_ITEM_IDS)[number]

export interface Prefs {
  theme: ThemeMode
  nav: {
    edge: NavEdge
    /** Explicit order, so a reorder survives a reload. */
    order: NavItemId[]
    /** Ids the user has switched off entirely. */
    hidden: NavItemId[]
    /**
     * Ids pinned to the far end of the rail, with the free space above them.
     *
     * This is a reachability decision, not decoration. On a held tablet or a
     * phone the far end of the rail is where the thumb rests, so the controls
     * you use constantly while actually working (window management, keyboard,
     * gamepad) belong there, and the ones you touch once a week (accounts,
     * appearance, settings) belong at the other end, out of accidental reach.
     */
    anchored: NavItemId[]
    /** Bigger targets for touch, smaller for a mouse. */
    size: "sm" | "md" | "lg"
  }
  gamepad: {
    skin: GamepadSkin
    /** Opacity of the pad over the game, 0.2â€“1. */
    opacity: number
    haptics: boolean
  }
  keyboard: {
    /** Keep modifiers latched until tapped again, for one-finger combos. */
    stickyModifiers: boolean
    haptics: boolean
  }
  /** Show the engine's own strip scroll position rather than a fitted layout. */
  followEngineScroll: boolean
}

export const DEFAULT_PREFS: Prefs = {
  theme: "system",
  nav: {
    edge: "left",
    order: [...NAV_ITEM_IDS],
    hidden: [],
    anchored: ["gamepad", "keyboard", "workspaces"],
    size: "md",
  },
  gamepad: {
    skin: "neutral",
    opacity: 0.85,
    haptics: true,
  },
  keyboard: {
    stickyModifiers: true,
    haptics: true,
  },
  followEngineScroll: false,
}

const STORAGE_KEY = "lwfa.prefs"

/**
 * Merge a stored value over the defaults, one level into each section.
 *
 * Not `{...DEFAULT, ...stored}`: that replaces whole sections, so a preferences
 * blob written before a key existed would leave that key `undefined` and every
 * reader would need a fallback. Adding a preference must not break a device
 * that has already saved its settings.
 */
function hydrate(raw: unknown): Prefs {
  if (typeof raw !== "object" || raw === null) return DEFAULT_PREFS
  const stored = raw as Partial<Prefs>
  const order = sanitiseOrder(stored.nav?.order)
  return {
    theme: stored.theme ?? DEFAULT_PREFS.theme,
    nav: { ...DEFAULT_PREFS.nav, ...stored.nav, order },
    gamepad: { ...DEFAULT_PREFS.gamepad, ...stored.gamepad },
    keyboard: { ...DEFAULT_PREFS.keyboard, ...stored.keyboard },
    followEngineScroll: stored.followEngineScroll ?? DEFAULT_PREFS.followEngineScroll,
  }
}

/**
 * Make a stored order usable: drop ids that no longer exist, append ids that
 * did not exist when it was saved.
 *
 * Without the second half, a new button would be invisible to everyone who had
 * ever opened the shell before it shipped, which is the kind of bug that gets
 * reported as "the feature does not work".
 */
function sanitiseOrder(stored: NavItemId[] | undefined): NavItemId[] {
  const known = new Set<string>(NAV_ITEM_IDS)
  const kept = (stored ?? []).filter((id) => known.has(id))
  const seen = new Set(kept)
  return [...kept, ...NAV_ITEM_IDS.filter((id) => !seen.has(id))]
}

function read(): Prefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    return hydrate(raw ? JSON.parse(raw) : null)
  } catch {
    // Private browsing, quota, or a half-written blob. Defaults are always
    // usable, and refusing to render because a preference is corrupt would be
    // a much worse outcome than ignoring it.
    return DEFAULT_PREFS
  }
}

let current: Prefs = read()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Replace preferences wholesale. `update` receives the current value. */
export function setPrefs(update: (prev: Prefs) => Prefs): void {
  const next = update(current)
  if (next === current) return
  current = next
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Not fatal: the change applies for this session, it just will not persist.
  }
  emit()
}

/** Patch one section without disturbing the others. */
export function patchPrefs<K extends keyof Prefs>(
  section: K,
  patch: Prefs[K] extends object ? Partial<Prefs[K]> : Prefs[K],
): void {
  setPrefs((prev) => {
    const before = prev[section]
    const after =
      typeof before === "object" && before !== null
        ? { ...(before as object), ...(patch as object) }
        : patch
    return { ...prev, [section]: after } as Prefs
  })
}

export function resetPrefs(): void {
  setPrefs(() => DEFAULT_PREFS)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Another tab changing preferences should not leave this one stale.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return
    current = read()
    emit()
  }
  globalThis.addEventListener?.("storage", onStorage)
  return () => {
    listeners.delete(listener)
    globalThis.removeEventListener?.("storage", onStorage)
  }
}

const snapshot = (): Prefs => current

/**
 * The current preferences, outside React.
 *
 * For event handlers that need to compute the next value from the latest one
 * rather than from whatever the render closed over. Pressing a move button
 * twice quickly must apply the second move to the result of the first.
 */
export function getPrefs(): Prefs {
  return current
}

/**
 * Subscribe to all preferences.
 *
 * `current` is replaced rather than mutated, so the identity check React does
 * is enough and there is no need for a selector layer. If a hot path ever needs
 * one, add `usePref(selector)` here rather than reaching into the store.
 */
export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
