/**
 * "That application is already open on the desktop."
 *
 * The state machine behind the dialog. Three states rather than a pair of
 * booleans, because the one that matters is "we asked it to quit and it has
 * not", and that is exactly the state booleans lose.
 *
 * It is not a failure state. An application with unsaved work answers a polite
 * request to quit by opening a dialog, and that dialog is on the screen this
 * session is not looking at. Only from there may forcing be offered, because
 * forcing loses the work the dialog is asking about.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  blocked,
  blockedNow,
  clearBlocked,
  closing,
  subscribe,
} from "../src/lib/alreadyRunning"

const CODE = { command: "code", terminal: false, program: "code", pid: 4321 }

afterEach(() => clearBlocked())

describe("being told an app is already open", () => {
  it("starts by asking", () => {
    blocked(CODE)
    expect(blockedNow()).toMatchObject({ program: "code", pid: 4321, phase: "asking" })
  })

  it("keeps the command and terminal flag so the launch can be retried", () => {
    // The whole point is to run the original request once the way is clear, so
    // losing either of these would silently change what gets launched.
    blocked({ command: "alacritty -e htop", terminal: true, program: "alacritty", pid: 9 })
    expect(blockedNow()).toMatchObject({ command: "alacritty -e htop", terminal: true })
  })

  it("starts empty", () => {
    expect(blockedNow()).toBeNull()
  })
})

describe("closing it", () => {
  it("moves to waiting", () => {
    blocked(CODE)
    closing()
    expect(blockedNow()?.phase).toBe("closing")
  })

  it("does nothing when there is nothing to close", () => {
    closing()
    expect(blockedNow()).toBeNull()
  })
})

describe("when it does not go away", () => {
  it("becomes stubborn rather than asking again", () => {
    // The engine sends the same message when the grace period ends. Treating
    // that as a fresh ask would loop the user through "close it" forever and
    // never offer the way out.
    blocked(CODE)
    closing()
    blocked(CODE)
    expect(blockedNow()?.phase).toBe("stubborn")
  })

  it("only offers forcing after a polite attempt", () => {
    // Forcing loses unsaved work, so it must never be reachable from the
    // first dialog.
    blocked(CODE)
    expect(blockedNow()?.phase).toBe("asking")
    blocked(CODE)
    expect(blockedNow()?.phase).toBe("asking")
  })

  it("treats a different program as a new question", () => {
    blocked(CODE)
    closing()
    blocked({ command: "firefox", terminal: false, program: "firefox", pid: 77 })
    expect(blockedNow()).toMatchObject({ program: "firefox", phase: "asking" })
  })

  it("can be told to keep waiting from stubborn", () => {
    blocked(CODE)
    closing()
    blocked(CODE)
    closing()
    expect(blockedNow()?.phase).toBe("closing")
  })
})

describe("finishing", () => {
  it("clears", () => {
    blocked(CODE)
    clearBlocked()
    expect(blockedNow()).toBeNull()
  })

  it("clearing twice is harmless", () => {
    blocked(CODE)
    clearBlocked()
    clearBlocked()
    expect(blockedNow()).toBeNull()
  })
})

describe("what subscribers are told", () => {
  it("notifies on every real change", () => {
    const seen = vi.fn()
    const stop = subscribe(seen)
    blocked(CODE)
    closing()
    clearBlocked()
    expect(seen).toHaveBeenCalledTimes(3)
    stop()
  })

  it("says nothing when clearing what is already clear", () => {
    const seen = vi.fn()
    const stop = subscribe(seen)
    clearBlocked()
    expect(seen).not.toHaveBeenCalled()
    stop()
  })

  it("stops telling a listener that has gone", () => {
    const seen = vi.fn()
    subscribe(seen)()
    blocked(CODE)
    expect(seen).not.toHaveBeenCalled()
  })
})
