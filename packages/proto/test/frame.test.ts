/**
 * Binary frame parity with the Rust encoder.
 *
 * The header is a hand-written byte layout on both sides, which is exactly the
 * kind of thing that drifts silently: a wrong offset shows up as pixels in the
 * wrong window, not as an error. The fixture below is produced by the Rust
 * implementation.
 */

import { describe, expect, it } from "vitest"
import {
  FRAME_HEADER_LEN,
  FRAME_VERSION,
  FrameFormat,
  decodeFrame,
} from "../src/index.js"

/** Byte-for-byte what `FrameHeader::encode_with_payload` produces. */
function rustFrame(
  id: number,
  width: number,
  height: number,
  payload: number[],
): ArrayBuffer {
  const buf = new ArrayBuffer(FRAME_HEADER_LEN + payload.length)
  const bytes = new Uint8Array(buf)
  const view = new DataView(buf)
  bytes.set([0x4c, 0x57, 0x46, 0x41], 0) // "LWFA"
  bytes[4] = FRAME_VERSION
  bytes[5] = FrameFormat.Jpeg
  view.setBigUint64(8, BigInt(id), true)
  view.setUint32(16, width, true)
  view.setUint32(20, height, true)
  bytes.set(payload, FRAME_HEADER_LEN)
  return buf
}

describe("binary frames", () => {
  it("decodes a frame the Rust side would emit", () => {
    const payload = [0xff, 0xd8, 0xff, 0xe0]
    const frame = decodeFrame(rustFrame(7, 1261, 1390, payload))
    expect(frame).not.toBeNull()
    expect(frame!.header).toEqual({
      window: 7,
      width: 1261,
      height: 1390,
      format: FrameFormat.Jpeg,
    })
    expect([...frame!.payload]).toEqual(payload)
  })

  it("agrees with Rust on the header size", () => {
    // Both sides slice at this offset; a mismatch shifts every pixel.
    expect(FRAME_HEADER_LEN).toBe(24)
    const frame = decodeFrame(rustFrame(1, 2, 2, []))
    expect(frame!.payload.length).toBe(0)
  })

  it("rejects a foreign binary message", () => {
    const junk = new TextEncoder().encode("not a frame, just some bytes here!!")
    expect(decodeFrame(junk.buffer as ArrayBuffer)).toBeNull()
  })

  it("rejects a future version", () => {
    const buf = rustFrame(1, 10, 10, [0])
    new Uint8Array(buf)[4] = FRAME_VERSION + 1
    expect(decodeFrame(buf)).toBeNull()
  })

  it("rejects an unknown format", () => {
    const buf = rustFrame(1, 10, 10, [0])
    new Uint8Array(buf)[5] = 99
    expect(decodeFrame(buf)).toBeNull()
  })

  it("rejects a truncated header", () => {
    const full = rustFrame(1, 10, 10, [1, 2, 3])
    for (let len = 0; len < FRAME_HEADER_LEN; len++) {
      expect(decodeFrame(full.slice(0, len)), `${len} bytes`).toBeNull()
    }
  })

  it("rejects zero dimensions", () => {
    expect(decodeFrame(rustFrame(1, 0, 10, [0]))).toBeNull()
    expect(decodeFrame(rustFrame(1, 10, 0, [0]))).toBeNull()
  })

  it("rejects a window id too large to represent exactly", () => {
    // u64 on the wire, double in JS. Silently rounding would put pixels in the
    // wrong window, so this refuses rather than approximates.
    const buf = rustFrame(1, 10, 10, [0])
    new DataView(buf).setBigUint64(8, BigInt(Number.MAX_SAFE_INTEGER) + 10n, true)
    expect(decodeFrame(buf)).toBeNull()
  })

  it("reads little-endian, matching Rust", () => {
    // Getting the endianness backwards would turn window 1 into 2^56.
    const frame = decodeFrame(rustFrame(1, 256, 1, [0]))
    expect(frame!.header.window).toBe(1)
    expect(frame!.header.width).toBe(256)
  })
})
