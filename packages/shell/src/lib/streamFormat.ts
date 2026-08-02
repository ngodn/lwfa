/**
 * What is actually arriving, as opposed to what could be.
 *
 * # Why this exists
 *
 * The session panel used to report the decode format as
 * `supportsH264() ? "H.264" : "JPEG"`, which is a statement about the browser's
 * capabilities and not about the stream. It said "H.264" while an iPad was
 * being sent HEVC, and it would say "H.264" with streaming switched off
 * entirely. A readout that cannot be wrong is not a readout.
 *
 * The engine chooses the codec from what every connected client says it can
 * decode, so the answer is not knowable in advance from this side at all. The
 * only honest source is the frames themselves, and every frame carries its
 * format in the header.
 *
 * # Why a store and not state
 *
 * Frames arrive continuously and the panel that displays this is usually
 * closed. A store means the value costs a comparison per frame and re-renders
 * only the components that asked for it, and only when it genuinely changes.
 */

import { useSyncExternalStore } from "react"
import { FrameFormat } from "@lwfa/proto"

/** What the last frame was encoded as, or `null` before any has arrived. */
let current: FrameFormat | null = null
const listeners = new Set<() => void>()

/**
 * Record the format of a frame that just arrived.
 *
 * Called per frame, so it does nothing at all in the common case: the format
 * changes when the engine renegotiates a codec, which is a handful of times a
 * session, not sixty times a second.
 */
export function noteFormat(format: FrameFormat): void {
  if (format === current) return
  current = format
  for (const listener of listeners) listener()
}

/** Forget, for when the stream stops and the old answer would be stale. */
export function clearFormat(): void {
  if (current === null) return
  current = null
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): FrameFormat | null => current

export function useStreamFormat(): FrameFormat | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Read without subscribing. */
export function formatNow(): FrameFormat | null {
  return current
}

/**
 * What to show for a format.
 *
 * `null` is "nothing has arrived", which is different from "JPEG" and is the
 * state the panel is in while streaming is off or a window is still being set
 * up. Saying so beats naming a codec that is not being used.
 */
export function describeFormat(format: FrameFormat | null): string {
  switch (format) {
    case FrameFormat.Hevc:
      return "HEVC"
    case FrameFormat.H264:
      return "H.264"
    case FrameFormat.Jpeg:
      return "JPEG"
    default:
      return "—"
  }
}
