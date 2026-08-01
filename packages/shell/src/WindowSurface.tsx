/**
 * One live window, composited in the DOM.
 *
 * This is the component the whole remote architecture exists for. Each window
 * is its own element, so the browser composites them rather than receiving one
 * flat screenshot. Two things follow from that, and neither is possible with
 * whole-screen streaming:
 *
 * - The shell can lay windows out however its own viewport demands, which is
 *   what makes a phone show one column and a monitor show four.
 * - CSS applies to live application windows. The transform below moves a real
 *   terminal, and `border-radius` clips it.
 *
 * Frames arrive as JPEG over the WebSocket and are drawn to a `<canvas>` rather
 * than an `<img>`, so decoding is explicit and a dropped frame leaves the last
 * good one on screen instead of flashing empty.
 */

import { memo, useCallback, useEffect, useRef } from "react"
import type { Rect, WindowId } from "@lwfa/proto"
import { evdevFromButton, wheelDelta, windowPoint } from "./input.js"
import { useFrame } from "@/lib/frames"
import { cn } from "@/lib/utils"

export interface WindowSurfaceProps {
  id: WindowId
  rect: Rect
  z: number
  focused: boolean
  label: string
  /**
   * Whether pixels are being requested for this window at all.
   *
   * A column scrolled off the strip is deliberately not streamed, which is what
   * bounds the encoder budget. Saying it is "waiting for pixels" would be
   * wrong: nothing is coming, and nothing should be.
   */
  streamed: boolean
  /**
   * Both take the window id, so one callback instance serves every surface.
   * A per-window closure would change identity on each parent render and defeat
   * the memo below, which is the whole reason this component is cheap.
   */
  onFocus: (id: WindowId) => void
  /** Input headed for the window itself, in window-relative logical pixels. */
  onInput: (id: WindowId, event: SurfaceInput) => void
}

/** Input aimed at a specific window, already in its coordinate space. */
export type SurfaceInput =
  | { kind: "motion"; x: number; y: number }
  | { kind: "button"; button: number; pressed: boolean }
  | { kind: "axis"; horizontal: number; vertical: number }
  | { kind: "touchDown"; id: number; x: number; y: number }
  | { kind: "touchMotion"; id: number; x: number; y: number }
  | { kind: "touchUp"; id: number }

export const WindowSurface = memo(function WindowSurface({
  id,
  rect,
  z,
  focused,
  label,
  streamed,
  onFocus,
  onInput,
}: WindowSurfaceProps): React.ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null)
  // Subscribed per window, so a frame for another window does not re-render
  // this one. See lib/frames.ts.
  const frame = useFrame(id)
  const send = useCallback((event: SurfaceInput) => onInput(id, event), [onInput, id])

  useEffect(() => {
    if (!frame) return
    const el = canvas.current
    if (!el) return

    // Size the backing store to the frame, not to the CSS box. The CSS box is
    // the layout the shell chose; the backing store is what the engine sent.
    // Conflating them would resample every frame on the GPU for nothing.
    if (el.width !== frame.width || el.height !== frame.height) {
      el.width = frame.width
      el.height = frame.height
    }

    const ctx = el.getContext("2d", { alpha: false })
    if (!ctx) return
    ctx.drawImage(frame, 0, 0)
  }, [frame])

  return (
    <div
      className={cn(
        "absolute top-0 left-0 overflow-hidden rounded-xl bg-black/40 shadow-lg ring-1 transition-shadow",
        "ring-white/10",
        focused && "ring-2 ring-primary shadow-2xl",
      )}
      style={{
        // `translate` rather than `left`/`top`: transforms are composited and
        // do not trigger layout, which matters when several windows animate at
        // once on a tablet that is already busy decoding.
        transform: `translate(${rect.x}px, ${rect.y}px)`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        zIndex: z,
      }}
      role="application"
      aria-label={label}
      onPointerDown={(event) => {
        onFocus(id)
        const point = windowPoint(event, event.currentTarget, rect)
        if (!point) return
        // Capture, so a drag that leaves the element still delivers its
        // release. Without this a client is left with a button stuck down.
        event.currentTarget.setPointerCapture(event.pointerId)

        if (event.pointerType === "touch") {
          send({ kind: "touchDown", id: event.pointerId, ...point })
          return
        }
        const button = evdevFromButton(event.button)
        send({ kind: "motion", ...point })
        if (button !== null) send({ kind: "button", button, pressed: true })
      }}
      onPointerMove={(event) => {
        const point = windowPoint(event, event.currentTarget, rect)
        if (!point) return
        send(
          event.pointerType === "touch"
            ? { kind: "touchMotion", id: event.pointerId, ...point }
            : { kind: "motion", ...point },
        )
      }}
      onPointerUp={(event) => {
        if (event.pointerType === "touch") {
          send({ kind: "touchUp", id: event.pointerId })
          return
        }
        const button = evdevFromButton(event.button)
        if (button !== null) send({ kind: "button", button, pressed: false })
      }}
      onPointerCancel={(event) => {
        if (event.pointerType === "touch") send({ kind: "touchUp", id: event.pointerId })
      }}
      onWheel={(event) => send({ kind: "axis", ...wheelDelta(event.nativeEvent) })}
      onContextMenu={(event) => {
        // Right-click belongs to the application, not to the browser's menu.
        event.preventDefault()
      }}
    >
      <canvas ref={canvas} className="block h-full w-full" />
      {frame ? null : (
        <span className="absolute inset-0 grid place-items-center px-4 text-center text-sm text-white/50">
          {streamed ? "Waiting for pixels\u2026" : "Off screen"}
        </span>
      )}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-3 pt-6 pb-2 text-xs text-white/80">
        {label}
      </span>
    </div>
  )
})
