/**
 * Decoded frames, stored per window and subscribed to per window.
 *
 * # Why this is not React state
 *
 * Frames arrive several times a second per window, and there can be a dozen
 * windows. Holding them in a `Map` in `App`'s state means every frame from
 * every window replaces that map, re-renders `App`, and re-renders the entire
 * tree beneath it, including all the *other* windows and the whole navigation.
 * A terminal blinking its cursor should not cost a render of the gamepad.
 *
 * Here each surface subscribes to its own id, so a frame for `w4` wakes exactly
 * one component. Nothing above it renders at all.
 *
 * # Lifetime
 *
 * An `ImageBitmap` holds GPU memory and is not garbage collected in any useful
 * timeframe, so every one that is replaced or dropped is closed explicitly.
 * Forgetting that is a slow leak that only shows up after an hour of use, which
 * is exactly the kind of bug this project cannot afford.
 */

import { useCallback, useSyncExternalStore } from "react"
import type { WindowId } from "@lwfa/proto"

const frames = new Map<WindowId, ImageBitmap>()
const listeners = new Map<WindowId, Set<() => void>>()

function notify(id: WindowId): void {
  const subscribers = listeners.get(id)
  if (!subscribers) return
  for (const listener of subscribers) listener()
}

/** Store a newly decoded frame, closing the one it replaces. */
export function publishFrame(id: WindowId, bitmap: ImageBitmap): void {
  frames.get(id)?.close()
  frames.set(id, bitmap)
  notify(id)
}

/** Drop a window's frame, e.g. when it closes or stops being streamed. */
export function dropFrame(id: WindowId): void {
  const existing = frames.get(id)
  if (!existing) return
  existing.close()
  frames.delete(id)
  notify(id)
}

/** Drop everything. Called when the connection goes away. */
export function clearFrames(): void {
  const ids = [...frames.keys()]
  for (const id of ids) {
    frames.get(id)?.close()
    frames.delete(id)
  }
  for (const id of ids) notify(id)
}

/**
 * The latest frame for one window.
 *
 * Returns the bitmap itself, so React's identity check is the change check: a
 * re-published bitmap is a different object, an unchanged one is not.
 *
 * Both callbacks are memoised on `id`. `useSyncExternalStore` re-subscribes
 * whenever `subscribe` changes identity, so building it inline would tear down
 * and rebuild the subscription on every single render.
 */
export function useFrame(id: WindowId): ImageBitmap | null {
  const subscribe = useCallback(
    (listener: () => void) => {
      let set = listeners.get(id)
      if (!set) {
        set = new Set()
        listeners.set(id, set)
      }
      set.add(listener)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(id)
      }
    },
    [id],
  )
  const snapshot = useCallback(() => frames.get(id) ?? null, [id])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
