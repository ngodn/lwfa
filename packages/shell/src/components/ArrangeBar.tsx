/**
 * The bar along the bottom of arrange mode.
 *
 * Holds the workspaces and the way out. It floats over the zoomed-out strip
 * rather than docking beside it, because docking would shrink the very thing
 * being arranged, and the strip is already inset to leave room for it.
 *
 * Rendered only while arranging, so it costs nothing the rest of the time.
 */

import { memo, useEffect } from "react"
import { Check } from "lucide-react"
import { setArrange, useArranging, useCarried } from "@/lib/arrange"
import { useSessionActions, useSessionState } from "@/session"
import { currentWorkspace } from "@/strip"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export const ArrangeBar = memo(function ArrangeBar() {
  const arranging = useArranging()
  const carrying = useCarried() !== null
  const { strip, primary } = useSessionState()
  const actions = useSessionActions()

  // Escape leaves, the same key that leaves every other mode in the shell.
  // Registered only while arranging so it cannot swallow an Escape meant for
  // the desktop, which is a key applications genuinely need.
  useEffect(() => {
    if (!arranging) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      setArrange(false)
    }
    globalThis.addEventListener("keydown", onKey, { capture: true })
    return () => globalThis.removeEventListener("keydown", onKey, { capture: true })
  }, [arranging])

  // Leaving control means every button here becomes a no-op, since the engine
  // drops layout from anyone but the primary. Dropping out of the mode says so
  // more clearly than a screen of controls that quietly do nothing.
  useEffect(() => {
    if (arranging && !primary) setArrange(false)
  }, [arranging, primary])

  if (!arranging) return null

  const workspace = strip.workspaces.indexOf(currentWorkspace(strip))

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 z-40 flex items-center gap-2 p-4",
        "bg-gradient-to-t from-black/60 to-transparent",
      )}
    >
      <div className="pointer-events-auto flex flex-wrap items-center gap-1.5">
        {strip.workspaces.map((_, index) => (
          <Button
            key={index}
            size="sm"
            variant={index === workspace ? "default" : "secondary"}
            // Read by the drag on release, rather than the chip listening for
            // a pointer it never captured. The window being dragged holds
            // pointer capture for the whole gesture, so events never reach
            // anything underneath it, and hit testing on release is the only
            // way a chip can know it was the target.
            data-workspace-drop={index}
            className={cn(
              "h-11 min-w-11 px-3 transition-transform",
              // Grown while something is being carried, because a chip is a
              // small target and a dragged window is large enough to hide it.
              carrying && "scale-110 ring-2 ring-primary ring-offset-2 ring-offset-transparent",
            )}
            aria-current={index === workspace}
            aria-label={
              carrying ? `Send to workspace ${index + 1}` : `Workspace ${index + 1}`
            }
            onClick={() => actions.focusWorkspace(index)}
          >
            {index + 1}
          </Button>
        ))}
      </div>

      <div className="pointer-events-auto ml-auto">
        <Button className="h-11 gap-1.5 px-5" onClick={() => setArrange(false)}>
          <Check className="size-4" aria-hidden />
          Done
        </Button>
      </div>
    </div>
  )
})
