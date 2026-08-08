/**
 * The state of "an application on the desktop is asking for files".
 *
 * # Where this sits
 *
 * The engine's portal forwards an application's file dialog to this shell
 * as a `fileChooser` message; the human answers through the modal in
 * `components/FileDialog.tsx`; uploads ride their own WebSocket, driven by
 * `lib/upload.ts`. This store is the meeting point: the queue of open
 * requests, the remote listing, and the per-file upload rows all live
 * here, so the dialog can render from one snapshot and the uploader can
 * report progress without touching React.
 *
 * # Why a queue rather than one slot
 *
 * The engine allows several applications to ask at once (each is blocked
 * in its own dialog, they do not block each other). One slot would mean a
 * second request silently overwrites the first, orphaning a dialog whose
 * application still waits. The queue shows dialogs one at a time, oldest
 * first, and answering or dismissing one reveals the next.
 *
 * # Reconnects
 *
 * The store is module state, so it survives the session socket dying. The
 * engine re-sends the open dialog when the session comes back (same
 * request id, same ticket); `opened` recognises the id and keeps the
 * existing state, uploads and all. Upload rows themselves live through
 * network trouble because the uploader owns its reconnects; see
 * `lib/upload.ts`.
 */

import { useSyncExternalStore } from "react"
import type { DirEntry, FileChooserMode, FileFilter, ToShell } from "@lwfa/proto"

/** One file being sent from this device, as the dialog shows it. */
export interface UploadRow {
  /** This client's own id for the file, stable across reconnects. */
  id: string
  /** The file handle, kept for resume: re-reading a prefix needs it. */
  handle: File
  name: string
  /** Path inside a picked folder, `[]` for a plain file. */
  rel: string[]
  size: number
  /** Bytes the engine has confirmed written to its disk. */
  written: number
  status: "waiting" | "sending" | "paused" | "done" | "failed"
  /** The final name on the machine, once done. Differs on collision. */
  finalName?: string | undefined
  error?: string | undefined
  /** Smoothed bytes per second, while sending. */
  speed?: number | undefined
}

/** What `fileChooser` carried, minus the wire envelope. */
export interface DialogRequest {
  request: number
  mode: FileChooserMode
  multiple: boolean
  directory: boolean
  title: string
  appId: string
  acceptLabel: string | null
  suggestedName: string | null
  filters: FileFilter[]
  names: string[]
  ticket: string
}

export interface Listing {
  path: string
  entries: DirEntry[]
  truncated: boolean
  error: string | null
}

/** The upload channel's health, for the dialog's banner. */
export type ChannelState = "idle" | "connecting" | "open" | "paused"

export interface DialogState extends DialogRequest {
  /** The remote browse pane's current directory, `null` while loading. */
  listing: Listing | null
  uploads: UploadRow[]
  channel: ChannelState
}

let queue: DialogState[] = []
let version = 0
const listeners = new Set<() => void>()

function emit(): void {
  version += 1
  for (const listener of listeners) listener()
}

/**
 * Mutate one dialog's state in place, immutably enough for React.
 *
 * Rows and dialogs are replaced, not patched, so a memoised component
 * comparing references re-renders exactly when its slice changed.
 */
function patch(request: number, change: (dialog: DialogState) => DialogState): void {
  let touched = false
  queue = queue.map((dialog) => {
    if (dialog.request !== request) return dialog
    touched = true
    return change(dialog)
  })
  if (touched) emit()
}

/** The engine opened (or re-sent) a dialog. */
export function opened(message: Extract<ToShell, { type: "fileChooser" }>): void {
  if (queue.some((dialog) => dialog.request === message.request)) {
    // A reconnected session being shown the same dialog again. The local
    // state, uploads included, is the newer truth; keep it.
    return
  }
  const { type: _type, ...request } = message
  queue = [...queue, { ...request, listing: null, uploads: [], channel: "idle" }]
  emit()
}

/** The dialog is over: answered elsewhere, withdrawn, or expired. */
export function closed(request: number): void {
  const before = queue.length
  queue = queue.filter((dialog) => dialog.request !== request)
  if (queue.length !== before) emit()
}

/** A directory listing arrived for whichever dialog asked. */
export function listed(message: Extract<ToShell, { type: "dirListing" }>): void {
  patch(message.request, (dialog) => ({
    ...dialog,
    listing: {
      path: message.path,
      entries: message.entries,
      truncated: message.truncated,
      error: message.error,
    },
  }))
}

/** The browse pane asked for a directory; show loading until it lands. */
export function loadingListing(request: number): void {
  patch(request, (dialog) => ({ ...dialog, listing: null }))
}

export function addUploads(request: number, rows: UploadRow[]): void {
  patch(request, (dialog) => ({ ...dialog, uploads: [...dialog.uploads, ...rows] }))
}

export function updateUpload(
  request: number,
  id: string,
  change: Partial<UploadRow>,
): void {
  patch(request, (dialog) => ({
    ...dialog,
    uploads: dialog.uploads.map((row) => (row.id === id ? { ...row, ...change } : row)),
  }))
}

export function setChannel(request: number, channel: ChannelState): void {
  patch(request, (dialog) => (dialog.channel === channel ? dialog : { ...dialog, channel }))
}

/** Everything gone, for teardown paths that outlive any one dialog. */
export function clearFileDialogs(): void {
  if (queue.length === 0) return
  queue = []
  emit()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// The version-number snapshot dance, same as lib/pending.ts: the array is
// replaced on every change, but useSyncExternalStore needs a snapshot that
// is referentially stable between changes, which `() => queue` provides
// only as long as nothing mutates it. Version keeps honest people honest.
const snapshot = () => queue

/** The dialog currently shown: the oldest open request, or null. */
export function useActiveFileDialog(): DialogState | null {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot)
  return all[0] ?? null
}

/** How many are waiting behind the active one. */
export function useQueuedFileDialogs(): number {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot)
  return Math.max(0, all.length - 1)
}

/** Read without subscribing. */
export function activeFileDialogNow(): DialogState | null {
  return queue[0] ?? null
}

export function dialogNow(request: number): DialogState | null {
  return queue.find((dialog) => dialog.request === request) ?? null
}

/** For tests. */
export function fileDialogVersion(): number {
  return version
}

/**
 * A human-facing name for a portal app id.
 *
 * `org.gimp.GIMP` should read as "GIMP", `firefox` as "Firefox". Unsandboxed
 * applications often report nothing at all, which becomes "An app".
 */
export function appDisplayName(appId: string): string {
  const last = appId.split(".").filter(Boolean).at(-1) ?? ""
  if (!last) return "An app"
  return last.length <= 3 ? last.toUpperCase() : (last[0] ?? "").toUpperCase() + last.slice(1)
}
