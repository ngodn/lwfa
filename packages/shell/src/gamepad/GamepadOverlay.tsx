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

import { memo, useCallback, useMemo, useRef } from "react"
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

type PadNode = Node<{ pad: Pad; skin: GamepadSkin }, "pad">

const EditCanvas = memo(function EditCanvas({ pads, skin, onChange }: GamepadOverlayProps) {
  const box = useRef<HTMLDivElement | null>(null)

  // React Flow works in pixels; the layout is stored in percentages so it
  // survives a rotation or a different device. Convert at the boundary.
  const nodes = useMemo<PadNode[]>(() => {
    const rect = box.current?.getBoundingClientRect()
    const w = rect?.width ?? 1000
    const h = rect?.height ?? 700
    return pads.map((pad) => ({
      id: pad.id,
      type: "pad",
      position: { x: (pad.x / 100) * w, y: (pad.y / 100) * h },
      data: { pad, skin },
      // Dragging is the entire point; connecting them is meaningless here.
      connectable: false,
      deletable: false,
    }))
  }, [pads, skin])

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      const rect = box.current?.getBoundingClientRect()
      if (!rect) return
      onChange(
        pads.map((pad) =>
          pad.id === node.id
            ? clampPad({
                ...pad,
                x: (node.position.x / rect.width) * 100,
                y: (node.position.y / rect.height) * 100,
              })
            : pad,
        ),
      )
    },
    [onChange, pads],
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
        // exactly the thing being positioned.
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
        className="bg-transparent"
      >
        {/* The dots exist only here. See the module comment: a grid over a
            running game is an editor leaking into the product. */}
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} className="opacity-60" />
      </ReactFlow>
    </div>
  )
})

const PadNodeView = memo(function PadNodeView({ data }: NodeProps<PadNode>) {
  const { pad, skin } = data
  const label =
    pad.kind === "dpad" ? "✛" : pad.kind === "stick" ? "◉" : (SKIN_LABELS[skin]?.[pad.face] ?? pad.face)
  return (
    <div
      className={cn(
        "grid place-items-center border-2 border-dashed border-primary/70 bg-primary/15",
        "text-sm text-primary backdrop-blur-sm",
        pad.kind === "trigger" ? "rounded-lg" : "rounded-full",
      )}
      style={{ width: pad.size * 8, height: pad.size * 8 }}
    >
      {label}
    </div>
  )
})

const NODE_TYPES = { pad: PadNodeView }
