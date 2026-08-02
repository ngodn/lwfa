/**
 * One connection per browser, not one per tab.
 *
 * # The problem this removes
 *
 * The engine identifies a browser by a stable id kept in `localStorage`, and
 * `localStorage` is shared by every tab of that browser. So two tabs of the
 * shell present the same identity, and the engine — correctly, by its own
 * rules — treats each new one as the older one reconnecting and closes the
 * other. Left there, each tab then reconnects, supersedes the other, and the
 * two trade the session forever. That happened: a new session every 290ms,
 * two hundred deep, with the audio capture stopping and starting on each pass.
 *
 * Patching the reconnect rule stops the loop but not the cause. The cause is
 * that two tabs both believe they should hold the connection, and the fix is
 * to make exactly one of them right.
 *
 * # How
 *
 * The Web Locks API, which is the established way to elect a leader among
 * tabs. Every tab asks for the same named lock; the browser grants it to one
 * and queues the rest. The holder keeps it until its tab goes away — closed,
 * crashed, or navigated — at which point the browser releases it and the next
 * tab in the queue is promoted with no timeout and no heartbeat to get wrong.
 *
 * # When the API is not there
 *
 * `navigator.locks` is secure-context only, so a shell reached over plain HTTP
 * on a LAN address does not have it. There, every tab is told it leads.
 * That is deliberate: refusing to connect at all would be worse than the
 * problem, and the engine's supersede rule already stops the runaway loop, so
 * the failure mode degrades to "the newest tab wins", which is what a user
 * would expect anyway.
 */

/** Shared by every tab of this origin. That is the entire point. */
const LOCK_NAME = "lwfa.session"

export interface Leadership {
  /** True once this tab holds the lock, or immediately if there are no locks. */
  readonly held: boolean
  /** Give up leadership and stop waiting. Safe to call more than once. */
  release(): void
}

/**
 * Ask to be the tab that holds the connection.
 *
 * `onGranted` runs when this tab may connect, which for a second tab is when
 * the first one goes away. Nothing runs if leadership is released first.
 */
export function requestLeadership(onGranted: () => void): Leadership {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks

  if (!locks) {
    // No Web Locks: see the header. Lead immediately.
    onGranted()
    return { held: true, release: () => {} }
  }

  const controller = new AbortController()
  const state = { held: false, released: false }

  locks
    .request(LOCK_NAME, { mode: "exclusive", signal: controller.signal }, () => {
      if (state.released) return
      state.held = true
      onGranted()
      // Holding the lock means never resolving: the callback's promise is what
      // the browser waits on, so returning would hand leadership straight to
      // the next tab while this one is still using it. The lock is released by
      // aborting the request, or by the tab going away.
      return new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true })
      })
    })
    .catch(() => {
      // Aborted, which is the ordinary way this ends.
    })

  return {
    get held() {
      return state.held
    },
    release() {
      if (state.released) return
      state.released = true
      state.held = false
      controller.abort()
    },
  }
}
