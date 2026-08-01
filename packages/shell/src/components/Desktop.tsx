/**
 * The remote desktop: the engine's output, fitted to whatever space is left.
 *
 * One DOM element per window, composited by the browser. This is the thing the
 * whole remote architecture exists for, and the thing whole-screen streaming
 * cannot do: the browser owns the arrangement, so the same session can be a
 * four-column strip on a monitor and a single column on a phone.
 *
 * # Fitting
 *
 * The scene is laid out in the engine's own logical pixels and then scaled by a
 * single transform. Keeping the children in engine coordinates means the layout
 * maths in `strip.ts` never has to know anything about the viewer's viewport,
 * which is what lets the same pure function serve both backends.
 *
 * The scale is measured with a `ResizeObserver` and written to a CSS variable
 * rather than kept in React state. Resizing a window would otherwise re-render
 * every surface on every animation frame of the drag.
 */

import { memo, useLayoutEffect, useRef } from "react"
import type { WindowId, WindowInfo } from "@lwfa/proto"
import type { WindowLayout } from "@lwfa/proto"
import { WindowSurface, type SurfaceInput } from "@/WindowSurface"
import type { Output } from "@/strip"
import { cn } from "@/lib/utils"

export interface DesktopProps {
  output: Output
  placed: WindowLayout[]
  windows: Map<WindowId, WindowInfo>
  focused: WindowId | null
  /** Ids the engine is actually sending pixels for. */
  streamedIds: ReadonlySet<WindowId>
  onFocus: (id: WindowId) => void
  onInput: (id: WindowId, event: SurfaceInput) => void
}

export const Desktop = memo(function Desktop({
  output,
  placed,
  windows,
  focused,
  streamedIds,
  onFocus,
  onInput,
}: DesktopProps) {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<HTMLDivElement | null>(null)

  // Fit the engine's output into the available box, letterboxed, never
  // upscaled past 1:1 on a display larger than the remote one.
  useLayoutEffect(() => {
    const box = frameRef.current
    const scene = sceneRef.current
    if (!box || !scene || output.width <= 0 || output.height <= 0) return

    const fit = () => {
      const { width, height } = box.getBoundingClientRect()
      if (width <= 0 || height <= 0) return
      // Never upscale past 1:1. Blowing a 1280-wide remote up to fill a 4K
      // display just magnifies compression artefacts.
      const scale = Math.min(width / output.width, height / output.height, 1)
      // Centred by translating, not by `place-items-center` plus a centre
      // origin. A centre origin scales the box about its middle *after* layout
      // has already placed the full-size box, so the visible result is offset
      // by half the difference. Top-left origin plus an explicit offset is the
      // only combination that puts a scaled scene where it looks like it should
      // be, and both values are CSS variables so a resize costs no React work.
      scene.style.setProperty("--fit", String(scale))
      scene.style.setProperty("--ox", `${(width - output.width * scale) / 2}px`)
      scene.style.setProperty("--oy", `${(height - output.height * scale) / 2}px`)
    }
    fit()

    const observer = new ResizeObserver(fit)
    observer.observe(box)
    return () => observer.disconnect()
  }, [output.width, output.height])

  if (output.width <= 0 || output.height <= 0) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <p className="text-sm text-muted-foreground">Waiting for the engine&rsquo;s output size&hellip;</p>
      </div>
    )
  }

  return (
    <div ref={frameRef} className="relative h-full w-full overflow-hidden">
      <div
        ref={sceneRef}
        className="absolute top-0 left-0 origin-top-left"
        style={{
          width: output.width,
          height: output.height,
          transform: "translate(var(--ox, 0px), var(--oy, 0px)) scale(var(--fit, 0))",
        }}
      >
        {placed.map((w) => (
          <WindowSurface
            key={w.id}
            id={w.id}
            rect={w.rect}
            z={w.z}
            focused={w.id === focused}
            label={labelFor(windows.get(w.id), w.id)}
            streamed={streamedIds.has(w.id)}
            onFocus={onFocus}
            onInput={onInput}
          />
        ))}
        {placed.length === 0 ? (
          <div className={cn("absolute inset-0 grid place-items-center")}>
            <p className="text-sm text-muted-foreground">This workspace is empty.</p>
          </div>
        ) : null}
      </div>
    </div>
  )
})

function labelFor(info: WindowInfo | undefined, id: WindowId): string {
  return info?.title || info?.appId || `Window ${id}`
}
