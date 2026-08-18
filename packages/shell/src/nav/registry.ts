/**
 * What the navigation can contain, and what survives when it runs out of room.
 *
 * The rail is one strip of buttons along an edge the user chooses. On a 27"
 * display every button fits with space to spare; on a phone in portrait, along
 * the bottom, roughly four do. Rather than scroll the rail, which hides
 * controls behind a gesture nobody will discover, buttons merge into grouped
 * ones that open a panel containing what was merged.
 *
 * The merge order is a priority decision, not a layout one, so it lives here
 * next to the catalogue instead of inside the component that measures pixels.
 */

import type { LucideIcon } from "lucide-react"
import {
  AppWindow,
  CornerUpLeft,
  Gamepad2,
  Grid3x3,
  Info,
  KeyboardIcon,
  MoreHorizontal,
  Network,
  Settings,
  SlidersHorizontal,
  SunMoon,
  Users,
} from "lucide-react"
import type { NavItemId } from "@/lib/prefs"

export interface NavItem {
  id: NavItemId
  label: string
  /** Shown in the tooltip under the label. Says what the button is *for*. */
  hint: string
  icon: LucideIcon
  /**
   * What this button does when pressed.
   *
   * Most open a panel. `dock` puts an input surface on screen instead, and
   * `action` just does the thing, with no UI of its own. Encoded here rather
   * than as a list of special cases in the rail, so adding another action is a
   * table entry.
   */
  kind?: "panel" | "dock" | "action"
  /**
   * Rendered instead of the icon.
   *
   * For controls whose meaning *is* their legend. There is no icon for Escape
   * that anyone would read as Escape, and a keycap is how every keyboard has
   * labelled it for forty years.
   */
  glyph?: string
}

export const NAV_ITEMS: Record<NavItemId, NavItem> = {
  info: {
    id: "info",
    label: "Session",
    hint: "Connection health, stream stats and the engine log",
    icon: Info,
  },
  connections: {
    id: "connections",
    label: "Connections",
    hint: "Machines you can reach, and which one you are on",
    icon: Network,
  },
  access: {
    id: "access",
    label: "Access",
    hint: "Who may connect, and what they are allowed to do",
    icon: Users,
  },
  theme: {
    id: "theme",
    label: "Appearance",
    hint: "Theme, movement and touch feedback",
    icon: SunMoon,
  },
  settings: {
    id: "settings",
    label: "Settings",
    hint: "Navigation, input and stream preferences",
    icon: Settings,
  },
  apps: {
    id: "apps",
    label: "Apps",
    hint: "Launch something on the remote machine",
    icon: Grid3x3,
  },
  escape: {
    id: "escape",
    label: "Escape",
    hint: "Send Escape. Closes menus and dialogs, and leaves vim's insert mode",
    // Never drawn: `glyph` wins. Present because every item has an icon, and
    // there is no icon anyone reads as "Escape" — a keycap is how keyboards
    // have labelled it for forty years.
    icon: CornerUpLeft,
    kind: "action",
    glyph: "ESC",
  },
  gamepad: {
    id: "gamepad",
    label: "Gamepad",
    hint: "On-screen controller, with an editable layout",
    icon: Gamepad2,
    kind: "dock",
  },
  keyboard: {
    id: "keyboard",
    label: "Keyboard",
    hint: "On-screen keyboard, including held modifier combos",
    icon: KeyboardIcon,
    kind: "dock",
  },
  workspaces: {
    id: "workspaces",
    label: "Windows",
    hint: "Workspaces, window arrangement and focus",
    icon: AppWindow,
  },
}

/**
 * Buttons that stand for several others once the rail is short.
 *
 * `input` and `more` are not items the user can reorder; they appear only when
 * their members have been folded away, and opening one shows those members.
 */
export type NavGroupId = "input" | "more"

export interface NavGroup {
  id: NavGroupId
  label: string
  hint: string
  icon: LucideIcon
  members: NavItemId[]
}

export const NAV_GROUPS: Record<NavGroupId, NavGroup> = {
  input: {
    id: "input",
    label: "Input",
    hint: "Keyboard and gamepad",
    icon: SlidersHorizontal,
    members: ["keyboard", "gamepad"],
  },
  more: {
    id: "more",
    label: "More",
    hint: "Everything else",
    icon: MoreHorizontal,
    // Order matters: this is the order they appear inside the panel.
    members: ["info", "connections", "access", "theme", "settings"],
  },
}

/**
 * Which of the rail's three zones a slot belongs to.
 *
 * Three, not two, because the launcher is neither configuration nor a control
 * you reach for mid-task: it sits in the middle with space either side.
 *
 * A group inherits the zone of its members: `input` holds the keyboard and
 * gamepad, which are anchored, so the button that replaces them is anchored
 * too. Collapsing the rail must not move a control out from under the thumb.
 */
export type NavZone = "start" | "centre" | "end"

export function zoneOf(
  slot: NavSlot,
  anchored: NavItemId[],
  centred: NavItemId[],
): NavZone {
  const ends = new Set(anchored)
  const middles = new Set(centred)
  const ids = slot.kind === "item" ? [slot.id] : slot.members
  if (ids.some((id) => ends.has(id))) return "end"
  if (ids.some((id) => middles.has(id))) return "centre"
  return "start"
}

/** Anything the rail can show: a single item, or a group standing for several. */
export type NavSlot =
  | { kind: "item"; id: NavItemId; item: NavItem }
  | { kind: "group"; id: NavGroupId; group: NavGroup; members: NavItemId[] }

/**
 * The tiers, roomiest first.
 *
 * Tier 0 is everything laid out individually. Each subsequent tier gives up one
 * more distinction, ending with the three things you cannot operate the machine
 * without: launch something, manage what is open, and type into it.
 *
 * These are exactly the priorities in the design sketch, written down where the
 * layout code can consult them rather than reimplementing them.
 */
const TIERS: ReadonlyArray<ReadonlyArray<NavItemId | NavGroupId>> = [
  // Everything, in the user's own order. Filled in by `slotsForTier`.
  [],
  // Keyboard and gamepad share a button; the rest stay put.
  [
    "info",
    "connections",
    "access",
    "theme",
    "settings",
    "apps",
    "escape",
    "input",
    "workspaces",
  ],
  // The management panels collapse together. Escape survives this tier: it is
  // one tap and it is what gets you out of whatever is in the way.
  ["apps", "escape", "workspaces", "input", "more"],
  // The floor. Losing any of these makes the session unusable rather than
  // merely inconvenient, so the rail never collapses further; it scrolls.
  // Escape goes here, because the keyboard always has one.
  ["apps", "workspaces", "more"],
]

export const TIER_COUNT = TIERS.length

const EMPTY_EXPANDED: ReadonlySet<NavGroupId> = new Set<NavGroupId>()

/**
 * Groups worth un-merging again when the chosen tier left room to spare.
 *
 * The tiers are coarse by design, so the rail routinely lands on one that fits
 * with a hundred pixels going begging: a phone in portrait has room for seven
 * buttons and tier 2 draws five. Merging a control nobody asked to merge is not
 * free either. `keyboard` and `gamepad` put their surface on screen with one
 * tap, and folding them into `input` turns that tap into "open a settings panel
 * and find the switch" — the cost is much higher than it is for `more`, whose
 * members open panels regardless.
 *
 * So: hardest-to-lose first, and the rail expands while the buttons still fit.
 */
const EXPAND_ORDER: ReadonlyArray<NavGroupId> = ["input", "more"]

/**
 * Which groups to lay out in full, given how many buttons the rail can hold.
 *
 * `fits` answers "can the rail draw this many buttons", which only the
 * component measuring pixels can know.
 */
export function expandGroups(
  tier: number,
  order: NavItemId[],
  hidden: NavItemId[],
  fits: (count: number) => boolean,
): ReadonlySet<NavGroupId> {
  if (tier <= 0) return EMPTY_EXPANDED

  const expanded = new Set<NavGroupId>()
  for (const group of EXPAND_ORDER) {
    const candidate = new Set(expanded).add(group)
    if (fits(slotsForTier(tier, order, hidden, candidate).length)) {
      expanded.add(group)
    }
  }
  return expanded
}

function isGroup(id: NavItemId | NavGroupId): id is NavGroupId {
  return id === "input" || id === "more"
}

/**
 * The slots for one tier, honouring the user's order and hidden set.
 *
 * A group only appears if at least one of its members is actually present;
 * hiding both the keyboard and the gamepad should remove the Input button
 * rather than leave a button that opens an empty panel.
 */
export function slotsForTier(
  tier: number,
  order: NavItemId[],
  hidden: NavItemId[],
  expanded: ReadonlySet<NavGroupId> = EMPTY_EXPANDED,
): NavSlot[] {
  const isHidden = new Set(hidden)
  const visible = order.filter((id) => !isHidden.has(id))

  if (tier <= 0) {
    return visible.map((id) => ({ kind: "item", id, item: NAV_ITEMS[id] }))
  }

  const allowed = TIERS[Math.min(tier, TIERS.length - 1)]!
  const slots: NavSlot[] = []
  const emitted = new Set<string>()

  // Walk the *user's* order so a collapsed rail still reads left-to-right the
  // way they arranged it. A group takes the position of its first member.
  for (const id of visible) {
    const owner = allowed.find((slot) => {
      if (slot === id) return true
      return isGroup(slot) && NAV_GROUPS[slot].members.includes(id)
    })
    if (!owner || emitted.has(owner)) continue
    emitted.add(owner)

    if (isGroup(owner)) {
      const members = NAV_GROUPS[owner].members.filter((m) => !isHidden.has(m))
      if (members.length === 0) continue
      // One surviving member does not need a menu wrapped round it, and neither
      // does a group the rail found room to lay out in full.
      if (members.length === 1 || expanded.has(owner)) {
        // The user's order, not the group's: the group's is a panel tab order.
        const set = new Set(members)
        for (const m of visible) {
          if (set.has(m)) slots.push({ kind: "item", id: m, item: NAV_ITEMS[m] })
        }
        continue
      }
      slots.push({ kind: "group", id: owner, group: NAV_GROUPS[owner], members })
    } else {
      slots.push({ kind: "item", id: owner, item: NAV_ITEMS[owner] })
    }
  }

  return slots
}
