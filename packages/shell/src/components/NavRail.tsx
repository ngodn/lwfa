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
import { cn } from "@/lib/utils"
import { usePrefs, type NavEdge, type NavItemId } from "@/lib/prefs"
import { useDock } from "@/lib/dock"
import {
  NAV_GROUPS,
  TIER_COUNT,
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
  onSelect: (target: NavTarget) => void
}

const SIZES = {
  sm: { button: 36, gap: 4, pad: 8, icon: 16 },
  md: { button: 44, gap: 6, pad: 10, icon: 18 },
  lg: { button: 52, gap: 8, pad: 12, icon: 20 },
} as const

const isVertical = (edge: NavEdge) => edge === "left" || edge === "right"

export const NavRail = memo(function NavRail({ active, onSelect }: NavRailProps) {
  const { nav } = usePrefs()
  const { edge, order, hidden, anchored, size } = nav
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

  // The first tier whose buttons fit. Recomputed only when something that can
  // change the answer changes.
  const tier = pickTier(available, metrics, order, hidden)
  const slots = slotsForTier(tier, order, hidden)

  // Two clusters with the slack between them, which is the whole point of the
  // layout: the buttons you reach for constantly while working sit hard against
  // the far edge, under the thumb of a hand holding the device, and the ones
  // you touch once a week sit at the other end where they cannot be hit by
  // accident. See `nav.anchored`.
  const start = slots.filter((slot) => zoneOf(slot, anchored) === "start")
  const end = slots.filter((slot) => zoneOf(slot, anchored) === "end")

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
        vertical
          ? "h-full flex-col border-r border-sidebar-border pl-safe"
          : "w-full flex-row border-b border-sidebar-border pt-safe",
        edge === "right" && "border-r-0 border-l pr-safe pl-0",
        edge === "bottom" && "border-b-0 border-t pb-safe pt-0",
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
          onSelect={onSelect}
        />
      ))}

      {/* The gap. `flex-1` rather than a fixed margin, so it absorbs whatever
          is left over at any rail length and the anchored cluster stays put. */}
      {end.length > 0 ? <div className="flex-1" aria-hidden /> : null}

      {end.map((slot) => (
        <RailButton
          key={slot.kind === "item" ? slot.id : `group:${slot.id}`}
          slot={slot}
          edge={edge}
          metrics={metrics}
          active={isActive(slot.id)}
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
  onSelect: (target: NavTarget) => void
}

const RailButton = memo(function RailButton({
  slot,
  edge,
  metrics,
  active,
  onSelect,
}: RailButtonProps) {
  const meta = slot.kind === "item" ? slot.item : slot.group
  const Icon = meta.icon

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
            )}
            style={{ width: metrics.button, height: metrics.button }}
          >
            <Icon size={metrics.icon} strokeWidth={1.9} aria-hidden />
            {/* A group is standing in for several buttons; the dot says the
                panel behind it holds more than its label suggests. */}
            {slot.kind === "group" ? (
              <span className="absolute right-1 bottom-1 size-1 rounded-full bg-current opacity-60" />
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
 * The roomiest tier that fits in `available` pixels.
 *
 * Returns tier 0 until the first measurement lands. That is the right guess:
 * the overwhelmingly common case is a display with room to spare, and starting
 * collapsed would make every desktop load flash a compact rail.
 */
function pickTier(
  available: number | null,
  metrics: (typeof SIZES)[keyof typeof SIZES],
  order: NavItemId[],
  hidden: NavItemId[],
): number {
  if (available === null) return 0

  const usable = available - metrics.pad * 2
  for (let tier = 0; tier < TIER_COUNT; tier++) {
    const count = slotsForTier(tier, order, hidden).length
    if (count === 0) return tier
    // One separator's worth of slack, plus the gaps between buttons.
    const needed = count * metrics.button + (count - 1) * metrics.gap + 12
    if (needed <= usable) return tier
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
