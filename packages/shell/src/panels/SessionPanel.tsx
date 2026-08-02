/**
 * What the session is actually doing.
 *
 * The panel you open when something looks wrong: is it connected, is it
 * decoding in hardware, how many windows are being streamed, and what has
 * happened recently. Everything here is observed by the shell itself rather
 * than reported by the engine, so it keeps working when the engine does not.
 */

import { memo } from "react"
import { Activity, AppWindow, Cpu, Gamepad2, Layers, LogOut, Radio } from "lucide-react"
import { useSessionActions, useSessionState } from "@/session"
import { useLog } from "@/lib/log"
import { supportsH264 } from "@/decode"
import { currentWorkspace, focusedWindow } from "@/strip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PanelSection } from "@/panels/parts"
import { describeStatus, type Tone } from "@/lib/status"
import { describeFormat, useStreamFormat } from "@/lib/streamFormat"
import { cn } from "@/lib/utils"

function SessionPanel() {
  const { status, statusDetail, output, windows, strip, endpoint, account, permissions, primary, peers } =
    useSessionState()
  const actions = useSessionActions()
  const entries = useLog()
  const workspace = currentWorkspace(strip)

  // The title of whatever has focus.
  //
  // It used to be painted along the bottom of every window, which put a
  // permanent caption over the application you are trying to use, on a device
  // where screen space is the scarce thing. Windows are identifiable by what
  // they are showing; the name is only wanted when you go looking for it, and
  // this is where you look.
  const focused = focusedWindow(strip)
  const focusedTitle = focused === null ? null : titleOf(windows.get(focused), focused)
  // The panel people open when something looks wrong, so it says what is
  // happening in words rather than showing the internal name of a state.
  const report = describeStatus(status, statusDetail)
  const format = useStreamFormat()

  return (
    <div className="space-y-6 pt-2">
      <PanelSection title="Connection">
        <div className="grid grid-cols-2 gap-2">
          <Stat icon={Radio} label="Status" value={report.label} tone={report.tone} />
          {/* What is arriving, not what this browser could take. The engine
            * picks the codec from what every connected client reports, so it
            * is not knowable here in advance; the frames are the only honest
            * source. See `lib/streamFormat`. */}
          <Stat icon={Cpu} label="Decode" value={describeFormat(format)} />
          <Stat icon={Layers} label="Windows" value={String(windows.size)} />
          <Stat
            icon={Activity}
            label="Viewport"
            value={output.width > 0 ? `${output.width}×${output.height}` : "—"}
          />
        </div>
        {report.tone === "good" ? null : (
          <p className="text-xs text-muted-foreground">{report.hint}</p>
        )}
        {!supportsH264() ? (
          <p className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
            Using JPEG. Serve the shell over HTTPS to enable H.264.
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
          <Row
            label="Devices"
            value={peers.length <= 1 ? "This one only" : `${peers.length} attached`}
          />
          <Row label="Layout" value={primary ? "Decided here" : "Following another device"} />
        </dl>

        {!primary ? (
          <Button size="sm" variant="outline" className="w-full gap-1.5" onClick={actions.takeControl}>
            <Gamepad2 className="size-3.5" aria-hidden />
            Arrange from this device
          </Button>
        ) : null}
      </PanelSection>

      <PanelSection
        title="Focused window"
        description="Which window has the keyboard."
      >
        <div className="flex items-center gap-2 rounded-lg border bg-card p-2.5">
          <AppWindow className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm">
            {focusedTitle ?? <span className="text-muted-foreground">Nothing focused</span>}
          </span>
        </div>
      </PanelSection>

      <PanelSection
        title="Recent events"
        description="What this tab saw, newest first."
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

      <PanelSection title="Sign out">
        <Button variant="outline" size="sm" className="w-full gap-2" onClick={actions.signOut}>
          <LogOut className="size-3.5" aria-hidden />
          Forget the password on this device
        </Button>
      </PanelSection>
    </div>
  )
}

/** The same naming the window list uses, so one window has one name. */
function titleOf(info: { title?: string | null; appId?: string | null } | undefined, id: number): string {
  return info?.title || info?.appId || `Window ${id}`
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
  tone?: Tone
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
          // Amber rather than red: something in progress is not a failure, and
          // colouring a reconnect the same as a refused password is what made
          // every hiccup look like a breakage.
          tone === "busy" && "text-warning",
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
