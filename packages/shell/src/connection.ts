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
  decodeAudio,
  decodeFrame,
  type AudioFormat,
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

/**
 * Close reason for a socket the *same* client has superseded by reconnecting.
 *
 * Distinct from {@link REPLACED_REASON} because the right response is the
 * opposite. Being replaced by another device means stop; being superseded by
 * your own newer socket means carry on, because the newer socket is this same
 * connection. Sending the first for both made a raced reconnect look like a
 * takeover and the shell stopped trying.
 *
 * Must match `SUPERSEDED_REASON` in `crates/lwfa-engine/src/shell.rs`.
 */
export const SUPERSEDED_REASON = "superseded-by-reconnect"

export type Status =
  | "connecting"
  | "connected"
  /**
   * Another tab of this browser holds the session, and this one is queued.
   *
   * Not a failure and not a connection attempt: nothing is being tried and
   * nothing is wrong. It was reported as "connecting" until it was given a
   * name of its own, which meant a tab that would never connect looked exactly
   * like one that was about to. See `lib/leader`.
   */
  | "waiting"
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
  /**
   * One chunk of audio, with what it is.
   *
   * The format can change mid-stream (the engine picks per listener and says
   * so on every chunk), so each chunk declares which it is. The payload is a
   * *view into the socket message*, not a copy: the handler may transfer the
   * underlying buffer or read through the view, but must not assume the
   * payload starts at byte zero. Copying 3840 bytes fifty times a second
   * was pure garbage-collector feed, so nothing on this path copies.
   */
  onAudio: (payload: Uint8Array, format: AudioFormat, frames: number) => void
  onStatus: (status: Status, detail?: string) => void
}

/** Backoff bounds for reconnecting. */
const RECONNECT_MIN_MS = 250
const RECONNECT_MAX_MS = 5_000

/**
 * How long a resumed page waits for proof its socket is alive.
 *
 * Generous against a slow LAN round trip, tight against a person staring at a
 * frozen desktop: the reply normally arrives in single-digit milliseconds, so
 * anything that takes longer than this is not late, it is gone.
 */
const RESUME_PROBE_MS = 2_000

export class Connection {
  #url: string
  #handlers: ConnectionHandlers
  #socket: WebSocket | null = null
  #retryMs = RECONNECT_MIN_MS
  #timer: ReturnType<typeof setTimeout> | null = null
  #closed = false
  /** The deadline on an unanswered resume probe. See `#onResume`. */
  #probe: ReturnType<typeof setTimeout> | null = null
  /** Bound once so `close()` can remove exactly what was added. */
  #onResumeBound = () => this.#onResume()
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
    // A page coming back from the background must not trust its socket.
    //
    // On iPadOS a home-screen web app that is backgrounded and resumed is
    // routinely handed back a WebSocket that reports OPEN and delivers
    // nothing, and WebKit never fires `close` on it (WebKit bug 247943), so
    // without this the shell sits on a corpse forever and the desktop looks
    // frozen until the app is force-quit or the iPad rebooted. `pageshow`
    // covers the back/forward-cache restore, `visibilitychange` covers the
    // ordinary app switch.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.#onResumeBound)
      globalThis.addEventListener("pageshow", this.#onResumeBound)
    }
  }

  /** Prove the socket is alive, or replace it. See the constructor. */
  #onResume(): void {
    if (this.#closed) return
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return

    const socket = this.#socket
    if (socket?.readyState === WebSocket.OPEN) {
      if (this.#probe !== null) return // one probe at a time
      // Any message at all is the answer: the pong if the session is idle, or
      // whatever frame was already on the way. See `onmessage`.
      this.send({ type: "ping" })
      this.#probe = setTimeout(() => {
        this.#probe = null
        // Dead. Abandon it rather than closing it politely: `close()` on a
        // wedged socket waits on the very TCP teardown that will never come,
        // and the stale-socket guard in `onclose` ignores the corpse when it
        // does eventually report in.
        this.#socket = null
        try {
          socket.close()
        } catch {
          // Already broken beyond closing, which changes nothing.
        }
        this.#handlers.onStatus("connecting")
        this.#retryMs = RECONNECT_MIN_MS
        this.connect()
      }, RESUME_PROBE_MS)
      return
    }

    // No live socket. If a retry is queued for later, it was scheduled while
    // nobody was looking; a person is looking now, so go immediately.
    if (socket === null && this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
      this.#retryMs = RECONNECT_MIN_MS
      this.connect()
    }
  }

  /** The probe question has been answered; the socket is real. */
  #probeAnswered(): void {
    if (this.#probe !== null) {
      clearTimeout(this.#probe)
      this.#probe = null
    }
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
      // Anything arriving proves the socket is alive, which is all the resume
      // probe wanted to know. The pong itself needs no handling of its own.
      this.#probeAnswered()
      if (event.data instanceof ArrayBuffer) {
        // Audio first: it is the cheaper check, and on a session with sound
        // there are more audio chunks per second than video frames.
        const audio = decodeAudio(event.data)
        if (audio) {
          // The view, not a copy. Nothing else reads this message after the
          // handler, so the handler owns the buffer behind the view.
          this.#handlers.onAudio(audio.payload, audio.header.format, audio.header.frames)
          return
        }
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
      // A close from a socket this connection has already moved on from.
      //
      // Reconnecting replaces `#socket` before the old one has finished
      // dying, so its `onclose` still fires afterwards and would otherwise be
      // acted on as though it were the live socket. That was not theoretical:
      // the engine closes a superseded socket with a reason that tells the
      // client to stop retrying, so a retry that raced its predecessor made
      // the shell give up permanently and sit on "connecting" until the page
      // was reloaded.
      if (socket !== this.#socket) return

      this.#socket = null
      if (this.#closed) return

      if (event.reason === SUPERSEDED_REASON) {
        // Another connection of this same browser holds the newer socket.
        //
        // Getting here at all means the socket that superseded this one is not
        // ours, because a retry of our own would have been caught by the stale
        // check above. So a second tab, or a page that outlived its reload, is
        // now the live session for this browser and this one has lost.
        //
        // Stop. Reconnecting looks reasonable and is a trap: the new socket
        // would supersede theirs, theirs would supersede ours back, and the
        // two would trade the session forever. That is not theoretical, it is
        // what happened when this branch retried: connect, evict, reconnect,
        // every 290ms, two hundred sessions deep, with the audio capture
        // starting and stopping on each pass.
        this.#closed = true
        this.#handlers.onStatus("replaced")
        return
      }

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
    this.#probeAnswered()
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.#onResumeBound)
      globalThis.removeEventListener("pageshow", this.#onResumeBound)
    }
    this.#socket?.close()
  }
}
