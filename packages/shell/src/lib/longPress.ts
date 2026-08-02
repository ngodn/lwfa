/**
 * Right-clicking with a finger.
 *
 * # Why this is not the browser's job
 *
 * On a mouse or a touchpad it already is. A two-finger tap, or a click in the
 * corner of a touchpad, is turned into a right button by the operating system
 * before any of this sees it, so the browser reports `button === 2` and the
 * shell forwards `BTN_RIGHT` with no special handling at all.
 *
 * A touchscreen has no second button, and the web has never agreed on what to
 * do about it. Android fires `contextmenu` on a long press; **iOS Safari has
 * not since iOS 13**, and shows its own callout instead. `-webkit-touch-callout:
 * none` suppresses the callout and still does not produce the event. Since iPads
 * are the devices this project exists for, waiting for `contextmenu` means no
 * right click at all on the hardware that matters most.
 *
 * So the gesture is measured here: a finger held still for long enough is a
 * right click.
 *
 * # The two numbers
 *
 * They are in tension. Too short and every slow tap becomes a right click,
 * which in a file manager means a menu instead of opening something. Too long
 * and it feels broken and people give up before it fires. 500ms is what the
 * platforms themselves use, near enough, and it is the number people already
 * have in their fingers.
 *
 * The movement tolerance exists because a finger is not a mouse. Nobody holds
 * one perfectly still, and a screen reports the wobble faithfully, so a
 * zero-tolerance test would almost never fire. Too generous and a slow drag
 * becomes a right click halfway through, which is worse than not having the
 * gesture. Ten pixels is about the width of the wobble and well under a
 * deliberate drag.
 */

/** How long a finger has to stay down. */
export const LONG_PRESS_MS = 500

/** How far it may wander first, in CSS pixels. */
export const MOVE_TOLERANCE = 10

export interface Point {
  clientX: number
  clientY: number
}

/**
 * Has the finger moved far enough that this is a drag, not a press?
 *
 * Compared as a straight line rather than per axis: a diagonal wander of ten
 * pixels each way is fourteen pixels of movement and should count as one, which
 * a per-axis test would let through.
 */
export function movedTooFar(from: Point, to: Point, tolerance = MOVE_TOLERANCE): boolean {
  return Math.hypot(to.clientX - from.clientX, to.clientY - from.clientY) > tolerance
}

/**
 * Watches one finger and reports when it has been held long enough.
 *
 * Time is injected rather than read, so the behaviour can be tested without
 * waiting half a second per case.
 */
export class LongPress {
  #timer: ReturnType<typeof setTimeout> | undefined
  #origin: Point | null = null
  /** Set once it has fired, so the release knows not to also be a tap. */
  #fired = false

  /**
   * Start watching. `onFire` runs if the finger is still down and still still
   * when the time is up.
   */
  start(at: Point, onFire: () => void): void {
    this.cancel()
    this.#origin = { clientX: at.clientX, clientY: at.clientY }
    this.#fired = false
    this.#timer = globalThis.setTimeout(() => {
      this.#timer = undefined
      this.#fired = true
      onFire()
    }, LONG_PRESS_MS)
  }

  /** Report movement. Cancels the press if the finger has wandered. */
  move(to: Point): void {
    if (!this.#origin || this.#fired) return
    if (movedTooFar(this.#origin, to)) this.cancel()
  }

  /**
   * Stop watching.
   *
   * Returns whether it had already fired, which is what tells the caller to
   * swallow the release: a long press that has become a right click must not
   * also deliver the tap that would otherwise follow it.
   */
  finish(): boolean {
    const fired = this.#fired
    this.cancel()
    return fired
  }

  cancel(): void {
    if (this.#timer !== undefined) globalThis.clearTimeout(this.#timer)
    this.#timer = undefined
    this.#origin = null
    this.#fired = false
  }

  /** Whether it has fired and not yet been finished. */
  get fired(): boolean {
    return this.#fired
  }
}
