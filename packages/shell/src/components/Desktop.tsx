/**
 * The remote desktop: the engine's output, fitted to whatever space is left.
 *
 * One DOM element per window, composited by the browser. This is the thing the
 * whole remote architecture exists for, and the thing whole-screen streaming
 * cannot do: the browser owns the arrangement, so the same session can be a
 * four-column strip on a monitor and a single column on a phone.
 *
 * # The engine resizes; this does not scale
 *
 * The desktop measures itself and tells the engine, which resizes its output to
 * match. So the scene is normally 1:1 and there is nothing to fit.
 *
 * The alternative, which this used to do, was to keep the engine at the
 * machine's own resolution and scale it down here. That letterboxes on any
 * device with a different aspect ratio, wastes the viewport, and makes every
 * window the wrong physical size, because a 2560x1440 desktop shrunk into an
 * iPad is a desktop rendered at half scale. It also made "responsive" a lie:
 * `strip.ts` computes column widths from the output size, so a fixed output
 * meant fixed columns on every device.
 *
 * The transform stays as a fallback for the moment before the engine has
 * answered, and for a shell that is not allowed to resize it.
 */

import { memo, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { WindowId, WindowInfo } from "@lwfa/proto"
import type { WindowLayout } from "@lwfa/proto"
import { WindowSurface, type SurfaceInput } from "@/WindowSurface"
import type { Output } from "@/strip"
import { fillsOutput, stripBounds } from "@/strip"
import { useArranging } from "@/lib/arrange"
import { ArrangeBar } from "@/components/ArrangeBar"
import { ArrangeLayer, type SceneTransform } from "@/components/ArrangeLayer"
import { cn } from "@/lib/utils"

/**
 * Breathing room around the zoomed-out strip, in device pixels.
 *
 * The workspace rail sits along the bottom and each window carries controls,
 * so the strip is inset rather than filling the box edge to edge.
 */
const ARRANGE_INSET = 56

export interface DesktopProps {
  output: Output
  /** Told the engine how much room there is. See `useViewportReport`. */
  onViewport: (width: number, height: number, scale: number) => void
  placed: WindowLayout[]
  windows: Map<WindowId, WindowInfo>
  focused: WindowId | null
  /** Ids the engine is actually sending pixels for. */
  streamedIds: ReadonlySet<WindowId>
  /** Ids the engine has said have drawn nothing at all. See `windowBlank`. */
  blankIds: ReadonlySet<WindowId>
  onFocus: (id: WindowId) => void
  onInput: (id: WindowId, event: SurfaceInput) => void
}

export const Desktop = memo(function Desktop({
  output,
  placed,
  windows,
  focused,
  streamedIds,
  blankIds,
  onViewport,
  onFocus,
  onInput,
}: DesktopProps) {
  const arrangingNow = useArranging()
  /** How the scene maps onto the screen. Only tracked while arranging. */
  const [transform, setTransform] = useState<SceneTransform | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<HTMLDivElement | null>(null)

  // Report the real box, so the engine can be the right shape.
  //
  // Debounced: a rotation, a keyboard docking, or a dragged browser window
  // produce a burst of sizes, and resizing the compositor issues a `configure`
  // to every client. Native apps re-layout from scratch on one of those, so
  // sending sixty is visibly worse than sending one.
  useLayoutEffect(() => {
    const box = frameRef.current
    if (!box) return

    let timer: ReturnType<typeof setTimeout> | undefined
    const report = () => {
      const rect = box.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        onViewport(
          Math.round(rect.width),
          Math.round(rect.height),
          globalThis.devicePixelRatio || 1,
        )
      }, 150)
    }
    report()

    const observer = new ResizeObserver(report)
    observer.observe(box)
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [onViewport])

  /**
   * What has to be visible: the output normally, the whole strip when
   * arranging.
   *
   * Recomputed only when arranging, because `placed` changes on every layout
   * and the ordinary path must not pay for a bounding box it will not use.
   */
  const view = useMemo(
    () => (arrangingNow ? stripBounds(placed, output) : { x: 0, y: 0, ...output }),
    [arrangingNow, placed, output],
  )

  // Fit `view` into the available box, letterboxed, never upscaled past 1:1 on
  // a display larger than the remote one.
  useLayoutEffect(() => {
    const box = frameRef.current
    const scene = sceneRef.current
    if (!box || !scene || view.width <= 0 || view.height <= 0) return

    const fit = () => {
      const { width, height } = box.getBoundingClientRect()
      if (width <= 0 || height <= 0) return
      // Room for the workspace rail and the per-window controls, so nothing
      // sits under them. Only while arranging: the ordinary view is the
      // desktop and must not be inset.
      const pad = arrangingNow ? ARRANGE_INSET : 0
      const usable = { width: Math.max(1, width - pad * 2), height: Math.max(1, height - pad * 2) }

      // Never upscale past 1:1. Blowing a 1280-wide remote up to fill a 4K
      // display just magnifies compression artefacts.
      const scale = Math.min(usable.width / view.width, usable.height / view.height, 1)

      // Centred by translating, not by `place-items-center` plus a centre
      // origin. A centre origin scales the box about its middle *after* layout
      // has already placed the full-size box, so the visible result is offset
      // by half the difference. Top-left origin plus an explicit offset is the
      // only combination that puts a scaled scene where it looks like it should
      // be, and both values are CSS variables so a resize costs no React work.
      //
      // `view.x` and `view.y` are subtracted because the strip's bounding box
      // starts at a negative coordinate whenever a column has scrolled off the
      // left. Without that the zoomed-out strip is pushed off the near edge by
      // however far it had scrolled.
      const ox = (width - view.width * scale) / 2 - view.x * scale
      const oy = (height - view.height * scale) / 2 - view.y * scale
      scene.style.setProperty("--fit", String(scale))
      scene.style.setProperty("--ox", `${ox}px`)
      scene.style.setProperty("--oy", `${oy}px`)

      // Handed to React only while arranging, because the controls drawn over
      // each window live outside the scaled scene and have to be positioned in
      // screen pixels. The ordinary path keeps writing CSS variables and doing
      // no React work at all, which is why a resize is free there.
      setTransform((prev) => {
        if (!arrangingNow) return prev === null ? prev : null
        if (prev && prev.scale === scale && prev.ox === ox && prev.oy === oy) return prev
        return { scale, ox, oy }
      })
    }
    fit()

    const observer = new ResizeObserver(fit)
    observer.observe(box)
    return () => observer.disconnect()
  }, [view, arrangingNow])

  const ready = output.width > 0 && output.height > 0

  // Deliberately not an early return for the not-ready case.
  //
  // Returning different JSX before the engine has answered means `frameRef`
  // is never attached on the first render, and the effect above has already
  // run and bailed. It does not re-run when the real element appears, so the
  // `ResizeObserver` is never created and the viewport is never reported: the
  // shell waits for a size the engine is waiting to be told. Keeping one
  // element and putting the message *inside* it removes the whole class of
  // bug.
  return (
    // `touch-action: none` on the whole desktop area, not only on the windows.
    // A swipe that starts in a gap between columns is still a swipe on the
    // desktop, and letting the browser treat it as a page gesture is what makes
    // the entire page slide when you meant to touch a window.
    <div
      ref={frameRef}
      className="relative h-full w-full touch-none overflow-hidden overscroll-none"
    >
      {!ready ? (
        <div className="grid h-full place-items-center p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Waiting for the engine&rsquo;s output size&hellip;
          </p>
        </div>
      ) : null}
      <div
        ref={sceneRef}
        hidden={!ready}
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
            filling={fillsOutput(w.rect, output)}
            focused={w.id === focused}
            label={labelFor(windows.get(w.id), w.id)}
            streamed={streamedIds.has(w.id)}
            blank={blankIds.has(w.id)}
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
      {/* Outside the scene, so neither is scaled with the strip. */}
      {arrangingNow && transform ? (
        <ArrangeLayer
          placed={placed}
          windows={windows}
          focused={focused}
          transform={transform}
        />
      ) : null}
      <ArrangeBar />
    </div>
  )
})

function labelFor(info: WindowInfo | undefined, id: WindowId): string {
  return info?.title || info?.appId || `Window ${id}`
}
