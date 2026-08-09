/**
 * What a resize costs the browser's decoder.
 *
 * A window changing size means new parameter sets, and the decoder has to be
 * told. There are two ways to tell it: reconfigure the one that exists, or
 * throw it away and build another. They look equivalent from here and are not.
 *
 * WebKit runs `VideoDecoder` in its GPU process, which outlives the document.
 * A decoder destroyed and rebuilt on every resize therefore churns a resource
 * a page reload cannot reclaim, which is why a stuttering session on the iPad
 * could only be cured by quitting Safari, never by reloading. Measured against
 * the old code: three window resizes produced three closes and three
 * constructions.
 *
 * These pin the cheap path. If someone reaches for `new VideoDecoder` on a
 * resize again, `a_resize_reconfigures_rather_than_rebuilding` fails.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { FrameFormat, type DecodedFrame, type WindowId } from "@lwfa/proto"
import { FrameDecoder } from "../src/decode"

const W = 1 as WindowId

/** How many decoders were built, configured and closed since the last reset. */
const stats = { constructed: 0, configured: 0, closed: 0 }

class FakeVideoDecoder {
  state: "unconfigured" | "configured" | "closed" = "unconfigured"
  /** Set by a test that wants `configure` to refuse, as a real one may. */
  static refuseReconfigure = false

  constructor(_init: VideoDecoderInit) {
    stats.constructed++
  }
  configure(_config: VideoDecoderConfig): void {
    if (FakeVideoDecoder.refuseReconfigure && this.state === "configured") {
      throw new Error("nope")
    }
    stats.configured++
    this.state = "configured"
  }
  decode(_chunk: unknown): void {}
  close(): void {
    stats.closed++
    this.state = "closed"
  }
}

/**
 * A payload carrying one SPS, which is the only thing `codecFromSps` reads.
 *
 * Start code, then a NAL header whose low five bits are 7, then the three
 * bytes that become the `avc1.PPCCLL` codec string.
 */
function keyframePayload(): Uint8Array {
  return new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e, 0x00, 0x11])
}

function frame(width: number, height: number, keyframe = true): DecodedFrame {
  return {
    header: { window: W, width, height, format: FrameFormat.H264, keyframe },
    payload: keyframePayload(),
  }
}

describe("the frame decoder", () => {
  beforeEach(() => {
    stats.constructed = 0
    stats.configured = 0
    stats.closed = 0
    FakeVideoDecoder.refuseReconfigure = false
    vi.stubGlobal("VideoDecoder", FakeVideoDecoder)
    vi.stubGlobal("EncodedVideoChunk", class {})
  })

  it("builds one decoder for a window's first keyframe", () => {
    const decoder = new FrameDecoder(() => {})
    void decoder.handle(frame(800, 600))
    expect(stats).toMatchObject({ constructed: 1, configured: 1, closed: 0 })
  })

  it("a resize reconfigures rather than rebuilding", () => {
    // The whole point. Four sizes, one decoder.
    const decoder = new FrameDecoder(() => {})
    void decoder.handle(frame(800, 600))
    void decoder.handle(frame(1024, 768))
    void decoder.handle(frame(640, 480))
    void decoder.handle(frame(1280, 720))

    expect(stats.constructed).toBe(1)
    expect(stats.configured).toBe(4)
    expect(stats.closed).toBe(0)
  })

  it("does not reconfigure when nothing changed", () => {
    // A keyframe arrives regularly at a steady size, and reconfiguring on each
    // one would throw away the reference frames for nothing.
    const decoder = new FrameDecoder(() => {})
    void decoder.handle(frame(800, 600))
    void decoder.handle(frame(800, 600))
    void decoder.handle(frame(800, 600))

    expect(stats.constructed).toBe(1)
    expect(stats.configured).toBe(1)
  })

  it("replaces a decoder that refuses the new configuration", () => {
    // The fallback has to still work: a decoder that will not take the new
    // config is no worse off being replaced, which is what always happened
    // before. Losing this would turn a rejected resize into a dead window.
    const decoder = new FrameDecoder(() => {})
    void decoder.handle(frame(800, 600))
    FakeVideoDecoder.refuseReconfigure = true
    void decoder.handle(frame(1024, 768))

    expect(stats.constructed).toBe(2)
    expect(stats.closed).toBe(1)
  })

  it("still releases a window's decoder when it closes", () => {
    // Reusing decoders must not turn into keeping them forever.
    const decoder = new FrameDecoder(() => {})
    void decoder.handle(frame(800, 600))
    decoder.forget(W)
    expect(stats.closed).toBe(1)
  })

  it("releases every decoder on disconnect", () => {
    const decoder = new FrameDecoder(() => {})
    void decoder.handle(frame(800, 600))
    void decoder.handle({
      header: { window: 2 as WindowId, width: 640, height: 480, format: FrameFormat.H264, keyframe: true },
      payload: keyframePayload(),
    })
    expect(stats.constructed).toBe(2)
    decoder.close()
    expect(stats.closed).toBe(2)
  })
})
