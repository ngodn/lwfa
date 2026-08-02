/**
 * Settings for this device.
 *
 * # Why tabs
 *
 * These are unrelated groups that happen to share a home, and they grew past
 * the point where one scroll was findable: the rail's shape, the order of its
 * buttons, and what the connection is doing have nothing to do with each other,
 * and hunting past forty rows of button ordering to pause the video is not a
 * settings screen, it is a haystack. Tabs make each group one tap away and keep
 * the sheet's scroll short enough to be worth scrolling.
 *
 * Reordering is done with move buttons rather than drag and drop: this list is
 * operated on a touchscreen as often as with a mouse, a drag inside an
 * already-scrolling sheet is fiddly on both, and buttons are reachable by
 * keyboard without any extra work.
 */

import { memo, useCallback } from "react"
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Eye,
  EyeOff,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  RotateCcw,
  Wand2,
} from "lucide-react"
import { useEffect, useState } from "react"
import { useSessionState } from "@/session"
import * as audio from "@/lib/audio"
import { choose, decodable } from "@/lib/codecs"
import type { Codec } from "@lwfa/proto"
import {
  getPrefs,
  patchPrefs,
  resetPrefs,
  usePrefs,
  type NavEdgePref,
  type NavItemId,
} from "@/lib/prefs"
import { NAV_ITEMS } from "@/nav/registry"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Field, FieldRow, PanelSection } from "@/panels/parts"
import { cn } from "@/lib/utils"

const EDGES: { value: NavEdgePref; label: string; icon: typeof PanelLeft }[] = [
  { value: "auto", label: "Auto", icon: Wand2 },
  { value: "left", label: "Left", icon: PanelLeft },
  { value: "top", label: "Top", icon: PanelTop },
  { value: "right", label: "Right", icon: PanelRight },
  { value: "bottom", label: "Bottom", icon: PanelBottom },
]

const SIZES = [
  { value: "sm", label: "Small" },
  { value: "md", label: "Medium" },
  { value: "lg", label: "Large" },
] as const

function SettingsPanel() {
  const { nav } = usePrefs()

  // Both read the store rather than this render's copy, so pressing a button
  // twice quickly applies the second change on top of the first.
  const move = useCallback((id: NavItemId, delta: -1 | 1) => {
    patchPrefs("nav", { order: reorder(getPrefs().nav.order, id, delta) })
  }, [])

  const anchor = useCallback((id: NavItemId) => {
    const anchored = new Set(getPrefs().nav.anchored)
    if (anchored.has(id)) anchored.delete(id)
    else anchored.add(id)
    patchPrefs("nav", { anchored: [...anchored] })
  }, [])

  const toggle = useCallback((id: NavItemId) => {
    const hidden = new Set(getPrefs().nav.hidden)
    if (hidden.has(id)) hidden.delete(id)
    else hidden.add(id)
    patchPrefs("nav", { hidden: [...hidden] })
  }, [])

  return (
    <Tabs defaultValue="navigation" className="pt-2">
      {/* Sticky, because these lists are long and losing the way back to the
        * other groups halfway down is the whole failure tabs exist to avoid. */}
      <TabsList className="sticky top-0 z-10 w-full">
        <TabsTrigger value="navigation" className="flex-1">
          Navigation
        </TabsTrigger>
        <TabsTrigger value="buttons" className="flex-1">
          Buttons
        </TabsTrigger>
        <TabsTrigger value="stream" className="flex-1">
          Stream
        </TabsTrigger>
      </TabsList>

      <TabsContent value="navigation" className="space-y-6">
      <PanelSection
        title="Position"
        description="Auto follows the shape of the screen."
      >
        <ToggleGroup
          type="single"
          value={nav.edge}
          onValueChange={(value) => value && patchPrefs("nav", { edge: value as NavEdgePref })}
          variant="outline"
          className="grid w-full grid-cols-5"
        >
          {EDGES.map(({ value, label, icon: Icon }) => (
            <ToggleGroupItem
              key={value}
              value={value}
              aria-label={label}
              className="flex-col gap-1 py-2 h-auto"
            >
              <Icon className="size-4" aria-hidden />
              <span className="text-[11px]">{label}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </PanelSection>

      <PanelSection
        title="Button size"
        description="Bigger targets for touch, smaller for a mouse."
      >
        <ToggleGroup
          type="single"
          value={nav.size}
          onValueChange={(value) =>
            value && patchPrefs("nav", { size: value as "sm" | "md" | "lg" })
          }
          variant="outline"
          className="w-full"
        >
          {SIZES.map(({ value, label }) => (
            <ToggleGroupItem key={value} value={value} className="flex-1">
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </PanelSection>

      </TabsContent>

      <TabsContent value="buttons" className="space-y-6">
      <PanelSection
        title="Buttons"
        description="Reorder, hide, or pin buttons."
      >
        <ul className="divide-y rounded-lg border">
          {nav.order.map((id, index) => {
            const item = NAV_ITEMS[id]
            const hidden = nav.hidden.includes(id)
            const anchored = nav.anchored.includes(id)
            const Icon = item.icon
            return (
              <li key={id} className="flex items-center gap-2 p-2">
                <Icon
                  className={cn("size-4 shrink-0", hidden && "opacity-40")}
                  aria-hidden
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-sm",
                    hidden && "text-muted-foreground line-through",
                  )}
                >
                  {item.label}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={`Move ${item.label} ${index === 0 ? "to the end" : "earlier"}`}
                  disabled={index === 0}
                  onClick={() => move(id, -1)}
                >
                  <ArrowUp className="size-4" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={`Move ${item.label} later`}
                  disabled={index === nav.order.length - 1}
                  onClick={() => move(id, 1)}
                >
                  <ArrowDown className="size-4" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={
                    anchored
                      ? `Move ${item.label} to the near end`
                      : `Anchor ${item.label} to the far end`
                  }
                  aria-pressed={anchored}
                  onClick={() => anchor(id)}
                >
                  {anchored ? (
                    <ArrowDownToLine className="size-4 text-primary" aria-hidden />
                  ) : (
                    <ArrowUpToLine className="size-4 opacity-60" aria-hidden />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={hidden ? `Show ${item.label}` : `Hide ${item.label}`}
                  aria-pressed={!hidden}
                  onClick={() => toggle(id)}
                >
                  {hidden ? (
                    <EyeOff className="size-4 opacity-60" aria-hidden />
                  ) : (
                    <Eye className="size-4" aria-hidden />
                  )}
                </Button>
              </li>
            )
          })}
        </ul>
      </PanelSection>

      </TabsContent>

      <TabsContent value="stream" className="space-y-6">
        <StreamSettings />
      </TabsContent>

      {/* Outside the tabs on purpose: it resets all of them, so filing it under
        * one would be a lie about what it does. */}
      <PanelSection title="Reset">
        <FieldRow>
          <Field
            label="Restore defaults"
            hint="Resets this device only."
          />
          <Button variant="outline" size="sm" onClick={resetPrefs} className="gap-2">
            <RotateCcw className="size-3.5" aria-hidden />
            Reset
          </Button>
        </FieldRow>
      </PanelSection>
    </Tabs>
  )
}

/**
 * What this device is asking the engine to send it.
 *
 * Per device, deliberately. The same session can be a laptop on ethernet and a
 * phone on a train, and "how much video would you like" has a different answer
 * for each. None of it changes what anyone else sees.
 */
/**
 * The pause-inactive switch, with a speed bump on the way off.
 *
 * Turning it off means every visible window streams, encodes and decodes at
 * once, which is the single easiest way to make a session with a few windows
 * feel broken everywhere. So the off direction asks first, inline rather than
 * in a dialog: the panel is non-modal over a live desktop, and a portal'd
 * confirmation box would be a heavier thing than the choice deserves.
 * Turning it back on is always instant and never asks.
 */
function PauseInactive({ value, disabled }: { value: boolean; disabled: boolean }) {
  const [confirming, setConfirming] = useState(false)

  return (
    <>
      <FieldRow>
        <Field
          label="Pause inactive windows"
          hint={
            value
              ? "Only the focused window streams live"
              : "Every visible window streams live"
          }
        />
        <Switch
          checked={value}
          disabled={disabled}
          onCheckedChange={(next) => {
            if (next) {
              patchPrefs("stream", { pauseInactive: true })
              setConfirming(false)
            } else {
              setConfirming(true)
            }
          }}
          aria-label="Pause inactive windows"
        />
      </FieldRow>
      {confirming ? (
        <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/10 p-3">
          <p className="text-sm">
            <span className="font-medium">Streaming every window costs real performance.</span>{" "}
            <span className="text-muted-foreground">
              Each one keeps rendering, encoding and decoding even while you
              work elsewhere. With several windows open this is what makes the
              whole session feel laggy.
            </span>
          </p>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-11 flex-1"
              onClick={() => {
                patchPrefs("stream", { pauseInactive: false })
                setConfirming(false)
              }}
            >
              Stream them all anyway
            </Button>
            <Button size="sm" className="h-11 flex-1" onClick={() => setConfirming(false)}>
              Keep pausing
            </Button>
          </div>
        </div>
      ) : null}
    </>
  )
}

function StreamSettings() {
  const { stream, motion } = usePrefs()
  const { permissions } = useSessionState()
  /**
   * What this device can decode, asked of it once when the panel opens.
   *
   * Drives both which choices are offered and what the status section reports,
   * so the panel can never offer a codec that would produce a black window.
   */
  const [decodes, setDecodes] = useState<Codec[]>([])
  useEffect(() => {
    let live = true
    void decodable().then((codecs) => live && setDecodes(codecs))
    return () => {
      live = false
    }
  }, [])
  const hardware = decodes.length > 0

  /**
   * The codec that will actually be used, by the same rule the engine applies:
   * the preference narrows what the device offers, and the best survivor wins.
   */
  const inUse = (() => {
    if (stream.codec === "jpeg") return null
    const allowed = stream.codec === "auto" ? decodes : decodes.filter((c) => c === stream.codec)
    const chosen = choose(allowed)
    return chosen === "hevc" ? "HEVC, hardware" : chosen === "h264" ? "H.264, hardware" : null
  })()

  return (
    <>
      <PanelSection
        title="Video"
        description="Pause video to save battery. Stays connected."
      >
        <FieldRow>
          <Field
            label="Show the desktop"
            hint={stream.enabled ? "Receiving video" : "Paused"}
          />
          <Switch
            checked={stream.enabled}
            onCheckedChange={(enabled) => patchPrefs("stream", { enabled })}
            aria-label="Show the desktop"
          />
        </FieldRow>
        <PauseInactive value={stream.pauseInactive} disabled={!stream.enabled} />
      </PanelSection>

      <PanelSection
        title="Video quality"
        description="Video uses less bandwidth. JPEG keeps text sharper."
      >
        <ToggleGroup
          type="single"
          value={stream.codec}
          onValueChange={(value) =>
            value && patchPrefs("stream", { codec: value as typeof stream.codec })
          }
          variant="outline"
          className="w-full"
          disabled={!stream.enabled}
        >
          <ToggleGroupItem value="auto" className="h-11 flex-1">
            Auto
          </ToggleGroupItem>
          {/* Only offered where the device can actually decode them, so a
            * choice can never produce a black window. */}
          {decodes.includes("hevc") ? (
            <ToggleGroupItem value="hevc" className="h-11 flex-1">
              HEVC
            </ToggleGroupItem>
          ) : null}
          {decodes.includes("h264") ? (
            <ToggleGroupItem value="h264" className="h-11 flex-1">
              H.264
            </ToggleGroupItem>
          ) : null}
          <ToggleGroupItem value="jpeg" className="h-11 flex-1">
            JPEG
          </ToggleGroupItem>
        </ToggleGroup>

        {/*
          * Not a setting, an explanation. WebCodecs is only exposed in a secure
          * context, so the same browser has a hardware decoder on localhost and
          * none at all over plain HTTP on a LAN address. Without saying so, the
          * "automatic" option silently does nothing and looks broken.
          */}
        {!hardware ? (
          <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            Over plain HTTP the browser blocks hardware decoding, so
            Automatic uses JPEG. Serve the shell over HTTPS to enable H.264.
          </p>
        ) : null}
      </PanelSection>

      <PanelSection
        title="Sound"
        description="Sound from apps running on the desktop."
      >
        <FieldRow>
          <Field
            label="Enable audio"
            hint={stream.audio ? "Streaming" : "Muted"}
          />
          <Switch
            checked={stream.audio}
            onCheckedChange={(audio) => patchPrefs("stream", { audio })}
            aria-label="Enable audio"
          />
        </FieldRow>
        {/*
          * There is no way to detect the iOS mute switch, so this says it
          * rather than leaving someone to conclude the feature is broken.
          */}
        {stream.audio && isApple() ? (
          <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            No sound? Check the ringer switch. iOS mutes web audio when the
            ringer is off.
          </p>
        ) : null}
        {stream.audio ? <AudioDiagnostics /> : null}
        {stream.audio ? (
          <FieldRow>
            <Field
              label="Also play on the desktop's speakers"
              hint={
                stream.localPlayback
                  ? "Anyone in that room hears it too"
                  : "Only devices listening like this one"
              }
            />
            <Switch
              checked={stream.localPlayback}
              onCheckedChange={(localPlayback) => patchPrefs("stream", { localPlayback })}
              aria-label="Also play on the desktop's speakers"
            />
          </FieldRow>
        ) : null}
        {stream.audio ? (
          <FieldRow>
            <Field label="Volume" hint={`${Math.round(stream.volume * 100)}%`} />
            <Slider
              className="w-40"
              min={0}
              max={1}
              step={0.05}
              value={[stream.volume]}
              onValueChange={([volume]) =>
                patchPrefs("stream", { volume: volume ?? 1 })
              }
              aria-label="Volume"
            />
          </FieldRow>
        ) : null}
        {stream.audio ? (
          <div className="space-y-1.5">
            <Field
              label="Sound quality"
              hint={
                stream.audioQuality === "auto"
                  ? "Follows the connection, like the picture"
                  : { high: "128 kbit/s", medium: "96 kbit/s", low: "64 kbit/s" }[
                      stream.audioQuality
                    ]
              }
            />
            <ToggleGroup
              type="single"
              value={stream.audioQuality}
              onValueChange={(value) => {
                if (value) {
                  patchPrefs("stream", {
                    audioQuality: value as "auto" | "high" | "medium" | "low",
                  })
                }
              }}
              variant="outline"
              className="w-full"
            >
              <ToggleGroupItem value="auto" className="h-11 flex-1">
                Auto
              </ToggleGroupItem>
              <ToggleGroupItem value="high" className="h-11 flex-1">
                High
              </ToggleGroupItem>
              <ToggleGroupItem value="medium" className="h-11 flex-1">
                Medium
              </ToggleGroupItem>
              <ToggleGroupItem value="low" className="h-11 flex-1">
                Low
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        ) : null}
      </PanelSection>

      <PanelSection
        title="Motion"
        description="Slide windows to their new positions."
      >
        <FieldRow>
          <Field label="Animate windows" hint={motion.animate ? "Sliding" : "Instant"} />
          <Switch
            checked={motion.animate}
            onCheckedChange={(animate) => patchPrefs("motion", { animate })}
            aria-label="Animate windows"
          />
        </FieldRow>
      </PanelSection>

      <PanelSection
        title="Status"
      >
        <dl className="space-y-1.5 text-xs">
          <Readout
            label="Encoding in use"
            value={
              !stream.enabled
                ? "Nothing"
                : (inUse ?? "JPEG")
            }
          />
          <Readout label="Sound" value={stream.audio ? "48kHz stereo, uncompressed" : "Muted"} />
          {stream.audio ? (
            <Readout
              label="Playback"
              value={hardware ? "Audio worklet" : "Scheduled buffers"}
            />
          ) : null}
          <Readout
            label="This session"
            value={permissions.mode === "interact" ? "Can interact" : "Viewing only"}
          />
        </dl>
      </PanelSection>
    </>
  )
}

/**
 * Whether this is an Apple mobile device, for the mute-switch note.
 *
 * An iPad in desktop mode reports itself as a Macintosh, so the touch count is
 * what separates it from a real Mac. Same tell as `describeDevice` in App.
 */
function isApple(): boolean {
  const ua = navigator.userAgent
  return /iPad|iPhone/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

/**
 * Live state of the audio graph.
 *
 * Deliberately blunt. "Running, worklet, 1423 chunks" and "suspended, 0 chunks"
 * are different problems with the same symptom, and without this the only way
 * to tell them apart is a laptop and a debugger, which is precisely what nobody
 * has when the thing that is silent is a tablet.
 */
function AudioDiagnostics() {
  const [state, setState] = useState(() => audio.diagnostics())
  useEffect(() => {
    const timer = setInterval(() => setState(audio.diagnostics()), 700)
    return () => clearInterval(timer)
  }, [])

  const stalled = state.contextState !== "running"
  const starved = state.contextState === "running" && state.chunks === 0

  return (
    <div
      className={cn(
        "space-y-1 rounded-lg border p-3 text-xs",
        stalled || starved ? "border-warning/40 bg-warning/10" : "border-dashed",
      )}
    >
      <dl className="space-y-1">
        <Readout label="Audio context" value={state.contextState} />
        <Readout label="Playback path" value={state.path} />
        <Readout label="Chunks received" value={String(state.chunks)} />
        <Readout label="Dropouts" value={String(state.underruns)} />
      </dl>
      {stalled ? (
        <p className="pt-1 text-muted-foreground">
          The browser has not started audio. Tap anywhere on the page: it will
          not begin until the page has been touched.
        </p>
      ) : null}
      {starved ? (
        <p className="pt-1 text-muted-foreground">
          Playing, but nothing is arriving from the machine. That is the
          connection or the engine, not this device.
        </p>
      ) : null}
    </div>
  )
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  )
}

/** Move one id by one position, clamped. Pure, so it is trivially testable. */
export function reorder(order: NavItemId[], id: NavItemId, delta: -1 | 1): NavItemId[] {
  const from = order.indexOf(id)
  if (from === -1) return order
  const to = from + delta
  if (to < 0 || to >= order.length) return order
  const next = [...order]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}

export default memo(SettingsPanel)
