/**
 * WebSocket link to the engine.
 *
 * Thin on purpose: decode, hand off, reconnect. It holds no layout state, so
 * the strip logic stays pure and testable (see `strip.ts`).
 */

import {
  PROTOCOL_VERSION,
  ProtocolError,
  decodeToShell,
  encode,
  type ToEngine,
  type ToShell,
} from "@lwfa/proto"

export type Status = "connecting" | "connected" | "disconnected" | "incompatible"

export interface ConnectionHandlers {
  onMessage: (message: ToShell) => void
  onStatus: (status: Status, detail?: string) => void
}

/** Backoff bounds for reconnecting. */
const RECONNECT_MIN_MS = 250
const RECONNECT_MAX_MS = 5_000

export class Connection {
  #url: string
  #handlers: ConnectionHandlers
  #socket: WebSocket | null = null
  #retryMs = RECONNECT_MIN_MS
  #timer: ReturnType<typeof setTimeout> | null = null
  #closed = false

  constructor(url: string, handlers: ConnectionHandlers) {
    this.#url = url
    this.#handlers = handlers
  }

  connect(): void {
    if (this.#closed) return
    this.#handlers.onStatus("connecting")

    const socket = new WebSocket(this.#url)
    this.#socket = socket

    socket.onopen = () => {
      this.#retryMs = RECONNECT_MIN_MS
      // Not "connected" yet: the engine's Hello decides that, since a version
      // mismatch means an open socket we must not drive.
    }

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        // v0 is JSON text only. Binary frames are reserved for per-surface
        // video in milestone 4 and are not expected here.
        console.warn("ignoring a non-text frame from the engine")
        return
      }

      let message: ToShell
      try {
        message = decodeToShell(event.data)
      } catch (err) {
        // Loud, not silent. A message the shell cannot parse means the two
        // sides disagree about the protocol, which is exactly the failure the
        // parity tests exist to prevent reaching here.
        const detail = err instanceof ProtocolError ? err.message : String(err)
        console.error("undecodable message from engine:", detail, event.data)
        return
      }

      if (message.type === "hello") {
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          const detail = `engine speaks protocol ${message.protocolVersion}, shell speaks ${PROTOCOL_VERSION}`
          console.error(detail)
          this.#handlers.onStatus("incompatible", detail)
          // Refuse to drive rather than mislay windows against a protocol we do
          // not understand.
          socket.close()
          return
        }
        this.#handlers.onStatus("connected")
      }

      this.#handlers.onMessage(message)
    }

    socket.onclose = () => {
      this.#socket = null
      if (this.#closed) return
      this.#handlers.onStatus("disconnected")
      this.#scheduleReconnect()
    }

    socket.onerror = () => {
      // onclose always follows, so reconnection is handled there.
    }
  }

  #scheduleReconnect(): void {
    if (this.#timer !== null) return
    const delay = this.#retryMs
    this.#retryMs = Math.min(this.#retryMs * 2, RECONNECT_MAX_MS)
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.connect()
    }, delay)
  }

  send(message: ToEngine): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return
    this.#socket.send(encode(message))
  }

  close(): void {
    this.#closed = true
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#socket?.close()
  }
}
