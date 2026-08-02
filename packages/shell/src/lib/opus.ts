/**
 * Turning Opus packets back into the PCM the player already understands.
 *
 * # Why a shim rather than a second playback path
 *
 * The audio player takes interleaved 16-bit PCM and has two ways to play it,
 * an `AudioWorklet` and scheduled buffers, both already written and both
 * already handling the awkward parts: the playhead, underruns, and the seam
 * between chunks. Adding a third path for Opus would mean solving those again.
 *
 * So this decodes to exactly what the player already takes, and the player does
 * not learn that Opus exists.
 *
 * # Ordering
 *
 * `AudioDecoder` is asynchronous and its outputs arrive in submission order,
 * but *after* the call that produced them. Handing each output straight to the
 * player would therefore be correct only by luck if the queue ever ran more
 * than one deep. It does not here, since packets arrive every 20ms and decode
 * in well under that, but the callback is the ordering guarantee and this
 * relies on it rather than on the timing.
 *
 * # When it is not available
 *
 * `AudioDecoder` is secure-context only, so a page on plain HTTP has none. The
 * engine is told that and sends PCM instead, so this never runs. If it somehow
 * does, the packets are dropped rather than fed to the player as if they were
 * samples, which would be loud noise.
 */

/** 48kHz stereo, matching what the engine captures. */
const SAMPLE_RATE = 48000
const CHANNELS = 2

export type PcmSink = (pcm: ArrayBuffer) => void

/**
 * A decoder that hands finished PCM to `sink`.
 *
 * One per session. Opus is stateful, predicting from previous packets, so the
 * decoder has to persist across them.
 */
export class OpusStream {
  #decoder: AudioDecoder | null = null
  #sink: PcmSink
  /** Rising, in microseconds, because `EncodedAudioChunk` requires one. */
  #timestamp = 0
  #failed = false

  constructor(sink: PcmSink) {
    this.#sink = sink
  }

  /** Whether this browser has an `AudioDecoder` at all. */
  static available(): boolean {
    return typeof globalThis.AudioDecoder !== "undefined"
  }

  /** Decode one packet. Silently ignored if the decoder could not be made. */
  push(packet: ArrayBuffer, frames: number): void {
    if (this.#failed) return
    const decoder = this.#ensure()
    if (!decoder) return

    try {
      decoder.decode(
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
    // Advanced by what the packet claims rather than by what comes out, so a
    // dropped packet still leaves a gap of the right length instead of pulling
    // everything after it earlier.
    this.#timestamp += Math.round((frames / SAMPLE_RATE) * 1_000_000)
  }

  close(): void {
    try {
      this.#decoder?.close()
    } catch {
      // Already closed, or never opened.
    }
    this.#decoder = null
    this.#timestamp = 0
    this.#failed = false
  }

  #ensure(): AudioDecoder | null {
    if (this.#decoder) return this.#decoder
    if (!OpusStream.available()) {
      this.#failed = true
      return null
    }
    try {
      const decoder = new AudioDecoder({
        output: (data) => this.#emit(data),
        error: () => {
          // The decoder is unusable from here. Give up rather than retrying
          // per packet fifty times a second.
          this.#failed = true
          this.#decoder = null
        },
      })
      decoder.configure({ codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS })
      this.#decoder = decoder
      return decoder
    } catch {
      this.#failed = true
      return null
    }
  }

  /** One decoded buffer, converted to the interleaved 16-bit the player takes. */
  #emit(data: AudioData): void {
    try {
      const frames = data.numberOfFrames
      const channels = Math.min(data.numberOfChannels, CHANNELS)
      const out = new Int16Array(frames * CHANNELS)

      // Planar float is what Opus decodes to, so each channel is copied
      // separately and interleaved here.
      const plane = new Float32Array(frames)
      for (let c = 0; c < channels; c++) {
        data.copyTo(plane, { planeIndex: c, format: "f32-planar" })
        for (let i = 0; i < frames; i++) {
          // Clamped before scaling: a decoder may return slightly past full
          // scale, and letting that wrap would be a loud click.
          const sample = Math.max(-1, Math.min(1, plane[i]!))
          out[i * CHANNELS + c] = Math.round(sample * 32767)
        }
      }
      // Mono into both ears, rather than silence on the right.
      if (channels === 1) {
        for (let i = 0; i < frames; i++) out[i * CHANNELS + 1] = out[i * CHANNELS]!
      }
      this.#sink(out.buffer)
    } finally {
      // Not optional: an unclosed `AudioData` holds its backing memory, and at
      // fifty a second that is a leak measured in megabytes per minute.
      data.close()
    }
  }
}
