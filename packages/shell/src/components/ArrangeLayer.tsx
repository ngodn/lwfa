/**
 * The controls drawn over each window while arranging.
 *
 * # Why this is a separate layer and not part of the window
 *
 * The desktop is one scaled element: every window inside it is transformed by
 * the same `scale()`, which is what lets arrange mode zoom out without moving
 * or remounting a single surface. Controls placed inside that element would be
 * scaled too, so on a strip zoomed to a third they would be third-size buttons,
 * which is unusable with a finger and gets worse the more windows you have.
 *
 * So the controls live outside the scene, in screen pixels, positioned by
 * applying the scene's transform to each window's rect. They stay 44px
 * whatever the zoom.
 *
 * # Why the transform arrives as a prop
 *
 * On the ordinary path the scene's scale and offset are CSS variables written
 * straight to the element, so a resize costs no React work at all. That is
 * deliberate and worth keeping. Arrange mode has to know the numbers, because
 * it is positioning real DOM outside the scene, so the desktop passes them
 * down while arranging and not otherwise.
 */

import { memo, useCallback, useMemo, useRef, useState } from "react"
import { ChevronDown, ChevronUp, Maximize2, X } from "lucide-react"
import type { WindowId, WindowInfo, WindowLayout } from "@lwfa/proto"
import { dropTarget, isNoop, type ColumnBox } from "@/lib/arrangeDrop"
import { setArrange, setCarried } from "@/lib/arrange"
import { useSessionActions, useSessionState } from "@/session"
import { currentWorkspace } from "@/strip"
import type { MoveTarget } from "@/strip"
import { cn } from "@/lib/utils"

/** How the scene maps its own coordinates onto the screen. */
export interface SceneTransform {
  scale: number
  ox: number
  oy: number
}

export interface ArrangeLayerProps {
  placed: WindowLayout[]
  windows: Map<WindowId, WindowInfo>
  focused: WindowId | null
  transform: SceneTransform
}

/** Where a window sits in the strip, so the move buttons know what is possible. */
interface Place {
  column: number
  row: number
  /** How many windows share the column. One means nowhere to move. */
  height: number
}

export const ArrangeLayer = memo(function ArrangeLayer({
  placed,
  windows,
  focused,
  transform,
}: ArrangeLayerProps) {
  const { strip } = useSessionState()

  // Built once per render rather than searched per card: the strip is the same
  // for all of them, and looking each window up separately is the shape of
  // thing that turns into a quadratic scan the day somebody opens thirty
  // windows.
  const places = useMemo(() => {
    const map = new Map<WindowId, Place>()
    currentWorkspace(strip).columns.forEach((column, index) => {
      column.windows.forEach((id, row) => {
        map.set(id, { column: index, row, height: column.windows.length })
      })
    })
    return map
  }, [strip])

  /**
   * Every column as it appears on screen, which is what a drop is resolved
   * against. Derived from the same rects the cards are drawn from, so the
   * highlight can never disagree with where a window actually lands.
   */
  const boxes = useMemo(() => {
    const byColumn = new Map<number, ColumnBox>()
    for (const window of placed) {
      const place = places.get(window.id)
      if (!place) continue
      const left = transform.ox + window.rect.x * transform.scale
      const right = left + window.rect.width * transform.scale
      const top = transform.oy + window.rect.y * transform.scale
      const bottom = top + window.rect.height * transform.scale

      const existing = byColumn.get(place.column)
      if (existing) {
        existing.left = Math.min(existing.left, left)
        existing.right = Math.max(existing.right, right)
        existing.rows.push({ id: window.id, top, bottom })
      } else {
        byColumn.set(place.column, {
          index: place.column,
          left,
          right,
          rows: [{ id: window.id, top, bottom }],
        })
      }
    }
    for (const column of byColumn.values()) column.rows.sort((a, b) => a.top - b.top)
    return [...byColumn.values()].sort((a, b) => a.index - b.index)
  }, [placed, places, transform])

  const [drag, setDrag] = useState<DragState | null>(null)

  return (
    // Transparent to pointers by default so the desktop underneath still takes
    // taps between windows; each card turns them back on for itself.
    <div className="pointer-events-none absolute inset-0 z-30">
      {drag?.target?.kind === "newColumn" ? (
        <NewColumnHint boxes={boxes} index={drag.target.index} />
      ) : null}
      {placed.map((window) => (
        <ArrangeCard
          key={window.id}
          window={window}
          info={windows.get(window.id)}
          focused={window.id === focused}
          transform={transform}
          place={places.get(window.id) ?? null}
          boxes={boxes}
          drag={drag?.id === window.id ? drag : null}
          highlighted={
            drag !== null &&
            drag.id !== window.id &&
            drag.target?.kind === "column" &&
            drag.target.index === places.get(window.id)?.column
          }
          onDrag={setDrag}
        />
      ))}
    </div>
  )
})

/** What is being dragged, and where it would land right now. */
interface DragState {
  id: WindowId
  /** Offset from the pointer to the card's corner, so it follows the finger. */
  dx: number
  dy: number
  /** Where the pointer is now, in screen pixels. */
  x: number
  y: number
  moved: boolean
  target: MoveTarget | null
}

/**
 * The gap that opens where a new column would go.
 *
 * Drawn rather than described, because "this window will get a column of its
 * own, here" is not something a highlight on an existing column can say.
 */
function NewColumnHint({ boxes, index }: { boxes: ColumnBox[]; index: number }) {
  const before = boxes[index - 1]
  const after = boxes[index]
  const x = after ? after.left : before ? before.right : 0
  const top = (after ?? before)?.rows[0]?.top ?? 0
  const bottom = (after ?? before)?.rows.at(-1)?.bottom ?? 0

  return (
    <div
      className="pointer-events-none absolute rounded-lg border-2 border-dashed border-primary bg-primary/20"
      style={{ left: x - 24, top, width: 48, height: Math.max(0, bottom - top) }}
      aria-hidden
    />
  )
}

const ArrangeCard = memo(function ArrangeCard({
  window,
  info,
  focused,
  transform,
  place,
  boxes,
  drag,
  highlighted,
  onDrag,
}: {
  window: WindowLayout
  info: WindowInfo | undefined
  focused: boolean
  transform: SceneTransform
  place: Place | null
  boxes: ColumnBox[]
  drag: DragState | null
  highlighted: boolean
  onDrag: (next: DragState | null) => void
}) {
  const actions = useSessionActions()
  const { scale, ox, oy } = transform
  const { rect } = window

  /**
   * Set for the whole gesture that ends a drag, so the click it produces does
   * not also focus the window and leave the mode. A pointerup after a drag
   * still fires a click, and without this every rearrangement would be
   * followed by the desktop zooming back in.
   */
  const dragged = useRef(false)

  const label = info?.title || info?.appId || `Window ${window.id}`

  // Acting on a window that is not focused focuses it first, because every
  // strip operation below works on the focused window. Doing it in this order
  // means the button does what it says rather than acting on whatever happened
  // to be focused before.
  const act = useCallback(
    (run: () => void) => {
      actions.focusWindow(window.id)
      run()
    },
    [actions, window.id],
  )

  const move = useCallback(
    (delta: -1 | 1) => {
      if (!place) return
      actions.moveWindow(window.id, {
        kind: "column",
        index: place.column,
        row: place.row + delta,
      })
    },
    [actions, window.id, place],
  )

  const stacked = (place?.height ?? 1) > 1
  const first = (place?.row ?? 0) === 0
  const last = place ? place.row === place.height - 1 : true

  return (
    <div
      className={cn(
        "pointer-events-auto absolute flex flex-col justify-between overflow-hidden rounded-xl",
        "ring-2",
        focused ? "ring-primary" : "ring-white/25",
        highlighted && "bg-primary/20 ring-primary",
        drag?.moved && "z-10 opacity-90",
      )}
      style={{
        left: ox + rect.x * scale,
        top: oy + rect.y * scale,
        width: rect.width * scale,
        height: rect.height * scale,
        // Written as a transform rather than by moving `left` and `top`, so a
        // pointer move is a compositor job and not a layout one. Same rule the
        // gamepad editor had to learn: a React render per pointer move is what
        // makes a drag feel like it is stepping rather than following.
        transform: drag?.moved
          ? `translate(${drag.x - drag.dx - (ox + rect.x * scale)}px, ${
              drag.y - drag.dy - (oy + rect.y * scale)
            }px)`
          : undefined,
        // Invisible to hit testing while it is being carried, so the release
        // can ask what is *underneath* the finger. Pointer capture keeps
        // delivering this card's own events either way, so it loses nothing.
        // Without it `elementFromPoint` only ever finds the card itself and no
        // workspace chip could ever be a drop target.
        pointerEvents: drag?.moved ? "none" : undefined,
        // A drag lands here, so the whole card belongs to the card. Same
        // reasoning as the gamepad's square hit areas.
        touchAction: "none",
      }}
      onPointerDown={(event) => {
        if (!place) return
        dragged.current = false
        event.currentTarget.setPointerCapture(event.pointerId)
        setCarried(window.id)
        onDrag({
          id: window.id,
          dx: event.clientX - (ox + rect.x * scale),
          dy: event.clientY - (oy + rect.y * scale),
          x: event.clientX,
          y: event.clientY,
          moved: false,
          target: null,
        })
      }}
      onPointerMove={(event) => {
        if (!drag) return
        // A few pixels of slack, so a tap with a shaky finger stays a tap.
        const moved =
          drag.moved ||
          Math.hypot(event.clientX - (ox + rect.x * scale) - drag.dx,
                     event.clientY - (oy + rect.y * scale) - drag.dy) > 6
        if (!moved) return
        dragged.current = true
        onDrag({
          ...drag,
          x: event.clientX,
          y: event.clientY,
          moved: true,
          target: dropTarget({ x: event.clientX, y: event.clientY }, boxes),
        })
      }}
      onPointerUp={(event) => {
        const finished = drag
        onDrag(null)
        setCarried(null)

        // A workspace chip claims the drop before the strip does: it is drawn
        // over the bar at the bottom, so a pointer there is not pointing at a
        // column even though the column boxes may still contain it.
        const chip = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest("[data-workspace-drop]")
        if (finished?.moved && chip) {
          const index = Number(chip.getAttribute("data-workspace-drop"))
          if (Number.isInteger(index)) actions.sendToWorkspace(window.id, index)
          return
        }

        if (!finished?.moved || !finished.target || !place) return
        // A drag that ended where it started must do nothing: committing it
        // would clear fullscreen and re-settle a strip nobody asked to change.
        if (isNoop(finished.target, place)) return
        actions.moveWindow(window.id, finished.target)
      }}
      onPointerCancel={() => {
        onDrag(null)
        setCarried(null)
      }}
      // Tapping a window is how you say "this is the one I wanted", so it
      // focuses and leaves. Anything else would make arrange mode a place you
      // have to remember to get out of.
      onClick={() => {
        if (dragged.current) return
        actions.focusWindow(window.id)
        setArrange(false)
      }}
    >
      <div className="flex items-start justify-between gap-1 bg-gradient-to-b from-black/70 to-transparent p-1.5">
        <span className="truncate rounded-md bg-black/50 px-2 py-1 text-xs text-white/90 backdrop-blur-sm">
          {label}
        </span>
      </div>

      <div className="flex items-center justify-center gap-1 bg-gradient-to-t from-black/70 to-transparent p-1.5">
        <Cap label={`Fullscreen ${label}`} onClick={() => act(actions.toggleFullscreen)}>
          <Maximize2 aria-hidden />
        </Cap>
        {stacked ? (
          <>
            <Cap label="Move up in column" disabled={first} onClick={() => move(-1)}>
              <ChevronUp aria-hidden />
            </Cap>
            <Cap label="Move down in column" disabled={last} onClick={() => move(1)}>
              <ChevronDown aria-hidden />
            </Cap>
          </>
        ) : null}
        <Cap
          label={`Close ${label}`}
          danger
          onClick={() => actions.closeWindow(window.id)}
        >
          <X aria-hidden />
        </Cap>
      </div>
    </div>
  )
})

/**
 * One control. 44px, which is the smallest a finger reliably hits, and the
 * reason the controls are outside the scaled scene at all.
 */
function Cap({
  label,
  danger,
  disabled,
  onClick,
  children,
}: {
  label: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      // Stopped here so a press on a control is not also the start of a drag
      // of the window behind it, and not a tap that focuses and leaves.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={cn(
        "grid size-11 place-items-center rounded-lg border border-white/20 bg-black/60 text-white",
        "backdrop-blur-sm transition-colors [&>svg]:size-5",
        "disabled:pointer-events-none disabled:opacity-35",
        danger ? "hover:border-destructive hover:bg-destructive" : "hover:bg-white/25",
      )}
    >
      {children}
    </button>
  )
}
