/**
 * "That application is already open on the desktop."
 *
 * The three states this can be in are genuinely different questions, so each
 * gets its own words and its own buttons rather than one dialog with things
 * greyed out. See `lib/alreadyRunning`.
 *
 * The `stubborn` case is the one worth reading carefully. An application that
 * has not quit after being asked is almost always showing a "save changes?"
 * dialog, and that dialog is on the screen this session is not. Saying so is
 * the difference between "it is broken" and "go and look at the other screen",
 * and it is why forcing is offered only here and never as the first move.
 */

import { memo } from "react"
import { Loader2, MonitorSmartphone, TriangleAlert } from "lucide-react"
import { clearBlocked, closing, useBlocked } from "@/lib/alreadyRunning"
import { useSessionActions } from "@/session"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export const AlreadyRunning = memo(function AlreadyRunning() {
  const blocked = useBlocked()
  const actions = useSessionActions()
  if (!blocked) return null

  const { program, phase } = blocked

  const close = (force: boolean) => {
    closing()
    actions.closeAndSpawn(blocked.command, blocked.terminal, blocked.pid, force)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Dismissing while it is being closed would leave the engine working
        // on something with nothing to report back to, so the only way out of
        // that state is one of the buttons.
        if (!open && phase !== "closing") clearBlocked()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {phase === "closing" ? (
              <Loader2 className="size-5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
            ) : phase === "stubborn" ? (
              <TriangleAlert className="size-5 shrink-0 text-warning" aria-hidden />
            ) : (
              <MonitorSmartphone className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            )}
            {phase === "closing"
              ? `Waiting for ${program} to close`
              : phase === "stubborn"
                ? `${program} has not closed`
                : `${program} is already open on the desktop`}
          </DialogTitle>
          <DialogDescription>
            {phase === "closing"
              ? "It may be asking to save something on the desktop screen."
              : phase === "stubborn"
                ? "It is most likely asking to save something on the desktop screen. Answer it there, or force it to quit and lose those changes."
                : "Apps that share a profile reuse their open window instead of starting a second copy, so it opened on the desktop rather than here."}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="gap-2 sm:gap-2">
          {phase === "asking" ? (
            <>
              <Button variant="outline" className="h-11" onClick={() => clearBlocked()}>
                Cancel
              </Button>
              <Button className="h-11" onClick={() => close(false)}>
                Close it and open here
              </Button>
            </>
          ) : null}

          {phase === "closing" ? (
            <Button variant="outline" className="h-11" disabled>
              Waiting…
            </Button>
          ) : null}

          {phase === "stubborn" ? (
            <>
              <Button variant="outline" className="h-11" onClick={() => clearBlocked()}>
                Leave it open
              </Button>
              <Button variant="outline" className="h-11" onClick={() => close(false)}>
                Keep waiting
              </Button>
              <Button variant="destructive" className="h-11" onClick={() => close(true)}>
                Force quit
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})
