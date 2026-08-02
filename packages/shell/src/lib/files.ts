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
        active = {
          ...active,
          uploads: active.uploads.map((row) =>
            row.ok === undefined && row.name === message.name ? { ...row, ok: message.ok } : row,
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

/**
 * Stream one file up the socket under the active request.
 *
 * Announce, chunks, done: see the protocol docs. Paced by `bufferedAmount`
 * so the socket's queue stays shallow enough for keystrokes to interleave.
 */
export async function uploadFile(
  sink: UploadSink,
  send: (message: { type: "fileUpload"; request: number; name: string; size: number } | { type: "fileUploadDone"; request: number }) => void,
  request: number,
  file: File,
): Promise<void> {
  if (active?.request !== request) return
  active = { ...active, uploads: [...active.uploads, { name: file.name }], uploading: true }
  emit()

  send({ type: "fileUpload", request, name: file.name, size: file.size })

  const header = new Uint8Array(9)
  header[0] = FILE_TAG
  new DataView(header.buffer).setBigUint64(1, BigInt(request), true)

  const buffer = await file.arrayBuffer()
  for (let offset = 0; offset < buffer.byteLength; offset += CHUNK) {
    // Backpressure: the socket also carries the user's keystrokes.
    while (sink.bufferedAmount() > HIGH_WATER) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (active?.request !== request) return // dialog closed mid-upload
    }
    const slice = new Uint8Array(buffer, offset, Math.min(CHUNK, buffer.byteLength - offset))
    const framed = new Uint8Array(header.length + slice.length)
    framed.set(header)
    framed.set(slice, header.length)
    sink.sendBinary(framed)
  }
  send({ type: "fileUploadDone", request })

  if (active?.request === request) {
    active = { ...active, uploading: false }
    emit()
  }
}
