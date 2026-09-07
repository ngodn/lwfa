/**
 * Live state of the audio graph.
 *
 * Deliberately blunt. "Running, worklet, 1423 chunks" and "suspended, 0 chunks"
 * are different problems with the same symptom, and without this the only way
 * to tell them apart is a laptop and a debugger, which is precisely what nobody
 * has when the thing that is silent is a tablet.
 *
 * Moved out of the settings panel, which is where the switches are, into the
 * session panel, which is where somebody goes when it sounds wrong. Two values
 * that used to sit alongside these were wrong in the way readings kept away
 * from their measurement always eventually are, and both are fixed here:
 *
 * - The format said "48kHz stereo, uncompressed" whenever sound was on. It is
 *   Opus in every normal session, and the line below it said so. It now reads
 *   the same source that line does.
 * - The playback path was decided by `hardware`, meaning "can this browser
 *   decode H.264". That has nothing to do with which audio player is running.
 *   `audio.diagnostics()` has always known the real answer.
 */

import { useEffect, useState } from "react"
import * as audio from "@/lib/audio"
import { cn } from "@/lib/utils"
import { PanelGroup, ReadoutRow } from "@/panels/parts"

export function AudioReadout() {
  const [state, setState] = useState(() => audio.diagnostics())
  useEffect(() => {
    // Bail when nothing moved: `diagnostics()` returns a fresh object every
    // call, so setting it unconditionally re-rendered this panel every tick
    // even while every number stood still.
    const timer = setInterval(
      () =>
        setState((last) => {
          const next = audio.diagnostics()
          return (Object.keys(next) as (keyof typeof next)[]).every(
            (key) => next[key] === last[key],
          )
            ? last
            : next
        }),
      700,
    )
    return () => clearInterval(timer)
  }, [])

  const stalled = state.contextState !== "running"
  const starved = state.contextState === "running" && state.chunks === 0
  // The player's own cushion is meant to sit around 60ms. Anything much above
  // that is delay this device is adding, not delay the network caused, and it
  // used to be invisible: a burst arriving after a stalled connection filled
  // the buffer to its ceiling and it stayed there for the rest of the session.
  const laggy = state.bufferedMs > 150

  return (
    <div
      className={cn(
        "space-y-2 text-xs",
        stalled || starved || laggy ? "text-warning" : "",
      )}
    >
      <PanelGroup asChild>
        <dl>
          <Readout label="Audio context" value={state.contextState} />
          <Readout label="Playback path" value={describePath(state.path)} />
          <Readout
            label="Incoming audio"
            value={
              state.wire === "none"
                ? "nothing yet"
                : state.wire === "opus"
                  ? `Opus, ${state.wireKbits > 0 ? `${state.wireKbits} kbit/s` : "measuring"}`
                  : "raw PCM, 1536 kbit/s"
            }
          />
          {state.bufferedMs >= 0 ? (
            <Readout label="Playback buffer" value={`${state.bufferedMs} ms`} />
          ) : null}
          <Readout label="Chunks received" value={String(state.chunks)} />
          <Readout label="Dropouts" value={String(state.underruns)} />
        </dl>
      </PanelGroup>
      {state.wire === "pcm" ? (
        <p className="pt-1 text-muted-foreground">
          Uncompressed audio fallback is active.
        </p>
      ) : null}
      {laggy ? (
        <p className="pt-1 text-muted-foreground">
          Playback buffer is high.
        </p>
      ) : null}
      {stalled ? (
        <p className="pt-1 text-muted-foreground">
          Tap to start audio.
        </p>
      ) : null}
      {starved ? (
        <p className="pt-1 text-muted-foreground">
          No audio received yet.
        </p>
      ) : null}
    </div>
  )
}

/**
 * Which player is running, in words rather than in the internal name.
 *
 * The distinction is worth showing rather than hiding: the worklet is the
 * low-latency path and is only available in a secure context, so "scheduled"
 * here is usually the same story as JPEG video, and both are fixed by serving
 * the shell over HTTPS.
 */
function describePath(path: "worklet" | "scheduled" | "none"): string {
  switch (path) {
    case "worklet":
      return "Audio worklet"
    case "scheduled":
      return "Scheduled buffers (no HTTPS)"
    default:
      return "None"
  }
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <ReadoutRow>
      <dt className="font-medium text-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right text-muted-foreground tabular-nums">{value}</dd>
    </ReadoutRow>
  )
}
