/**
 * The clipboard, as this device sees it.
 *
 * # What lives here
 *
 * The engine owns the history and keeps three clipboards in step (the
 * windows in this session, the desktop the machine is running, and this
 * device). This store holds one page of that history at a time, the
 * credential for fetching entry bytes, and the state of anything being sent
 * the other way. A store rather than component state because the panel is
 * unmounted every time the sheet closes, and nothing here should be
 * refetched because somebody looked away.
 *
 * # What this device can and cannot do
 *
 * Reading this device's clipboard unprompted is not possible and will not
 * become possible: `clipboard-read` is a permission Safari does not
 * implement and has said it will not. So sending from here always hangs off
 * a deliberate tap, which is also why the panel offers a paste box: the tap
 * route reaches text and images, and the paste box reaches everything else,
 * files included.
 *
 * Writing is the same story in reverse. Putting an entry on this device's
 * clipboard has to happen inside the click that asked for it, which is why
 * {@link copyToDevice} builds its `ClipboardItem` synchronously around a
 * promise: awaiting the fetch first loses the user gesture, and Safari then
 * refuses the write.
 */

import { useSyncExternalStore } from "react"
import type { ClipItem, ToEngine } from "@lwfa/proto"
import { engineFor } from "@/lib/engineUrl"
import { log } from "@/lib/log"
import { rowsFor, uploaderFor, dropUploader, type UploadSink } from "@/lib/upload"
import type { UploadRow } from "@/lib/fileDialog"

/** How many rows a page holds. */
export const PAGE = 20

/** One file on its way from this device to the machine. */
export interface Outgoing {
  id: string
  name: string
  size: number
  written: number
  status: "waiting" | "sending" | "paused" | "done" | "failed"
  error?: string | undefined
  speed?: number | undefined
}

export interface ClipState {
  /** The upload channel and ticket, once the engine has offered them. */
  channel: { channel: number; ticket: string } | null
  items: ClipItem[]
  /** Whether anything older than the last row exists. */
  more: boolean
  /** The first page is on its way and there is nothing to show yet. */
  loading: boolean
  /** Another page is on its way, under rows that are already showing. */
  paging: boolean
  /** Something this device tried to do, and could not. */
  error: string | null
  /** Files going the other way, newest first. */
  outgoing: Outgoing[]
}

const EMPTY: ClipState = {
  channel: null,
  items: [],
  more: false,
  loading: false,
  paging: false,
  error: null,
  outgoing: [],
}

let state: ClipState = EMPTY
const listeners = new Set<() => void>()

/** The page request outstanding, so a stale answer can be ignored. */
let awaiting: number | null = null
let nextRequest = 1

/**
 * The file handles behind the rows above, kept for a reconnect.
 *
 * A clipboard channel dies with its session, so a file half-sent when the
 * network blips cannot resume on the ticket it started with. The browser
 * still holds the `File`, though, so the transfer is re-queued on the new
 * channel instead of sitting paused forever waiting for a socket that will
 * never come back. Which is precisely the case this has to survive: a
 * tablet on a mobile connection, sending something large.
 */
const handles = new Map<string, UploadRow>()

function set(change: Partial<ClipState>): void {
  state = { ...state, ...change }
  for (const listener of listeners) listener()
}

// ---------------------------------------------------------------------------
// What the engine says
// ---------------------------------------------------------------------------

/**
 * The session is up and may use the clipboard.
 *
 * Everything held is dropped rather than kept. A new channel means a new
 * connection, and possibly a restarted engine, in which case the ids this
 * device is holding name entries that no longer exist.
 */
export function clipReady(channel: number, ticket: string): void {
  const previous = state.channel?.channel
  awaiting = null
  // Both, because a restarted engine mints ids from one again: the old
  // uploader would otherwise be found by id and reused with a ticket that
  // died with the last connection, and every send would pause at 0%.
  if (previous !== undefined) dropUploader(previous)
  dropUploader(channel)

  const unfinished = state.outgoing.filter(
    (row) => row.status !== "done" && row.status !== "failed",
  )
  set({
    ...EMPTY,
    channel: { channel, ticket },
    outgoing: unfinished.map((row) => ({ ...row, written: 0, status: "waiting" as const })),
  })
  for (const id of handles.keys()) {
    if (!unfinished.some((row) => row.id === id)) handles.delete(id)
  }

  const resume = unfinished.map((row) => handles.get(row.id)).filter((row) => row !== undefined)
  if (resume.length > 0) uploaderFor(channel, ticket, sink).send(resume)
}

/**
 * Something was copied, or an entry was put back on the clipboard.
 *
 * One message covers both, so an entry already held is removed before this
 * one goes on top rather than appearing twice.
 */
export function clipAdded(item: ClipItem): void {
  set({ items: [item, ...state.items.filter((held) => held.id !== item.id)] })
}

export function clipDropped(id: number): void {
  set({ items: state.items.filter((item) => item.id !== id) })
}

export function clipCleared(): void {
  set({ items: [], more: false })
}

export function clipHistory(request: number, items: ClipItem[], more: boolean): void {
  // A page nobody is waiting for answers a request this device has since
  // replaced. Appending it would repeat rows.
  if (awaiting !== request) return
  awaiting = null
  const known = new Set(state.items.map((item) => item.id))
  set({
    items: [...state.items, ...items.filter((item) => !known.has(item.id))],
    more,
    loading: false,
    paging: false,
  })
}

/** The session went away. The ticket it carried is already dead. */
export function clipReset(): void {
  if (state.channel) dropUploader(state.channel.channel)
  handles.clear()
  awaiting = null
  state = EMPTY
  for (const listener of listeners) listener()
}

export function clipError(message: string): void {
  set({ error: message })
}

// ---------------------------------------------------------------------------
// What this device asks for
// ---------------------------------------------------------------------------

type Send = (message: ToEngine) => void

/** The newest page, replacing whatever is held. */
export function loadFirstPage(send: Send): void {
  const request = nextRequest++
  awaiting = request
  set({ items: [], more: false, loading: true, paging: false, error: null })
  send({ type: "clipList", request, before: null, limit: PAGE })
}

/** One page older, under the rows already showing. */
export function loadMore(send: Send): void {
  const oldest = state.items.at(-1)
  if (!oldest || state.paging || state.loading) return
  const request = nextRequest++
  awaiting = request
  set({ paging: true })
  send({ type: "clipList", request, before: oldest.id, limit: PAGE })
}

/**
 * Put text from this device on the machine's clipboard.
 *
 * Sent exactly as it is. Not trimmed: indentation is meaningful in the
 * thing people most often copy across, which is code.
 */
export function sendText(send: Send, text: string): void {
  if (text.trim().length === 0) return
  set({ error: null })
  send({ type: "clipSetText", text })
}

/**
 * Send files from this device. They land in `~/Uploads` and go on the
 * machine's clipboard as each one arrives whole.
 *
 * On the upload channel rather than the session socket, so a 300MB video
 * does not stall the picture. See `lib/upload.ts`.
 */
export function sendFiles(files: File[]): void {
  const open = state.channel
  if (!open) {
    clipError("Not connected to the machine.")
    return
  }
  if (files.length === 0) return

  const rows = rowsFor(files)
  for (const row of rows) handles.set(row.id, row)
  set({
    error: null,
    outgoing: [
      ...rows.map((row) => ({
        id: row.id,
        name: row.name,
        size: row.size,
        written: 0,
        status: "waiting" as const,
      })),
      ...state.outgoing,
    ],
  })
  uploaderFor(open.channel, open.ticket, sink).send(rows)
}

/** Stop showing a finished or failed row. */
export function dismissOutgoing(id: string): void {
  handles.delete(id)
  set({ outgoing: state.outgoing.filter((row) => row.id !== id) })
}

/**
 * Where the uploader reports when the clipboard asked for the transfer.
 *
 * These rows are the panel's own rather than a dialog's, so only the fields
 * this store shows are carried across.
 */
const sink: UploadSink = {
  update(file, change) {
    if (change.status === "done") handles.delete(file)
    set({
      outgoing: state.outgoing.map((row) =>
        row.id === file
          ? {
              ...row,
              ...(change.written !== undefined ? { written: change.written } : {}),
              ...(change.status !== undefined ? { status: change.status } : {}),
              ...(change.speed !== undefined ? { speed: change.speed } : {}),
              ...(change.error !== undefined ? { error: change.error } : {}),
              ...(change.finalName !== undefined ? { name: change.finalName } : {}),
            }
          : row,
      ),
    })
  },
  channel() {
    // Each file shows its own state, which says more than one word about
    // the socket underneath all of them.
  },
  row(file) {
    const held = state.outgoing.find((row) => row.id === file)
    // The uploader wants a row shaped like a dialog's, and reads only the
    // byte count, for the transfer-rate estimate.
    return held ? ({ id: held.id, size: held.size, written: held.written } as never) : undefined
  },
}

// ---------------------------------------------------------------------------
// Fetching bytes
// ---------------------------------------------------------------------------

/** What an entry's bytes are wanted for. */
export type Fetch = "raw" | "thumb" | "download"

/**
 * The URL an entry's bytes live at, or `null` before the channel exists.
 *
 * An ordinary `http` GET rather than the session socket: a browser can put
 * this in an `<img>` and stream a large file straight to disk, and neither
 * costs the video a frame. See `clipserve.rs`.
 */
export function clipUrl(id: number, want: Fetch = "raw"): string | null {
  const open = state.channel
  if (!open) return null
  const base = engineFor(location, location.search)
    .replace(/^ws/, "http")
    .replace(/\/$/, "")
  const extra = want === "thumb" ? "&thumb=1" : want === "download" ? "&download=1" : ""
  return `${base}/clip?channel=${open.channel}&ticket=${encodeURIComponent(open.ticket)}&id=${id}${extra}`
}

/**
 * Whether an entry has one thing worth saving to this device.
 *
 * An image always has: a screenshot copied on the machine lives only on the
 * clipboard, with no path, and gating on a path left the one thing people
 * most want to save with no way to save it. A list of several files is the
 * exception, because there is no single thing for the link to be.
 */
export function savable(item: ClipItem): boolean {
  return item.kind === "image" || item.path !== null
}

/**
 * Put an entry on *this device's* clipboard.
 *
 * Must be called from inside the click that asked for it. The
 * `ClipboardItem` is built synchronously around a promise rather than after
 * an `await`, because Safari checks that the write still belongs to a user
 * gesture and an awaited fetch has already lost it.
 *
 * Text short enough to have travelled with the row needs no fetch at all,
 * which is the common case and the fast one on a slow link.
 */
export async function copyToDevice(item: ClipItem): Promise<void> {
  if (item.kind === "text" && item.whole) {
    await navigator.clipboard.writeText(item.preview)
    return
  }

  const url = clipUrl(item.id)
  if (!url) throw new Error("not connected")

  // PNG is the one image type every browser accepts on a clipboard, and
  // Safari rejects the rest outright, so anything else goes as text below.
  if (item.kind === "image" && item.mime === "image/png" && typeof ClipboardItem !== "undefined") {
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": fetch(url).then((response) => response.blob()) }),
    ])
    return
  }

  // Everything else crosses as text: the whole of a long text entry, or a
  // file's path, which is what pasting a file into a text field does on the
  // machine too.
  const response = await fetch(url)
  if (!response.ok) throw new Error(`the machine answered ${response.status}`)
  await navigator.clipboard.writeText(await response.text())
}

/** What {@link sendDeviceClipboard} managed to find. */
export type Sent = "text" | "image" | "nothing"

/**
 * Read this device's clipboard and send what is on it.
 *
 * Triggers the browser's own paste confirmation, which is the price of
 * reading a clipboard this page did not write. Returns what was sent, so
 * the panel can say something more useful than "done".
 */
export async function sendDeviceClipboard(send: Send): Promise<Sent> {
  // The rich read first: it is the only one that reaches an image, and the
  // one Safari implements least completely, so failing it falls through
  // rather than giving up.
  if (navigator.clipboard?.read) {
    try {
      const contents = await navigator.clipboard.read()
      for (const entry of contents) {
        const image = entry.types.find((type) => type.startsWith("image/"))
        if (image) {
          const blob = await entry.getType(image)
          const name = `pasted-${stamp()}.${image.split("/")[1] ?? "png"}`
          sendFiles([new File([blob], name, { type: image })])
          return "image"
        }
      }
      for (const entry of contents) {
        if (entry.types.includes("text/plain")) {
          const text = await (await entry.getType("text/plain")).text()
          if (text) {
            sendText(send, text)
            return "text"
          }
        }
      }
    } catch (err) {
      log("info", `rich clipboard read declined: ${(err as Error).message}`)
    }
  }

  const text = await navigator.clipboard.readText()
  if (!text) return "nothing"
  sendText(send, text)
  return "text"
}

/** A filename-safe timestamp, for things pasted in with no name of their own. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19)
}

// ---------------------------------------------------------------------------
// Reading the store
// ---------------------------------------------------------------------------

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): ClipState => state

export function useClipboard(): ClipState {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** For tests. */
export function clipStateNow(): ClipState {
  return state
}
