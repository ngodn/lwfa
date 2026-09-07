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
  static refuseConfigure = false
  static refuseConstruction = false
  static configs: VideoDecoderConfig[] = []
  static errors: WebCodecsErrorCallback[] = []
  static isConfigSupported = vi.fn(async (config: VideoDecoderConfig) => ({ supported: true, config }))

  static outputs: VideoFrameOutputCallback[] = []
  static decoded: { instance: number; chunk: EncodedVideoChunk }[] = []
  static decodeFailures = 0
  instance: number

  constructor(init: VideoDecoderInit) {
    if (FakeVideoDecoder.refuseConstruction) throw new DOMException("no decoder", "NotSupportedError")
    FakeVideoDecoder.outputs.push(init.output)
    FakeVideoDecoder.errors.push(init.error)
    this.instance = ++stats.constructed
  }
  configure(config: VideoDecoderConfig): void {
    if (FakeVideoDecoder.refuseConfigure) throw new DOMException("unsupported size", "NotSupportedError")
    FakeVideoDecoder.configs.push(config)
    if (FakeVideoDecoder.refuseReconfigure && this.state === "configured") {
      throw new Error("nope")
    }
    stats.configured++
    this.state = "configured"
  }
  decode(chunk: EncodedVideoChunk): void {
    FakeVideoDecoder.decoded.push({ instance: this.instance, chunk })
    if (FakeVideoDecoder.decodeFailures > 0) {
      FakeVideoDecoder.decodeFailures--
      throw new DOMException("temporary decoder failure", "EncodingError")
    }
  }
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
    FakeVideoDecoder.outputs = []
    FakeVideoDecoder.decoded = []
    FakeVideoDecoder.decodeFailures = 0
    FakeVideoDecoder.errors = []
    FakeVideoDecoder.configs = []
    FakeVideoDecoder.refuseConfigure = false
    FakeVideoDecoder.refuseConstruction = false
    FakeVideoDecoder.isConfigSupported.mockReset().mockImplementation(async (config) => ({ supported: true, config }))
    vi.stubGlobal("VideoDecoder", FakeVideoDecoder)
    vi.stubGlobal("EncodedVideoChunk", class {
      constructor(init: EncodedVideoChunkInit) { Object.assign(this, init) }
    })
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


describe("asynchronous frame delivery", () => {
  beforeEach(() => {
    FakeVideoDecoder.refuseReconfigure = false
    FakeVideoDecoder.outputs = []
    FakeVideoDecoder.decoded = []
    FakeVideoDecoder.decodeFailures = 0
    FakeVideoDecoder.errors = []
    FakeVideoDecoder.configs = []
    FakeVideoDecoder.refuseConfigure = false
    FakeVideoDecoder.refuseConstruction = false
    FakeVideoDecoder.isConfigSupported.mockReset().mockImplementation(async (config) => ({ supported: true, config }))
    vi.stubGlobal("VideoDecoder", FakeVideoDecoder)
    vi.stubGlobal("EncodedVideoChunk", class {
      constructor(init: EncodedVideoChunkInit) { Object.assign(this, init) }
    })
  })

  for (const format of [FrameFormat.Jpeg, FrameFormat.H264]) {
    for (const stop of ["forget", "close"] as const) {
      it(`discards a pending ${format} bitmap after ${stop}`, async () => {
        let resolve!: (value: ImageBitmap) => void
        vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise<ImageBitmap>((r) => { resolve = r })))
        const sink = vi.fn()
        const decoder = new FrameDecoder(sink)
        const pending = decoder.handle({ ...frame(800, 600), header: { ...frame(800, 600).header, format } })
        const video = { close: vi.fn() } as unknown as VideoFrame
        if (format === FrameFormat.H264) FakeVideoDecoder.outputs[0]!(video)
        if (stop === "forget") decoder.forget(W)
        else decoder.close()
        const bitmap = { close: vi.fn() } as unknown as ImageBitmap
        resolve(bitmap)
        await pending
        await Promise.resolve()
        await Promise.resolve()
        expect(sink).not.toHaveBeenCalled()
        expect(bitmap.close).toHaveBeenCalledOnce()
        if (format === FrameFormat.H264) expect(video.close).toHaveBeenCalledOnce()
      })
    }
  }

  for (const format of [FrameFormat.Jpeg, FrameFormat.H264]) {
    it(`never lets an older ${format} bitmap replace a newer completed frame`, async () => {
      const resolves: ((value: ImageBitmap) => void)[] = []
      vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise<ImageBitmap>((r) => resolves.push(r))))
      const sink = vi.fn()
      const decoder = new FrameDecoder(sink)
      const input = { ...frame(800, 600), header: { ...frame(800, 600).header, format } }
      const older = decoder.handle(input)
      if (format === FrameFormat.H264) FakeVideoDecoder.outputs[0]!({ close: vi.fn() } as unknown as VideoFrame)
      const newer = decoder.handle(input)
      if (format === FrameFormat.H264) FakeVideoDecoder.outputs[0]!({ close: vi.fn() } as unknown as VideoFrame)
      const a = { close: vi.fn() } as unknown as ImageBitmap
      const b = { close: vi.fn() } as unknown as ImageBitmap
      resolves[1]!(b)
      await newer
      resolves[0]!(a)
      await older
      expect(sink).toHaveBeenCalledTimes(1)
      expect(sink).toHaveBeenCalledWith(W, b)
      expect(a.close).toHaveBeenCalledOnce()
    })
  }

  it("drops a pending conversion from before a resize", async () => {
    let resolve!: (value: ImageBitmap) => void
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise<ImageBitmap>((r) => { resolve = r })))
    const sink = vi.fn()
    const decoder = new FrameDecoder(sink)
    await decoder.handle(frame(800, 600))
    FakeVideoDecoder.outputs[0]!({ close: vi.fn() } as unknown as VideoFrame)
    await decoder.handle(frame(1024, 768))
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    resolve(bitmap)
    await Promise.resolve()
    expect(sink).not.toHaveBeenCalled()
    expect(bitmap.close).toHaveBeenCalledOnce()
  })
  it("rejects queued old video output delivered after reconfiguration", async () => {
    const sink = vi.fn()
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const convert = vi.fn(async () => bitmap)
    vi.stubGlobal("createImageBitmap", convert)
    const decoder = new FrameDecoder(sink)
    await decoder.handle(frame(800, 600))
    await decoder.handle(frame(1024, 768))
    const old = { timestamp: 16_667, close: vi.fn() } as unknown as VideoFrame
    FakeVideoDecoder.outputs[0]!(old)
    await Promise.resolve()
    expect(convert).not.toHaveBeenCalled()
    expect(sink).not.toHaveBeenCalled()
    expect(old.close).toHaveBeenCalledOnce()
    const current = { timestamp: 33_334, close: vi.fn() } as unknown as VideoFrame
    FakeVideoDecoder.outputs[0]!(current)
    await Promise.resolve()
    expect(sink).toHaveBeenCalledWith(W, bitmap)
  })
})

describe("actual stream capability and fallback", () => {
  const hevc = (width = 4000, height = 3000): DecodedFrame => ({
    header: { window: W, width, height, format: FrameFormat.Hevc, keyframe: true },
    payload: new Uint8Array([0,0,0,1,0x42,1,1,1,0x60,0,0,3,0,0xb0,0,0,3,0,0,3,0,180]),
  })

  beforeEach(() => {
    stats.constructed = stats.configured = stats.closed = 0
    FakeVideoDecoder.outputs = []
    FakeVideoDecoder.decoded = []
    FakeVideoDecoder.decodeFailures = 0
    FakeVideoDecoder.errors = []
    FakeVideoDecoder.configs = []
    FakeVideoDecoder.refuseConfigure = false
    FakeVideoDecoder.refuseReconfigure = false
    FakeVideoDecoder.refuseConstruction = false
    FakeVideoDecoder.isConfigSupported.mockReset().mockImplementation(async config => ({ supported: true, config }))
    vi.stubGlobal("VideoDecoder", FakeVideoDecoder)
    vi.stubGlobal("EncodedVideoChunk", class {
      constructor(init: EncodedVideoChunkInit) { Object.assign(this, init) }
    })
  })

  it("configures and probes the real HEVC level and coded dimensions", async () => {
    const decoder = new FrameDecoder(() => {})
    await decoder.handle(hevc())
    const config = { codec: "hvc1.1.6.L180.B0", codedWidth: 4000, codedHeight: 3000, optimizeForLatency: true }
    expect(FakeVideoDecoder.configs).toEqual([config])
    expect(FakeVideoDecoder.isConfigSupported).toHaveBeenCalledExactlyOnceWith(config)
    await decoder.handle(hevc())
    expect(FakeVideoDecoder.isConfigSupported).toHaveBeenCalledTimes(1)
  })

  it("requests fallback once for unsupported HEVC, then allows H264", async () => {
    const fallback = vi.fn()
    FakeVideoDecoder.isConfigSupported.mockImplementation(async config => ({ supported: !config.codec.startsWith("hvc1"), config }))
    const decoder = new FrameDecoder(() => {}, fallback)
    await decoder.handle(hevc())
    expect(fallback).toHaveBeenCalledExactlyOnceWith("hevc", "Window 1 4000×3000: stream configuration is unsupported")
    await decoder.handle(hevc())
    expect(stats.constructed).toBe(1)
    await decoder.handle(frame(800,600))
    expect(stats.constructed).toBe(2)
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  for (const failure of ["refuseConstruction", "refuseConfigure"] as const) {
    it(`negotiates fallback when ${failure} throws`, async () => {
      const fallback = vi.fn()
      FakeVideoDecoder[failure] = true
      const decoder = new FrameDecoder(() => {}, fallback)
      await expect(decoder.handle(hevc())).resolves.toBeUndefined()
      expect(fallback).toHaveBeenCalledExactlyOnceWith("hevc", expect.any(String))
    })
  }

  it("attributes decoder errors to the current codec after a family change", async () => {
    const fallback = vi.fn()
    const decoder = new FrameDecoder(() => {}, fallback)
    await decoder.handle(hevc())
    await decoder.handle(frame(800,600))
    expect(stats.constructed).toBe(1)
    FakeVideoDecoder.errors[0]!(new DOMException("decode failed", "EncodingError"))
    expect(fallback).not.toHaveBeenCalled()
    expect(stats.constructed).toBe(2)
    FakeVideoDecoder.errors[1]!(new DOMException("decode failed again", "EncodingError"))
    expect(fallback).toHaveBeenCalledExactlyOnceWith("h264", expect.any(String))
  })

  it("replays the scaled keyframe once after an asynchronous EncodingError without needing another packet", async () => {
    const fallback = vi.fn()
    const decoder = new FrameDecoder(() => {}, fallback)
    await decoder.handle(frame(800, 600))
    await decoder.handle(frame(1600, 1200))
    FakeVideoDecoder.errors[0]!(new DOMException("resize failed", "EncodingError"))
    expect(fallback).not.toHaveBeenCalled()
    expect(stats.constructed).toBe(2)
    expect(stats.closed).toBe(1)
    expect(FakeVideoDecoder.configs.at(-1)).toMatchObject({ codedWidth: 1600, codedHeight: 1200 })
    expect(FakeVideoDecoder.decoded).toHaveLength(3)
    expect(FakeVideoDecoder.decoded.at(-1)).toMatchObject({ instance: 2, chunk: { type: "key" } })
    // Late callbacks from the replaced decoder cannot consume the retry.
    FakeVideoDecoder.errors[0]!(new DOMException("late resize failure", "EncodingError"))
    expect(fallback).not.toHaveBeenCalled()
    expect(stats.constructed).toBe(2)
  })

  it("retries a synchronous decode failure once, then stops on repeated failure", async () => {
    const fallback = vi.fn()
    const decoder = new FrameDecoder(() => {}, fallback)
    FakeVideoDecoder.decodeFailures = 2
    await decoder.handle(frame(1600, 1200))
    expect(stats.constructed).toBe(2)
    expect(FakeVideoDecoder.decoded).toHaveLength(2)
    expect(fallback).toHaveBeenCalledExactlyOnceWith("h264", expect.any(String))
    await decoder.handle(frame(1600, 1200))
    expect(stats.constructed).toBe(2)
  })

  it("requests one fresh keyframe after a delta error so an idle window can recover", async () => {
    const fallback = vi.fn()
    const requestKeyframe = vi.fn()
    const decoder = new FrameDecoder(() => {}, fallback, requestKeyframe)
    await decoder.handle(frame(800, 600))
    await decoder.handle(frame(800, 600, false))
    FakeVideoDecoder.errors[0]!(new DOMException("delta failed", "EncodingError"))
    expect(fallback).not.toHaveBeenCalled()
    expect(stats.closed).toBe(1)
    expect(stats.constructed).toBe(1)
    expect(requestKeyframe).toHaveBeenCalledExactlyOnceWith(W)
    // Neither an old callback nor queued deltas should issue another request.
    FakeVideoDecoder.errors[0]!(new DOMException("late delta error", "EncodingError"))
    await decoder.handle(frame(800, 600, false))
    expect(FakeVideoDecoder.decoded).toHaveLength(2)
    expect(requestKeyframe).toHaveBeenCalledOnce()
    await decoder.handle(frame(800, 600))
    expect(stats.constructed).toBe(2)
    expect(FakeVideoDecoder.decoded.at(-1)).toMatchObject({ instance: 2, chunk: { type: "key" } })
    FakeVideoDecoder.errors[1]!(new DOMException("keyframe also failed", "EncodingError"))
    expect(fallback).toHaveBeenCalledExactlyOnceWith("h264", expect.any(String))
    expect(requestKeyframe).toHaveBeenCalledOnce()
  })

  it("does not retry a confirmed NotSupportedError", async () => {
    const fallback = vi.fn()
    const decoder = new FrameDecoder(() => {}, fallback)
    await decoder.handle(frame(800, 600))
    FakeVideoDecoder.errors[0]!(new DOMException("unsupported profile", "NotSupportedError"))
    expect(stats.constructed).toBe(1)
    expect(fallback).toHaveBeenCalledExactlyOnceWith("h264", expect.any(String))
  })

  it("allows one new recovery when the stream configuration changes", async () => {
    const fallback = vi.fn()
    const decoder = new FrameDecoder(() => {}, fallback)
    await decoder.handle(frame(800, 600))
    FakeVideoDecoder.errors[0]!(new DOMException("first size failed", "EncodingError"))
    await decoder.handle(frame(1600, 1200))
    FakeVideoDecoder.errors[1]!(new DOMException("new size failed", "EncodingError"))
    expect(stats.constructed).toBe(3)
    expect(fallback).not.toHaveBeenCalled()
    FakeVideoDecoder.errors[2]!(new DOMException("new size failed again", "EncodingError"))
    expect(stats.constructed).toBe(3)
    expect(fallback).toHaveBeenCalledExactlyOnceWith("h264", expect.any(String))
  })

  it("keeps recovery bounded after successful output and discards retired decoder output", async () => {
    const fallback = vi.fn()
    const sink = vi.fn()
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const convert = vi.fn(async () => bitmap)
    vi.stubGlobal("createImageBitmap", convert)
    const decoder = new FrameDecoder(sink, fallback)
    await decoder.handle(frame(1600, 1200))
    FakeVideoDecoder.errors[0]!(new DOMException("first failure", "EncodingError"))
    const oldOutput = { timestamp: 16_667, close: vi.fn() } as unknown as VideoFrame
    FakeVideoDecoder.outputs[0]!(oldOutput)
    expect(oldOutput.close).toHaveBeenCalledOnce()
    expect(convert).not.toHaveBeenCalled()
    FakeVideoDecoder.outputs[1]!({ timestamp: 16_667, close: vi.fn() } as unknown as VideoFrame)
    await Promise.resolve()
    expect(sink).toHaveBeenCalledWith(W, bitmap)
    FakeVideoDecoder.errors[1]!(new DOMException("later failure at same size", "EncodingError"))
    expect(fallback).toHaveBeenCalledExactlyOnceWith("h264", expect.any(String))
    expect(stats.constructed).toBe(2)
  })

  it("ignores the retired support probe after replaying a keyframe", async () => {
    let finish!: (value: { supported: boolean; config: VideoDecoderConfig }) => void
    FakeVideoDecoder.isConfigSupported.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const fallback = vi.fn()
    const decoder = new FrameDecoder(() => {}, fallback)
    await decoder.handle(frame(1600, 1200))
    FakeVideoDecoder.errors[0]!(new DOMException("first failure", "EncodingError"))
    finish({ supported: false, config: FakeVideoDecoder.configs[0]! })
    await Promise.resolve()
    expect(stats.constructed).toBe(2)
    expect(fallback).not.toHaveBeenCalled()
  })

  it("retries a failed family only when that window's dimensions change", async () => {
    const fallback = vi.fn()
    FakeVideoDecoder.isConfigSupported.mockImplementationOnce(async config => ({ supported: false, config }))
    const decoder = new FrameDecoder(() => {}, fallback)
    await decoder.handle(hevc(4000, 3000))
    expect(decoder.retryResizedWindow(W, 4000, 3000)).toEqual([])
    expect(decoder.retryResizedWindow(2 as WindowId, 2000, 1500)).toEqual([])
    expect(decoder.retryResizedWindow(W, 2000, 1500)).toEqual(["hevc"])
    expect(decoder.retryResizedWindow(W, 2000, 1500)).toEqual([])
    await decoder.handle(hevc(2000, 1500))
    expect(stats.constructed).toBe(2)
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it("explicit retry clears failed codecs and invalidates old support checks", async () => {
    const fallback = vi.fn()
    FakeVideoDecoder.refuseConfigure = true
    const decoder = new FrameDecoder(() => {}, fallback)
    await decoder.handle(hevc())
    FakeVideoDecoder.refuseConfigure = false
    let finish!: (value: { supported: boolean; config: VideoDecoderConfig }) => void
    FakeVideoDecoder.isConfigSupported.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await decoder.handle(frame(800, 600))
    decoder.retryFailedCodecs()
    expect(decoder.retryResizedWindow(W, 2000, 1500)).toEqual([])
    finish({ supported: false, config: FakeVideoDecoder.configs.at(-1)! })
    await Promise.resolve()
    await decoder.handle(hevc())
    expect(stats.constructed).toBe(3)
    expect(fallback).toHaveBeenCalledExactlyOnceWith("hevc", expect.any(String))
    FakeVideoDecoder.errors[0]!(new DOMException("old failed decoder", "EncodingError"))
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  for (const transition of ["resize", "forget", "close", "jpeg"] as const) {
    it(`ignores a stale unsupported result after ${transition}`, async () => {
      let finish!: (value: { supported: boolean; config: VideoDecoderConfig }) => void
      FakeVideoDecoder.isConfigSupported.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      const fallback = vi.fn()
      const decoder = new FrameDecoder(() => {}, fallback)
      await decoder.handle(hevc())
      if (transition === "resize") await decoder.handle(hevc(2000,1500))
      if (transition === "forget") decoder.forget(W)
      if (transition === "close") decoder.close()
      if (transition === "jpeg") {
        vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close() {} })))
        await decoder.handle({ ...frame(800,600), header: { ...frame(800,600).header, format: FrameFormat.Jpeg } })
      }
      finish({ supported: false, config: FakeVideoDecoder.configs[0]! })
      await Promise.resolve()
      expect(fallback).not.toHaveBeenCalled()
    })
  }

  it("ignores a retired decoder error instead of retiring its replacement", async () => {
    const fallback = vi.fn()
    const decoder = new FrameDecoder(() => {}, fallback)
    await decoder.handle(frame(800,600))
    decoder.forget(W)
    await decoder.handle(frame(800,600))
    FakeVideoDecoder.errors[0]!(new DOMException("late error", "EncodingError"))
    expect(fallback).not.toHaveBeenCalled()
    expect(stats.closed).toBe(1)
  })

  it("does not submit a truncated SPS to an existing decoder", async () => {
    const decoder = new FrameDecoder(() => {})
    await decoder.handle(hevc())
    const broken = hevc()
    broken.payload = broken.payload.slice(0,10)
    await decoder.handle(broken)
    expect(stats.closed).toBe(1)
    await decoder.handle({ ...hevc(), header: { ...hevc().header, keyframe: false } })
    expect(stats.constructed).toBe(1)
    await decoder.handle(hevc())
    expect(stats.constructed).toBe(2)
  })

  it("waits for a keyframe when dimensions change before the next keyframe", async () => {
    const decoder = new FrameDecoder(() => {})
    await decoder.handle(frame(800,600))
    await decoder.handle(frame(1600,1200,false))
    expect(stats.closed).toBe(1)
    await decoder.handle(frame(1600,1200,false))
    expect(stats.constructed).toBe(1)
    await decoder.handle(frame(1600,1200))
    expect(stats.constructed).toBe(2)
  })
})
