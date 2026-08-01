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
import {
  CENTRE_FOCUSED,
  DEFAULT_WIDTH,
  ORIENTATION,
} from "@/generated/config.ts"

/** A concrete edge. What the rail actually renders against. */
export type NavEdge = "left" | "right" | "top" | "bottom"

/**
 * What the user asked for, which may be "work it out".
 *
 * `auto` follows the viewport: a side rail in landscape, where height is
 * plentiful and width is not, and the bottom in portrait, where it is the other
 * way round and the bottom is also where a thumb rests. Pinning a vertical rail
 * on a phone held upright spends the one axis that is already scarce.
 */
export type NavEdgePref = NavEdge | "auto"

/** Resolve `auto` against a viewport. */
export function resolveEdge(pref: NavEdgePref, portrait: boolean): NavEdge {
  if (pref !== "auto") return pref
  return portrait ? "bottom" : "left"
}
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
  "escape",
  "gamepad",
  "keyboard",
  "workspaces",
] as const

export type NavItemId = (typeof NAV_ITEM_IDS)[number]

export interface Prefs {
  theme: ThemeMode
  nav: {
    edge: NavEdgePref
    /** Explicit order, so a reorder survives a reload. */
    order: NavItemId[]
    /** Ids the user has switched off entirely. */
    hidden: NavItemId[]
    /**
     * Ids pinned to the far end of the rail, with free space before them.
     *
     * This is a reachability decision, not decoration. On a held tablet or a
     * phone the far end of the rail is where the thumb rests, so the controls
     * used constantly while actually working (window management, keyboard,
     * gamepad, escape) belong there, and the ones touched once a week
     * (accounts, appearance, settings) belong at the other end, out of
     * accidental reach.
     */
    anchored: NavItemId[]
    /**
     * Ids pinned to the middle, with free space on both sides.
     *
     * The launcher is neither: it is not configuration you set once, and it is
     * not something you reach for mid-task without looking. Its own zone keeps
     * it findable without putting it under a thumb that is busy.
     */
    centred: NavItemId[]
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
  /**
   * Layout policy the user can change at runtime.
   *
   * Seeded from `configs/defaults.toml`, which is the machine's default, and
   * then owned by the device. Two people on the same machine can want different
   * things here, and one of them is holding a phone.
   */
  layout: {
    /** `auto` follows the viewport's long axis. */
    orientation: "auto" | "horizontal" | "vertical"
    /** Index into the width presets. */
    defaultWidth: number
    centreFocused: boolean
  }
  /** Show the engine's own strip scroll position rather than a fitted layout. */
  followEngineScroll: boolean
}

export const DEFAULT_PREFS: Prefs = {
  theme: "system",
  nav: {
    edge: "auto",
    order: [...NAV_ITEM_IDS],
    hidden: [],
    anchored: ["escape", "gamepad", "keyboard", "workspaces"],
    centred: ["apps"],
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
  layout: {
    orientation: ORIENTATION,
    defaultWidth: DEFAULT_WIDTH,
    centreFocused: CENTRE_FOCUSED,
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
  const anchored = sanitiseZone(stored.nav?.order, stored.nav?.anchored, "anchored")
  const centred = sanitiseZone(stored.nav?.order, stored.nav?.centred, "centred")
  return {
    theme: stored.theme ?? DEFAULT_PREFS.theme,
    nav: { ...DEFAULT_PREFS.nav, ...stored.nav, order, anchored, centred },
    gamepad: { ...DEFAULT_PREFS.gamepad, ...stored.gamepad },
    keyboard: { ...DEFAULT_PREFS.keyboard, ...stored.keyboard },
    layout: { ...DEFAULT_PREFS.layout, ...stored.layout },
    followEngineScroll: stored.followEngineScroll ?? DEFAULT_PREFS.followEngineScroll,
  }
}

/**
 * Make a stored order usable: drop ids that no longer exist, and place ids that
 * did not exist when it was saved.
 *
 * The interesting half is placement. Appending is the obvious thing and it is
 * wrong: a new button belongs where it was *designed* to go, not at the end.
 * Escape shipped as "immediately before the gamepad", and appending put it
 * after the window controls for everyone who had ever opened the shell before
 * — which looks exactly like the feature being broken.
 *
 * So a new id is inserted after whichever of its default predecessors the user
 * still has, which keeps their arrangement intact and still lands the newcomer
 * next to the thing it belongs with.
 */
function sanitiseOrder(stored: NavItemId[] | undefined): NavItemId[] {
  const known = new Set<string>(NAV_ITEM_IDS)
  const result = (stored ?? []).filter((id) => known.has(id))
  if (result.length === 0) return [...NAV_ITEM_IDS]

  const present = new Set(result)
  for (const [index, id] of NAV_ITEM_IDS.entries()) {
    if (present.has(id)) continue
    // The nearest earlier neighbour from the default order that survives in
    // the user's list. Insert just after it; fall back to the front.
    let at = 0
    for (let before = index - 1; before >= 0; before--) {
      const anchor = NAV_ITEM_IDS[before]!
      const found = result.indexOf(anchor)
      if (found !== -1) {
        at = found + 1
        break
      }
    }
    result.splice(at, 0, id)
    present.add(id)
  }
  return result
}

/**
 * Keep the user's anchoring, and apply the default for buttons they have never
 * seen.
 *
 * Same problem as the order: a new control that is anchored by design must not
 * arrive un-anchored just because the saved list predates it, or it lands at
 * the wrong end of the rail and out of thumb reach.
 */
function sanitiseZone(
  storedOrder: NavItemId[] | undefined,
  stored: NavItemId[] | undefined,
  zone: "anchored" | "centred",
): NavItemId[] {
  const known = new Set<string>(NAV_ITEM_IDS)
  if (!stored) return [...DEFAULT_PREFS.nav[zone]]

  const kept = stored.filter((id) => known.has(id))
  // "Never seen" means absent from the saved *order*, which lists every button
  // the user has ever had. Absent from this zone alone would mean anything they
  // deliberately moved out of it gets moved back on the next release.
  const seen = new Set(storedOrder ?? [])
  const fresh = DEFAULT_PREFS.nav[zone].filter((id) => !seen.has(id))
  return [...new Set([...kept, ...fresh])]
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
