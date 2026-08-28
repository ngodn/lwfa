/**
 * The virtual mouse surface.
 *
 * It floats over the desktop like the gamepad, with the whole middle left
 * `pointer-events-none` so a tap on a window passes straight through to it, and
 * only the controls at the edges claim events. The tap on the window is the
 * click; these controls only decide what that click *is* and provide the parts
 * a tap cannot express, scroll, the side buttons, drag-lock and hover.
 *
 * See `lib/mouse.ts` for the live mode this reads and writes, and
 * `WindowSurface` for where a tap becomes the click.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Hand, MousePointer2, MousePointerClick, MousePointer } from "lucide-react"

import { tap } from "@/lib/haptics"
import { cn } from "@/lib/utils"
import { getPrefs, patchPrefs } from "@/lib/prefs"
import {
  type MouseButton,
  resetMouseMode,
  setButton,
  setDragLock,
  setHover,
  useMouseMode,
} from "@/lib/mouse"

/** The clusters that can be rearranged, keyed as in `Prefs.mouse.positions`. */
type ClusterId = "selector" | "tools" | "modifiers"

/** Linux evdev codes for the two side buttons a tap fires directly. */
const BTN_SIDE = 0x113
const BTN_EXTRA = 0x114

/** The modifiers a tap can be held with, as evdev keycodes. */
const MODIFIERS = [
  { code: 29, label: "Ctrl" },
  { code: 42, label: "Shift" },
  { code: 56, label: "Alt" },
] as const

const HIT_AREA = "relative after:absolute after:-inset-2 after:content-['']"

export interface MouseOverlayProps {
  haptics: boolean
  scrollSpeed: number
  naturalScroll: boolean
  /** Rearranging the clusters instead of using them. */
  editing: boolean
  /** Where each cluster sits, as a percentage of the surface. */
  positions: Record<ClusterId, { x: number; y: number }>
  /** A direct button press/release (side buttons). */
  onButton: (button: number, pressed: boolean) => void
  /** Scroll, in the engine's axis units. */
  onAxis: (horizontal: number, vertical: number) => void
  /** A modifier held down (so a tap becomes a modifier-click) or released. */
  onKey: (key: number, pressed: boolean) => void
}

export const MouseOverlay = memo(function MouseOverlay({
  haptics,
  scrollSpeed,
  naturalScroll,
  editing,
  positions,
  onButton,
  onAxis,
  onKey,
}: MouseOverlayProps): React.ReactElement {
  const mode = useMouseMode()

  const saveCluster = useCallback((id: ClusterId, x: number, y: number) => {
    patchPrefs("mouse", { positions: { ...getPrefs().mouse.positions, [id]: { x, y } } })
  }, [])

  // Open clean: the last session's latch, hover and drag-lock never carry over.
  useEffect(() => {
    resetMouseMode()
  }, [])

  const buzz = useCallback(() => {
    if (haptics) tap()
  }, [haptics])

  // Modifiers held for a modifier-click: latched here and held at the seat
  // (the keyboard and mouse cannot be on screen at once, so the mouse carries
  // its own). Kept in a ref as well as state so the unmount cleanup releases
  // exactly what is held without re-subscribing.
  const [held, setHeld] = useState<readonly number[]>([])
  const heldRef = useRef<readonly number[]>([])
  heldRef.current = held
  useEffect(() => {
    // Closing the surface must not leave a modifier stuck down on the machine.
    return () => {
      for (const code of heldRef.current) onKey(code, false)
    }
  }, [onKey])

  const toggleModifier = useCallback(
    (code: number) => {
      buzz()
      setHeld((current) => {
        if (current.includes(code)) {
          onKey(code, false)
          return current.filter((c) => c !== code)
        }
        onKey(code, true)
        return [...current, code]
      })
    },
    [buzz, onKey],
  )

  // A side button is a whole click on tap: press then release, no target.
  const clickThrough = useCallback(
    (button: number) => {
      buzz()
      onButton(button, true)
      onButton(button, false)
    },
    [buzz, onButton],
  )

  const pick = useCallback(
    (button: MouseButton) => {
      buzz()
      setButton(button)
    },
    [buzz],
  )

  // Scroll strip: finger travel becomes wheel, both axes, coalesced to one send
  // per frame so a 120Hz drag does not flood the socket. See the gamepad Stick.
  const scroll = useRef({ raf: 0, dx: 0, dy: 0, lastX: 0, lastY: 0, active: false })
  const flushScroll = useCallback(() => {
    scroll.current.raf = 0
    const { dx, dy } = scroll.current
    scroll.current.dx = 0
    scroll.current.dy = 0
    const sign = naturalScroll ? -1 : 1
    if (dx !== 0 || dy !== 0) onAxis(dx * scrollSpeed * sign, dy * scrollSpeed * sign)
  }, [onAxis, scrollSpeed, naturalScroll])

  const onScrollDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    scroll.current.active = true
    scroll.current.lastX = event.clientX
    scroll.current.lastY = event.clientY
  }, [])

  const onScrollMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!scroll.current.active) return
      scroll.current.dx += event.clientX - scroll.current.lastX
      scroll.current.dy += event.clientY - scroll.current.lastY
      scroll.current.lastX = event.clientX
      scroll.current.lastY = event.clientY
      if (!scroll.current.raf) scroll.current.raf = requestAnimationFrame(flushScroll)
    },
    [flushScroll],
  )

  const endScroll = useCallback(() => {
    scroll.current.active = false
  }, [])

  return (
    // No pointer events of its own so a tap in the middle reaches the window
    // behind; the clusters opt back in. While arranging, the whole area is
    // caught and dimmed instead, so a drag cannot leak to the desktop.
    <div
      className={cn(
        "absolute inset-0 select-none",
        editing ? "pointer-events-auto bg-black/30" : "pointer-events-none",
      )}
    >
      {editing ? (
        <p className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md bg-black/60 px-3 py-1 text-xs text-white/80 backdrop-blur-sm">
          Drag the clusters to rearrange. Tap Done when finished.
        </p>
      ) : null}

      {/* The click-type selector. The active one is highlighted so you always
          know what a tap will do (it is latched). */}
      <Cluster id="selector" pos={positions.selector} editing={editing} onMoveEnd={saveCluster}>
        <div className="flex flex-col gap-3">
          <SelectButton active={mode.button === "left"} onPick={() => pick("left")} label="Left click">
            <MousePointer2 className="size-5" aria-hidden />
          </SelectButton>
          <SelectButton active={mode.button === "right"} onPick={() => pick("right")} label="Right click">
            <MousePointerClick className="size-5" aria-hidden />
          </SelectButton>
          <SelectButton active={mode.button === "middle"} onPick={() => pick("middle")} label="Middle click">
            <MousePointer className="size-5" aria-hidden />
          </SelectButton>
        </div>
      </Cluster>

      {/* Scroll strip, the two side buttons, drag-lock and hover. */}
      <Cluster id="tools" pos={positions.tools} editing={editing} onMoveEnd={saveCluster}>
        <div className="flex flex-col items-center gap-3">
          <div
            onPointerDown={onScrollDown}
            onPointerMove={onScrollMove}
            onPointerUp={endScroll}
            onPointerCancel={endScroll}
            className="flex h-24 w-9 cursor-ns-resize touch-none items-center justify-center rounded-full border border-white/20 bg-black/45 text-white/70 backdrop-blur-sm"
            aria-label="Scroll"
          >
            <div className="size-4 rounded-full bg-white/50" />
          </div>
          <RoundButton onTrigger={() => clickThrough(BTN_SIDE)} label="Back (side button)">
            <ChevronLeft className="size-5" aria-hidden />
          </RoundButton>
          <RoundButton onTrigger={() => clickThrough(BTN_EXTRA)} label="Forward (side button)">
            <ChevronRight className="size-5" aria-hidden />
          </RoundButton>
          <ToggleButton
            active={mode.dragLock}
            onToggle={() => {
              buzz()
              setDragLock(!mode.dragLock)
            }}
            label="Drag lock"
          >
            <Hand className="size-5" aria-hidden />
          </ToggleButton>
          <ToggleButton
            active={mode.hover}
            onToggle={() => {
              buzz()
              setHover(!mode.hover)
            }}
            label="Hover (move without clicking)"
          >
            <MousePointer2 className="size-5" aria-hidden />
          </ToggleButton>
        </div>
      </Cluster>

      {/* Modifiers, latched so the next taps are modifier clicks. Ctrl-click to
          add to a selection, Shift-click for a range. */}
      <Cluster id="modifiers" pos={positions.modifiers} editing={editing} onMoveEnd={saveCluster}>
        <div className="flex gap-2">
          {MODIFIERS.map((m) => (
            <button
              key={m.code}
              onPointerDown={(event) => {
                event.preventDefault()
                toggleModifier(m.code)
              }}
              aria-pressed={held.includes(m.code)}
              title={`${m.label} (held for a modifier click)`}
              className={cn(
                HIT_AREA,
                "flex h-9 min-w-14 touch-none items-center justify-center rounded-md border px-3 text-sm font-medium backdrop-blur-sm",
                held.includes(m.code)
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-white/20 bg-black/45 text-white/80",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </Cluster>
    </div>
  )
})

/**
 * A rearrangeable cluster of controls, positioned as a percentage of the
 * surface. In edit mode it is draggable and the controls inside it are inert;
 * otherwise it is transparent to layout and the controls work normally.
 */
function Cluster({
  id,
  pos,
  editing,
  onMoveEnd,
  children,
}: {
  id: ClusterId
  pos: { x: number; y: number }
  editing: boolean
  onMoveEnd: (id: ClusterId, x: number, y: number) => void
  children: React.ReactNode
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ area: DOMRect; x: number; y: number } | null>(null)

  const onDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!editing) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const area = ref.current?.parentElement?.getBoundingClientRect()
      if (area) drag.current = { area, x: pos.x, y: pos.y }
    },
    [editing, pos.x, pos.y],
  )

  const onMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const el = ref.current
    if (!d || !el) return
    const x = Math.min(96, Math.max(4, ((event.clientX - d.area.left) / d.area.width) * 100))
    const y = Math.min(96, Math.max(4, ((event.clientY - d.area.top) / d.area.height) * 100))
    d.x = x
    d.y = y
    // Straight to the DOM during the drag; prefs are written once, on release.
    el.style.left = `${x}%`
    el.style.top = `${y}%`
  }, [])

  const onUp = useCallback(() => {
    const d = drag.current
    drag.current = null
    if (d) onMoveEnd(id, d.x, d.y)
  }, [id, onMoveEnd])

  return (
    <div
      ref={ref}
      style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
      className={cn(
        "pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 touch-none",
        editing && "cursor-move rounded-xl p-2 ring-2 ring-primary/70",
      )}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <div className={editing ? "pointer-events-none" : undefined}>{children}</div>
    </div>
  )
}

function SelectButton({
  active,
  onPick,
  label,
  children,
}: {
  active: boolean
  onPick: () => void
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      onPointerDown={(event) => {
        event.preventDefault()
        onPick()
      }}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        HIT_AREA,
        "flex size-11 touch-none items-center justify-center rounded-full border backdrop-blur-sm",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-white/20 bg-black/45 text-white/80",
      )}
    >
      {children}
    </button>
  )
}

function RoundButton({
  onTrigger,
  label,
  children,
}: {
  onTrigger: () => void
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      onPointerDown={(event) => {
        event.preventDefault()
        onTrigger()
      }}
      aria-label={label}
      title={label}
      className={cn(
        HIT_AREA,
        "flex size-11 touch-none items-center justify-center rounded-full border border-white/20 bg-black/45 text-white/80 backdrop-blur-sm",
      )}
    >
      {children}
    </button>
  )
}

function ToggleButton({
  active,
  onToggle,
  label,
  children,
}: {
  active: boolean
  onToggle: () => void
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      onPointerDown={(event) => {
        event.preventDefault()
        onToggle()
      }}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        HIT_AREA,
        "flex size-11 touch-none items-center justify-center rounded-full border backdrop-blur-sm",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-white/20 bg-black/45 text-white/80",
      )}
    >
      {children}
    </button>
  )
}
