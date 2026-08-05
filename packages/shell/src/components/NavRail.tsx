/**
 * The navigation rail.
 *
 * One strip of buttons along an edge the user picks. It measures the space it
 * actually has and drops to a more collapsed tier when the buttons stop fitting
 * (see `nav/registry.ts` for what collapses into what and why).
 *
 * # Measuring rather than guessing
 *
 * A breakpoint would be wrong here. The rail's length depends on the edge it is
 * on, and "is there room for nine buttons" is a different question along the
 * bottom of a phone than down the side of the same phone. A `ResizeObserver` on
 * the rail answers the real question, and it keeps working for viewport sizes
 * nobody thought to write a breakpoint for.
 *
 * # Rendering
 *
 * Memoised, and it reads preferences straight from the store rather than taking
 * them as props. Nothing about the desktop behind it can cause it to re-render,
 * and opening a panel cannot cause the desktop to re-render.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { describeStatus } from "@/lib/status"
import { cn } from "@/lib/utils"
import { resolveEdge, usePrefSection, type NavEdge, type NavItemId } from "@/lib/prefs"
import { useSessionState } from "@/session"
import type { Status } from "@/connection"
import { useDock } from "@/lib/dock"
import {
  NAV_GROUPS,
  TIER_COUNT,
  expandGroups,
  slotsForTier,
  zoneOf,
  type NavGroupId,
  type NavSlot,
} from "@/nav/registry"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export type NavTarget = { kind: "item"; id: NavItemId } | { kind: "group"; id: NavGroupId }

export interface NavRailProps {
  /** Which panel is open, so the matching button can read as selected. */
  active: NavItemId | NavGroupId | null
  /**
   * An action button that just fired, so it can flash.
   *
   * Actions change nothing on screen, and a button that looks inert after a
   * press is a button people press again.
   */
  fired: NavItemId | null
  onSelect: (target: NavTarget) => void
}

const SIZES = {
  sm: { button: 36, gap: 4, pad: 8, icon: 16 },
  md: { button: 44, gap: 6, pad: 10, icon: 18 },
  lg: { button: 52, gap: 8, pad: 12, icon: 20 },
} as const

const isVertical = (edge: NavEdge) => edge === "left" || edge === "right"

export const NavRail = memo(function NavRail({ active, fired, onSelect }: NavRailProps) {
  const nav = usePrefSection("nav")
  const { order, hidden, anchored, centred, size } = nav
  const edge = resolveEdge(nav.edge, usePortrait())
  const dock = useDock()
  const metrics = SIZES[size]
  const vertical = isVertical(edge)

  const railRef = useRef<HTMLElement | null>(null)
  const [available, setAvailable] = useState<number | null>(null)

  // Measured before paint, so the rail never shows nine buttons for one frame
  // and then snaps to four. On a tablet that flash is very visible.
  useLayoutEffect(() => {
    const element = railRef.current
    if (!element) return

    const measure = () => {
      const box = element.getBoundingClientRect()
      setAvailable(vertical ? box.height : box.width)
    }
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [vertical])

  // The first tier whose buttons fit, then any groups the leftover space can
  // afford to lay out in full. The tiers are coarse, and without the second
  // step a rail with room for seven buttons draws five and merges the keyboard
  // and gamepad for no reason.
  const fits = fitsIn(available, metrics)
  const tier = pickTier(fits, order, hidden)
  const slots = slotsForTier(tier, order, hidden, expandGroups(tier, order, hidden, fits))

  // Three clusters with the slack shared between them, which is the whole point
  // of the layout. The buttons reached for constantly while working sit hard
  // against the far edge, under the thumb of a hand holding the device. The
  // ones touched once a week sit at the other end where they cannot be hit by
  // accident. The launcher sits in the middle, belonging to neither.
  // See `nav.anchored` and `nav.centred`.
  const start = slots.filter((slot) => zoneOf(slot, anchored, centred) === "start")
  const centre = slots.filter((slot) => zoneOf(slot, anchored, centred) === "centre")
  const end = slots.filter((slot) => zoneOf(slot, anchored, centred) === "end")

  // The keyboard and gamepad buttons dock a surface rather than open a panel,
  // so "active" for them means "on screen", not "its panel is open". Without
  // this the only way to tell whether the keyboard is up is to look for it.
  const isActive = (id: string) => id === active || id === dock

  return (
    <nav
      ref={railRef as React.Ref<HTMLElement>}
      aria-label="Shell navigation"
      data-shell-nav
      data-edge={edge}
      className={cn(
        "z-30 flex shrink-0 items-center bg-sidebar/80 backdrop-blur-xl",
        // The rail is a slab against the viewport edge, so only the inner side
        // gets a border. Anything else draws a line against the screen bezel.
        // No safe-area padding here: the shell root pads the whole chrome
        // inside the insets (see ShellChrome). The `p*-safe` classes that
        // used to sit here were dead anyway, silently overridden by the
        // `padding` shorthand in the style attribute below.
        vertical
          ? "h-full flex-col border-r border-sidebar-border"
          : "w-full flex-row border-b border-sidebar-border",
        edge === "right" && "border-r-0 border-l",
        edge === "bottom" && "border-b-0 border-t",
      )}
      style={{ padding: metrics.pad, gap: metrics.gap }}
    >
      {start.map((slot) => (
        <RailButton
          key={slot.kind === "item" ? slot.id : `group:${slot.id}`}
          slot={slot}
          edge={edge}
          metrics={metrics}
          active={isActive(slot.id)}
          fired={fired === slot.id}
          onSelect={onSelect}
        />
      ))}

      {/* The gaps. `flex-1` rather than fixed margins, so they share whatever
          is left over at any rail length and each cluster stays put. Rendered
          even when a cluster is empty, so the remaining ones do not slide: with
          nothing centred, two equal gaps still push `end` to the far edge. */}
      <div className="flex-1" aria-hidden />

      {centre.map((slot) => (
        <RailButton
          key={slot.kind === "item" ? slot.id : `group:${slot.id}`}
          slot={slot}
          edge={edge}
          metrics={metrics}
          active={isActive(slot.id)}
          fired={fired === slot.id}
          onSelect={onSelect}
        />
      ))}

      <div className="flex-1" aria-hidden />

      {end.map((slot) => (
        <RailButton
          key={slot.kind === "item" ? slot.id : `group:${slot.id}`}
          slot={slot}
          edge={edge}
          metrics={metrics}
          active={isActive(slot.id)}
          fired={fired === slot.id}
          onSelect={onSelect}
        />
      ))}
    </nav>
  )
})

interface RailButtonProps {
  slot: NavSlot
  edge: NavEdge
  metrics: (typeof SIZES)[keyof typeof SIZES]
  active: boolean
  fired: boolean
  onSelect: (target: NavTarget) => void
}

/**
 * Connection state, reduced to the three things worth a colour.
 *
 * Green when it is working, amber while it is trying, red when it is not.
 * Deliberately coarse: the exact state is a word away in the panel, and a
 * light on a button is for noticing, not for reading.
 */
function toneFor(status: Status): "good" | "busy" | "bad" {
  // One table decides what each state means, so the dot on the rail and the
  // words in the session panel can never disagree. See `lib/status`.
  return describeStatus(status).tone
}

const RailButton = memo(function RailButton({
  slot,
  edge,
  metrics,
  active,
  fired,
  onSelect,
}: RailButtonProps) {
  const meta = slot.kind === "item" ? slot.item : slot.group
  const Icon = meta.icon
  const glyph = slot.kind === "item" ? slot.item.glyph : undefined

  // Only the session button carries the connection light. Putting it on every
  // button would be noise; putting it on none costs the one thing the badge it
  // replaces was actually good for.
  const carriesStatus =
    slot.kind === "item" ? slot.id === "info" : slot.group.members.includes("info")
  const { status } = useSessionState()
  const statusTone = carriesStatus ? toneFor(status) : null

  const handle = useCallback(() => {
    onSelect(
      slot.kind === "item" ? { kind: "item", id: slot.id } : { kind: "group", id: slot.id },
    )
  }, [onSelect, slot])

  return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={active ? "secondary" : "ghost"}
            size="icon"
            aria-label={meta.label}
            aria-pressed={active}
            onClick={handle}
            className={cn(
              "relative shrink-0 rounded-lg text-sidebar-foreground/70 transition-colors",
              "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              active && "bg-sidebar-accent text-sidebar-accent-foreground",
              fired && "bg-primary text-primary-foreground",
            )}
            style={{ width: metrics.button, height: metrics.button }}
          >
            {glyph ? (
              <span
                className="font-semibold tracking-tight"
                style={{ fontSize: Math.round(metrics.icon * 0.62) }}
                aria-hidden
              >
                {glyph}
              </span>
            ) : (
              <Icon size={metrics.icon} strokeWidth={1.9} aria-hidden />
            )}
            {/* A group is standing in for several buttons; the dot says the
                panel behind it holds more than its label suggests. */}
            {slot.kind === "group" ? (
              <span className="absolute right-1 bottom-1 size-1 rounded-full bg-current opacity-60" />
            ) : null}
            {/* Connection health, on the button that already means "session".
                It used to be a badge floating over the desktop, which put a
                permanent widget on top of the thing you are actually looking
                at to tell you something that is almost always "fine". A dot on
                the button says the same in the space the button already
                occupies, and is only eye-catching when it is not green. */}
            {statusTone ? (
              <span
                className={cn(
                  "absolute top-1 right-1 size-1.5 rounded-full",
                  statusTone === "good" && "bg-success",
                  statusTone === "busy" && "bg-warning animate-pulse",
                  statusTone === "bad" && "bg-destructive",
                )}
                aria-hidden
              />
            ) : null}
          </Button>
        </TooltipTrigger>
        <TooltipContent
          side={edge === "left" ? "right" : edge === "right" ? "left" : edge === "top" ? "bottom" : "top"}
          className="max-w-56"
        >
          <p className="font-medium">{meta.label}</p>
          <p className="text-xs opacity-80">{meta.hint}</p>
        </TooltipContent>
      </Tooltip>
  )
})

/**
 * Whether the rail can draw `count` buttons in the space it measured.
 *
 * Everything true until the first measurement lands. That is the right guess:
 * the overwhelmingly common case is a display with room to spare, and starting
 * collapsed would make every desktop load flash a compact rail.
 */
function fitsIn(
  available: number | null,
  metrics: (typeof SIZES)[keyof typeof SIZES],
): (count: number) => boolean {
  if (available === null) return () => true
  const usable = available - metrics.pad * 2
  return (count) => {
    if (count === 0) return true
    // One separator's worth of slack, plus the gaps between buttons.
    return count * metrics.button + (count - 1) * metrics.gap + 12 <= usable
  }
}

/** The roomiest tier that fits. */
function pickTier(
  fits: (count: number) => boolean,
  order: NavItemId[],
  hidden: NavItemId[],
): number {
  for (let tier = 0; tier < TIER_COUNT; tier++) {
    if (fits(slotsForTier(tier, order, hidden).length)) return tier
  }
  return TIER_COUNT - 1
}

/**
 * Where the rail is, as flex direction for the surrounding layout.
 *
 * Exported so the app shell does not have to re-derive it and risk disagreeing
 * about which side the rail is on.
 */
export function shellDirection(edge: NavEdge): string {
  switch (edge) {
    case "left":
      return "flex-row"
    case "right":
      return "flex-row-reverse"
    case "top":
      return "flex-col"
    case "bottom":
      return "flex-col-reverse"
  }
}

/** Small helper so panels can open from the same side the rail is on. */
export function sheetSideFor(edge: NavEdge): "left" | "right" | "top" | "bottom" {
  return edge
}

/** Re-exported for panels that need to know the merge membership. */
export { NAV_GROUPS }

/** Guard for callers holding a `NavItemId | NavGroupId`. */
export function isGroupId(id: string): id is NavGroupId {
  return id in NAV_GROUPS
}

/**
 * Whether the viewport is taller than it is wide.
 *
 * A media query rather than a `ResizeObserver`: this is about the *window*, not
 * about any element, and it changes exactly when a device is rotated.
 */
export function usePortrait(): boolean {
  const [portrait, setPortrait] = useState(
    () => globalThis.matchMedia?.("(orientation: portrait)").matches ?? false,
  )
  useEffect(() => {
    const media = globalThis.matchMedia?.("(orientation: portrait)")
    if (!media) return
    const update = () => setPortrait(media.matches)
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
  return portrait
}

/** Kept out of the component so the effect above stays dependency-free. */
export function useIsCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () => globalThis.matchMedia?.("(pointer: coarse)").matches ?? false,
  )
  useEffect(() => {
    const media = globalThis.matchMedia?.("(pointer: coarse)")
    if (!media) return
    const update = () => setCoarse(media.matches)
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
  return coarse
}
