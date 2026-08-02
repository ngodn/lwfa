/**
 * Saying what the connection is actually doing.
 *
 * # Why this exists
 *
 * "Connecting" was shown for at least four different situations: a first
 * attempt, a retry after the connection dropped, a tab queued behind another
 * tab that will never connect while that one lives, and an engine that is not
 * running at all. Every one of those was reported with the same word and the
 * same spinner, and the only way to tell them apart was to read the engine's
 * log, which is not available from the tablet the shell is usually on.
 *
 * That cost real time more than once. So each state gets a name, a sentence
 * saying what to do about it, and a tone, and they live here rather than being
 * spelled out at each of the three places that display them.
 *
 * # What the tones mean
 *
 * - `good`: working.
 * - `busy`: something is in progress and will probably resolve itself. Wait.
 * - `bad`: it will not resolve itself. Something has to change.
 *
 * `waiting` is `busy` rather than `bad`: nothing is broken, and closing the
 * other tab fixes it immediately.
 */

import type { Status } from "@/connection"

export type Tone = "good" | "busy" | "bad"

export interface StatusReport {
  /** Two or three words, for a badge. */
  label: string
  /** One sentence saying what is happening, or what to do. */
  hint: string
  tone: Tone
}

/**
 * Describe a status.
 *
 * `detail` comes from the connection when it knows something specific, such as
 * which protocol versions disagreed. It replaces the generic sentence rather
 * than being appended, because the specific one is always the more useful of
 * the two.
 */
export function describeStatus(status: Status, detail?: string): StatusReport {
  const report = REPORTS[status]
  return detail ? { ...report, hint: detail } : report
}

const REPORTS: Record<Status, StatusReport> = {
  connected: {
    label: "Connected",
    hint: "The desktop is live.",
    tone: "good",
  },
  connecting: {
    label: "Connecting",
    hint: "Opening a connection to the engine.",
    tone: "busy",
  },
  waiting: {
    label: "Another tab has it",
    // Names the fix, because this is the one state where the user can end it
    // instantly and would otherwise sit watching a spinner that will never
    // finish. One connection per browser is deliberate; see `lib/leader`.
    hint: "This desktop is open in another tab. Close it to use this one instead.",
    tone: "busy",
  },
  disconnected: {
    label: "Reconnecting",
    // Distinct from `connecting`: this one had a session and lost it, so the
    // windows on screen are a still picture rather than a live desktop.
    hint: "The connection dropped. Trying again.",
    tone: "busy",
  },
  unreachable: {
    label: "No answer",
    hint: "The engine did not accept the connection. It may not be running.",
    tone: "bad",
  },
  unauthorized: {
    label: "Password refused",
    hint: "The engine rejected this password.",
    tone: "bad",
  },
  incompatible: {
    label: "Version mismatch",
    hint: "The engine and this page speak different protocol versions.",
    tone: "bad",
  },
  replaced: {
    label: "Taken over",
    hint: "Another tab took this session. Reload to use it here.",
    tone: "bad",
  },
}

/** Is the desktop on screen a live one, or the last frame of a dead session? */
export function isLive(status: Status): boolean {
  return status === "connected"
}
