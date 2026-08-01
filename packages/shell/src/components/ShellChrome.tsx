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

import { memo, useCallback, useLayoutEffect, useState } from "react"
import { usePrefs } from "@/lib/prefs"
import { NavRail, shellDirection, type NavTarget } from "@/components/NavRail"
import { PanelHost } from "@/components/PanelHost"
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

  const select = useCallback((target: NavTarget) => {
    // Tapping the open panel's own button closes it, which is what a bar of
    // toggles should do and saves reaching for the overlay to dismiss it.
    setActive((current) => (current === target.id ? null : target.id))
  }, [])

  const close = useCallback(() => setActive(null), [])

  // On the document element, not on the div below. Radix portals overlays to
  // `document.body`, so a variable set on a descendant is invisible to the
  // panel that needs it, and the panel silently lays itself out over the rail.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--rail-size", railSize(nav.size))
    document.documentElement.style.setProperty("--rail-edge", nav.edge)
  }, [nav.size, nav.edge])

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      <div className={cn("flex h-full w-full overflow-hidden bg-backdrop", shellDirection(nav.edge))}>
        <NavRail active={active} onSelect={select} />
        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
        <PanelHost active={active} onClose={close} />
      </div>
    </TooltipProvider>
  )
})

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
