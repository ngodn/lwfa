/**
 * Deciding whether to reload after a crash, or to stop and say so.
 *
 * # Why not simply reload
 *
 * Reloading is nearly free here, which argues for doing it automatically: the
 * desktop lives in the engine, so windows, their contents and the arrangement
 * all survive, and the password is already stored. A reload costs a second and
 * loses nothing.
 *
 * What it cannot do is reload *unconditionally*. If whatever throws also throws
 * on the way back up, which is exactly what a bad stored preference or an
 * unhandled message would do, the page reloads, crashes, reloads, crashes,
 * forever. You cannot read the error, you cannot reach the settings that would
 * fix it, and you cannot even close the tab easily on a tablet. One bug becomes
 * a device you have to force-quit.
 *
 * So: reload the first few times, and if it keeps happening, stop and show the
 * error. The common case, a one-off, heals itself and nobody sees anything. The
 * bad case is a screen you can read and act on.
 *
 * # Why sessionStorage
 *
 * It has to survive a reload, or the count is always zero and every crash looks
 * like the first. It must not survive the tab, or yesterday's crashes make
 * today's first one look like a loop. That is exactly `sessionStorage`.
 */

const KEY = "lwfa.crashes"

/**
 * Where the last crash's message waits to be reported.
 *
 * Separate from the count, and read once: the count decides whether to reload,
 * this is what gets told to the engine afterwards. It has to go through storage
 * because the connection that saw the crash is being torn down as the page
 * goes away, so nothing sent on it can be relied on to arrive.
 */
const REPORT_KEY = "lwfa.crash.report"

/** How many automatic reloads before giving up and showing the error. */
export const LIMIT = 3

/**
 * Crashes older than this are forgotten.
 *
 * Long enough to catch a genuine loop, which reloads in a second or two, and
 * short enough that a crash this morning does not count against one this
 * afternoon.
 */
export const WINDOW_MS = 60_000

/** Just enough of `Storage` to be swappable in tests. */
export interface Store {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function read(store: Store, now: number): number[] {
  try {
    const raw = store.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((at): at is number => typeof at === "number" && Number.isFinite(at))
      .filter((at) => now - at < WINDOW_MS)
  } catch {
    // Unparseable, or storage disabled. Treat as no history: the worst case is
    // one reload that should have been a message.
    return []
  }
}

/**
 * Record a crash and say what to do about it.
 *
 * `"reload"` means recover silently. `"stop"` means this keeps happening and
 * the error should be shown instead.
 */
export function onCrash(store: Store, now: number): "reload" | "stop" {
  const recent = [...read(store, now), now]
  try {
    store.setItem(KEY, JSON.stringify(recent))
  } catch {
    // Cannot remember, so cannot detect a loop. Showing the error is the safe
    // side of that: an unreadable message beats an unbreakable reload loop.
    return "stop"
  }
  return recent.length > LIMIT ? "stop" : "reload"
}

/**
 * Forget the history, once the shell has clearly survived.
 *
 * Without this a session that crashed twice hours ago is one crash away from
 * refusing to reload, having been fine in between.
 */
export function clearCrashes(store: Store): void {
  try {
    store.removeItem(KEY)
  } catch {
    // Nothing to do, and nothing depends on it succeeding.
  }
}

/**
 * Leave the crash's message for the next page load to report.
 *
 * Truncated, because a React error can carry an entire component stack and this
 * has to survive in a storage quota shared with everything else.
 */
export function noteCrashToReport(store: Store, message: string): void {
  try {
    store.setItem(REPORT_KEY, message.slice(0, 300))
  } catch {
    // Storage full or blocked. The reload still happens; only the report is
    // lost, which is exactly where things stood before this existed.
  }
}

/**
 * Take the message left by a crash, if there is one.
 *
 * Taking rather than reading: a report is made once. Leaving it would send the
 * same crash again on every reconnect for the rest of the session.
 */
export function takeCrashToReport(store: Store): string | null {
  try {
    const message = store.getItem(REPORT_KEY)
    if (message !== null) store.removeItem(REPORT_KEY)
    return message
  } catch {
    return null
  }
}

/** How many crashes are being counted right now. For the message. */
export function crashCount(store: Store, now: number): number {
  return read(store, now).length
}
