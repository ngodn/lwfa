/**
 * The overlay/stacked choice, shared by the keyboard and gamepad panels.
 *
 * Both surfaces get both options, and the wording is the same in both places
 * because it is the same decision. See `Prefs.gamepad.placement`.
 */

import { memo } from "react"
import { Layers, PanelBottom } from "lucide-react"
import type { SurfacePlacement } from "@/lib/prefs"
import { hapticSupport } from "@/lib/haptics"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

export const PlacementChoice = memo(function PlacementChoice({
  value,
  onChange,
  label,
}: {
  value: SurfacePlacement
  onChange: (next: SurfacePlacement) => void
  label: string
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => next && onChange(next as SurfacePlacement)}
      variant="outline"
      className="grid w-full grid-cols-2"
      aria-label={label}
    >
      <ToggleGroupItem value="overlay" className="h-auto flex-col gap-0.5 px-1 py-2">
        <Layers className="size-[15px]" aria-hidden />
        <span className="text-xs">Overlay</span>
        <span className="text-[10px] opacity-70">Floats on top</span>
      </ToggleGroupItem>
      <ToggleGroupItem value="stacked" className="h-auto flex-col gap-0.5 px-1 py-2">
        <PanelBottom className="size-[15px]" aria-hidden />
        <span className="text-xs">Stacked</span>
        <span className="text-[10px] opacity-70">Takes its own space</span>
      </ToggleGroupItem>
    </ToggleGroup>
  )
})

/**
 * What to say under the vibrate switch, given what this device can do.
 *
 * The switch stays usable either way: a layout is carried between devices by
 * backup, and turning it off on a device that cannot vibrate should still be
 * remembered for one that can.
 */
function hapticHint(): string | undefined {
  switch (hapticSupport()) {
    case "vibration":
      return undefined
    case "switch":
      // The switch capability does not guarantee vibration feedback.
      return "Vibration may be unavailable in this browser."
    case "none":
      return "Vibration is unavailable in this browser."
  }
}

/**
 * As a spread, because `hint` is an optional prop under
 * `exactOptionalPropertyTypes` and passing an explicit `undefined` is an error.
 */
export function hapticHintProp(): { hint?: string } {
  const hint = hapticHint()
  return hint === undefined ? {} : { hint }
}
