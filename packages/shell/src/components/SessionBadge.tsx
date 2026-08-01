/**
 * A small, always-visible read-out of whether the session is actually working.
 *
 * Deliberately not in a panel. "Is it connected" and "why does it look wrong"
 * are questions you ask *while* something is off, and burying the answer behind
 * a button means the first thing a confused person does is guess. It stays out
 * of the way when everything is fine, and gets louder when it is not.
 */

import { memo } from "react"
import { LogOut, Wifi, WifiOff } from "lucide-react"
import type { Status } from "@/connection"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

export interface SessionBadgeProps {
  status: Status
  detail?: string | undefined
  endpoint: string
  workspace: number
  workspaces: number
  streaming: boolean
  hardwareDecode: boolean
  onSignOut: () => void
}

const TONE: Record<Status, string> = {
  connecting: "bg-warning/15 text-warning border-warning/30",
  connected: "bg-success/15 text-success border-success/30",
  disconnected: "bg-destructive/15 text-destructive border-destructive/30",
  incompatible: "bg-destructive/15 text-destructive border-destructive/30",
  replaced: "bg-muted text-muted-foreground border-border",
  unauthorized: "bg-destructive/15 text-destructive border-destructive/30",
}

export const SessionBadge = memo(function SessionBadge({
  status,
  detail,
  endpoint,
  workspace,
  workspaces,
  streaming,
  hardwareDecode,
  onSignOut,
}: SessionBadgeProps) {
  const healthy = status === "connected"

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "absolute top-2 right-2 z-20 flex items-center gap-2 rounded-full border px-2.5 py-1",
            "bg-card/70 text-xs backdrop-blur-md transition-opacity",
            // Fades back once it has nothing to report, so it stops competing
            // with the window you are actually using.
            healthy ? "opacity-40 hover:opacity-100" : "opacity-100",
          )}
          aria-label="Session status"
        >
          {healthy ? (
            <Wifi className="size-3.5 text-success" aria-hidden />
          ) : (
            <WifiOff className="size-3.5 text-destructive" aria-hidden />
          )}
          <span className="font-medium">
            {workspace}/{workspaces}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 text-sm" data-selectable>
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">Session</span>
          <Badge variant="outline" className={cn("capitalize", TONE[status])}>
            {status}
          </Badge>
        </div>
        {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}

        <Separator />

        <dl className="space-y-1.5 text-xs">
          <Row label="Engine" value={<code className="font-mono">{endpoint}</code>} />
          <Row label="Workspace" value={`${workspace} of ${workspaces}`} />
          <Row label="Pixels" value={streaming ? "Streaming" : "Paused"} />
          <Row
            label="Decode"
            value={hardwareDecode ? "H.264, hardware" : "JPEG (needs HTTPS for H.264)"}
          />
        </dl>

        <Separator />

        <Button variant="outline" size="sm" className="w-full gap-2" onClick={onSignOut}>
          <LogOut className="size-3.5" aria-hidden />
          Forget password
        </Button>
      </PopoverContent>
    </Popover>
  )
})

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  )
}
