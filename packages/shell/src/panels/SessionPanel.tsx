/**
 * What the session is actually doing.
 *
 * The panel you open when something looks wrong. Everything here is *observed*
 * rather than chosen, which is the line that decides what belongs here and what
 * belongs in settings: if it is a number the shell measured or a state it found
 * itself in, it is here; if it is a switch, it is in Settings > Stream.
 *
 * That line used to be blurred. A "Status" block and a set of audio
 * diagnostics lived at the bottom of the settings tab, next to the switches
 * that caused them, which meant the readings were filed under the one place
 * nobody looks when the picture goes wrong. Two of them had also drifted into
 * being untrue, which is the failure mode of a readout kept away from the thing
 * it measures: one reported "uncompressed" sound while Opus was being decoded,
 * and one decided which *audio* path was running by asking whether the browser
 * could decode *video*.
 *
 * Almost all of it is measured by the shell itself rather than reported by the
 * engine, so it keeps working when the engine does not, which is exactly when
 * it is wanted.
 */

import { memo } from "react"
import {
  Activity,
  AppWindow,
  Cpu,
  Gamepad2,
  Gauge,
  Layers,
  LogOut,
  Radio,
  RefreshCw,
} from "lucide-react"
import { useSessionActions, useSessionState } from "@/session"
import { useLog } from "@/lib/log"
import { supportsH264 } from "@/decode"
import { currentWorkspace, focusedWindow } from "@/strip"
import { usePrefs } from "@/lib/prefs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PanelSection } from "@/panels/parts"
import { describeStatus, type Tone } from "@/lib/status"
import { describeFormat, useStreamFormat } from "@/lib/streamFormat"
import { useStreamStats } from "@/lib/streamStats"
import { AudioReadout } from "@/panels/AudioReadout"
import { cn } from "@/lib/utils"
import { SHELL_VERSION } from "@/generated/config"

function SessionPanel() {
  const { status, statusDetail, output, windows, strip, endpoint, account, permissions, primary, peers, engineVersion } =
    useSessionState()
  const actions = useSessionActions()
  const entries = useLog()
  const workspace = currentWorkspace(strip)
  const { stream: streamPrefs } = usePrefs()

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
  const stats = useStreamStats()
  // A page keeps running the JavaScript it loaded until it is reloaded, so an
  // upgraded machine and an open tab disagree until somebody remembers to
  // refresh. Now the page can notice by itself. Null means an engine that
  // predates saying so, which is not something to nag about.
  const stale = engineVersion !== null && engineVersion !== SHELL_VERSION

  return (
    <div className="space-y-6 pt-2">
      <PanelSection title="Connection">
        <div className="grid grid-cols-2 gap-2">
          <Stat icon={Radio} label="Status" value={report.label} tone={report.tone} />
          {/* What is arriving, not what this browser could take. The engine
            * picks the codec from what every connected client reports, so it
            * is not knowable here in advance; the frames are the only honest
            * source. See `lib/streamFormat`. */}
          <Stat icon={Cpu} label="Decode" value={describeFormat(format)} verbatim />
          <Stat icon={Layers} label="Windows" value={String(windows.size)} />
          <Stat
            icon={Activity}
            label="Viewport"
            value={output.width > 0 ? `${output.width}×${output.height}` : "—"}
            verbatim
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

      {/*
        * The three numbers that tell "it feels laggy" apart from itself.
        *
        * A stream can be poor in three unrelated ways and they are
        * indistinguishable by eye: fewer frames, smaller frames, or none at
        * all. The engine's budget paces both quality and capture rate, so a
        * link it has given up on shows here as a low frame rate rather than a
        * soft picture, and a link that is genuinely saturated shows as a high
        * rate at a low bitrate. Neither was visible anywhere before.
        */}
      <PanelSection
        title="Video"
        description="Counted as the video arrives."
      >
        {!streamPrefs.enabled ? (
          <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            Paused. Turn the picture back on in Settings.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Stat
                icon={Gauge}
                label="Frame rate"
                value={stats.fps > 0 ? `${stats.fps}/s` : "—"}
                tone={rateTone(stats.fps)}
                verbatim
              />
              <Stat
                icon={Activity}
                label="Bitrate"
                value={describeRate(stats.kbits)}
                verbatim
              />
            </div>
            <dl className="space-y-1.5 text-xs">
              <Row label="Largest frame" value={stats.size ?? "—"} />
              {/* An all-keyframe stream is JPEG by another name, and the ratio
                * is the cheapest way to notice an encoder rebuilding itself
                * over and over: every rebuild costs one. */}
              <Row
                label="Keyframes"
                value={stats.fps > 0 ? `${stats.keyframes} of ${stats.fps}` : "—"}
              />
            </dl>
            {stats.fps > 0 && stats.fps < 20 ? (
              <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                The connection cannot carry more, so the engine is sending
                fewer frames. That is the link, not this device.
              </p>
            ) : null}
          </>
        )}
      </PanelSection>

      {/* Moved here whole from Settings > Stream, where the switches are. */}
      <PanelSection title="Sound" description="Why there might be no sound.">
        {streamPrefs.audio ? (
          <AudioReadout />
        ) : (
          <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            Muted. Turn sound on in Settings.
          </p>
        )}
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
          <Row
            label="Version"
            value={
              stale ? (
                <span className="text-warning">
                  {SHELL_VERSION} · machine has {engineVersion}
                </span>
              ) : (
                SHELL_VERSION
              )
            }
          />
        </dl>

        {stale ? (
          <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
            <p className="text-muted-foreground">
              This page is older than the machine. Reloading picks up{" "}
              {engineVersion}. Your windows stay open, because they live on the
              machine, not here.
            </p>
            <Button
              size="sm"
              className="w-full gap-1.5"
              onClick={() => {
                // Enough on its own: the engine serves index.html as
                // `no-cache` and every asset under a content-hashed name, so a
                // reload revalidates the page and pulls whatever it now points
                // at. See `cache_control` in http.rs.
                globalThis.location.reload()
              }}
            >
              <RefreshCw className="size-3.5" aria-hidden />
              Reload to update
            </Button>
          </div>
        ) : null}

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
        description="Newest first."
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

/**
 * Kilobits into something a person can hold in their head.
 *
 * Zero is "nothing is arriving", which is a different statement from
 * "0 Mbit/s" and worth making differently.
 */
function describeRate(kbits: number): string {
  if (kbits <= 0) return "—"
  if (kbits < 1000) return `${kbits} kbit/s`
  return `${(kbits / 1000).toFixed(1)} Mbit/s`
}

/**
 * Whether a frame rate is worth colouring.
 *
 * The engine's floor is ten a second, so anything near it means the budget has
 * bottomed out. Amber rather than red: it is a degraded picture, not a broken
 * session, and colouring it the same as a dropped connection is what makes
 * every readout look alarming and therefore ignorable.
 */
function rateTone(fps: number): Tone | undefined {
  if (fps === 0) return undefined
  if (fps < 20) return "busy"
  return "good"
}

const Stat = memo(function Stat({
  icon: Icon,
  label,
  value,
  tone,
  verbatim,
}: {
  icon: typeof Radio
  label: string
  value: string
  tone?: Tone | undefined
  /**
   * Show the value exactly as given.
   *
   * The status words ("connected", "waiting") are written lower case and
   * capitalised here, which is wrong for anything with a unit in it: it
   * rendered "218 kbit/s" as "218 Kbit/S".
   */
  verbatim?: boolean | undefined
}) {
  return (
    <div className="rounded-lg border bg-card p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3" aria-hidden />
        {label}
      </div>
      <p
        className={cn(
          "mt-0.5 truncate text-sm font-medium",
          !verbatim && "capitalize",
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
