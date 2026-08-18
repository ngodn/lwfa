/**
 * How much video is actually arriving, measured rather than assumed.
 *
 * # Why this exists
 *
 * When a session feels slow there are three very different causes and they all
 * look identical from the outside: the engine is sending less (its budget
 * dropped), the engine is sending less often (its capture is paced down), or
 * the picture is fine and the input is not. Nothing in the shell could tell
 * them apart, so "it went laggy" was never more than a feeling, and the fixes
 * for the three are unrelated.
 *
 * Frames carry their own size and dimensions, so all of it is measurable here
 * without asking the engine anything. Frames per second separates "paced down"
 * from "compressed harder"; the bitrate separates both from a link doing
 * nothing at all.
 *
 * # Why a store and not state
 *
 * Frames arrive sixty times a second and the panel showing this is usually
 * closed. A store means the measurement costs two additions per frame, and a
 * re-render happens once a second and only for whoever asked.
 */

import { useSyncExternalStore } from "react"

/** How often the rolling counts are turned into a published figure. */
const WINDOW_MS = 1000

/**
 * How long without a frame before the numbers are reported as zero.
 *
 * A stream that stops leaves its last figure standing otherwise, so a paused
 * or broken session goes on claiming twenty megabits. Generous enough that the
 * slowest paced capture (ten frames a second) never trips it.
 */
const STALE_MS = 2500

export interface StreamStats {
  /** Frames decoded in the last window. */
  fps: number
  /** Kilobits per second across every streamed window. */
  kbits: number
  /** The largest frame seen in the last window, as `width×height`, or null. */
  size: string | null
  /** Keyframes in the last window. A stream that is all keyframes is JPEG. */
  keyframes: number
}

const NOTHING: StreamStats = { fps: 0, kbits: 0, size: null, keyframes: 0 }

let published: StreamStats = NOTHING
const listeners = new Set<() => void>()

let frames = 0
let bytes = 0
let keyframes = 0
let widest = 0
let tallest = 0
/**
 * When the open window began, and when the last frame landed.
 *
 * `null` rather than zero for "not started". `performance.now()` is zero at
 * the moment the page loads, so a zero sentinel collides with a real reading:
 * the first frames of a freshly loaded page kept resetting the window instead
 * of filling it, and nothing was ever published.
 */
let since: number | null = null
let lastFrameAt: number | null = null
let ticker: ReturnType<typeof setInterval> | null = null

function announce(next: StreamStats): void {
  // Compared field by field so an unchanged second does not re-render. The
  // object is rebuilt every window regardless, so identity alone says nothing.
  if (
    next.fps === published.fps &&
    next.kbits === published.kbits &&
    next.size === published.size &&
    next.keyframes === published.keyframes
  ) {
    return
  }
  published = next
  for (const listener of listeners) listener()
}

/**
 * Record one decoded frame.
 *
 * Called from the decoder rather than from the socket, so what is counted is
 * what a viewer actually saw: a frame dropped for want of a keyframe is not a
 * frame that arrived as far as this is concerned.
 */
export function noteFrame(
  bytesInFrame: number,
  width: number,
  height: number,
  keyframe: boolean,
): void {
  const now = performance.now()
  if (since === null) since = now
  lastFrameAt = now

  frames++
  bytes += bytesInFrame
  if (keyframe) keyframes++
  if (width * height > widest * tallest) {
    widest = width
    tallest = height
  }

  const elapsed = now - since
  if (elapsed < WINDOW_MS) return

  announce({
    fps: Math.round((frames * 1000) / elapsed),
    kbits: Math.round((bytes * 8) / elapsed),
    size: widest > 0 ? `${widest}×${tallest}` : null,
    keyframes,
  })
  frames = 0
  bytes = 0
  keyframes = 0
  widest = 0
  tallest = 0
  since = now
}

/** Forget everything. For when the stream stops and the last figure would lie. */
export function clearStats(): void {
  frames = 0
  bytes = 0
  keyframes = 0
  widest = 0
  tallest = 0
  since = null
  lastFrameAt = null
  announce(NOTHING)
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Only while somebody is watching. Without this, a session with every panel
  // closed would still hold a timer for the whole time it is open, and the
  // thing it exists for (noticing that frames *stopped*) is only interesting
  // to somebody actually reading the number.
  if (ticker === null) {
    ticker = setInterval(() => {
      if (lastFrameAt === null) return
      if (performance.now() - lastFrameAt < STALE_MS) return
      clearStats()
    }, WINDOW_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && ticker !== null) {
      clearInterval(ticker)
      ticker = null
    }
  }
}

const snapshot = (): StreamStats => published

export function useStreamStats(): StreamStats {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Read without subscribing. Same shape as `streamFormat`'s `formatNow`. */
export function statsNow(): StreamStats {
  return published
}
