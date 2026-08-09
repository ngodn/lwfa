/**
 * Whether taps that miss the pads should be swallowed.
 *
 * Its own function because it is four conditions that must all hold, and three
 * of them are there to stop the shield appearing somewhere it would do harm
 * rather than good. Inline in the component they were four `&&` nobody could
 * check; here they can be.
 *
 * See `Prefs.gamepad.shield` for why the feature exists at all.
 */

import type { SurfacePlacement } from "@/lib/prefs"

export interface ShieldInput {
  /** Which surface is docked, if any. */
  dock: "none" | "keyboard" | "gamepad"
  /** The controller's placement. Only `overlay` sits over the window. */
  placement: SurfacePlacement
  /** The preference itself. */
  shield: boolean
  /** Whether the pad layout is being edited. */
  editing: boolean
}

export function shieldActive({ dock, placement, shield, editing }: ShieldInput): boolean {
  // Off unless asked for. The default is the old behaviour, where a tap
  // between the pads reaches the window behind them.
  if (!shield) return false
  // Only under the controller. A keyboard is a strip with no gaps to miss,
  // and with no controller up there is nothing to be missing.
  if (dock !== "gamepad") return false
  // Only when the controller is actually over the window. `stacked` gives it a
  // row of its own and the desktop shrinks to fit, so nothing is behind it and
  // a shield would protect empty space.
  if (placement !== "overlay") return false
  // Never while editing. Arranging pads is a drag across this same area, and a
  // full-area sibling underneath is a second claimant to those events. Nothing
  // is being played meanwhile, so a stray tap costs nothing.
  if (editing) return false
  return true
}
