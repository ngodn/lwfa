/**
 * Settings, which for now means the shape of the navigation itself.
 *
 * The rail can sit on any edge, its buttons can be reordered, and any of them
 * can be switched off. Reordering is done with move buttons rather than drag
 * and drop: this list is operated on a touchscreen as often as with a mouse,
 * a drag inside an already-scrolling sheet is fiddly on both, and buttons are
 * reachable by keyboard without any extra work.
 */

import { memo, useCallback } from "react"
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Eye,
  EyeOff,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  RotateCcw,
  Wand2,
} from "lucide-react"
import {
  getPrefs,
  patchPrefs,
  resetPrefs,
  usePrefs,
  type NavEdgePref,
  type NavItemId,
} from "@/lib/prefs"
import { NAV_ITEMS } from "@/nav/registry"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Field, FieldRow, PanelSection } from "@/panels/parts"
import { cn } from "@/lib/utils"

const EDGES: { value: NavEdgePref; label: string; icon: typeof PanelLeft }[] = [
  { value: "auto", label: "Auto", icon: Wand2 },
  { value: "left", label: "Left", icon: PanelLeft },
  { value: "top", label: "Top", icon: PanelTop },
  { value: "right", label: "Right", icon: PanelRight },
  { value: "bottom", label: "Bottom", icon: PanelBottom },
]

const SIZES = [
  { value: "sm", label: "Small" },
  { value: "md", label: "Medium" },
  { value: "lg", label: "Large" },
] as const

function SettingsPanel() {
  const { nav } = usePrefs()

  // Both read the store rather than this render's copy, so pressing a button
  // twice quickly applies the second change on top of the first.
  const move = useCallback((id: NavItemId, delta: -1 | 1) => {
    patchPrefs("nav", { order: reorder(getPrefs().nav.order, id, delta) })
  }, [])

  const anchor = useCallback((id: NavItemId) => {
    const anchored = new Set(getPrefs().nav.anchored)
    if (anchored.has(id)) anchored.delete(id)
    else anchored.add(id)
    patchPrefs("nav", { anchored: [...anchored] })
  }, [])

  const toggle = useCallback((id: NavItemId) => {
    const hidden = new Set(getPrefs().nav.hidden)
    if (hidden.has(id)) hidden.delete(id)
    else hidden.add(id)
    patchPrefs("nav", { hidden: [...hidden] })
  }, [])

  return (
    <div className="space-y-6 pt-2">
      <PanelSection
        title="Navigation edge"
        description="Where the bar sits. Auto puts it down the side in landscape, where height is plentiful and width is not, and along the bottom in portrait, where it is the other way round and a thumb is already there."
      >
        <ToggleGroup
          type="single"
          value={nav.edge}
          onValueChange={(value) => value && patchPrefs("nav", { edge: value as NavEdgePref })}
          variant="outline"
          className="grid w-full grid-cols-5"
        >
          {EDGES.map(({ value, label, icon: Icon }) => (
            <ToggleGroupItem
              key={value}
              value={value}
              aria-label={label}
              className="flex-col gap-1 py-2 h-auto"
            >
              <Icon className="size-4" aria-hidden />
              <span className="text-[11px]">{label}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </PanelSection>

      <PanelSection title="Button size">
        <ToggleGroup
          type="single"
          value={nav.size}
          onValueChange={(value) =>
            value && patchPrefs("nav", { size: value as "sm" | "md" | "lg" })
          }
          variant="outline"
          className="w-full"
        >
          {SIZES.map(({ value, label }) => (
            <ToggleGroupItem key={value} value={value} className="flex-1">
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </PanelSection>

      <PanelSection
        title="Buttons"
        description="Order, which end of the bar they sit at, and whether they appear at all. Anchored buttons are pushed to the far end, where a thumb reaches them; everything else stays at the near end, out of accidental reach. When the bar runs out of room, buttons merge into grouped ones rather than disappearing."
      >
        <ul className="divide-y rounded-lg border">
          {nav.order.map((id, index) => {
            const item = NAV_ITEMS[id]
            const hidden = nav.hidden.includes(id)
            const anchored = nav.anchored.includes(id)
            const Icon = item.icon
            return (
              <li key={id} className="flex items-center gap-2 p-2">
                <Icon
                  className={cn("size-4 shrink-0", hidden && "opacity-40")}
                  aria-hidden
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-sm",
                    hidden && "text-muted-foreground line-through",
                  )}
                >
                  {item.label}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={`Move ${item.label} ${index === 0 ? "to the end" : "earlier"}`}
                  disabled={index === 0}
                  onClick={() => move(id, -1)}
                >
                  <ArrowUp className="size-4" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={`Move ${item.label} later`}
                  disabled={index === nav.order.length - 1}
                  onClick={() => move(id, 1)}
                >
                  <ArrowDown className="size-4" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={
                    anchored
                      ? `Move ${item.label} to the near end`
                      : `Anchor ${item.label} to the far end`
                  }
                  aria-pressed={anchored}
                  onClick={() => anchor(id)}
                >
                  {anchored ? (
                    <ArrowDownToLine className="size-4 text-primary" aria-hidden />
                  ) : (
                    <ArrowUpToLine className="size-4 opacity-60" aria-hidden />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={hidden ? `Show ${item.label}` : `Hide ${item.label}`}
                  aria-pressed={!hidden}
                  onClick={() => toggle(id)}
                >
                  {hidden ? (
                    <EyeOff className="size-4 opacity-60" aria-hidden />
                  ) : (
                    <Eye className="size-4" aria-hidden />
                  )}
                </Button>
              </li>
            )
          })}
        </ul>
      </PanelSection>

      <PanelSection title="Reset">
        <FieldRow>
          <Field
            label="Restore defaults"
            hint="Theme, navigation, keyboard and gamepad preferences on this device."
          />
          <Button variant="outline" size="sm" onClick={resetPrefs} className="gap-2">
            <RotateCcw className="size-3.5" aria-hidden />
            Reset
          </Button>
        </FieldRow>
      </PanelSection>
    </div>
  )
}

/** Move one id by one position, clamped. Pure, so it is trivially testable. */
export function reorder(order: NavItemId[], id: NavItemId, delta: -1 | 1): NavItemId[] {
  const from = order.indexOf(id)
  if (from === -1) return order
  const to = from + delta
  if (to < 0 || to >= order.length) return order
  const next = [...order]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}

export default memo(SettingsPanel)
