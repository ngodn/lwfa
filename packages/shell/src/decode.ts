/**
 * Frame decoding for the remote backend.
 *
 * Two paths, chosen per frame by the format byte in the header:
 *
 * - **H.264** via WebCodecs `VideoDecoder`. The normal path. Hardware decoded,
 *   and inter-frame, so an idle window costs almost nothing on the wire.
 * - **JPEG** via `createImageBitmap`. The fallback the engine uses when it runs
 *   out of hardware encoder sessions (8 concurrent on the dev GPU), so a ninth
 *   streaming window degrades instead of going blank.
 *
 * # Why decoding cannot just start anywhere
 *
 * An H.264 delta frame is meaningless without its reference. A browser that
 * attaches mid-stream has to discard frames until a keyframe arrives, which is
 * what the header's `keyframe` flag is for. Feeding a decoder deltas with no
 * reference produces errors or garbage, and the garbage is worse because it
 * looks like a rendering bug.
 *
 * The engine repeats SPS/PPS on every keyframe (Annex B), so the decoder can
 * configure itself from the stream rather than needing an out-of-band
 * description negotiated at connect time.
 *
 * # Availability
 *
 * WebCodecs shipped in Safari 26.0 on iOS/iPadOS. Below that, `VideoDecoder`
 * is absent and every H.264 frame is dropped, which would be a blank window
 * with no explanation. {@link supportsH264} exists so the shell can say so.
 */

import { FrameFormat, type DecodedFrame, type WindowId } from "@lwfa/proto"
import { noteFormat } from "@/lib/streamFormat"
import { noteFrame } from "@/lib/streamStats"

/**
 * Derive the WebCodecs codec string from the stream's own SPS.
 *
 * This must not be hardcoded. NVENC picks a profile and a level based on the
 * frame size and settings, and the level in particular changes with
 * resolution. A guessed string like `avc1.42E01E` (Baseline, level 3.0) is
 * rejected or mis-decoded the moment the encoder emits Main profile or a
 * larger frame, which is exactly what it does here.
 *
 * The three bytes after an SPS NAL header are `profile_idc`,
 * `constraint_flags` and `level_idc`, which is precisely the `avc1.PPCCLL`
 * form WebCodecs wants.
 *
 * Returns null if no SPS is present, in which case the caller waits for a
 * keyframe that has one rather than configuring from a guess.
 */
/**
 * HEVC Main profile, level 5.1.
 *
 * Deliberately generous: the level has to be at least the stream's, and one
 * that covers 4K covers every window this will ever carry.
 */
const HEVC_CODEC = "hvc1.1.6.L153.B0"

function codecFromSps(data: Uint8Array): string | null {
  // Scan for a start code followed by a NAL header whose type is 7 (SPS).
  for (let i = 0; i + 4 < data.length; i++) {
    const isStart3 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1
    const isStart4 =
      data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1
    if (!isStart3 && !isStart4) continue

    const nal = i + (isStart4 ? 4 : 3)
    if (nal + 3 >= data.length) break
    if ((data[nal]! & 0x1f) !== 7) continue

    const hex = (b: number) => b.toString(16).padStart(2, "0").toUpperCase()
    return `avc1.${hex(data[nal + 1]!)}${hex(data[nal + 2]!)}${hex(data[nal + 3]!)}`
  }
  return null
}

export function supportsH264(): boolean {
  return typeof globalThis.VideoDecoder !== "undefined"
}

export type FrameSink = (window: WindowId, bitmap: ImageBitmap) => void

/**
 * Owns one decoder per window and turns wire frames into drawable bitmaps.
 *
 * Decoders are stateful and per-stream, which is why this is a class rather
 * than a function: a window's decoder has to persist across frames to hold the
 * reference picture.
 */
export class FrameDecoder {
  #sink: FrameSink
  #decoders = new Map<WindowId, VideoDecoder>()
  /** Windows still waiting for their first keyframe. */
  #awaitingKeyframe = new Set<WindowId>()
  /** Size each decoder was configured for, so a resize can reconfigure it. */
  #configured = new Map<WindowId, string>()
  #timestamps = new Map<WindowId, number>()

  constructor(sink: FrameSink) {
    this.#sink = sink
  }

  async handle(frame: DecodedFrame): Promise<void> {
    // What is actually arriving, so the session panel can report it rather
    // than reporting what the browser is merely capable of. Free unless it
    // changes; see `lib/streamFormat`.
    noteFormat(frame.header.format)
    // How much and how often, which is what separates "the engine lowered the
    // quality" from "the engine lowered the frame rate" from "nothing is
    // arriving at all". See `lib/streamStats`.
    noteFrame(
      frame.payload.byteLength,
      frame.header.width,
      frame.header.height,
      frame.header.keyframe,
    )

    if (frame.header.format === FrameFormat.Jpeg) {
      await this.#handleJpeg(frame)
      return
    }
    this.#handleVideo(frame)
  }

  async #handleJpeg(frame: DecodedFrame): Promise<void> {
    const blob = new Blob([frame.payload as BlobPart], { type: "image/jpeg" })
    try {
      this.#sink(frame.header.window, await createImageBitmap(blob))
    } catch (err) {
      console.warn(`could not decode a JPEG frame for w${frame.header.window}:`, err)
    }
  }

  #handleVideo(frame: DecodedFrame): void {
    const { window: id, width, height, keyframe } = frame.header
    const hevc = frame.header.format === FrameFormat.Hevc

    if (!supportsH264()) {
      // Loud and once-ish: silently dropping every frame would look like a
      // network problem rather than a missing browser feature. This should not
      // happen, since the engine only sends video to a client that said it can
      // decode some, but a stream in flight when a client changes its mind
      // would land here.
      this.#warnOnce(id, "this browser has no WebCodecs VideoDecoder (Safari 26+ required)")
      return
    }

    // For H.264 the codec string comes from the SPS, so a decoder can only be
    // built from a keyframe. Deltas before that are dropped below.
    //
    // HEVC is not parsed. Its parameter sets are considerably more involved
    // than H.264's three bytes, and the string only has to *cover* the stream
    // rather than describe it exactly: Main profile at level 5.1 spans
    // everything a desktop window will be, and a browser that accepted it at
    // probe time will accept it here. See `lib/codecs`.
    const codec = keyframe ? (hevc ? HEVC_CODEC : codecFromSps(frame.payload)) : null
    const wanted = codec ? `${width}x${height}:${codec}` : null

    let decoder = this.#decoders.get(id)

    if (codec !== null && wanted !== null && this.#configured.get(id) !== wanted) {
      // Resolution or profile changed, so the old configuration is useless and
      // its reference frames with it.
      //
      // Reconfigured rather than rebuilt. `close()` followed by `new
      // VideoDecoder` is one decoder destroyed and another created on every
      // resize, and WebKit runs decoders in its GPU process, which outlives
      // the document: a reload cannot reclaim what that churn leaves behind,
      // which is why quitting Safari was the only thing that ever helped.
      // Reconfiguring a live decoder is the same state change without the
      // churn, and is what the call is for. Measured before this: three window
      // resizes produced three closes and three constructions.
      if (decoder && decoder.state !== "closed") {
        try {
          decoder.configure({ codec, optimizeForLatency: true })
          this.#configured.set(id, wanted)
          // Reconfiguring throws the reference frames away, so this decoder is
          // back to needing a keyframe. It has one: only a keyframe carries
          // the parameter sets, so this branch only runs on one.
          this.#awaitingKeyframe.add(id)
          // The timestamp counter deliberately keeps running. It feeds one
          // decoder, and handing that decoder a sequence that jumps backwards
          // is a thing to avoid for no gain.
        } catch (err) {
          // A decoder that will not take the new configuration is no worse off
          // for being replaced, which is what this did unconditionally before.
          console.warn(`could not reconfigure the decoder for w${id}:`, err)
          this.#reset(id)
          decoder = undefined
        }
      } else {
        this.#reset(id)
        decoder = undefined
      }
    }

    if (!decoder) {
      if (!codec || wanted === null) {
        // No decoder and no SPS to build one from. Wait for a keyframe that
        // carries one; the engine repeats SPS on every keyframe for exactly
        // this case.
        return
      }
      decoder = new VideoDecoder({
        output: (videoFrame) => {
          // createImageBitmap takes ownership of the pixels; the VideoFrame
          // must still be closed or the decoder starves on buffers.
          createImageBitmap(videoFrame)
            .then((bitmap) => this.#sink(id, bitmap))
            .catch((err) => console.warn(`could not convert a frame for w${id}:`, err))
            .finally(() => videoFrame.close())
        },
        error: (err) => {
          console.warn(`decoder error for w${id}:`, err)
          // Drop it; the next keyframe rebuilds from scratch.
          this.#reset(id)
        },
      })
      decoder.configure({
        codec,
        // Tells the decoder not to buffer for reordering. This stream has no
        // B-frames, so buffering would add latency for nothing.
        optimizeForLatency: true,
      })
      this.#decoders.set(id, decoder)
      this.#configured.set(id, wanted)
      this.#awaitingKeyframe.add(id)
      this.#timestamps.set(id, 0)
    }

    if (this.#awaitingKeyframe.has(id)) {
      if (!keyframe) return // no reference yet; discarding is the correct move
      this.#awaitingKeyframe.delete(id)
    }

    // Monotonic and per window. The engine's pts is not carried on the wire
    // because nothing here needs to match it: there is no audio to sync to and
    // no seeking.
    const timestamp = (this.#timestamps.get(id) ?? 0) + 16_667
    this.#timestamps.set(id, timestamp)

    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: keyframe ? "key" : "delta",
          timestamp,
          data: frame.payload,
        }),
      )
    } catch (err) {
      console.warn(`could not decode an H.264 frame for w${id}:`, err)
      this.#reset(id)
    }
  }

  #warned = new Set<WindowId>()
  #warnOnce(id: WindowId, message: string): void {
    if (this.#warned.has(id)) return
    this.#warned.add(id)
    console.warn(`w${id}: ${message}`)
  }

  #reset(id: WindowId): void {
    const decoder = this.#decoders.get(id)
    if (decoder && decoder.state !== "closed") {
      try {
        decoder.close()
      } catch {
        // Already closing. Nothing useful to do.
      }
    }
    this.#decoders.delete(id)
    this.#configured.delete(id)
    this.#awaitingKeyframe.delete(id)
  }

  /** Release a window's decoder. Call when the window closes. */
  forget(id: WindowId): void {
    this.#reset(id)
    this.#warned.delete(id)
    this.#timestamps.delete(id)
  }

  /** Release everything. Call on disconnect. */
  close(): void {
    for (const id of [...this.#decoders.keys()]) this.#reset(id)
  }
}
