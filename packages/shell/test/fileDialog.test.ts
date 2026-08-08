// The file dialog store: a queue of open requests, one shown at a time.
//
// The behaviours worth pinning are the ones a refactor would break
// silently: a re-sent dialog must not reset local state (that is the
// reconnect path), the queue must reveal the next dialog when one closes,
// and upload rows must update by id without disturbing their neighbours.

import { beforeEach, describe, expect, it } from "vitest"
import type { ToShell } from "@lwfa/proto"
import {
  activeFileDialogNow,
  addUploads,
  appDisplayName,
  clearFileDialogs,
  closed,
  dialogNow,
  listed,
  opened,
  updateUpload,
  type UploadRow,
} from "../src/lib/fileDialog"

function chooser(request: number): Extract<ToShell, { type: "fileChooser" }> {
  return {
    type: "fileChooser",
    request,
    mode: "open",
    multiple: true,
    directory: false,
    title: "Open",
    appId: "org.gimp.GIMP",
    acceptLabel: null,
    suggestedName: null,
    filters: [],
    names: [],
    ticket: "aa".repeat(16),
  }
}

function row(id: string): UploadRow {
  return {
    id,
    handle: new Blob(["x"]) as File,
    name: `${id}.bin`,
    rel: [],
    size: 100,
    written: 0,
    status: "waiting",
  }
}

describe("fileDialog store", () => {
  beforeEach(() => clearFileDialogs())

  it("shows the oldest request and queues the rest", () => {
    opened(chooser(1))
    opened(chooser(2))
    expect(activeFileDialogNow()?.request).toBe(1)
    closed(1)
    expect(activeFileDialogNow()?.request).toBe(2)
  })

  it("keeps local state when the engine re-sends a dialog", () => {
    opened(chooser(1))
    addUploads(1, [row("a")])
    updateUpload(1, "a", { status: "done", finalName: "a-2.bin" })
    // The reconnect path: same request id arrives again.
    opened(chooser(1))
    const dialog = dialogNow(1)
    expect(dialog?.uploads).toHaveLength(1)
    expect(dialog?.uploads[0]?.finalName).toBe("a-2.bin")
  })

  it("updates one upload row without touching the others", () => {
    opened(chooser(1))
    addUploads(1, [row("a"), row("b")])
    updateUpload(1, "b", { written: 50, status: "sending" })
    const uploads = dialogNow(1)?.uploads ?? []
    expect(uploads[0]?.written).toBe(0)
    expect(uploads[1]?.written).toBe(50)
    expect(uploads[1]?.status).toBe("sending")
  })

  it("routes listings to the dialog that asked", () => {
    opened(chooser(1))
    opened(chooser(2))
    listed({
      type: "dirListing",
      request: 2,
      path: "/home/u",
      entries: [{ name: "docs", dir: true, size: 0 }],
      truncated: false,
      error: null,
    })
    expect(dialogNow(1)?.listing).toBeNull()
    expect(dialogNow(2)?.listing?.path).toBe("/home/u")
  })

  it("ignores messages for requests it does not hold", () => {
    opened(chooser(1))
    updateUpload(9, "a", { written: 10 })
    closed(9)
    expect(activeFileDialogNow()?.request).toBe(1)
  })

  it("turns app ids into something a human recognises", () => {
    expect(appDisplayName("org.gimp.GIMP")).toBe("GIMP")
    expect(appDisplayName("firefox")).toBe("Firefox")
    expect(appDisplayName("org.videolan.VLC")).toBe("VLC")
    expect(appDisplayName("")).toBe("An app")
  })
})
