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

import { tap } from "@/lib/haptics"
import { memo, useCallback, useEffect, useLayoutEffect, useRef } from "react"
import type { Rect, WindowId } from "@lwfa/proto"
import { evdevFromButton, wheelDelta, windowPoint } from "./input.js"
import { describe, measure, probeEnabled } from "@/lib/captureProbe"
import { LongPress } from "@/lib/longPress"
import { getPrefs } from "@/lib/prefs"
import { useFrame } from "@/lib/frames"
import { log } from "@/lib/log"
import { motion } from "@/lib/motion"
import { cn } from "@/lib/utils"

/**
 * Whether to measure decoded frames. Read once: it comes from the URL, so it
 * cannot change without a reload, and testing it per frame would be waste.
 */
const PROBE = probeEnabled(globalThis.location?.search ?? "")

/** Linux `BTN_RIGHT`, the same code a real right button sends. */
const RIGHT_BUTTON = 0x111

export interface WindowSurfaceProps {
  id: WindowId
  rect: Rect
  z: number
  /**
   * Whether this window covers the whole output, with no desktop around it.
   *
   * Drives whether it is drawn as a card or edge to edge. See `fillsOutput`.
   */
  filling: boolean
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
  filling,
  focused,
  label,
  streamed,
  onFocus,
  onInput,
}: WindowSurfaceProps): React.ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null)
  const ctx2d = useRef<CanvasRenderingContext2D | null>(null)
  // Where each pointer last was, so an event that did not actually move it
  // (pressure change, a finger resting) costs nothing. On a 120Hz tablet a
  // drag is up to 120 serialized sends a second; the still ones are free.
  const lastMove = useRef(new Map<number, { x: number; y: number }>())
  /** When this window was last measured, so the probe cannot flood the log. */
  const probedAt = useRef(0)
  /** Turns a held finger into a right click. See `lib/longPress`. */
  const longPress = useRef(new LongPress())
  /**
   * The size of the pixels on screen, which is what a click must map through.
   *
   * The canvas backing store is exactly what the engine last sent, so it is
   * the application's real size. `rect` is only what the shell *asked* for,
   * and a client that has not resized yet makes those differ. See
   * `windowPoint`.
   */
  const contentSize = useCallback(
    () => ({
      width: canvas.current?.width || rect.width,
      height: canvas.current?.height || rect.height,
    }),
    [rect.width, rect.height],
  )
  const box = useRef<HTMLDivElement>(null)
  // Subscribed per window, so a frame for another window does not re-render
  // this one. See lib/frames.ts.
  const frame = useFrame(id)
  const send = useCallback((event: SurfaceInput) => onInput(id, event), [onInput, id])

  // Hand the element to the animator, which owns its transform and box size
  // from here on. A layout effect, so the position is written before the
  // browser paints and a window never flashes at the origin on mount.
  //
  // `rect` and `z` are only a starting point, for a surface that mounts before
  // anything has told the animator where it goes. Afterwards `App` drives it.
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    return motion.attach(id, element, rect, z)
    // Deliberately id-only. Re-attaching on every geometry change would snap
    // the window to each new target and there would be no animation at all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Scrolling has to be an *active* listener, which means going around React.
  //
  // React attaches `wheel` at the root as passive, so `preventDefault` inside
  // `onWheel` is ignored and the browser scrolls the page as well as the
  // application receiving the scroll. Two things scroll at once, which is what
  // it looks like: the window scrolls and the page slides. `{ passive: false }`
  // on the element itself is the only way to actually claim the gesture.
  useEffect(() => {
    const element = box.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      send({ kind: "axis", ...wheelDelta(event) })
    }
    element.addEventListener("wheel", onWheel, { passive: false })
    return () => element.removeEventListener("wheel", onWheel)
  }, [send])

  useEffect(() => {
    if (!frame) return
    const el = canvas.current
    if (!el) return

    // A bitmap that was closed between the render that read it and this effect
    // is detached, and drawing it throws `InvalidStateError`. That threw from a
    // passive effect, which React treats as a render error, so it hit the error
    // boundary and took the *whole shell* down: the desktop, the panels, input,
    // everything. The visible symptom was "touch stopped working", because
    // there was no longer a shell to send any.
    //
    // The gap is real and unavoidable from here. `publishFrame` closes the
    // frame it replaces and `dropFrame` closes one whose window has stopped
    // streaming, both the instant they are called, while this effect runs after
    // paint. Anything that raises the frame rate or churns the stream list
    // widens the odds: several windows in a group streaming at once, a video in
    // its own window, a layout change moving windows in and out of the list.
    //
    // A detached bitmap reports zero dimensions, which is the only way to ask.
    // Returning here rather than drawing leaves the canvas showing the last
    // good frame, which is exactly right: the next frame is milliseconds away,
    // and a stale frame for one tick is invisible where a blanked window is
    // not.
    if (frame.width === 0 || frame.height === 0) return

    // Size the backing store to the frame, not to the CSS box. The CSS box is
    // the layout the shell chose; the backing store is what the engine sent.
    // Conflating them would resample every frame on the GPU for nothing.
    if (el.width !== frame.width || el.height !== frame.height) {
      el.width = frame.width
      el.height = frame.height
    }

    // Looked up once per canvas, not per frame. The browser caches the
    // context internally, but the lookup plus its options object were still
    // paid thirty to sixty times a second per streamed window.
    if (ctx2d.current?.canvas !== el) {
      ctx2d.current = el.getContext("2d", { alpha: false })
    }
    const ctx = ctx2d.current
    if (!ctx) return
    try {
      ctx.drawImage(frame, 0, 0)
    } catch {
      // Belt and braces for the same race: the check above is the honest test,
      // but a bitmap closed *between* it and here would still throw, and no
      // single frame is worth the session.
      return
    }

    // Measure what the engine actually sent, when asked to. Off by default and
    // free when off; see `captureProbe`. Rate limited because a window being
    // scrolled produces frames far faster than anyone can read a log.
    if (PROBE && performance.now() - probedAt.current > 1000) {
      probedAt.current = performance.now()
      const reading = measure(el, box.current?.getBoundingClientRect() ?? rect)
      if (reading) {
        const dead = reading.dead
        const bad = dead.left > 0 || dead.right > 0 || dead.top > 0 || dead.bottom > 0
        log(bad ? "warn" : "info", describe(label, reading))
      }
    }
  }, [frame, label, rect])

  return (
    <div
      ref={box}
      className={cn(
        "absolute top-0 left-0 overflow-hidden bg-black/40 transition-shadow",
        // A window with nothing around it is not a card. Rounding its corners
        // shows the desktop through them, and a focus ring distinguishes it
        // from neighbours that are not there. See `fillsOutput`.
        filling
          ? "rounded-none ring-0 shadow-none"
          : cn(
              "rounded-xl shadow-lg ring-1 ring-white/10",
              focused && "shadow-2xl ring-2 ring-primary",
            ),
      )}
      style={{
        // No transform, width, height or z-index here on purpose: `lib/motion`
        // owns them and writes them every frame while a spring runs. React
        // setting them too would fight the animation, and putting them in state
        // would mean a render per frame per window.
        //
        // A finger on a window belongs to the application, not to the page.
        // Without this the browser claims the gesture as a pan and the whole
        // page slides under your finger, and the pointer stream is cancelled
        // half way through so the application sees a drag that never ends.
        touchAction: "none",
        // Suppress the selection handles and the callout iOS puts up on a long
        // press. It does not make `contextmenu` fire there, which is why the
        // gesture is measured by hand, but without it the browser's own menu
        // appears over the application's. See `lib/longPress`.
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
      }}
      role="application"
      aria-label={label}
      onPointerDown={(event) => {
        onFocus(id)
        const point = windowPoint(event, event.currentTarget, contentSize())
        if (!point) return
        // Capture, so a drag that leaves the element still delivers its
        // release. Without this a client is left with a button stuck down.
        event.currentTarget.setPointerCapture(event.pointerId)
        lastMove.current.set(event.pointerId, point)

        if (event.pointerType === "touch") {
          send({ kind: "touchDown", id: event.pointerId, ...point })
          // A finger held still is a right click. Started here rather than
          // waiting for `contextmenu`, which iOS Safari has not fired since
          // iOS 13. See `lib/longPress`.
          longPress.current.start(event, () => {
            // End the touch first. The application has already had a
            // touch-down, and leaving it open while a pointer button arrives
            // would look like two fingers to it.
            send({ kind: "touchUp", id: event.pointerId })
            send({ kind: "motion", ...point })
            send({ kind: "button", button: RIGHT_BUTTON, pressed: true })
            send({ kind: "button", button: RIGHT_BUTTON, pressed: false })
            // The only feedback there is. Nothing on screen says the gesture
            // took, and without this people hold longer and longer wondering
            // whether it is working.
            if (getPrefs().keyboard.haptics) tap(12)
          })
          return
        }
        const button = evdevFromButton(event.button)
        send({ kind: "motion", ...point })
        if (button !== null) send({ kind: "button", button, pressed: true })
      }}
      onPointerMove={(event) => {
        // A finger that wanders is a drag, not a press.
        if (event.pointerType === "touch") longPress.current.move(event)
        const point = windowPoint(event, event.currentTarget, contentSize())
        if (!point) return
        // Once the long press has fired the touch has already been ended, so
        // further motion for it would reopen a gesture the client thinks is
        // over.
        if (event.pointerType === "touch" && longPress.current.fired) return
        const last = lastMove.current.get(event.pointerId)
        if (last && last.x === point.x && last.y === point.y) return
        lastMove.current.set(event.pointerId, point)
        send(
          event.pointerType === "touch"
            ? { kind: "touchMotion", id: event.pointerId, ...point }
            : { kind: "motion", ...point },
        )
      }}
      onPointerUp={(event) => {
        lastMove.current.delete(event.pointerId)
        if (event.pointerType === "touch") {
          // A press that became a right click already sent its release, and
          // sending the tap as well would open a menu and immediately choose
          // something from it.
          if (longPress.current.finish()) return
          send({ kind: "touchUp", id: event.pointerId })
          return
        }
        const button = evdevFromButton(event.button)
        if (button !== null) send({ kind: "button", button, pressed: false })
      }}
      onPointerCancel={(event) => {
        lastMove.current.delete(event.pointerId)
        if (event.pointerType !== "touch") return
        if (longPress.current.finish()) return
        send({ kind: "touchUp", id: event.pointerId })
      }}
      onContextMenu={(event) => {
        // Right-click belongs to the application, not to the browser's menu.
        event.preventDefault()
      }}
    >
      <canvas ref={canvas} className="block h-full w-full" />
      {/*
        * No "paused" badge for unfocused windows on purpose. With
        * pause-inactive on, a frozen side window is the normal state of the
        * desktop, not an exception worth labelling: it holds the frame it had
        * at the moment it lost focus, and focusing it resumes it instantly.
        * Badging every unfocused window would put a permanent label on most
        * of the screen.
        */}
      {frame ? null : (
        <span className="absolute inset-0 grid place-items-center px-4 text-center text-sm text-white/50">
          {streamed ? "Waiting for pixels\u2026" : "Off screen"}
        </span>
      )}
      {/*
        No caption here on purpose.

        The title used to be painted along the bottom of every window, which
        put a permanent gradient and a line of text over the application you
        are trying to use, on the devices where screen space is scarcest. A
        window is identifiable by what it is showing; its name is only wanted
        when you go looking for it, and it is in the session panel and the
        window list when you do.

        It stays on `aria-label` above, so a screen reader still announces
        which window focus has landed on.
      */}
    </div>
  )
})
