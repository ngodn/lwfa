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

const EDGES: readonly NavEdge[] = ["left", "right", "top", "bottom"]

/**
 * Resolve an edge preference against a viewport.
 *
 * Validates rather than trusting. Preferences come from `localStorage`, which
 * means they can be older than the code, newer than the code, or hand-edited,
 * and an unrecognised value must not reach a component that will position
 * itself with it. The failure mode is nasty and was seen in practice: a stale
 * hot-reload left one component new enough to write `"auto"` and another old
 * enough to pass it straight to a sheet as a side, which is not a direction, so
 * the panel laid itself out off-screen and the shell looked broken.
 */
export function resolveEdge(pref: NavEdgePref | string, portrait: boolean): NavEdge {
  if (EDGES.includes(pref as NavEdge)) return pref as NavEdge
  return portrait ? "bottom" : "left"
}
export type ThemeMode = "light" | "dark" | "system"
export type GamepadSkin = "playstation" | "xbox" | "neutral"

/** Where an input surface sits relative to the desktop. See `Prefs.gamepad`. */
export type SurfacePlacement = "overlay" | "stacked"

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
  "mouse",
  "keyboard",
  "clipboard",
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
    /**
     * What the pad actually sends.
     *
     * `controller` creates a virtual gamepad on the machine, which is what
     * Steam and anything built with SDL look for, and is the only mode that
     * can express an analog stick. `keyboard` sends the keycodes each control
     * is bound to, which is what emulators and older titles want, and is the
     * fallback when the machine will not allow a virtual device.
     */
    mode: "controller" | "keyboard"
    /**
     * Whether this surface floats over the desktop or displaces it.
     *
     * `overlay` draws it on top: the desktop keeps every pixel and the surface
     * sits over the corners of it. `stacked` gives it a row of its own and the
     * desktop shrinks to what is left, so nothing is ever covered.
     *
     * Neither is right for both orientations, which is why it is a setting
     * rather than a rule. Held in landscape there is width to spare and height
     * is precious, so a controller wants to float over the game. Held upright
     * there is height to spare and the game is a letterbox in the middle
     * anyway, so a controller below it costs nothing and stops thumbs sitting
     * on the picture.
     *
     * The defaults are what each surface used to do unconditionally: a
     * keyboard displaced the desktop, because typing means watching the line
     * you are editing, and a controller floated, because a game wants every
     * pixel. Both are now available to both.
     */
    placement: SurfacePlacement
    /**
     * Swallow taps that land between the pads instead of passing them through.
     *
     * A floating controller deliberately lets pointers through the gaps, so a
     * tap on the game behind it still reaches the game. That is right for a
     * desktop and wrong for the thing a controller is usually over.
     *
     * Many games switch input mode on the first mouse event they see: the
     * gamepad prompts vanish, the pad stops being read, and it takes another
     * click somewhere to switch back. Wuchang and Assassin's Creed Odyssey
     * both do it. So one thumb landing a few millimetres wide of a pad does
     * not merely miss the button, it takes the controller away mid-fight.
     *
     * On, the area under the pads absorbs everything the pads themselves do
     * not take, and nothing reaches the window. Off is the old behaviour and
     * stays the default, because silently eating input is a surprising thing
     * for a desktop to do and only a game wants it.
     */
    shield: boolean
  }
  keyboard: {
    /** Keep modifiers latched until tapped again, for one-finger combos. */
    stickyModifiers: boolean
    haptics: boolean
    /** See `gamepad.placement`. */
    placement: SurfacePlacement
  }
  /**
   * The virtual mouse: a tap where you want, but as a real mouse click.
   *
   * Unlike a trackpad it keeps direct positioning, the finger is still the
   * target, and unlike plain touch it fires a chosen mouse button at that
   * exact point. The button, hover and drag-lock modes are session state (see
   * `lib/mouse.ts`); only the persistent preferences live here.
   */
  mouse: {
    /** See `gamepad.placement`. */
    placement: SurfacePlacement
    haptics: boolean
    /**
     * Vertical scroll speed, a multiplier on the raw finger travel.
     *
     * Defaults to the desktop's own `scroll_factor`, so a flick moves the same
     * distance it would on the real mouse.
     */
    scrollSpeed: number
    /** Contents follow the finger rather than opposing it. */
    naturalScroll: boolean
    /** The button a tap fires when the surface is first opened. */
    defaultButton: "left" | "right" | "middle"
    /**
     * Where each control cluster sits, as a percentage of the surface.
     *
     * Rearranged in the surface's edit mode and kept here, the same way the
     * gamepad keeps its pad positions. Clusters rather than single buttons: the
     * three (the click selector, the tools, the modifiers) move as units, which
     * is all the arranging a mouse needs.
     */
    positions: {
      selector: { x: number; y: number }
      tools: { x: number; y: number }
      modifiers: { x: number; y: number }
    }
  }
  stream: {
    /**
     * Whether to ask for pixels at all.
     *
     * Off is a real mode, not a debug switch: a second device left open on a
     * desk does not need to be decoding video, and on a phone it is the
     * difference between a warm pocket and a cold one. The session stays
     * connected and the layout stays live; only the frames stop.
     */
    enabled: boolean
    /**
     * Which encoding to ask for.
     *
     * `auto` means H.264 when the browser can decode it. `jpeg` forces the
     * fallback, which is worth having as a choice rather than only as a
     * consequence: H.264 is far cheaper on bandwidth but it is lossy in a way
     * that smears text, and on a fast LAN a still terminal looks better as
     * JPEG. It is also the first thing to try when video goes wrong.
     */
    /**
     * Which codec to ask for.
     *
     * "auto" takes the best the device can decode. Naming one pins it, which
     * is useful for comparing them by eye. "jpeg" turns video off entirely and
     * keeps text at its sharpest.
     *
     * A choice can only narrow what the hardware offers, never widen it: ask
     * for HEVC on a device without an HEVC decoder and you get JPEG, because
     * the alternative is a black window.
     */
    codec: "auto" | "hevc" | "h264" | "jpeg"
    /**
     * Whether to hear the machine.
     *
     * Off by default, and deliberately so. This carries every sound the
     * machine makes, not only the ones lwfa's own windows produce, because
     * there is no reliable link from a Wayland window to the audio node its
     * client writes to. A page that started playing the room the moment it
     * loaded would be a surprise of the worst kind.
     */
    audio: boolean
    /** Playback volume for that audio, 0 to 1. Per device. */
    volume: number
    /**
     * Also play the session's audio on the machine's own speakers.
     *
     * Off by default. Applications lwfa starts are pointed at a private audio
     * device that goes nowhere, so the machine is silent and only whoever is
     * listening remotely hears anything. Turning this on adds a loopback from
     * that device back to the real output.
     *
     * Machine-wide rather than per device: there is one set of speakers.
     */
    localPlayback: boolean
    /**
     * How many bits the sound deserves.
     *
     * "auto" follows the connection the way the video does: sound degrades
     * last, since broken audio is more jarring than a softer picture. The
     * named levels pin it, for anyone who would rather trade the bits by
     * hand. The engine honours the lowest request among everyone listening.
     */
    audioQuality: "auto" | "high" | "medium" | "low"
    /**
     * Stream only the focused window; the rest freeze on their last frame.
     *
     * On by default because it is the single biggest performance lever the
     * shell has. An unfocused window that stops being streamed is also told
     * by the engine to stop *rendering* (the xdg `suspended` state), so this
     * frees the GPU, the encoder, the network and this device's decoder all
     * at once. Focus a window and it resumes instantly.
     *
     * Off means every visible window streams live, which reads nicer on a
     * big screen with a wired connection and is exactly what makes a session
     * with five windows lag everywhere else.
     */
    pauseInactive: boolean
  }
  motion: {
    /**
     * Animate window movement.
     *
     * Separate from the operating system's reduced-motion setting, which is
     * always obeyed regardless. This is for someone who wants motion in
     * general and not here.
     */
    animate: boolean
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
    anchored: ["escape", "gamepad", "mouse", "keyboard", "clipboard", "workspaces"],
    centred: ["apps"],
    size: "md",
  },
  gamepad: {
    skin: "neutral",
    opacity: 0.85,
    haptics: true,
    mode: "controller",
    placement: "overlay",
    shield: false,
  },
  keyboard: {
    stickyModifiers: true,
    haptics: true,
    placement: "stacked",
  },
  mouse: {
    placement: "overlay",
    haptics: true,
    // Mirrors the desktop's `scroll_factor = 0.4`.
    scrollSpeed: 0.4,
    naturalScroll: false,
    defaultButton: "left",
    positions: {
      selector: { x: 92, y: 50 },
      tools: { x: 8, y: 50 },
      modifiers: { x: 50, y: 90 },
    },
  },
  stream: {
    enabled: true,
    codec: "auto",
    audio: false,
    volume: 1,
    localPlayback: false,
    audioQuality: "auto",
    pauseInactive: true,
  },
  motion: {
    animate: true,
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
    nav: {
      ...DEFAULT_PREFS.nav,
      ...stored.nav,
      edge: sanitiseEdge(stored.nav?.edge),
      order,
      anchored,
      centred,
    },
    gamepad: { ...DEFAULT_PREFS.gamepad, ...stored.gamepad },
    keyboard: { ...DEFAULT_PREFS.keyboard, ...stored.keyboard },
    mouse: { ...DEFAULT_PREFS.mouse, ...stored.mouse },
    stream: { ...DEFAULT_PREFS.stream, ...stored.stream },
    motion: { ...DEFAULT_PREFS.motion, ...stored.motion },
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
/** An edge preference we recognise, or `auto`. */
function sanitiseEdge(stored: unknown): NavEdgePref {
  return stored === "auto" || EDGES.includes(stored as NavEdge)
    ? (stored as NavEdgePref)
    : DEFAULT_PREFS.nav.edge
}

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
 * For panels and other small trees that read a bit of everything. Anything
 * mounted permanently should use {@link usePrefSection} instead: this hook
 * re-renders its component on *every* preference write, and the writes are not
 * all rare. The gamepad opacity slider writes on every pointer move, and with
 * `App` subscribed here each of those moves re-rendered the entire shell over
 * the live video, which read as stream lag on a tablet.
 */
export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/**
 * Subscribe to one section of the preferences.
 *
 * `patchPrefs` replaces only the section it touches and keeps the identity of
 * every other, so React's own snapshot comparison makes this precise: a write
 * to `gamepad` wakes the components reading `gamepad` and no one else. That is
 * the entire mechanism; there is no selector machinery to keep in sync.
 *
 * The exception is another tab writing preferences, which replaces the whole
 * object and re-renders every subscriber once. Cross-tab writes are rare and
 * correctness matters more than precision there.
 */
export function usePrefSection<K extends keyof Prefs>(section: K): Prefs[K] {
  return useSyncExternalStore(
    subscribe,
    () => current[section],
    () => current[section],
  )
}
