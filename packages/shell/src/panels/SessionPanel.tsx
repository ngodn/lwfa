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

import { memo, useState } from "react"
import {
  Gamepad2,
  LogOut,
  RefreshCw,
} from "lucide-react"
import { useSessionActions, useSessionState } from "@/session"
import { useLog } from "@/lib/log"
import { supportsH264 } from "@/decode"
import { currentWorkspace, focusedWindow } from "@/strip"
import { patchPrefs, usePrefs } from "@/lib/prefs"
import { Button } from "@/components/ui/button"
import { FieldRow, PanelGroup, PanelSection, ReadoutRow } from "@/panels/parts"
import { describeStatus, type Tone } from "@/lib/status"
import { describeFormat, useStreamFormat } from "@/lib/streamFormat"
import { useStreamStats } from "@/lib/streamStats"
import { AudioReadout } from "@/panels/AudioReadout"
import { cn } from "@/lib/utils"
import { SHELL_VERSION } from "@/generated/config"
import { usePending } from "@/lib/pending"
import { supportsRestart } from "@/lib/restart"
import { useFocusReturn } from "@/lib/useFocusReturn"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

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
  const [confirmRestart, setConfirmRestart] = useState(false)
  const restartFocus = useFocusReturn()
  const restarting = usePending("restartEngine")
  const restartSupported = supportsRestart(engineVersion)
  const canRestart = account === "owner" && restartSupported && status === "connected" && !restarting

  return (
    <div className="space-y-4">
      <PanelSection title="Connection">
        <PanelGroup asChild>
          <dl>
            <Row label="Status" value={<span className={cn("inline-flex items-center gap-1.5 capitalize", toneClass(report.tone))}><span className="size-1.5 rounded-full bg-current" aria-hidden />{report.label}</span>} />
            <Row label="Decode" value={describeFormat(format)} />
            <Row label="Windows" value={windows.size} />
            <Row label="Viewport" value={output.width > 0 ? `${output.width} × ${output.height}` : "Unavailable"} />
          </dl>
        </PanelGroup>
        {report.tone === "good" ? null : (
          <p className="text-xs text-muted-foreground">{report.hint}</p>
        )}
        {!supportsH264() ? (
          <p className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
            H.264 unavailable. A supported browser and HTTPS are required.
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
      >
        {!streamPrefs.enabled ? (
          <p className="rounded-xl border border-dashed p-3 text-xs text-muted-foreground">
            Video paused. Enable it in Stream.
          </p>
        ) : (
          <>
            <PanelGroup asChild>
              <dl>
                <Row label="Frame rate" value={<span className={toneClass(rateTone(stats.fps))}>{stats.fps > 0 ? `${stats.fps} /s` : "Nothing yet"}</span>} />
                <Row label="Bitrate" value={describeRate(stats.kbits)} />
                <Row label="Largest frame" value={stats.size ?? "Nothing yet"} />
                <Row label="Keyframes" value={stats.fps > 0 ? `${stats.keyframes} of ${stats.fps}` : "Nothing yet"} />
              </dl>
            </PanelGroup>
            {stats.fps > 0 && stats.fps < 20 ? (
              <p className="rounded-xl border border-dashed p-3 text-xs text-muted-foreground">
                Low frame rate.
              </p>
            ) : null}
          </>
        )}
      </PanelSection>

      {/* Moved here whole from Settings > Stream, where the switches are. */}
      <PanelSection title="Sound">
        {streamPrefs.audio ? (
          <AudioReadout />
        ) : (
          <PanelGroup>
            <FieldRow>
              <span className="text-sm text-muted-foreground">Muted</span>
              <Button variant="outline" size="sm" className="h-11" onClick={() => patchPrefs("stream", { audio: true })}>Enable</Button>
            </FieldRow>
          </PanelGroup>
        )}
      </PanelSection>

      <PanelSection title="Session">
        <PanelGroup asChild>
          <dl>
            <Row label="Engine" value={<code className="font-mono text-xs">{endpoint}</code>} />
            <Row label="Account" value={`${account || "Not connected"} · ${permissions.mode} · ${permissions.allowedApps === null ? "all apps" : `${permissions.allowedApps.length} apps`}`} />
            <Row label="Workspace" value={`${strip.focus + 1} of ${strip.workspaces.length} · ${workspace.columns.length} columns`} />
            <Row label="Devices" value={`${peers.length <= 1 ? "This one only" : `${peers.length} attached`} · ${primary ? "driving here" : "following"}`} />
            <Row label="Focus" value={focusedTitle ?? "Nothing focused"} />
            <Row label="Version" value={stale ? <span className="text-warning">{SHELL_VERSION} · machine has {engineVersion}</span> : SHELL_VERSION} />
          </dl>
        </PanelGroup>

        {stale ? (
          <div className="space-y-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs">
            <p className="text-muted-foreground">
              Reload to match engine version {engineVersion}. Windows stay open.
            </p>
            <Button
              size="sm"
              className="h-11 w-full gap-1.5"
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
          <Button size="sm" variant="outline" className="h-11 w-full gap-1.5" onClick={actions.takeControl}>
            <Gamepad2 className="size-3.5" aria-hidden />
            Arrange from this device
          </Button>
        ) : null}
      </PanelSection>

      <PanelSection
        title="Log"
        description="Newest first."
      >
        {entries.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">
            Nothing yet.
          </p>
        ) : (
          <ol className="space-y-0.5 rounded-xl border bg-card px-3 py-2.5 font-mono text-[11px] leading-relaxed">
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

      <Button variant="outline" size="sm" className="h-11 w-full gap-2" onClick={actions.signOut}>
        <LogOut className="size-3.5" aria-hidden />
        Sign out of this device
      </Button>
      {account === "owner" ? (
        <div className="space-y-2">
          <Button variant="outline" size="sm" className="h-11 w-full gap-2" disabled={!canRestart} onClick={() => setConfirmRestart(true)}>
            <RefreshCw className={cn("size-3.5", restarting && "animate-spin")} aria-hidden />
            {restarting ? "Restarting lwfa…" : "Restart lwfa"}
          </Button>
          {!restartSupported ? <p className="text-xs text-muted-foreground">Requires engine 1.5.4 or newer.</p> : null}
          <Dialog open={confirmRestart} onOpenChange={setConfirmRestart}>
            <DialogContent onOpenAutoFocus={restartFocus.onOpenAutoFocus} onCloseAutoFocus={restartFocus.onCloseAutoFocus}>
              <DialogHeader>
                <DialogTitle>Restart lwfa?</DialogTitle>
                <DialogDescription>
                  Everyone will disconnect, and running apps and games may close. Save your work first. This page will reconnect automatically.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" className="h-11" onClick={() => setConfirmRestart(false)}>Cancel</Button>
                <Button variant="destructive" className="h-11" disabled={!canRestart} onClick={() => {
                  setConfirmRestart(false)
                  actions.restartEngine()
                }}>Restart lwfa</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      ) : null}
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
  if (kbits <= 0) return "Nothing yet"
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

function toneClass(tone: Tone | undefined): string {
  return cn(
    tone === "good" && "text-success",
    tone === "busy" && "text-warning",
    tone === "bad" && "text-destructive",
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <ReadoutRow>
      <dt className="shrink-0 font-medium">{label}</dt>
      <dd className="min-w-0 break-words text-right text-muted-foreground tabular-nums">{value}</dd>
    </ReadoutRow>
  )
}

export default memo(SessionPanel)
