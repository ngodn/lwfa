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
import { codecFromAnnexB, type Codec } from "@/lib/codecs"

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
  #onUnsupported: (codec: Codec) => void
  #failed = new Set<Codec>()
  #supportChecks = new Map<WindowId, object>()
  #families = new Map<WindowId, Codec>()
  #decoders = new Map<WindowId, VideoDecoder>()
  /** Windows still waiting for their first keyframe. */
  #awaitingKeyframe = new Set<WindowId>()
  /** Size each decoder was configured for, so a resize can reconfigure it. */
  #configured = new Map<WindowId, string>()
  #timestamps = new Map<WindowId, number>()
  /** Last submitted timestamp before reconfiguration, whose output is stale. */
  #discardThrough = new Map<WindowId, number>()
  // Identity invalidates conversions already in flight when a window closes
  // or changes codec. Sequence numbers stop older conversions replacing newer
  // pixels when createImageBitmap promises finish out of order.
  #delivery = new Map<WindowId, { issued: number; published: number }>()

  constructor(sink: FrameSink, onUnsupported: (codec: Codec) => void = () => {}) {
    this.#sink = sink
    this.#onUnsupported = onUnsupported
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
    const id = frame.header.window
    if (this.#decoders.has(id)) this.#reset(id)
    const deliver = this.#deliveryFor(id)
    const blob = new Blob([frame.payload as BlobPart], { type: "image/jpeg" })
    try {
      deliver(await createImageBitmap(blob))
    } catch (err) {
      console.warn(`could not decode a JPEG frame for w${frame.header.window}:`, err)
    }
  }

  #handleVideo(frame: DecodedFrame): void {
    const { window: id, width, height, keyframe } = frame.header
    const family: Codec = frame.header.format === FrameFormat.Hevc ? "hevc" : "h264"
    if (this.#failed.has(family)) return

    if (!supportsH264()) {
      // Loud and once-ish: silently dropping every frame would look like a
      // network problem rather than a missing browser feature. This should not
      // happen, since the engine only sends video to a client that said it can
      // decode some, but a stream in flight when a client changes its mind
      // would land here.
      this.#warnOnce(id, "this browser has no WebCodecs VideoDecoder (Safari 26+ required)")
      return
    }

    // Parameter sets on each keyframe describe the real profile and level,
    // including HEVC level 6 when density scaling goes beyond 4K.
    const codec = keyframe ? codecFromAnnexB(frame.payload, family) : null
    if (keyframe && !codec) {
      // Do not feed a truncated parameter set into a previously valid decoder.
      // The next complete keyframe can establish its reference pictures again.
      this.#reset(id)
      return
    }
    const config = codec ? { codec, codedWidth: width, codedHeight: height, optimizeForLatency: true } : null
    const wanted = codec ? `${width}x${height}:${codec}` : null

    let decoder = this.#decoders.get(id)
    let changed = false

    if (!keyframe && decoder && (
      this.#families.get(id) !== family ||
      !this.#configured.get(id)?.startsWith(`${width}x${height}:`)
    )) {
      this.#reset(id)
      return
    }

    if (config !== null && wanted !== null && this.#configured.get(id) !== wanted) {
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
          decoder.configure(config)
          this.#families.set(id, family)
          changed = true
          this.#configured.set(id, wanted)
          this.#delivery.delete(id)
          this.#discardThrough.set(id, this.#timestamps.get(id) ?? 0)
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
      if (!config || wanted === null) {
        // No decoder and no SPS to build one from. Wait for a keyframe that
        // carries one; the engine repeats SPS on every keyframe for exactly
        // this case.
        return
      }
      try {
        decoder = new VideoDecoder({
          output: (videoFrame) => {
            // A retired decoder must not publish into a replacement stream.
            if (
              this.#decoders.get(id) !== decoder ||
              videoFrame.timestamp <= (this.#discardThrough.get(id) ?? -1)
            ) {
              videoFrame.close()
              return
            }
            const deliver = this.#deliveryFor(id)
            // Conversion copies the pixels asynchronously. Keep the VideoFrame
            // alive until it completes, then release its decoder buffer.
            createImageBitmap(videoFrame)
              .then(deliver)
              .catch((err) => console.warn(`could not convert a frame for w${id}:`, err))
              .finally(() => videoFrame.close())
          },
          error: (err) => {
            if (this.#decoders.get(id) !== decoder) return
            this.#rejectCodec(id, this.#families.get(id) ?? family, err)
          },
        })
      } catch (err) {
        this.#rejectCodec(id, family, err)
        return
      }
      this.#decoders.set(id, decoder)
      this.#families.set(id, family)
      try {
        decoder.configure(config)
      } catch (err) {
        this.#rejectCodec(id, family, err)
        return
      }
      changed = true
      this.#configured.set(id, wanted)
      this.#awaitingKeyframe.add(id)
      this.#timestamps.set(id, 0)
    }

    if (changed && config) this.#checkSupport(id, family, config)

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
      this.#rejectCodec(id, family, err)
    }
  }

  #checkSupport(id: WindowId, family: Codec, config: VideoDecoderConfig): void {
    const lifetime = {}
    this.#supportChecks.set(id, lifetime)
    // Probe in parallel with the decoder's ordered configure/decode queue.
    // Waiting here would require buffering interdependent video packets.
    // configure itself also reports operational failures through error().
    void (async () => {
      try {
        const support = await VideoDecoder.isConfigSupported(config)
        if (this.#supportChecks.get(id) !== lifetime) return
        if (!support.supported) this.#rejectCodec(id, family, "stream configuration is unsupported")
      } catch (err) {
        if (this.#supportChecks.get(id) === lifetime) this.#rejectCodec(id, family, err)
      }
    })()
  }

  #rejectCodec(id: WindowId, family: Codec, reason: unknown): void {
    this.#reset(id)
    if (this.#failed.has(family)) return
    this.#failed.add(family)
    console.warn(`w${id}: ${family} failed; requesting another stream format:`, reason)
    this.#onUnsupported(family)
  }

  #deliveryFor(id: WindowId): (bitmap: ImageBitmap) => void {
    let lifetime = this.#delivery.get(id)
    if (!lifetime) {
      lifetime = { issued: 0, published: 0 }
      this.#delivery.set(id, lifetime)
    }
    const current = lifetime
    const sequence = ++current.issued
    return (bitmap) => {
      if (this.#delivery.get(id) !== current || sequence <= current.published) {
        bitmap.close()
        return
      }
      current.published = sequence
      this.#sink(id, bitmap)
    }
  }

  #warned = new Set<WindowId>()
  #warnOnce(id: WindowId, message: string): void {
    if (this.#warned.has(id)) return
    this.#warned.add(id)
    console.warn(`w${id}: ${message}`)
  }

  #reset(id: WindowId): void {
    this.#supportChecks.delete(id)
    this.#families.delete(id)
    this.#delivery.delete(id)
    this.#discardThrough.delete(id)
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
    this.#delivery.clear()
    this.#timestamps.clear()
    this.#warned.clear()
  }
}
