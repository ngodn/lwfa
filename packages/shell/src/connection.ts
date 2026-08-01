/**
 * WebSocket link to the engine.
 *
 * Thin on purpose: decode, hand off, reconnect. It holds no layout state, so
 * the strip logic stays pure and testable (see `strip.ts`).
 */

import {
  PROTOCOL_VERSION,
  ProtocolError,
  type DecodedFrame,
  decodeFrame,
  decodeToShell,
  encode,
  type ToEngine,
  type ToShell,
} from "@lwfa/proto"

/**
 * Close reason the engine sends to a shell a newer one has replaced.
 * Must match `REPLACED_REASON` in `crates/lwfa-engine/src/shell.rs`.
 */
export const REPLACED_REASON = "replaced-by-newer-shell"

export type Status =
  | "connecting"
  | "connected"
  | "disconnected"
  | "incompatible"
  /** A newer shell took over. This one has stopped on purpose. */
  | "replaced"
  /** The engine refused the password. Retrying is pointless until it changes. */
  | "unauthorized"
  /**
   * Could not get past the handshake, and the cause is genuinely unknown:
   * either nothing is listening or the password was refused. See `onclose`.
   */
  | "unreachable"

export interface ConnectionHandlers {
  onMessage: (message: ToShell) => void
  /** A window's pixels. Binary frames, not JSON. */
  onFrame: (frame: DecodedFrame) => void
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
  /**
   * Whether this connection ever completed a handshake.
   *
   * A rejected password and an unreachable engine look identical to a browser:
   * both surface as a generic close with code 1006, because the HTTP status of
   * a failed WebSocket upgrade is deliberately not exposed to script. What
   * *does* distinguish them is whether `hello` ever arrived — the engine sends
   * it immediately on a successful handshake, so a close without one means the
   * upgrade never completed.
   */
  #everGreeted = false

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

    // Binary frames arrive as ArrayBuffer rather than Blob, which avoids an
    // async round trip per frame on the hot path.
    socket.binaryType = "arraybuffer"

    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const frame = decodeFrame(event.data)
        if (!frame) {
          console.warn("dropping an undecodable binary frame")
          return
        }
        this.#handlers.onFrame(frame)
        return
      }
      if (typeof event.data !== "string") {
        console.warn("ignoring an unexpected message type from the engine")
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
        this.#everGreeted = true
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

    socket.onclose = (event) => {
      this.#socket = null
      if (this.#closed) return

      if (event.reason === REPLACED_REASON) {
        // A newer shell took over. Reconnecting would displace it, and it
        // would then displace this one back, forever. Stop instead.
        this.#closed = true
        this.#handlers.onStatus("replaced")
        return
      }

      if (!this.#everGreeted) {
        // Never got past the handshake. Two very different things look
        // identical from here, and the browser will not tell us which:
        //
        //   - the engine refused the password, answering the upgrade with 401
        //   - nothing was listening at all
        //
        // Both surface as a close with no reason and no `onopen`, because a
        // failed WebSocket handshake deliberately hides the HTTP status from
        // script. So this must not *guess*, and in particular must not report
        // "unauthorized", which used to make the shell discard the stored
        // password: restarting the engine then logged the user out and told
        // them their correct password had been refused.
        //
        // Retry, and say honestly that it could be either.
        this.#handlers.onStatus(
          "unreachable",
          "the engine did not accept the connection: it may be down, or the password may be wrong",
        )
        this.#scheduleReconnect()
        return
      }

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
