/**
 * Deciding which codec to send by asking, not by guessing.
 *
 * The shell used to report one boolean answered by "does `VideoDecoder`
 * exist", which is a different question from "can you decode this". The
 * tempting next step is to decide from the user agent, and that is wrong in
 * both directions: an iPad older than the A9 has no HEVC decoder, and plenty
 * of non-Apple machines have had one for a decade. Guessing gives a client
 * either a stream it cannot play, which is a black window, or denies it one it
 * could have used.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { PREFERENCE, choose, chooseForAll, decodable } from "../src/lib/codecs"

/** Stand in for `VideoDecoder`, accepting only the codecs named. */
function withDecoder(accepts: string[] | null) {
  if (accepts === null) {
    Object.defineProperty(globalThis, "VideoDecoder", { value: undefined, configurable: true })
    return
  }
  Object.defineProperty(globalThis, "VideoDecoder", {
    value: {
      isConfigSupported: vi.fn(async (config: { codec: string }) => ({
        supported: accepts.some((prefix) => config.codec.startsWith(prefix)),
      })),
    },
    configurable: true,
  })
}

afterEach(() => {
  Object.defineProperty(globalThis, "VideoDecoder", { value: undefined, configurable: true })
})

describe("asking the browser", () => {
  it("reports both when both are decodable", async () => {
    withDecoder(["hvc1", "avc1"])
    expect(await decodable()).toEqual(["hevc", "h264"])
  })

  it("reports only H.264 on a device with no HEVC decoder", async () => {
    // An older iPad, or a desktop without the hardware. This is the case the
    // user-agent guess gets wrong.
    withDecoder(["avc1"])
    expect(await decodable()).toEqual(["h264"])
  })

  it("reports HEVC even where H.264 is refused", async () => {
    // Not expected, but the order must come from the answers rather than from
    // an assumption that H.264 is always available.
    withDecoder(["hvc1"])
    expect(await decodable()).toEqual(["hevc"])
  })

  it("reports nothing where WebCodecs is missing", async () => {
    // `VideoDecoder` is secure-context only, so a tablet on plain HTTP over a
    // LAN has no decoder at all and needs JPEG.
    withDecoder(null)
    expect(await decodable()).toEqual([])
  })

  it("reports nothing when everything is refused", async () => {
    withDecoder([])
    expect(await decodable()).toEqual([])
  })

  it("survives an implementation that throws instead of refusing", async () => {
    Object.defineProperty(globalThis, "VideoDecoder", {
      value: {
        isConfigSupported: async () => {
          throw new TypeError("bad config")
        },
      },
      configurable: true,
    })
    expect(await decodable()).toEqual([])
  })

  it("asks at a real size", async () => {
    // Some implementations answer differently for sizes the hardware cannot
    // manage, so probing at 16x16 would produce a confident wrong answer.
    withDecoder(["hvc1", "avc1"])
    await decodable()
    const probe = (globalThis as unknown as { VideoDecoder: { isConfigSupported: ReturnType<typeof vi.fn> } })
      .VideoDecoder.isConfigSupported
    for (const [config] of probe.mock.calls) {
      expect(config.codedWidth).toBeGreaterThanOrEqual(1280)
      expect(config.codedHeight).toBeGreaterThanOrEqual(720)
    }
  })
})

describe("choosing for one client", () => {
  it("prefers HEVC when it is on offer", () => {
    // Roughly a third fewer bits for the same picture.
    expect(choose(["h264", "hevc"])).toBe("hevc")
    expect(PREFERENCE[0]).toBe("hevc")
  })

  it("falls back to H.264 rather than refusing", () => {
    expect(choose(["h264"])).toBe("h264")
  })

  it("gives nothing when the client can decode nothing", () => {
    expect(choose([])).toBeNull()
  })
})

describe("choosing for everyone at once", () => {
  it("uses HEVC only when every client can take it", () => {
    // One encode is fanned out to all clients, so a codec one of them cannot
    // read is a black window for that one.
    expect(chooseForAll([["hevc", "h264"], ["hevc", "h264"]])).toBe("hevc")
  })

  it("drops to H.264 when one client cannot take HEVC", () => {
    expect(chooseForAll([["hevc", "h264"], ["h264"]])).toBe("h264")
  })

  it("gives nothing when one client can decode nothing at all", () => {
    // A tablet on plain HTTP among laptops. Everyone gets JPEG, which is the
    // honest outcome of encoding once.
    expect(chooseForAll([["hevc", "h264"], []])).toBeNull()
  })

  it("gives nothing when nobody is connected", () => {
    expect(chooseForAll([])).toBeNull()
  })

  it("does not care what order a client lists its codecs in", () => {
    expect(chooseForAll([["h264", "hevc"], ["hevc", "h264"]])).toBe("hevc")
  })
})

/**
 * Audio: the shell bundles a WASM Opus decoder, so "can this client decode
 * Opus" is a property of the bundle, not the browser. These tests pin that:
 * the old environment-dependent answer is what silently put every listener
 * on raw PCM at 1.5 Mbit/s whenever one browser lacked an `AudioDecoder`
 * (any Safari before 26, or any page on plain HTTP).
 */
describe("asking about Opus", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "AudioDecoder", { value: undefined, configurable: true })
  })

  it("says yes even where there is no AudioDecoder at all", async () => {
    // Plain HTTP over a LAN, which is exactly how a tablet reaches this. The
    // WASM decoder needs no secure context, so the answer no longer depends
    // on the origin.
    const { decodesOpus } = await import("../src/lib/codecs")
    Object.defineProperty(globalThis, "AudioDecoder", { value: undefined, configurable: true })
    expect(await decodesOpus()).toBe(true)
  })

  it("says yes with a native decoder present too", async () => {
    const { decodesOpus } = await import("../src/lib/codecs")
    Object.defineProperty(globalThis, "AudioDecoder", {
      value: { isConfigSupported: async () => ({ supported: true }) },
      configurable: true,
    })
    expect(await decodesOpus()).toBe(true)
  })
})
