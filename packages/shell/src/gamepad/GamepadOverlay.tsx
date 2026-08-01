/**
 * The gamepad itself, drawn over the desktop.
 *
 * # Play and edit are two different renderers
 *
 * In **play** mode this is a handful of absolutely positioned buttons and
 * nothing else: no canvas, no graph library, no grid. That matters. The thing
 * behind these controls is a game, and a dot grid over it while you are trying
 * to see enemies is exactly the kind of "editor bleeding into the product" that
 * makes an overlay feel unfinished. It also keeps the play path free of a
 * library that has no business running while somebody is holding a jump button.
 *
 * In **edit** mode the same pads become React Flow nodes on a canvas with a dot
 * background, so they can be dragged and resized against a visible grid.
 *
 * Both read the same `Pad[]`, so what you arrange is exactly what you play.
 */

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Background, BackgroundVariant, ReactFlow, type Node, type NodeProps } from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { SKIN_LABELS, clampPad, type Pad } from "@/gamepad/model"
import type { GamepadSkin } from "@/lib/prefs"
import { cn } from "@/lib/utils"

export interface GamepadOverlayProps {
  pads: Pad[]
  skin: GamepadSkin
  opacity: number
  haptics: boolean
  editing: boolean
  onChange: (pads: Pad[]) => void
  onKey: (code: number, pressed: boolean) => void
}

export const GamepadOverlay = memo(function GamepadOverlay(props: GamepadOverlayProps) {
  return props.editing ? <EditCanvas {...props} /> : <PlaySurface {...props} />
})

/* ------------------------------------------------------------------ play -- */

const PlaySurface = memo(function PlaySurface({
  pads,
  skin,
  opacity,
  haptics,
  onKey,
}: GamepadOverlayProps) {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 select-none"
      // A size container, so pads can be sized in `cqmin`: a percentage of the
      // play area's *smaller* side. Sizing off the width alone makes every pad
      // enormous on a landscape tablet and unusably small in portrait, which is
      // the same layout looking wrong on both.
      style={{ opacity, containerType: "size" }}
      aria-label="On-screen gamepad"
    >
      {pads.map((pad) => (
        <PlayPad key={pad.id} pad={pad} skin={skin} haptics={haptics} onKey={onKey} />
      ))}
    </div>
  )
})

const PlayPad = memo(function PlayPad({
  pad,
  skin,
  haptics,
  onKey,
}: {
  pad: Pad
  skin: GamepadSkin
  haptics: boolean
  onKey: (code: number, pressed: boolean) => void
}) {
  // Which keycode each active pointer is holding, so a finger that slides off
  // still releases the key it pressed. Without this a lifted finger can leave a
  // direction held down and the character walks into a wall forever.
  const holding = useRef(new Map<number, number>())

  const buzz = useCallback(() => {
    if (haptics) globalThis.navigator?.vibrate?.(6)
  }, [haptics])

  const down = useCallback(
    (event: React.PointerEvent<HTMLElement>, code: number) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      holding.current.set(event.pointerId, code)
      buzz()
      onKey(code, true)
    },
    [buzz, onKey],
  )

  const up = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const code = holding.current.get(event.pointerId)
      if (code === undefined) return
      holding.current.delete(event.pointerId)
      onKey(code, false)
    },
    [onKey],
  )

  // Inset by half the pad, so a control near an edge stays fully reachable
  // rather than being half off-screen where a thumb cannot land on it.
  const style: React.CSSProperties = {
    left: `clamp(${pad.size / 2}cqmin, ${pad.x}%, calc(100% - ${pad.size / 2}cqmin))`,
    top: `clamp(${pad.size / 2}cqmin, ${pad.y}%, calc(100% - ${pad.size / 2}cqmin))`,
    width: `${pad.size}cqmin`,
    aspectRatio: "1",
    transform: "translate(-50%, -50%)",
    // Re-enabled per pad, so the gaps between them stay clickable by the game.
    pointerEvents: "auto",
    // Otherwise a drag on the pad scrolls or zooms the page instead of playing.
    touchAction: "none",
  }

  if (pad.kind === "stick" && pad.directions) {
    return <Stick pad={pad} style={style} haptics={haptics} onKey={onKey} />
  }

  if (pad.kind === "dpad" && pad.directions) {
    const [up_, right, down_, left] = pad.directions
    return (
      <div className="absolute" style={style}>
        <div className="grid h-full w-full grid-cols-3 grid-rows-3">
          <span />
          <Segment onDown={(e) => down(e, up_)} onUp={up} className="rounded-t-lg">▲</Segment>
          <span />
          <Segment onDown={(e) => down(e, left)} onUp={up} className="rounded-l-lg">◀</Segment>
          <span className="border border-white/10 bg-black/30" />
          <Segment onDown={(e) => down(e, right)} onUp={up} className="rounded-r-lg">▶</Segment>
          <span />
          <Segment onDown={(e) => down(e, down_)} onUp={up} className="rounded-b-lg">▼</Segment>
          <span />
        </div>
      </div>
    )
  }

  const label = SKIN_LABELS[skin]?.[pad.face] ?? pad.face
  return (
    <button
      className={cn(
        "absolute grid place-items-center border border-white/20 bg-black/45 text-white/90",
        "backdrop-blur-sm transition-transform active:scale-95 active:bg-white/25",
        pad.kind === "trigger" ? "rounded-lg text-xs" : "rounded-full text-base",
        skin === "playstation" && pad.kind === "button" && "text-lg",
      )}
      style={style}
      onPointerDown={(event) => pad.code !== undefined && down(event, pad.code)}
      onPointerUp={up}
      onPointerCancel={up}
      onContextMenu={(event) => event.preventDefault()}
      aria-label={String(label)}
    >
      {label}
    </button>
  )
})

/**
 * An analog thumbstick.
 *
 * # Analog on a keyboard transport
 *
 * The stick reports a direction and a magnitude; the wire carries key presses.
 * So the circle is quantised into eight directions and the keys for the
 * current one are held down, with a dead zone in the middle so resting a thumb
 * does not walk the character into a wall. Diagonals hold two keys at once,
 * which is exactly what WASD does on a real keyboard.
 *
 * The nub is moved with a transform written straight to the DOM. Putting its
 * position in React state would re-render on every pointermove of a thumb that
 * never stops moving, which is the one place in this UI that genuinely cannot
 * afford it.
 *
 * A tap that never leaves the dead zone is a *click*: L3 or R3.
 */
const Stick = memo(function Stick({
  pad,
  style,
  haptics,
  onKey,
}: {
  pad: Pad
  style: React.CSSProperties
  haptics: boolean
  onKey: (code: number, pressed: boolean) => void
}) {
  const nub = useRef<HTMLSpanElement | null>(null)
  const held = useRef<Set<number>>(new Set())
  const moved = useRef(false)

  const release = useCallback(() => {
    for (const code of held.current) onKey(code, false)
    held.current.clear()
    nub.current?.style.setProperty("transform", "translate(-50%, -50%)")
  }, [onKey])

  /** Hold exactly the keys the current direction implies, and no others. */
  const apply = useCallback(
    (wanted: Set<number>) => {
      for (const code of held.current) {
        if (!wanted.has(code)) onKey(code, false)
      }
      for (const code of wanted) {
        if (!held.current.has(code)) onKey(code, true)
      }
      held.current = wanted
    },
    [onKey],
  )

  const track = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const box = event.currentTarget.getBoundingClientRect()
      const radius = box.width / 2
      let dx = event.clientX - (box.left + radius)
      let dy = event.clientY - (box.top + radius)
      const distance = Math.hypot(dx, dy)

      // Clamp the nub to the rim, so it reads as a physical stick rather than
      // a dot that can be dragged across the screen.
      if (distance > radius) {
        dx = (dx / distance) * radius
        dy = (dy / distance) * radius
      }
      nub.current?.style.setProperty(
        "transform",
        `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`,
      )

      const [up, right, down, left] = pad.directions!
      const wanted = new Set<number>()
      // A quarter of the travel. Below that a resting thumb sends nothing.
      if (distance > radius * 0.25) {
        moved.current = true
        // 22.5 degrees either side of each axis, so diagonals hold two keys.
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI
        if (angle > -157.5 && angle < -22.5) wanted.add(up)
        if (angle > 22.5 && angle < 157.5) wanted.add(down)
        if (angle > -67.5 && angle < 67.5) wanted.add(right)
        if (angle > 112.5 || angle < -112.5) wanted.add(left)
      }
      apply(wanted)
    },
    [apply, pad.directions],
  )

  return (
    <div
      className="absolute grid place-items-center rounded-full border border-white/20 bg-black/35 backdrop-blur-sm"
      style={style}
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        moved.current = false
        if (haptics) globalThis.navigator?.vibrate?.(6)
        track(event)
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) track(event)
      }}
      onPointerUp={(event) => {
        // Never left the dead zone: that was a click, not a push.
        if (!moved.current && pad.clickCode !== undefined) {
          onKey(pad.clickCode, true)
          onKey(pad.clickCode, false)
        }
        release()
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={release}
      onContextMenu={(event) => event.preventDefault()}
      aria-label={pad.face === "lstick" ? "Left stick" : "Right stick"}
    >
      <span
        ref={nub}
        className="pointer-events-none absolute top-1/2 left-1/2 size-[45%] rounded-full border border-white/30 bg-white/25"
        style={{ transform: "translate(-50%, -50%)" }}
      />
    </div>
  )
})

function Segment({
  children,
  className,
  onDown,
  onUp,
}: {
  children: React.ReactNode
  className?: string
  onDown: (event: React.PointerEvent<HTMLElement>) => void
  onUp: (event: React.PointerEvent<HTMLElement>) => void
}) {
  return (
    <button
      className={cn(
        "grid place-items-center border border-white/20 bg-black/45 text-[10px] text-white/80",
        "backdrop-blur-sm active:bg-white/25",
        className,
      )}
      style={{ touchAction: "none" }}
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ edit -- */

type PadNode = Node<{ pad: Pad; skin: GamepadSkin; px: number }, "pad">

/**
 * Edit and play must agree to the pixel.
 *
 * Play positions a pad by its *centre*, as a percentage of the area, and sizes
 * it in `cqmin`. React Flow positions a node by its *top-left*, in pixels. Get
 * that conversion wrong and the editor becomes a lie: you arrange a controller,
 * press Done, and everything has moved. So the measured box is the single
 * source of truth and both directions of the conversion live here, next to each
 * other, rather than being re-derived at each call site.
 */
function toPixels(pad: Pad, w: number, h: number) {
  const px = (pad.size * Math.min(w, h)) / 100
  return {
    px,
    x: (pad.x / 100) * w - px / 2,
    y: (pad.y / 100) * h - px / 2,
  }
}

function toPercent(x: number, y: number, px: number, w: number, h: number) {
  return {
    x: ((x + px / 2) / w) * 100,
    y: ((y + px / 2) / h) * 100,
  }
}

const EditCanvas = memo(function EditCanvas({ pads, skin, onChange }: GamepadOverlayProps) {
  const box = useRef<HTMLDivElement | null>(null)
  // In state, not a ref: the nodes cannot be positioned until the box has been
  // measured, so the first render genuinely has to happen again once it has.
  // Only edit mode pays for this, and edit mode is not a hot path.
  const [area, setArea] = useState<{ w: number; h: number } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      setArea({ w: rect.width, h: rect.height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const nodes = useMemo<PadNode[]>(() => {
    if (!area) return []
    return pads.map((pad) => {
      const { x, y, px } = toPixels(pad, area.w, area.h)
      return {
        id: pad.id,
        type: "pad" as const,
        position: { x, y },
        data: { pad, skin, px },
        // Dragging and resizing are the point; connecting them is meaningless.
        connectable: false,
        deletable: false,
      }
    })
  }, [pads, skin, area])

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      if (!area) return
      onChange(
        pads.map((pad) => {
          if (pad.id !== node.id) return pad
          const { px } = toPixels(pad, area.w, area.h)
          return clampPad({ ...pad, ...toPercent(node.position.x, node.position.y, px, area.w, area.h) })
        }),
      )
    },
    [onChange, pads, area],
  )

  /** Resize from the corner handle, keeping the pad's centre where it was. */
  const resize = useCallback(
    (id: string, deltaPx: number) => {
      if (!area) return
      onChange(
        pads.map((pad) =>
          pad.id === id
            ? clampPad({ ...pad, size: pad.size + (deltaPx / Math.min(area.w, area.h)) * 100 })
            : pad,
        ),
      )
    },
    [onChange, pads, area],
  )

  return (
    <div ref={box} className="absolute inset-0 z-10">
      <ReactFlow
        nodes={nodes}
        edges={[]}
        nodeTypes={NODE_TYPES}
        onNodeDragStop={onNodeDragStop}
        // A layout editor is not a diagram: panning and zooming the canvas
        // would move the pads relative to the game behind them, which is
        // exactly the thing being positioned. The viewport stays 1:1 so a
        // node's pixel position means the same thing as the play surface's.
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        nodesConnectable={false}
        elementsSelectable
        // Spread rather than passed as `undefined`: this repo runs with
        // `exactOptionalPropertyTypes`, under which an explicit `undefined` is
        // not the same as an absent prop.
        {...(area ? { nodeExtent: [[0, 0], [area.w, area.h]] as [[number, number], [number, number]] } : {})}
        proOptions={{ hideAttribution: true }}
        className="bg-transparent"
        onNodeClick={(_, node) => setSelected(node.id)}
        onPaneClick={() => setSelected(null)}
      >
        {/* The dots exist only here. See the module comment: a grid over a
            running game is an editor leaking into the product. */}
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} className="opacity-60" />
      </ReactFlow>
      <ResizeBar selected={selected} pads={pads} onResize={resize} />
    </div>
  )
})

/**
 * Resizing, as a pair of buttons rather than a drag handle.
 *
 * A corner handle on a circular pad is fiddly with a mouse and genuinely hard
 * with a finger, which is the input this editor is for. Two large buttons hit
 * the same requirement, work on a touchscreen, and are reachable by keyboard.
 */
const ResizeBar = memo(function ResizeBar({
  selected,
  pads,
  onResize,
}: {
  selected: string | null
  pads: Pad[]
  onResize: (id: string, deltaPx: number) => void
}) {
  const pad = pads.find((p) => p.id === selected)
  if (!pad) {
    return (
      <p className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-xs text-primary/70">
        Drag a control to move it. Tap one to resize.
      </p>
    )
  }
  return (
    <div className="absolute inset-x-0 bottom-2 flex items-center justify-center gap-2">
      <div className="flex items-center gap-1 rounded-lg border bg-card/95 p-1 backdrop-blur-md">
        <span className="px-2 text-xs text-muted-foreground">{pad.id}</span>
        <button
          className="size-8 rounded-md border text-lg leading-none active:bg-accent"
          onClick={() => onResize(pad.id, -16)}
          aria-label={`Make ${pad.id} smaller`}
        >
          &minus;
        </button>
        <button
          className="size-8 rounded-md border text-lg leading-none active:bg-accent"
          onClick={() => onResize(pad.id, 16)}
          aria-label={`Make ${pad.id} bigger`}
        >
          +
        </button>
      </div>
    </div>
  )
})

const PadNodeView = memo(function PadNodeView({ data }: NodeProps<PadNode>) {
  const { pad, skin, px } = data
  const label = pad.kind === "dpad" ? "\u271b" : pad.kind === "stick" ? "\u25c9" : (SKIN_LABELS[skin]?.[pad.face] ?? pad.face)
  return (
    <div
      className={cn(
        "grid place-items-center border-2 border-dashed border-primary/70 bg-primary/15",
        "text-xs text-primary backdrop-blur-sm",
        pad.kind === "trigger" ? "rounded-lg" : "rounded-full",
      )}
      style={{ width: px, height: px }}
    >
      {label}
    </div>
  )
})

const NODE_TYPES = { pad: PadNodeView }
