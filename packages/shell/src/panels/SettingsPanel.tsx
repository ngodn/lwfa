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
import * as audio from "@/lib/audio"
import { decodable } from "@/lib/codecs"
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
import { Field, FieldRow, PanelGroup, PanelSection } from "@/panels/parts"
import { cn } from "@/lib/utils"

const EDGES: { value: NavEdgePref; label: string; icon: typeof PanelLeft }[] = [
  { value: "auto", label: "Auto", icon: Wand2 },
  { value: "left", label: "Left", icon: PanelLeft },
  { value: "top", label: "Top", icon: PanelTop },
  { value: "right", label: "Right", icon: PanelRight },
  { value: "bottom", label: "Bottom", icon: PanelBottom },
]

const SIZES = [
  { value: "sm", label: "36 px" },
  { value: "md", label: "44 px" },
  { value: "lg", label: "52 px" },
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
    <Tabs defaultValue="navigation" className="gap-[15px]">
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

      <TabsContent value="navigation" className="space-y-[15px]">
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

      <TabsContent value="buttons" className="space-y-[15px]">
      <PanelSection
        title="Buttons"
      >
        <PanelGroup asChild>
        <ul>
          {nav.order.map((id, index) => {
            const item = NAV_ITEMS[id]
            const hidden = nav.hidden.includes(id)
            const anchored = nav.anchored.includes(id)
            const Icon = item.icon
            return (
              <li key={id} className="flex min-h-11 items-center gap-1 px-3 py-1">
                <Icon
                  className={cn("size-4 shrink-0", hidden && "opacity-40")}
                  aria-hidden
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[13.5px]",
                    hidden && "text-muted-foreground line-through",
                  )}
                >
                  {item.label}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0"
                  aria-label={`Move ${item.label} ${index === 0 ? "to the end" : "earlier"}`}
                  disabled={index === 0}
                  onClick={() => move(id, -1)}
                >
                  <ArrowUp className="size-4" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0"
                  aria-label={`Move ${item.label} later`}
                  disabled={index === nav.order.length - 1}
                  onClick={() => move(id, 1)}
                >
                  <ArrowDown className="size-4" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0"
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
                  className="size-11 shrink-0"
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
        </PanelGroup>
      </PanelSection>

      </TabsContent>

      <TabsContent value="stream" className="space-y-[15px]">
        <StreamSettings />
      </TabsContent>

      {/* Outside the tabs on purpose: it resets all of them, so filing it under
        * one would be a lie about what it does. */}
      <PanelSection title="Reset">
        <PanelGroup>
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
        </PanelGroup>
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
        <div className="space-y-3 bg-warning/10 p-3">
          <p className="text-sm">
            Streaming all visible windows uses more bandwidth and battery.
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
              Stream all windows
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
  const { stream } = usePrefs()
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

  return (
    <>
      <PanelSection
        title="Video"
        description="Pausing video keeps the connection open."
      >
        <PanelGroup>
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
        </PanelGroup>
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
            No supported video decoder detected. Using JPEG. HTTPS is required
            for H.264 and HEVC.
          </p>
        ) : null}
      </PanelSection>

      <PanelSection
        title="Sound"
      >
        <PanelGroup>
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
          {stream.audio ? (
            <FieldRow>
              <Field
                label="Also play on the desktop's speakers"
                hint={
                  stream.localPlayback
                    ? "Plays on the host and this device"
                    : "Plays on connected devices only"
                }
              />
              <Switch
                checked={stream.localPlayback}
                onCheckedChange={(localPlayback) => patchPrefs("stream", { localPlayback })}
                aria-label="Also play on the desktop's speakers"
              />
            </FieldRow>
          ) : null}
          {stream.audio ? <VolumeRow saved={stream.volume} /> : null}
        </PanelGroup>
        {/*
          * There is no way to detect the iOS mute switch, so this says it
          * rather than leaving someone to conclude the feature is broken.
          */}
        {stream.audio && isApple() ? (
          <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            If audio is silent on iOS, check Silent Mode.
          </p>
        ) : null}
        {stream.audio ? (
          <div className="space-y-1.5">
            <Field
              label="Sound quality"
              hint={
                stream.audioQuality === "auto"
                  ? "Adapts to the connection"
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

    </>
  )
}

/**
 * The volume slider, with its persistence off the drag path.
 *
 * Dragging used to call `patchPrefs` per pointer event, which is a
 * `JSON.stringify` of the whole prefs blob plus a synchronous localStorage
 * write plus a re-render of everything subscribed to prefs, up to 120 times
 * a second on the tablet this runs on. The ear needs `audio.setVolume` per
 * event; the disk only needs the value you let go at.
 */
function VolumeRow({ saved }: { saved: number }) {
  const [live, setLive] = useState<number | null>(null)
  const volume = live ?? saved
  return (
    <FieldRow>
      <Field label="Volume" hint={`${Math.round(volume * 100)}%`} />
      <Slider
        className="w-[min(40%,150px)] shrink-0"
        min={0}
        max={1}
        step={0.05}
        value={[volume]}
        onValueChange={([value]) => {
          const next = value ?? 1
          setLive(next)
          audio.setVolume(next)
        }}
        onValueCommit={([value]) => {
          patchPrefs("stream", { volume: value ?? 1 })
          setLive(null)
        }}
        aria-label="Volume"
      />
    </FieldRow>
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
