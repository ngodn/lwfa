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

import { useEffect, useRef } from "react"
import type { Rect, WindowId } from "@lwfa/proto"
import { evdevFromButton, wheelDelta, windowPoint } from "./input.js"

export interface WindowSurfaceProps {
  id: WindowId
  rect: Rect
  z: number
  focused: boolean
  label: string
  /** Most recent decoded frame, or null before the first one arrives. */
  frame: ImageBitmap | null
  /**
   * Whether pixels are being requested for this window at all.
   *
   * A column scrolled off the strip is deliberately not streamed, which is what
   * bounds the encoder budget. Saying it is "waiting for pixels" would be
   * wrong: nothing is coming, and nothing should be.
   */
  streamed: boolean
  onFocus: () => void
  /** Input headed for the window itself, in window-relative logical pixels. */
  onInput: (event: SurfaceInput) => void
}

/** Input aimed at a specific window, already in its coordinate space. */
export type SurfaceInput =
  | { kind: "motion"; x: number; y: number }
  | { kind: "button"; button: number; pressed: boolean }
  | { kind: "axis"; horizontal: number; vertical: number }
  | { kind: "touchDown"; id: number; x: number; y: number }
  | { kind: "touchMotion"; id: number; x: number; y: number }
  | { kind: "touchUp"; id: number }

export function WindowSurface({
  id,
  rect,
  z,
  focused,
  label,
  frame,
  streamed,
  onFocus,
  onInput,
}: WindowSurfaceProps): React.ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null)

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
      className={`surface${focused ? " focused" : ""}`}
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
        onFocus()
        const point = windowPoint(event, event.currentTarget, rect)
        if (!point) return
        // Capture, so a drag that leaves the element still delivers its
        // release. Without this a client is left with a button stuck down.
        event.currentTarget.setPointerCapture(event.pointerId)

        if (event.pointerType === "touch") {
          onInput({ kind: "touchDown", id: event.pointerId, ...point })
          return
        }
        const button = evdevFromButton(event.button)
        onInput({ kind: "motion", ...point })
        if (button !== null) onInput({ kind: "button", button, pressed: true })
      }}
      onPointerMove={(event) => {
        const point = windowPoint(event, event.currentTarget, rect)
        if (!point) return
        onInput(
          event.pointerType === "touch"
            ? { kind: "touchMotion", id: event.pointerId, ...point }
            : { kind: "motion", ...point },
        )
      }}
      onPointerUp={(event) => {
        if (event.pointerType === "touch") {
          onInput({ kind: "touchUp", id: event.pointerId })
          return
        }
        const button = evdevFromButton(event.button)
        if (button !== null) onInput({ kind: "button", button, pressed: false })
      }}
      onPointerCancel={(event) => {
        if (event.pointerType === "touch") onInput({ kind: "touchUp", id: event.pointerId })
      }}
      onWheel={(event) => onInput({ kind: "axis", ...wheelDelta(event.nativeEvent) })}
      onContextMenu={(event) => {
        // Right-click belongs to the application, not to the browser's menu.
        event.preventDefault()
      }}
    >
      <canvas ref={canvas} />
      {frame ? null : (
        <span className={streamed ? "waiting" : "offscreen"}>
          {streamed ? `w${id} waiting for pixels…` : `w${id} off screen`}
        </span>
      )}
      <span className="surface-label">{label}</span>
    </div>
  )
}
