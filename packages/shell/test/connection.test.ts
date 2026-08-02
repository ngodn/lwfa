/**
 * Reconnection, and the two ways a socket can be closed from the far end.
 *
 * The bug these exist for: a retry that raced its predecessor made the shell
 * give up permanently. The engine closes a superseded socket to stop counting
 * two viewers for one browser, and that close was being reported as "another
 * device replaced you", which tells the client to stop trying. So a flaky
 * network plus a couple of refreshes left the shell on "connecting" until the
 * page was reloaded by hand.
 *
 * Two independent defences, tested separately, because either alone would have
 * prevented it and both are worth keeping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  Connection,
  REPLACED_REASON,
  SUPERSEDED_REASON,
  type Status,
} from "../src/connection"

/** Every socket the code under test has opened, oldest first. */
let opened: FakeSocket[] = []

class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  binaryType = "blob"
  readyState = 0
  onopen: (() => void) | null = null
  onclose: ((event: { reason: string; code: number }) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(public url: string) {
    opened.push(this)
  }

  /** Complete the handshake, as the engine accepting would. */
  accept() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  /** Close from the far end, with a reason. */
  closeFromServer(reason: string) {
    this.readyState = 3
    this.onclose?.({ reason, code: 1000 })
  }

  close() {
    this.readyState = 3
  }

  send() {}
}

const handlers = () => {
  const statuses: Status[] = []
  return {
    seen: statuses,
    onMessage: () => {},
    onFrame: () => {},
    onAudio: () => {},
    onStatus: (s: Status) => statuses.push(s),
  }
}

beforeEach(() => {
  opened = []
  vi.useFakeTimers()
  Object.assign(globalThis, { WebSocket: FakeSocket })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("a superseded socket", () => {
  it("does not reconnect and start a fight over the session", () => {
    // Reaching this branch means another connection of this browser holds the
    // newer socket: a second tab, or a page that outlived its reload. Retrying
    // would supersede theirs, theirs would supersede ours back, and the two
    // would trade the session forever.
    //
    // That is exactly what happened when this reconnected: a new session every
    // 290ms, two hundred deep, restarting the audio capture on every pass.
    const h = handlers()
    const conn = new Connection("ws://engine", h)
    conn.connect()

    const first = opened[0]!
    first.accept()
    first.closeFromServer(SUPERSEDED_REASON)

    vi.advanceTimersByTime(30_000)
    expect(opened).toHaveLength(1)
    conn.close()
  })

  it("still stops when another device genuinely replaces it", () => {
    // The opposite case must keep working: two shells displacing each other
    // forever is exactly what this reason exists to prevent.
    const h = handlers()
    const conn = new Connection("ws://engine", h)
    conn.connect()

    const first = opened[0]!
    first.accept()
    first.closeFromServer(REPLACED_REASON)

    expect(h.seen).toContain("replaced")
    vi.advanceTimersByTime(6000)
    expect(opened).toHaveLength(1)
    conn.close()
  })
})

describe("a stale socket", () => {
  it("is ignored when it closes after being replaced", () => {
    // Reconnecting swaps in a new socket before the old one finishes dying,
    // so the old one's close still fires. Acting on it would tear down the
    // live connection, which is the second half of the same bug.
    const h = handlers()
    const conn = new Connection("ws://engine", h)
    conn.connect()

    const first = opened[0]!
    first.accept()
    // Drop, so the connection schedules a retry and opens a second socket.
    first.closeFromServer("")
    vi.advanceTimersByTime(6000)
    expect(opened.length).toBeGreaterThan(1)

    const second = opened[opened.length - 1]!
    second.accept()
    const before = h.seen.length

    // The *first* socket now reports its close, late and irrelevant.
    first.closeFromServer(REPLACED_REASON)

    expect(h.seen.slice(before)).not.toContain("replaced")
    conn.close()
  })
})
