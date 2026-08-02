/**
 * The file dialog's state: what an application asked for, and how it is
 * being answered.
 *
 * # Where this sits
 *
 * An application on the desktop opened a file dialog; the engine, being the
 * machine's portal backend, forwarded it here (see `portal.rs` and the
 * `fileChooser` message). This store holds the one active request, the
 * directory listing its browser is showing, and the progress of uploads from
 * this device. `FileDialog.tsx` renders it; `App` feeds it from the message
 * stream.
 *
 * One request at a time on purpose: the engine's portal answers dialogs
 * serially because a human does, so a second request while one is open
 * simply queues behind it on the engine side.
 *
 * # Uploads
 *
 * A file from this device is streamed up the socket in tagged binary chunks
 * (see `FILE_TAG`), paced by the socket's own `bufferedAmount` so a large
 * file cannot bury the input channel the user is still typing on: the mic
 * and the keyboard share that socket, and an upload is the lowest-priority
 * thing on it.
 */

import { useSyncExternalStore } from "react"
import { FILE_TAG, type DirEntry, type ToShell } from "@lwfa/proto"

/** One upload row in the dialog: pending until the engine confirms. */
export interface UploadRow {
  name: string
  /** Total bytes, for the progress readout. */
  size: number
  /** Bytes accepted by the socket so far. */
  sent: number
  /** Undefined while in flight; the engine's verdict when done. */
  ok?: boolean
}

export interface ActiveFileRequest {
  request: number
  save: boolean
  multiple: boolean
  directory: boolean
  title: string
  suggestedName: string | null
  /** The listing the browser pane is showing, when one has arrived. */
  listing: { path: string; entries: DirEntry[]; error: string | null } | null
  uploads: UploadRow[]
  /** True while a chosen upload is still streaming up the socket. */
  uploading: boolean
}

let active: ActiveFileRequest | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): ActiveFileRequest | null => active

export function useFileRequest(): ActiveFileRequest | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Feed one message from the engine. Returns true when it was consumed. */
export function fileMessage(message: ToShell): boolean {
  switch (message.type) {
    case "fileChooser":
      active = {
        request: message.request,
        save: message.save,
        multiple: message.multiple,
        directory: message.directory,
        title: message.title,
        suggestedName: message.suggestedName,
        listing: null,
        uploads: [],
        uploading: false,
      }
      emit()
      return true
    case "dirListing":
      if (active?.request === message.request) {
        active = {
          ...active,
          listing: { path: message.path, entries: message.entries, error: message.error },
        }
        emit()
      }
      return true
    case "uploaded":
      if (active?.request === message.request) {
        // Positional, not by name: uploads within a request are strictly
        // sequential, and the engine's name is the *final* one, which
        // differs from ours whenever a collision was renamed. Matching on
        // names left a renamed upload "Sending…" forever.
        const index = active.uploads.findIndex((row) => row.ok === undefined)
        active = {
          ...active,
          uploads: active.uploads.map((row, i) =>
            i === index
              ? { ...row, name: message.name || row.name, ok: message.ok, sent: row.size }
              : row,
          ),
        }
        emit()
      }
      return true
    default:
      return false
  }
}

/** The dialog is over, answered or not. Also called on disconnect. */
export function clearFileRequest(): void {
  if (active === null) return
  active = null
  emit()
}

/** What the upload loop needs from the connection, without importing it. */
export interface UploadSink {
  sendBinary(data: Uint8Array): void
  bufferedAmount(): number
}

/** Bytes per binary message. Small enough to interleave with input. */
const CHUNK = 64 * 1024

/** Pause the upload while more than this much is queued unsent. */
const HIGH_WATER = 512 * 1024

/** Publish progress at most this often: smooth enough, cheap enough. */
const PROGRESS_EVERY_MS = 200

/**
 * Stream one file up the socket under the active request.
 *
 * Announce, chunks, done: see the protocol docs. Paced by `bufferedAmount`
 * so the socket's queue stays shallow enough for keystrokes to interleave.
 *
 * Streamed off the file, never loaded whole: a screen recording from a
 * phone is hundreds of megabytes, and `arrayBuffer()` on that either
 * stalls the tab or gets the page killed on exactly the devices this
 * feature exists for. Progress is published as bytes go, because a
 * megabyte-a-second upload with no counter is indistinguishable from a
 * hang, and was reported as one.
 */
export async function uploadFile(
  sink: UploadSink,
  send: (message: { type: "fileUpload"; request: number; name: string; size: number } | { type: "fileUploadDone"; request: number }) => void,
  request: number,
  file: File,
): Promise<void> {
  if (active?.request !== request) return
  active = {
    ...active,
    uploads: [...active.uploads, { name: file.name, size: file.size, sent: 0 }],
    uploading: true,
  }
  const row = active.uploads.length - 1
  emit()

  send({ type: "fileUpload", request, name: file.name, size: file.size })

  const header = new Uint8Array(9)
  header[0] = FILE_TAG
  new DataView(header.buffer).setBigUint64(1, BigInt(request), true)

  let sent = 0
  let published = 0
  const progress = (force: boolean) => {
    const now = Date.now()
    if (!force && now - published < PROGRESS_EVERY_MS) return
    published = now
    if (active?.request !== request) return
    active = {
      ...active,
      uploads: active.uploads.map((r, i) => (i === row ? { ...r, sent } : r)),
    }
    emit()
  }

  const ship = async (bytes: Uint8Array): Promise<boolean> => {
    // Backpressure: the socket also carries the user's keystrokes.
    while (sink.bufferedAmount() > HIGH_WATER) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (active?.request !== request) return false // dialog closed mid-upload
    }
    const framed = new Uint8Array(header.length + bytes.length)
    framed.set(header)
    framed.set(bytes, header.length)
    sink.sendBinary(framed)
    sent += bytes.length
    progress(false)
    return true
  }

  if (typeof file.stream === "function") {
    const reader = file.stream().getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        // Re-chunked: the reader hands whatever it likes, the wire wants
        // pieces small enough to interleave with input.
        for (let offset = 0; offset < value.byteLength; offset += CHUNK) {
          const slice = value.subarray(offset, Math.min(offset + CHUNK, value.byteLength))
          if (!(await ship(slice))) return
        }
      }
    } finally {
      reader.releaseLock()
    }
  } else {
    // The one environment without Blob.stream gets the memory-hungry path
    // rather than no path.
    const buffer = await file.arrayBuffer()
    for (let offset = 0; offset < buffer.byteLength; offset += CHUNK) {
      const slice = new Uint8Array(buffer, offset, Math.min(CHUNK, buffer.byteLength - offset))
      if (!(await ship(slice))) return
    }
  }

  progress(true)
  send({ type: "fileUploadDone", request })

  if (active?.request === request) {
    active = { ...active, uploading: false }
    emit()
  }
}
