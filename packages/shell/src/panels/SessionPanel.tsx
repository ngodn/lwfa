/**
 * What the session is actually doing.
 *
 * The panel you open when something looks wrong: is it connected, is it
 * decoding in hardware, how many windows are being streamed, and what has
 * happened recently. Everything here is observed by the shell itself rather
 * than reported by the engine, so it keeps working when the engine does not.
 */

import { memo } from "react"
import { Activity, Cpu, Layers, Radio } from "lucide-react"
import { useSessionState } from "@/session"
import { useLog } from "@/lib/log"
import { supportsH264 } from "@/decode"
import { currentWorkspace } from "@/strip"
import { Badge } from "@/components/ui/badge"
import { PanelSection } from "@/panels/parts"
import { cn } from "@/lib/utils"

function SessionPanel() {
  const { status, statusDetail, output, windows, strip, endpoint, account, permissions } =
    useSessionState()
  const entries = useLog()
  const workspace = currentWorkspace(strip)

  return (
    <div className="space-y-6 pt-2">
      <PanelSection title="Connection">
        <div className="grid grid-cols-2 gap-2">
          <Stat icon={Radio} label="Status" value={status} tone={status === "connected" ? "good" : "bad"} />
          <Stat icon={Cpu} label="Decode" value={supportsH264() ? "H.264" : "JPEG"} />
          <Stat icon={Layers} label="Windows" value={String(windows.size)} />
          <Stat
            icon={Activity}
            label="Viewport"
            value={output.width > 0 ? `${output.width}×${output.height}` : "—"}
          />
        </div>
        {statusDetail ? (
          <p className="text-xs text-muted-foreground">{statusDetail}</p>
        ) : null}
        {!supportsH264() ? (
          <p className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
            Falling back to JPEG. WebCodecs needs a secure context, and this page is on plain
            HTTP; over HTTPS the browser decodes H.264 in hardware and uses far less bandwidth.
          </p>
        ) : null}
      </PanelSection>

      <PanelSection title="Session">
        <dl className="space-y-1.5 text-xs">
          <Row label="Engine" value={<code className="font-mono">{endpoint}</code>} />
          <Row label="Account" value={account || "—"} />
          <Row
            label="Permissions"
            value={
              <Badge variant="outline" className="text-[10px]">
                {permissions.mode}
                {permissions.allowedApps === null ? " · any app" : ` · ${permissions.allowedApps.length} apps`}
              </Badge>
            }
          />
          <Row label="Workspace" value={`${strip.focus + 1} of ${strip.workspaces.length}`} />
          <Row label="Columns" value={String(workspace.columns.length)} />
        </dl>
      </PanelSection>

      <PanelSection
        title="Recent events"
        description="Kept in this tab only, newest first. Not the engine's log; this is what the shell saw."
      >
        {entries.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
            Nothing yet.
          </p>
        ) : (
          <ol className="space-y-0.5 rounded-lg border p-2 font-mono text-[11px]">
            {entries.map((entry, index) => (
              <li key={index} className="flex gap-2">
                <span className="shrink-0 text-muted-foreground">{entry.at}</span>
                <span
                  className={cn(
                    "min-w-0 flex-1 break-words",
                    entry.level === "warn" && "text-warning",
                    entry.level === "error" && "text-destructive",
                  )}
                >
                  {entry.message}
                </span>
              </li>
            ))}
          </ol>
        )}
      </PanelSection>
    </div>
  )
}

const Stat = memo(function Stat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Radio
  label: string
  value: string
  tone?: "good" | "bad"
}) {
  return (
    <div className="rounded-lg border bg-card p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3" aria-hidden />
        {label}
      </div>
      <p
        className={cn(
          "mt-0.5 truncate text-sm font-medium capitalize",
          tone === "good" && "text-success",
          tone === "bad" && "text-destructive",
        )}
      >
        {value}
      </p>
    </div>
  )
})

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  )
}

export default memo(SessionPanel)
