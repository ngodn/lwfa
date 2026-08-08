/**
 * The upload channel: this device's files, streamed to the machine.
 *
 * # The channel
 *
 * One WebSocket per open dialog, separate from the session socket on
 * purpose: the session socket carries video, audio and input, all latency
 * sensitive, and a large file queued on it would either stutter the stream
 * or starve behind it. Two TCP connections let the kernel schedule both
 * fairly. The socket authenticates with the dialog's one-shot ticket, so
 * the stored password never appears in this URL.
 *
 * # The transfer, honestly measured
 *
 * For each file: `uploadBegin` announces it, the engine answers
 * `uploadOffset` with how much it already has (zero, or the survivor of a
 * dropped connection), the bytes stream from that offset as binary
 * frames, and `uploadEnd` carries the SHA-256 of the whole file. Progress
 * shown to the human is `uploadProgress`, which counts bytes the engine
 * wrote to disk; bytes this side pushed into the socket are not progress,
 * they are hope, and on a fast LAN the two disagree by the entire file.
 *
 * The digest is computed while reading, with a streaming hasher, because
 * `crypto.subtle.digest` wants the whole file in memory and a 2GB video
 * from the Files app does not fit there.
 *
 * # When the network goes away
 *
 * The socket dying mid-file marks the current row "paused" and retries on
 * a backoff, for as long as the dialog is open. On reconnect the same
 * file id is announced again, the engine answers with the offset it kept,
 * the local prefix is re-hashed (the checksum covers the whole file, not
 * one connection's share), and the stream continues where it stopped. The
 * session socket's own reconnect is unrelated: this channel neither
 * notices nor cares.
 */

import { sha256 } from "@noble/hashes/sha2.js"
import { decodeToShell, encode, type ToShell } from "@lwfa/proto"
import { engineFor } from "@/lib/engineUrl"
import * as store from "@/lib/fileDialog"
import { log } from "@/lib/log"

/** Bytes per binary frame. Big enough to amortise per-frame cost, small
 * enough that backpressure reacts within a frame or two. */
const CHUNK = 256 * 1024

/** Stop feeding the socket when this much is queued locally unsent. */
const HIGH_WATER = 4 * 1024 * 1024

/** How long to wait for the buffer to drain before checking again. */
const DRAIN_POLL_MS = 30

/** Reconnect backoff bounds, same shape as the session socket's. */
const RETRY_MIN_MS = 500
const RETRY_MAX_MS = 5000

interface Pending {
  resolve: (message: ToShell) => void
  reject: (reason: Error) => void
}

/** One dialog's uploader. Create with {@link uploaderFor}. */
export class Uploader {
  readonly #request: number
  readonly #ticket: string
  #socket: WebSocket | null = null
  #queue: store.UploadRow[] = []
  #running = false
  #aborted = false
  #retryMs = RETRY_MIN_MS
  /** The reply the state machine is waiting for, keyed by message type. */
  #pending = new Map<string, Pending>()

  constructor(request: number, ticket: string) {
    this.#request = request
    this.#ticket = ticket
  }

  /** Queue files picked from this device. Upload runs one at a time. */
  send(rows: store.UploadRow[]): void {
    if (this.#aborted) return
    this.#queue.push(...rows)
    if (!this.#running) {
      this.#running = true
      void this.#run()
    }
  }

  /** True while anything is announced but not yet done or failed. */
  get busy(): boolean {
    return this.#running
  }

  /** The dialog is over; stop everything and let the engine clean up. */
  abort(): void {
    this.#aborted = true
    this.#queue = []
    this.#failPending(new Error("dialog closed"))
    this.#socket?.close()
    this.#socket = null
  }

  async #run(): Promise<void> {
    try {
      while (this.#queue.length > 0 && !this.#aborted) {
        const row = this.#queue[0]
        if (!row) break
        const done = await this.#sendOne(row)
        if (done) this.#queue.shift()
        // Not done means the socket died: pause, back off, try again with
        // the same row. The engine kept the bytes it verified.
        if (!done) {
          if (this.#aborted) break
          store.updateUpload(this.#request, row.id, { status: "paused", speed: undefined })
          store.setChannel(this.#request, "paused")
          await sleep(this.#retryMs)
          this.#retryMs = Math.min(this.#retryMs * 2, RETRY_MAX_MS)
        }
      }
    } finally {
      this.#running = false
      if (!this.#aborted) store.setChannel(this.#request, "idle")
      this.#socket?.close()
      this.#socket = null
    }
  }

  /** One file, one attempt. False means retry the same file. */
  async #sendOne(row: store.UploadRow): Promise<boolean> {
    let socket: WebSocket
    try {
      socket = await this.#connect()
    } catch {
      return this.#aborted // aborted reads as done so the loop exits
    }

    try {
      store.updateUpload(this.#request, row.id, { status: "sending", error: undefined })

      const offsetReply = await this.#ask(socket, "uploadOffset", {
        type: "uploadBegin",
        request: this.#request,
        file: row.id,
        name: row.name,
        rel: row.rel,
        size: row.size,
      })
      if (offsetReply.type !== "uploadOffset") return true
      const offset = offsetReply.offset
      store.updateUpload(this.#request, row.id, { written: offset })

      // The hash covers the whole file, so a resumed transfer re-reads the
      // part the engine already has. Local disk, so this is fast relative
      // to the network it saves.
      const hasher = sha256.create()
      if (offset > 0) {
        await feed(row.handle.slice(0, offset), (bytes) => hasher.update(bytes))
      }

      const reader = row.handle.slice(offset).stream().getReader()
      try {
        for (;;) {
          if (this.#aborted || socket.readyState !== WebSocket.OPEN) return this.#aborted
          const { done, value } = await reader.read()
          if (done) break
          hasher.update(value)
          for (let at = 0; at < value.byteLength; at += CHUNK) {
            const slice = value.subarray(at, Math.min(at + CHUNK, value.byteLength))
            while (socket.bufferedAmount > HIGH_WATER) {
              if (this.#aborted || socket.readyState !== WebSocket.OPEN) return this.#aborted
              await sleep(DRAIN_POLL_MS)
            }
            socket.send(slice)
          }
        }
      } finally {
        reader.releaseLock()
      }

      const digest = toHex(hasher.digest())
      const doneReply = await this.#ask(socket, "uploadDone", {
        type: "uploadEnd",
        request: this.#request,
        file: row.id,
        sha256: digest,
      })
      if (doneReply.type !== "uploadDone") return true
      if (doneReply.ok) {
        store.updateUpload(this.#request, row.id, {
          status: "done",
          written: row.size,
          finalName: doneReply.name,
          speed: undefined,
        })
        this.#retryMs = RETRY_MIN_MS
      } else {
        // The engine said no: size mismatch, checksum, disk. Retrying will
        // not change the answer, so the row fails and the human decides.
        store.updateUpload(this.#request, row.id, {
          status: "failed",
          error: doneReply.error ?? "failed on the machine",
          speed: undefined,
        })
        log("warn", `upload of ${row.name} failed: ${doneReply.error ?? "unknown"}`)
      }
      return true
    } catch (err) {
      // Socket death mid-file. The caller pauses and retries.
      log("info", `upload of ${row.name} interrupted: ${(err as Error).message}`)
      return false
    }
  }

  /** Send a control message and await one reply of the expected type. */
  #ask(
    socket: WebSocket,
    expect: "uploadOffset" | "uploadDone",
    message: Parameters<typeof encode>[0],
  ): Promise<ToShell> {
    return new Promise<ToShell>((resolve, reject) => {
      this.#pending.set(expect, { resolve, reject })
      socket.send(encode(message))
    })
  }

  #failPending(reason: Error): void {
    for (const [, waiter] of this.#pending) waiter.reject(reason)
    this.#pending.clear()
  }

  async #connect(): Promise<WebSocket> {
    const existing = this.#socket
    if (existing && existing.readyState === WebSocket.OPEN) return existing
    if (this.#aborted) throw new Error("dialog closed")

    store.setChannel(this.#request, "connecting")
    const base = engineFor(location, location.search)
    const url = `${base.replace(/\/$/, "")}/upload?request=${this.#request}&ticket=${this.#ticket}`

    const socket = new WebSocket(url)
    socket.binaryType = "arraybuffer"
    this.#socket = socket
    socket.onmessage = (event) => this.#onMessage(event)
    socket.onclose = () => {
      if (this.#socket === socket) this.#socket = null
      this.#failPending(new Error("upload channel closed"))
    }

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error("upload channel refused"))
    })
    store.setChannel(this.#request, "open")
    return socket
  }

  #onMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") return
    let message: ToShell
    try {
      message = decodeToShell(event.data)
    } catch (err) {
      log("warn", `upload channel sent something unreadable: ${(err as Error).message}`)
      return
    }
    switch (message.type) {
      case "uploadProgress": {
        const row = store
          .dialogNow(this.#request)
          ?.uploads.find((r) => r.id === message.file)
        if (!row) break
        const speed = speedOf(row, message.written)
        store.updateUpload(this.#request, message.file, {
          written: message.written,
          ...(speed !== undefined ? { speed } : {}),
        })
        break
      }
      case "uploadOffset":
      case "uploadDone": {
        const waiter = this.#pending.get(message.type)
        if (waiter) {
          this.#pending.delete(message.type)
          waiter.resolve(message)
        }
        break
      }
      default:
        break
    }
  }
}

const uploaders = new Map<number, Uploader>()

/** The uploader for a dialog, created on first use. */
export function uploaderFor(request: number, ticket: string): Uploader {
  let uploader = uploaders.get(request)
  if (!uploader) {
    uploader = new Uploader(request, ticket)
    uploaders.set(request, uploader)
  }
  return uploader
}

/** The dialog ended; stop its uploader if one exists. */
export function dropUploader(request: number): void {
  uploaders.get(request)?.abort()
  uploaders.delete(request)
}

/** Wrap picked `File`s into rows the store and uploader share. */
export function rowsFor(files: File[]): store.UploadRow[] {
  return files.map((file) => {
    const rel = relativePathOf(file)
    return {
      id: freshId(),
      handle: file,
      name: rel.at(-1) ?? file.name,
      rel: rel.slice(0, -1),
      size: file.size,
      written: 0,
      status: "waiting" as const,
    }
  })
}

/**
 * `webkitRelativePath` is set for folder picks and empty otherwise. Split
 * and cleaned here so the rest of the pipeline never sees a raw path.
 */
function relativePathOf(file: File): string[] {
  const raw = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? ""
  const parts = raw.split("/").filter((part) => part && part !== "." && part !== "..")
  return parts.length > 0 ? parts : [file.name]
}

/** Random, opaque, and filesystem-safe: the engine checks the alphabet. */
function freshId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Pump a Blob through a callback in stream order. */
async function feed(blob: Blob, take: (bytes: Uint8Array) => void): Promise<void> {
  const reader = blob.stream().getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      take(value)
    }
  } finally {
    reader.releaseLock()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Speed, from engine acks
//
// Kept outside the store: the store holds what renders, and a rolling
// window of (time, bytes) samples does not render.
// ---------------------------------------------------------------------------

const speedWindows = new Map<string, { at: number; written: number }[]>()

function speedOf(row: store.UploadRow, written: number): number | undefined {
  const now = performance.now()
  const samples = speedWindows.get(row.id) ?? []
  samples.push({ at: now, written })
  // A three-second window: long enough to be steady, short enough to react
  // when the network changes underfoot.
  while (samples.length > 1 && now - (samples[0]?.at ?? now) > 3000) samples.shift()
  speedWindows.set(row.id, samples)
  if (samples.length < 2) return undefined
  const first = samples[0]
  if (!first) return undefined
  const seconds = (now - first.at) / 1000
  if (seconds <= 0) return undefined
  return Math.max(0, (written - first.written) / seconds)
}
