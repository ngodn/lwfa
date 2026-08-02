/**
 * Window motion in the browser.
 *
 * # Why this exists
 *
 * The engine already integrates springs, in `crates/lwfa-engine/src/layout.rs`,
 * and that is what animates windows on the physical display. It does nothing
 * for a remote shell: over the network the engine sends *per-window* pixels and
 * the browser decides where each one goes, so if the browser writes the target
 * position straight into the DOM, windows teleport. Scrolling the strip, going
 * fullscreen, and changing a column width all snapped from one arrangement to
 * the next with nothing in between, which reads as a glitch rather than as a
 * layout.
 *
 * So the browser integrates the same springs, from the same `@lwfa/spring`
 * package the engine uses, which is the entire reason that package is written
 * twice and parity-tested. The same move looks the same on both paths.
 *
 * # Why it is not React state
 *
 * A spring produces a new value every frame. Putting that in state would mean a
 * React render per frame per window, and each of those re-renders a component
 * that owns a `<canvas>` being fed decoded video. So this owns the elements
 * directly: React renders the window once, this writes `transform` and the box
 * size on every frame, and the two never fight because React no longer sets
 * those properties at all.
 *
 * Everything written here is composited (`transform`, and a size change on an
 * absolutely positioned element that nothing else depends on), so a frame costs
 * no layout of the surrounding page.
 *
 * # One loop, not one per window
 *
 * A `requestAnimationFrame` loop per surface would mean N callbacks per frame
 * and N chances to sample the clock at slightly different times, which is
 * exactly how windows animating together drift apart. One loop samples once and
 * advances everything from that instant, the same reason `layout.rs` takes
 * `now` as a parameter instead of reading it per window.
 */

import type { SpringSpec, WindowId, WindowLayout } from "@lwfa/proto"
import { Spring } from "@lwfa/spring"
import { WINDOW_SPRING } from "@/generated/config"

/** A single animated scalar. Mirrors `Animated` in `layout.rs`. */
interface Axis {
  current: number
  target: number
  spring: Spring | null
  /** When the current spring started, on the `performance.now()` clock. */
  started: number
  /** Which way this move is going: +1, -1, or 0 while at rest. */
  direction: number
}

const axis = (value: number): Axis => ({
  current: value,
  target: value,
  spring: null,
  started: 0,
  direction: 0,
})

function snap(a: Axis, target: number): void {
  a.current = target
  a.target = target
  a.spring = null
  a.direction = 0
}

/**
 * Start, or redirect, a spring toward `target`.
 *
 * Redirecting carries the in-flight velocity into the new spring, so changing
 * your mind mid-move stays smooth instead of visibly restarting from a
 * standstill. `lwfa-spring` has a test pinning that.
 */
function springTo(a: Axis, target: number, spec: SpringSpec, now: number): boolean {
  if (a.target === target && a.spring !== null) return true // already heading there
  const velocity = a.spring ? a.spring.velocityAt(now - a.started) : 0
  if (Math.abs(target - a.current) < 0.01 && velocity === 0) {
    snap(a, target)
    return false
  }
  a.direction = Math.sign(target - a.current)
  a.target = target
  a.spring = new Spring(
    { stiffness: spec.stiffness, damping: spec.damping, mass: spec.mass, velocity },
    a.current,
    target,
  )
  a.started = now
  return true
}

/**
 * Advance one axis. Returns true while it is still moving.
 *
 * The value can never pass its target. That is a hard guarantee here rather
 * than a consequence of the spring parameters, because the parameters cannot
 * provide it on their own: an overdamped spring does not overshoot *from rest*,
 * but redirecting one mid-flight carries the old velocity into the new spring,
 * and enough of it will sail past the target however heavily damped it is.
 *
 * Redirection is not an edge case, it is what happens every time you move focus
 * again before the last move finished. The result was a window arriving where
 * it was going, sliding past, and coming back: a bounce off the edge of the
 * viewport that nobody asked for and that no amount of retuning removes.
 *
 * So: arriving is arriving. Overshooting is treated as done.
 */
function tick(a: Axis, now: number): boolean {
  if (!a.spring) return false
  const state = a.spring.stateAt(now - a.started)
  const passed = a.direction !== 0 && (state.value - a.target) * a.direction > 0
  if (state.done || passed) {
    snap(a, a.target)
    return false
  }
  a.current = state.value
  return true
}

interface Track {
  x: Axis
  y: Axis
  width: Axis
  height: Axis
  z: number
  /** Whether `will-change` is currently set, so it is not written every frame. */
  hinted: boolean
}

function trackFor(rect: { x: number; y: number; width: number; height: number }): Track {
  return {
    x: axis(rect.x),
    y: axis(rect.y),
    width: axis(rect.width),
    height: axis(rect.height),
    z: 0,
    hinted: false,
  }
}

/**
 * Positions every live window surface.
 *
 * One instance, module-scoped: there is exactly one desktop.
 */
class Motion {
  #tracks = new Map<WindowId, Track>()
  #elements = new Map<WindowId, HTMLElement>()
  #frame: number | null = null
  /**
   * From `configs/defaults.toml`, not from the protocol's default.
   *
   * This used to start at `DEFAULT_SPRING`, which is Motion's own default of
   * stiffness 100 / damping 10: a damping ratio of 0.5, which is *very*
   * bouncy. `setSpring` existed to replace it and nothing ever called it, so
   * every window in the browser animated on a spring nobody had chosen and no
   * amount of tuning the configured one changed anything. Defaulting to the
   * configured value means there is no window in which the wrong one is in
   * force, and nothing to remember to call.
   */
  #spec: SpringSpec = WINDOW_SPRING

  /**
   * Some people get motion sick, and some just do not want it. The OS already
   * knows; asking again in our own settings would be rude.
   */
  #reduced =
    typeof matchMedia === "function"
      ? matchMedia("(prefers-reduced-motion: reduce)")
      : null

  get reducedMotion(): boolean {
    return this.#reduced?.matches ?? false
  }

  /** Override the configured spring. Only used by tests. */
  setSpring(spec: SpringSpec): void {
    this.#spec = spec
  }

  /**
   * Take ownership of a window's element.
   *
   * Writes the current position immediately, before the browser paints, so a
   * surface never flashes at the origin on the frame it mounts. Called from a
   * layout effect for that reason.
   *
   * The rect is passed in because a child's layout effect runs *before* its
   * parent's: on the very first render the element can arrive before anything
   * has told this class where the window goes, and the surface itself knows.
   */
  attach(id: WindowId, element: HTMLElement, rect: WindowLayout["rect"], z: number): () => void {
    this.#elements.set(id, element)
    let track = this.#tracks.get(id)
    if (!track) {
      track = trackFor(rect)
      this.#tracks.set(id, track)
    }
    track.z = z
    write(element, track)
    return () => {
      // Only if it is still ours. React can mount the replacement before
      // unmounting the old one, and clearing then would strand the new element.
      if (this.#elements.get(id) === element) this.#elements.delete(id)
    }
  }

  /**
   * Declare where every window should be.
   *
   * Total, like `SetLayout` on the wire: anything absent has gone away and is
   * forgotten, so a window that closes and a window that moved to another
   * workspace both stop being animated.
   *
   * `animate` false means "be there now": a resync, or the viewport changing
   * shape. Windows should appear in place rather than flying in from wherever
   * they last happened to be.
   */
  set(windows: WindowLayout[], animate: boolean): void {
    const now = performance.now()
    const still = animate && !this.reducedMotion
    const seen = new Set<WindowId>()
    let running = false

    for (const window of windows) {
      seen.add(window.id)
      let track = this.#tracks.get(window.id)
      if (!track) {
        // First sight of this window. Snapping is the only sane choice: there
        // is no previous position for it to have come from.
        track = trackFor(window.rect)
        this.#tracks.set(window.id, track)
      } else if (still) {
        // Position animates, size does not.
        //
        // The same rule the engine follows, for the same reason plus one. A
        // window's pixels arrive at the size the client was configured to, so
        // animating the CSS box means stretching the last frame across a box
        // that does not match it and then snapping when the real one lands.
        // The result is a window that wobbles like jelly on every width change,
        // which is not motion, it is an artefact.
        running = springTo(track.x, window.rect.x, this.#spec, now) || running
        running = springTo(track.y, window.rect.y, this.#spec, now) || running
        snap(track.width, window.rect.width)
        snap(track.height, window.rect.height)
      } else {
        snap(track.x, window.rect.x)
        snap(track.y, window.rect.y)
        snap(track.width, window.rect.width)
        snap(track.height, window.rect.height)
      }
      track.z = window.z

      const element = this.#elements.get(window.id)
      if (element) write(element, track)
    }

    for (const id of [...this.#tracks.keys()]) {
      if (!seen.has(id)) this.#tracks.delete(id)
    }

    if (running) this.#schedule()
  }

  /** Where a window actually is, for hit-testing against a live animation. */
  rectOf(id: WindowId): { x: number; y: number; width: number; height: number } | null {
    const track = this.#tracks.get(id)
    if (!track) return null
    return {
      x: track.x.current,
      y: track.y.current,
      width: track.width.current,
      height: track.height.current,
    }
  }

  #schedule(): void {
    if (this.#frame !== null) return
    this.#frame = requestAnimationFrame(this.#tick)
  }

  // An arrow property, so it can be handed to `requestAnimationFrame` directly
  // and still see `this`.
  #tick = (now: number): void => {
    this.#frame = null
    let running = false

    for (const [id, track] of this.#tracks) {
      const moving =
        // Not `||`, which would short-circuit and leave the other axis frozen
        // at whatever it was when the first one settled.
        [tick(track.x, now), tick(track.y, now)].some(Boolean)
      running ||= moving

      const element = this.#elements.get(id)
      if (element) {
        write(element, track)
        // `will-change` earns its keep only while something is actually
        // moving. Left on permanently it is a standing request for a
        // compositor layer per window, which on a tablet is memory spent to
        // make nothing faster.
        if (moving !== track.hinted) {
          element.style.willChange = moving ? "transform" : ""
          track.hinted = moving
        }
      }
    }

    if (running) this.#schedule()
  }
}

function write(element: HTMLElement, track: Track): void {
  // `translate3d` rather than `left`/`top`: a transform is composited and skips
  // layout entirely, which matters when several windows move at once on a
  // device that is already busy decoding video for all of them.
  element.style.transform = `translate3d(${track.x.current}px, ${track.y.current}px, 0)`
  element.style.width = `${track.width.current}px`
  element.style.height = `${track.height.current}px`
  element.style.zIndex = String(track.z)
}

export const motion = new Motion()
