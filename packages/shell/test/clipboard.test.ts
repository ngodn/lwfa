// The clipboard store: one page of the engine's history at a time.
//
// The behaviours worth pinning are the ones a refactor would break
// silently. Pagination is a cursor, so a copy landing between two pages
// must not duplicate a row or skip one. An entry put back on the clipboard
// arrives as the same message as a fresh copy, so it must move rather than
// appear twice. And a stale page must be ignored, because the panel asks
// again whenever it opens and two answers can be in flight.

import { beforeEach, describe, expect, it } from "vitest"
import type { ClipItem, ToEngine } from "@lwfa/proto"
import {
  savable,
  clipAdded,
  clipCleared,
  clipDropped,
  clipHistory,
  clipReady,
  clipReset,
  clipStateNow,
  clipUrl,
  loadFirstPage,
  loadMore,
  sendText,
} from "../src/lib/clipboard"

function entry(id: number, over: Partial<ClipItem> = {}): ClipItem {
  return {
    id,
    at: 1_755_600_000_000 + id,
    origin: "lwfa",
    device: null,
    kind: "text",
    bytes: 5,
    mime: "text/plain;charset=utf-8",
    preview: `entry ${id}`,
    whole: true,
    width: null,
    height: null,
    path: null,
    ...over,
  }
}

/** Collects what the panel would have sent to the engine. */
function recorder(): { send: (m: ToEngine) => void; sent: ToEngine[] } {
  const sent: ToEngine[] = []
  return { send: (message) => sent.push(message), sent }
}

// The tests run without a DOM, and `clipUrl` derives the engine's address
// from the page the shell was served by, the same as every other fetch.
beforeEach(() => {
  Object.defineProperty(globalThis, "location", {
    value: { protocol: "https:", host: "lwfa.example", hostname: "lwfa.example", search: "" },
    configurable: true,
    writable: true,
  })
  clipReset()
  clipReady(42, "ab".repeat(16))
})

describe("history", () => {
  it("shows the newest copy first", () => {
    clipAdded(entry(1))
    clipAdded(entry(2))
    expect(clipStateNow().items.map((item) => item.id)).toEqual([2, 1])
  })

  it("moves an entry put back on the clipboard rather than repeating it", () => {
    // `clipAdded` covers both "this is new" and "this is current again",
    // which is only safe because the second case removes the first copy.
    clipAdded(entry(1))
    clipAdded(entry(2))
    clipAdded(entry(1, { at: 1_755_600_099_000 }))
    expect(clipStateNow().items.map((item) => item.id)).toEqual([1, 2])
  })

  it("forgets one entry without disturbing its neighbours", () => {
    clipAdded(entry(1))
    clipAdded(entry(2))
    clipAdded(entry(3))
    clipDropped(2)
    expect(clipStateNow().items.map((item) => item.id)).toEqual([3, 1])
  })

  it("empties on a clear", () => {
    clipAdded(entry(1))
    clipCleared()
    expect(clipStateNow().items).toEqual([])
    expect(clipStateNow().more).toBe(false)
  })
})

describe("paging", () => {
  it("asks for the newest page first, from no cursor", () => {
    const { send, sent } = recorder()
    loadFirstPage(send)
    expect(sent[0]).toMatchObject({ type: "clipList", before: null })
    expect(clipStateNow().loading).toBe(true)
  })

  it("asks for older rows from the oldest one it holds", () => {
    const { send, sent } = recorder()
    loadFirstPage(send)
    const request = (sent[0] as { request: number }).request
    clipHistory(request, [entry(9), entry(8)], true)

    loadMore(send)
    expect(sent[1]).toMatchObject({ type: "clipList", before: 8 })
    expect(clipStateNow().paging).toBe(true)
  })

  it("appends an older page under the rows already showing", () => {
    const { send, sent } = recorder()
    loadFirstPage(send)
    clipHistory((sent[0] as { request: number }).request, [entry(9), entry(8)], true)
    loadMore(send)
    clipHistory((sent[1] as { request: number }).request, [entry(7)], false)

    expect(clipStateNow().items.map((item) => item.id)).toEqual([9, 8, 7])
    expect(clipStateNow().more).toBe(false)
    expect(clipStateNow().paging).toBe(false)
  })

  it("ignores a page nobody is waiting for any more", () => {
    // The panel asks again every time it opens, so an answer to the
    // previous ask can arrive after the new one. Appending it would show
    // the same rows twice.
    const { send, sent } = recorder()
    loadFirstPage(send)
    const stale = (sent[0] as { request: number }).request
    loadFirstPage(send)
    clipHistory(stale, [entry(9)], true)
    expect(clipStateNow().items).toEqual([])
    expect(clipStateNow().loading).toBe(true)
  })

  it("does not show a row twice when a copy lands mid-page", () => {
    // Ids descend with age, so a cursor cannot slip. This is the belt to
    // that braces: an entry pushed while a page was in flight is already
    // held when the page arrives holding it too.
    const { send, sent } = recorder()
    loadFirstPage(send)
    clipHistory((sent[0] as { request: number }).request, [entry(9), entry(8)], true)
    clipAdded(entry(10))
    loadMore(send)
    clipHistory((sent[1] as { request: number }).request, [entry(8), entry(7)], false)

    expect(clipStateNow().items.map((item) => item.id)).toEqual([10, 9, 8, 7])
  })

  it("will not ask for more while an ask is outstanding", () => {
    const { send, sent } = recorder()
    loadFirstPage(send)
    clipHistory((sent[0] as { request: number }).request, [entry(9)], true)
    loadMore(send)
    loadMore(send)
    expect(sent.filter((m) => m.type === "clipList")).toHaveLength(2)
  })
})

describe("sending", () => {
  it("sends text exactly as it is", () => {
    // Indentation is meaningful in the thing people most often copy across.
    const { send, sent } = recorder()
    sendText(send, "  indented\n\tcode\n")
    expect(sent[0]).toEqual({ type: "clipSetText", text: "  indented\n\tcode\n" })
  })

  it("does not send whitespace nobody typed on purpose", () => {
    const { send, sent } = recorder()
    sendText(send, "   \n  ")
    expect(sent).toEqual([])
  })
})

describe("fetching bytes", () => {
  it("carries the channel and ticket, because the session socket cannot", () => {
    const url = clipUrl(7, "thumb")
    expect(url).toContain("channel=42")
    expect(url).toContain(`ticket=${"ab".repeat(16)}`)
    expect(url).toContain("id=7")
    expect(url).toContain("thumb=1")
  })

  it("has nowhere to fetch from before the engine offers a channel", () => {
    clipReset()
    expect(clipUrl(7)).toBeNull()
  })
})

describe("reconnecting", () => {
  it("drops what it held, because the ids may name a different engine's entries", () => {
    clipAdded(entry(1))
    clipReady(43, "cd".repeat(16))
    expect(clipStateNow().items).toEqual([])
    expect(clipStateNow().channel).toEqual({ channel: 43, ticket: "cd".repeat(16) })
  })

  it("ignores a page that was in flight across the reconnect", () => {
    const { send, sent } = recorder()
    loadFirstPage(send)
    const before = (sent[0] as { request: number }).request
    clipReady(43, "cd".repeat(16))
    clipHistory(before, [entry(9)], false)
    expect(clipStateNow().items).toEqual([])
  })
})

describe("what can be saved to this device", () => {
  it("offers an image copied on the machine, which is not a file anywhere", () => {
    // The one people most want to save. It lives only on the clipboard, so
    // it has no path, and requiring one left it with no Download button.
    expect(savable(entry(1, { kind: "image", mime: "image/png", path: null }))).toBe(true)
  })

  it("offers a single file", () => {
    expect(savable(entry(2, { kind: "files", path: "/home/u/notes.md" }))).toBe(true)
  })

  it("does not offer a list of several files, having nothing single to link to", () => {
    expect(savable(entry(3, { kind: "files", path: null }))).toBe(false)
  })

  it("does not offer text, which is what Copy here is for", () => {
    expect(savable(entry(4))).toBe(false)
  })
})

describe("a session that comes back", () => {
  it("re-queues a send that was in flight, on the new channel", async () => {
    // A clipboard channel dies with its session, so the ticket a paused
    // transfer holds is already dead. Without this the row sat at 0% for
    // ever, waiting on a socket that could never be authorised again.
    const { sendFiles, clipStateNow: now } = await import("../src/lib/clipboard")
    sendFiles([new File(["some bytes"], "photo.png", { type: "image/png" })])
    expect(now().outgoing[0]?.status).toBe("waiting")

    clipReady(1, "ef".repeat(16))
    expect(now().outgoing).toHaveLength(1)
    expect(now().outgoing[0]?.name).toBe("photo.png")
    expect(now().outgoing[0]?.written).toBe(0)
  })

  it("does not carry finished rows across", () => {
    clipReady(2, "ef".repeat(16))
    expect(clipStateNow().outgoing).toEqual([])
  })
})

describe("permission", () => {
  it("has no channel at all for a session that may only watch", () => {
    // The engine sends `clipReady` only to a session that may interact, so
    // a view-only one never leaves this state and the panel says so.
    clipReset()
    expect(clipStateNow().channel).toBeNull()
  })
})
