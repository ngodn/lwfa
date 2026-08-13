/**
 * Turning Opus packets into audio the player can take.
 *
 * # Two decoders, one of them always available
 *
 * The native `AudioDecoder` is preferred: it decodes off the main thread and
 * costs nothing to ship. But it is secure-context only, and Safari did not
 * have it at all before version 26, which is how this project discovered its
 * audio silently falling back to raw PCM at 1.5 Mbit/s: the engine will not
 * send Opus to a client that cannot decode it, and for a long time the iPad
 * this project exists for could not. So there is a second decoder, libopus
 * compiled to WASM (`opus-decoder`, ~85KB, WASM inlined in the bundle), which
 * works on any origin in any browser. Between the two, "can this client
 * decode Opus" is simply yes, and the PCM fallback stops being a steady state
 * anybody actually lives in.
 *
 * The WASM decoder is synchronous per packet (decoding 20ms of stereo takes
 * tens of microseconds), which also makes ordering trivial. The native path
 * is asynchronous but delivers outputs in submission order; see below.
 *
 * # Why the sink takes planar floats now
 *
 * Both decoders produce 32-bit float planes. The player's worklet keeps its
 * ring buffer in float planes, and the scheduled fallback fills an
 * `AudioBuffer`, which is float planes too. The old shape of this file
 * converted float to interleaved int16 here, sample by sample, only for the
 * player to convert it straight back, sample by sample, fifty times a second
 * on the main thread. Handing the planes through as-is deletes both loops
 * and both conversions' rounding.
 *
 * # Ordering
 *
 * `AudioDecoder` outputs arrive in submission order, but *after* the call
 * that produced them. The callback order is the guarantee this relies on.
 * The WASM path is synchronous, so it cannot reorder anything; packets that
 * arrive while the WASM is still compiling are queued and decoded in order
 * the moment it is ready, rather than dropped.
 */

/** 48kHz stereo, matching what the engine captures. */
const SAMPLE_RATE = 48000
const CHANNELS = 2

/**
 * One decoded chunk: a left and a right plane of equal length.
 *
 * Always two, mono duplicated, so the player never needs a channel-count
 * branch. The planes are fresh per call and the caller may transfer them.
 */
export type PlanarSink = (left: Float32Array, right: Float32Array) => void

/**
 * The slice of `opus-decoder` this file uses, named so a test can hand in a
 * fake instead of compiling real WASM per case.
 */
export interface WasmOpus {
  ready: Promise<unknown>
  decodeFrame(packet: Uint8Array): {
    channelData: Float32Array[]
    samplesDecoded: number
  }
  free(): void
}

/**
 * Packets to hold while the WASM decoder is still compiling. A second of
 * audio; anything older than that is better skipped than played late.
 */
const WASM_QUEUE_LIMIT = 50

/**
 * A decoder that hands finished planes to `sink`.
 *
 * One per session. Opus is stateful, predicting from previous packets, so the
 * decoder has to persist across them.
 */
export class OpusStream {
  #native: AudioDecoder | null = null
  #wasm: WasmOpus | null = null
  #wasmReady = false
  /** A decoder has been chosen and is being set up, possibly still async. */
  #started = false
  /** Packets that arrived before the WASM finished loading and compiling. */
  #pending: Uint8Array[] = []
  #sink: PlanarSink
  #makeWasm: () => WasmOpus | Promise<WasmOpus>
  /** Rising, in microseconds, because `EncodedAudioChunk` requires one. */
  #timestamp = 0
  #failed = false
  #closed = false

  constructor(sink: PlanarSink, makeWasm?: () => WasmOpus | Promise<WasmOpus>) {
    this.#sink = sink
    // Imported on demand: the WASM is ~90KB that a browser with a native
    // decoder never needs, so it stays out of the main bundle and off the
    // network until the fallback is actually taken.
    this.#makeWasm =
      makeWasm ??
      (async () => new (await import("opus-decoder")).OpusDecoder({ forceStereo: true }))
  }

  /** Decode one packet. Silently ignored only if both decoders failed. */
  push(packet: Uint8Array, frames: number): void {
    if (this.#failed || this.#closed) return

    if (!this.#started) this.#ensure()

    if (this.#native) {
      try {
        this.#native.decode(
          new EncodedAudioChunk({
            type: "key",
            timestamp: this.#timestamp,
            data: packet,
          }),
        )
      } catch {
        // A packet the decoder refuses. Dropping one costs 20ms of silence,
        // which is better than tearing down a working stream.
        return
      }
      // Advanced by what the packet claims rather than by what comes out, so
      // a dropped packet still leaves a gap of the right length instead of
      // pulling everything after it earlier.
      this.#timestamp += Math.round((frames / SAMPLE_RATE) * 1_000_000)
      return
    }

    if (this.#failed) return
    if (this.#wasmReady) {
      this.#decodeWasm(packet)
      return
    }
    // Still loading or compiling. Copied because the packet is a view into a
    // socket buffer that will be reused before the queue drains.
    if (this.#pending.length < WASM_QUEUE_LIMIT) {
      this.#pending.push(packet.slice())
    }
  }

  close(): void {
    this.#closed = true
    try {
      this.#native?.close()
    } catch {
      // Already closed, or never opened.
    }
    this.#native = null
    this.#wasm?.free()
    this.#wasm = null
    this.#wasmReady = false
    this.#pending = []
    this.#timestamp = 0
    this.#failed = false
  }

  /** Which decoder is doing the work, for the diagnostics readout. */
  path(): "native" | "wasm" | "none" {
    if (this.#native) return "native"
    if (this.#wasm) return "wasm"
    return "none"
  }

  /** Pick a decoder, once: native when the browser has one, WASM otherwise. */
  #ensure(): void {
    this.#started = true
    const Native = (globalThis as { AudioDecoder?: typeof AudioDecoder }).AudioDecoder
    if (Native) {
      try {
        const decoder = new Native({
          output: (data) => this.#emit(data),
          error: () => {
            // The decoder is unusable from here. Give up rather than
            // retrying per packet fifty times a second.
            this.#failed = true
            this.#native = null
          },
        })
        decoder.configure({ codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS })
        this.#native = decoder
        return
      } catch {
        // Present but broken. The WASM path below covers it.
      }
    }

    Promise.resolve()
      .then(() => this.#makeWasm())
      .then((wasm) => {
        if (this.#closed) {
          wasm.free()
          return
        }
        this.#wasm = wasm
        return wasm.ready.then(() => {
          if (this.#closed || this.#wasm !== wasm) return
          this.#wasmReady = true
          const queued = this.#pending
          this.#pending = []
          for (const packet of queued) this.#decodeWasm(packet)
        })
      })
      .catch(() => {
        this.#failed = true
        this.#wasm = null
        this.#pending = []
      })
  }

  #decodeWasm(packet: Uint8Array): void {
    const wasm = this.#wasm
    if (!wasm) return
    try {
      const { channelData, samplesDecoded } = wasm.decodeFrame(packet)
      if (samplesDecoded <= 0 || channelData.length === 0) return
      const left = channelData[0]!
      // `forceStereo` makes two channels the normal case; a mono plane is
      // duplicated rather than played into one ear.
      const right = channelData[1] ?? left.slice()
      this.#sink(left, right)
    } catch {
      // One bad packet is 20ms of silence, not a reason to stop.
    }
  }

  /** One decoded native buffer, split into the planes the player takes. */
  #emit(data: AudioData): void {
    try {
      const frames = data.numberOfFrames
      if (frames === 0) return
      const left = new Float32Array(frames)
      data.copyTo(left, { planeIndex: 0, format: "f32-planar" })
      let right: Float32Array
      if (data.numberOfChannels > 1) {
        right = new Float32Array(frames)
        data.copyTo(right, { planeIndex: 1, format: "f32-planar" })
      } else {
        right = left.slice()
      }
      this.#sink(left, right)
    } finally {
      // Not optional: an unclosed `AudioData` holds its backing memory, and at
      // fifty a second that is a leak measured in megabytes per minute.
      data.close()
    }
  }
}
