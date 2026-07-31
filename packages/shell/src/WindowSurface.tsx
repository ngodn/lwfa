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

export interface WindowSurfaceProps {
  id: WindowId
  rect: Rect
  z: number
  focused: boolean
  label: string
  /** Most recent decoded frame, or null before the first one arrives. */
  frame: ImageBitmap | null
  onFocus: () => void
}

export function WindowSurface({
  id,
  rect,
  z,
  focused,
  label,
  frame,
  onFocus,
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
      onPointerDown={onFocus}
      role="button"
      tabIndex={0}
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onFocus()
      }}
    >
      <canvas ref={canvas} />
      {frame ? null : <span className="waiting">w{id} waiting for pixels…</span>}
      <span className="surface-label">{label}</span>
    </div>
  )
}
