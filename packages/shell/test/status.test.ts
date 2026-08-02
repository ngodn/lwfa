/**
 * What the shell says when the connection is not simply working.
 *
 * "Connecting" used to cover four different situations: a first attempt, a
 * retry after a drop, a tab queued behind another tab that will never connect
 * while that one lives, and an engine that is not running. Same word, same
 * spinner, and the only way to tell them apart was the engine's log, which is
 * not reachable from the tablet the shell is usually on. That cost hours more
 * than once, which is why each of them now has a name and a test.
 */

import { describe, expect, it, vi } from "vitest"
import type { Status } from "../src/connection"
import { describeStatus, isLive } from "../src/lib/status"

const ALL: Status[] = [
  "connecting",
  "connected",
  "waiting",
  "disconnected",
  "incompatible",
  "replaced",
  "unauthorized",
  "unreachable",
]

describe("every status", () => {
  it("has a label, a sentence and a tone", () => {
    // A missing entry would render as `undefined` in the panel somebody opened
    // precisely because something looked wrong.
    for (const status of ALL) {
      const report = describeStatus(status)
      expect(report.label, status).toBeTruthy()
      expect(report.hint, status).toBeTruthy()
      expect(["good", "busy", "bad"], status).toContain(report.tone)
    }
  })

  it("does not put jargon in front of the user", () => {
    // The panel used to print the raw union member, so people read
    // "unreachable" or "unauthorized" and had to guess what the shell meant.
    // `connecting` and `connected` are left out on purpose: those words are
    // both the identifier and the right thing to say.
    const jargon = [
      "waiting",
      "disconnected",
      "incompatible",
      "replaced",
      "unauthorized",
      "unreachable",
    ] as const
    for (const status of jargon) {
      expect(describeStatus(status).label.toLowerCase(), status).not.toBe(status)
    }
  })

  it("starts every label with a capital", () => {
    for (const status of ALL) {
      const first = describeStatus(status).label[0]!
      expect(first, status).toBe(first.toUpperCase())
    }
  })

  it("ends its sentence, since it is shown as prose", () => {
    for (const status of ALL) {
      expect(describeStatus(status).hint.endsWith("."), status).toBe(true)
    }
  })
})

describe("telling the four waits apart", () => {
  it("says a queued tab is queued, not connecting", () => {
    // The one that made a tab which would never connect look exactly like a
    // tab about to succeed.
    const waiting = describeStatus("waiting")
    const connecting = describeStatus("connecting")
    expect(waiting.label).not.toBe(connecting.label)
    expect(waiting.hint).toMatch(/another tab/i)
  })

  it("tells a queued tab how to fix it", () => {
    // It is the only state the user can end instantly, so the sentence names
    // the action rather than describing the situation.
    expect(describeStatus("waiting").hint).toMatch(/close/i)
  })

  it("separates a dropped session from a first attempt", () => {
    // A drop means the windows on screen are a still picture. A first attempt
    // means there is nothing on screen yet.
    expect(describeStatus("disconnected").label).not.toBe(describeStatus("connecting").label)
    expect(describeStatus("disconnected").hint).toMatch(/dropped/i)
  })

  it("says an engine that is not answering will not fix itself", () => {
    expect(describeStatus("unreachable").tone).toBe("bad")
    expect(describeStatus("connecting").tone).toBe("busy")
  })
})

describe("tones", () => {
  it("treats work in progress as busy, not broken", () => {
    // Colouring a reconnect the same as a refused password is what made every
    // hiccup look like a breakage.
    for (const status of ["connecting", "waiting", "disconnected"] as const) {
      expect(describeStatus(status).tone, status).toBe("busy")
    }
  })

  it("treats states that need action as bad", () => {
    for (const status of ["unreachable", "unauthorized", "incompatible", "replaced"] as const) {
      expect(describeStatus(status).tone, status).toBe("bad")
    }
  })

  it("is good only when connected", () => {
    for (const status of ALL) {
      expect(describeStatus(status).tone === "good", status).toBe(status === "connected")
    }
  })
})

describe("detail from the connection", () => {
  it("replaces the generic sentence rather than being appended", () => {
    // The specific one is always more useful, and showing both meant the panel
    // said the same thing twice in different words.
    const detail = "the engine speaks protocol 4, this page speaks 3"
    expect(describeStatus("incompatible", detail).hint).toBe(detail)
  })

  it("keeps the label and tone", () => {
    const report = describeStatus("unreachable", "connection refused")
    expect(report.label).toBe(describeStatus("unreachable").label)
    expect(report.tone).toBe("bad")
  })
})

describe("isLive", () => {
  it("is true only when connected", () => {
    // Anything else means the windows on screen are the last frame of a
    // session that is no longer running.
    for (const status of ALL) {
      expect(isLive(status), status).toBe(status === "connected")
    }
  })
})

/**
 * The decode readout.
 *
 * It used to report `supportsH264() ? "H.264" : "JPEG"`, which is a statement
 * about the browser and not about the stream: it said "H.264" while an iPad
 * was being sent HEVC, and would have said it with streaming switched off. The
 * engine picks the codec from what every connected client can decode, so this
 * side cannot know the answer in advance. The frames are the only honest
 * source.
 */
describe("what the stream is actually in", () => {
  it("names each format", async () => {
    const { describeFormat } = await import("../src/lib/streamFormat")
    const { FrameFormat } = await import("@lwfa/proto")
    expect(describeFormat(FrameFormat.Hevc)).toBe("HEVC")
    expect(describeFormat(FrameFormat.H264)).toBe("H.264")
    expect(describeFormat(FrameFormat.Jpeg)).toBe("JPEG")
  })

  it("says nothing rather than guessing before a frame arrives", async () => {
    // Distinct from JPEG. Naming a codec that is not being used is the bug
    // this replaced.
    const { describeFormat } = await import("../src/lib/streamFormat")
    expect(describeFormat(null)).toBe("—")
  })

  it("tracks the last frame and forgets on demand", async () => {
    const { noteFormat, clearFormat, formatNow } = await import("../src/lib/streamFormat")
    const { FrameFormat } = await import("@lwfa/proto")
    clearFormat()
    expect(formatNow()).toBeNull()
    noteFormat(FrameFormat.Hevc)
    expect(formatNow()).toBe(FrameFormat.Hevc)
    noteFormat(FrameFormat.H264)
    expect(formatNow()).toBe(FrameFormat.H264)
    clearFormat()
    expect(formatNow()).toBeNull()
  })

  it("only notifies when the answer changes", async () => {
    // Called once per frame, so sixty times a second on a busy window.
    const { noteFormat, clearFormat, subscribe } = await import("../src/lib/streamFormat")
    const { FrameFormat } = await import("@lwfa/proto")
    clearFormat()
    const seen = vi.fn()
    const stop = subscribe(seen)
    noteFormat(FrameFormat.Hevc)
    noteFormat(FrameFormat.Hevc)
    noteFormat(FrameFormat.Hevc)
    expect(seen).toHaveBeenCalledTimes(1)
    stop()
    clearFormat()
  })
})
