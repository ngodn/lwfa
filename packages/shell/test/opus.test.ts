/**
 * The Opus stream, with the decoder faked.
 *
 * The point of these tests is the plumbing around the decoders, not the
 * decoders themselves: which one is chosen, what happens to packets that
 * arrive while WASM is still compiling, and that a mono result never plays
 * into one ear. Real libopus output is covered by listening to it.
 */

import { afterEach, describe, expect, it } from "vitest"
import { OpusStream, type WasmOpus } from "../src/lib/opus"

/** A controllable stand-in for the WASM decoder. */
function fakeWasm(planes: () => Float32Array[]) {
  let ready = () => {}
  let failed = (_reason?: unknown) => {}
  const decoded: Uint8Array[] = []
  const wasm: WasmOpus & {
    finish: () => Promise<void>
    fail: () => Promise<void>
    decoded: Uint8Array[]
    freed: () => boolean
  } = {
    ready: new Promise<void>((resolve, reject) => {
      ready = resolve
      failed = reject
    }),
    decodeFrame(packet: Uint8Array) {
      decoded.push(packet)
      const channelData = planes()
      return { channelData, samplesDecoded: channelData[0]?.length ?? 0 }
    },
    free() {
      freed = true
    },
    finish: async () => {
      ready()
      // A macrotask, so however many microtask hops the stream's promise
      // chain has, they have all run before the test asserts.
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    fail: async () => {
      failed(new Error("no wasm"))
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    decoded,
    freed: () => freed,
  }
  let freed = false
  return wasm
}

const packet = (...bytes: number[]) => new Uint8Array(bytes)

afterEach(() => {
  Object.defineProperty(globalThis, "AudioDecoder", { value: undefined, configurable: true })
})

describe("the WASM fallback", () => {
  it("queues packets while compiling and decodes them in order", async () => {
    const wasm = fakeWasm(() => [new Float32Array(960), new Float32Array(960)])
    const sunk: number[] = []
    const stream = new OpusStream((left) => sunk.push(left.length), () => wasm)

    stream.push(packet(1), 960)
    stream.push(packet(2), 960)
    expect(wasm.decoded).toHaveLength(0)

    await wasm.finish()
    expect(wasm.decoded.map((p) => p[0])).toEqual([1, 2])
    expect(sunk).toEqual([960, 960])
  })

  it("copies queued packets rather than trusting a socket buffer to survive", async () => {
    const wasm = fakeWasm(() => [new Float32Array(4)])
    const stream = new OpusStream(() => {}, () => wasm)

    const wire = packet(7, 7, 7)
    stream.push(wire, 960)
    // The socket buffer gets reused before the queue drains.
    wire.fill(0)

    await wasm.finish()
    expect(wasm.decoded[0]![0]).toBe(7)
  })

  it("duplicates a mono plane rather than playing one ear", async () => {
    const mono = new Float32Array([0.5, -0.5])
    const wasm = fakeWasm(() => [mono])
    let ears: [Float32Array, Float32Array] | null = null
    const stream = new OpusStream((left, right) => {
      ears = [left, right]
    }, () => wasm)

    // The decoder exists from the first push, so the push comes first and
    // the packet rides the compile queue.
    stream.push(packet(1), 2)
    await wasm.finish()

    expect(ears).not.toBeNull()
    const [left, right] = ears!
    expect(Array.from(right)).toEqual(Array.from(left))
    // Distinct buffers, because the player transfers both.
    expect(right.buffer).not.toBe(left.buffer)
  })

  it("gives up quietly when the WASM cannot load", async () => {
    const wasm = fakeWasm(() => [new Float32Array(4)])
    const stream = new OpusStream(() => {}, () => wasm)

    stream.push(packet(1), 960)
    await wasm.fail()
    stream.push(packet(2), 960)

    expect(wasm.decoded).toHaveLength(0)
    expect(stream.path()).toBe("none")
  })

  it("frees the decoder on close and decodes nothing afterwards", async () => {
    const wasm = fakeWasm(() => [new Float32Array(4)])
    const stream = new OpusStream(() => {}, () => wasm)
    stream.push(packet(1), 960)
    await wasm.finish()
    wasm.decoded.length = 0

    stream.close()
    stream.push(packet(2), 960)

    expect(wasm.freed()).toBe(true)
    expect(wasm.decoded).toHaveLength(0)
  })
})

describe("choosing a decoder", () => {
  it("prefers the native AudioDecoder when the browser has one", () => {
    const configured: unknown[] = []
    class FakeNative {
      constructor(_init: unknown) {}
      configure(config: unknown) {
        configured.push(config)
      }
      decode() {}
      close() {}
    }
    Object.defineProperty(globalThis, "AudioDecoder", {
      value: FakeNative,
      configurable: true,
    })

    const wasm = fakeWasm(() => [new Float32Array(4)])
    const stream = new OpusStream(() => {}, () => wasm)
    stream.push(packet(1), 960)

    expect(stream.path()).toBe("native")
    expect(configured).toHaveLength(1)
    expect(wasm.decoded).toHaveLength(0)
  })

  it("falls back to WASM when the native decoder cannot be built", async () => {
    class Broken {
      constructor() {
        throw new Error("nope")
      }
    }
    Object.defineProperty(globalThis, "AudioDecoder", { value: Broken, configurable: true })

    const wasm = fakeWasm(() => [new Float32Array(4)])
    const stream = new OpusStream(() => {}, () => wasm)
    stream.push(packet(1), 960)
    await wasm.finish()

    expect(stream.path()).toBe("wasm")
    expect(wasm.decoded).toHaveLength(1)
  })
})
