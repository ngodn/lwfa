/**
 * The chrome: rail, panels, and the slot the desktop renders into.
 *
 * # Why this is a separate component from `App`
 *
 * `App` owns the session: the socket, the window list, the decoded frames. That
 * state changes many times a second while a stream is running. The chrome's
 * state changes when somebody taps a button. Keeping them in one component
 * would mean every arriving frame re-rendered the navigation, and every panel
 * toggle re-rendered every window surface.
 *
 * So the desktop arrives as `children` and is never touched by anything here.
 * React skips re-rendering an element it has been handed by identity, which is
 * what makes this split actually work rather than merely look tidy.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useState } from "react"
import { getPrefs, resolveEdge, usePrefs } from "@/lib/prefs"
import { NavRail, shellDirection, usePortrait, type NavTarget } from "@/components/NavRail"
import { PanelHost } from "@/components/PanelHost"
import { InputDock } from "@/components/InputDock"
import { useArranging } from "@/lib/arrange"
import { AlreadyRunning } from "@/components/AlreadyRunning"
import { toggleDock } from "@/lib/dock"
import { NAV_ITEMS } from "@/nav/registry"
import { useSessionActions } from "@/session"
import type { NavItemId } from "@/lib/prefs"
import type { NavGroupId } from "@/nav/registry"
import { cn } from "@/lib/utils"
import { TooltipProvider } from "@/components/ui/tooltip"

export const ShellChrome = memo(function ShellChrome({
  children,
}: {
  children: React.ReactNode
}) {
  const { nav } = usePrefs()
  const [active, setActive] = useState<NavItemId | NavGroupId | null>(null)
  /** The action button that just fired, so it can flash. */
  const [fired, setFired] = useState<NavItemId | null>(null)
  const actions = useSessionActions()

  const select = useCallback(
    (target: NavTarget) => {
      // What a rail button does is a property of the button, not a list of
      // special cases here. See `NavItem.kind`.
      const kind = target.kind === "item" ? NAV_ITEMS[target.id].kind : "panel"

      if (kind === "dock" && target.kind === "item") {
        // Input devices go on screen rather than opening a panel about
        // themselves; their settings live behind the gear in the dock.
        toggleDock(target.id as "keyboard" | "gamepad")
        return
      }

      if (kind === "action" && target.id === "escape") {
        // Down then up, like every other key path. Sending only the press
        // leaves the far end holding Escape, which some applications treat as
        // a repeat.
        actions.send({ type: "key", key: ESCAPE, pressed: true })
        actions.send({ type: "key", key: ESCAPE, pressed: false })
        if (getPrefs().keyboard.haptics) globalThis.navigator?.vibrate?.(8)
        // A flash, because nothing else on screen changes and a button that
        // looks inert is a button people press twice.
        setFired(target.id)
        globalThis.setTimeout(() => setFired(null), 180)
        return
      }

      // Everything else toggles its panel, so tapping the open one closes it.
      setActive((current) => (current === target.id ? null : target.id))
    },
    [actions],
  )

  const close = useCallback(() => setActive(null), [])

  /**
   * Entering arrange mode closes whatever panel opened it.
   *
   * Arrange mode is the desktop, full width, with controls on the windows
   * themselves. A panel left open covers the thing being arranged, and worse:
   * the panel is non-modal, so the click that dismisses it also lands on a
   * window underneath, which focuses that window and leaves the mode. Pressing
   * "Arrange windows" and then clicking anywhere would undo itself.
   *
   * Handled here rather than in the panel because closing is this component's
   * state, and because any future way into the mode gets the same behaviour
   * without having to remember to ask for it.
   */
  const arranging = useArranging()
  useEffect(() => {
    if (arranging) setActive(null)
  }, [arranging])

  // On the document element, not on the div below. Radix portals overlays to
  // `document.body`, so a variable set on a descendant is invisible to the
  // panel that needs it, and the panel silently lays itself out over the rail.
  const edge = resolveEdge(nav.edge, usePortrait())

  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--rail-size", railSize(nav.size))
    document.documentElement.style.setProperty("--rail-edge", edge)
  }, [nav.size, edge])

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      {/* Safe-area padding lives here, once. Installed to a home screen the
          page draws edge to edge (iOS `black-translucent`, Android
          edge-to-edge), so without this the desktop's top row sits under the
          status bar. The backdrop colour still fills the insets, which is what
          makes the translucent status bar look intentional. Fixed-position
          things (the panel sheet) do not inherit padding and offset
          themselves; see PanelHost.

          Top and sides only, deliberately. The home indicator is a floating
          overlay, not a bar: reserving its inset painted a dead band across
          the bottom of the screen. The desktop runs underneath it like every
          full-screen app, and the one thing that must clear it, a docked
          keyboard's bottom row, pads itself (see InputDock). */}
      <div className={cn("pt-safe pl-safe pr-safe flex h-full w-full overflow-hidden bg-backdrop", shellDirection(edge))}>
        <NavRail active={active} fired={fired} onSelect={select} />
        {/* A column, so a docked keyboard takes space from the desktop rather
            than covering the line being typed into. The gamepad positions
            itself absolutely inside this same box and takes none. */}
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="relative min-h-0 flex-1">{children}</div>
          <InputDock onOpenSettings={setActive} />
        </main>
        <PanelHost active={active} onClose={close} />
        <AlreadyRunning />
      </div>
    </TooltipProvider>
  )
})

/** evdev `KEY_ESC`. */
const ESCAPE = 1

/** Rail thickness, matching `SIZES` in NavRail: button plus padding both sides. */
function railSize(size: "sm" | "md" | "lg"): string {
  switch (size) {
    case "sm":
      return "52px"
    case "md":
      return "64px"
    case "lg":
      return "76px"
  }
}
