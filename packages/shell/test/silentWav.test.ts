/**
 * The unmuter's silent WAV.
 *
 * This file exists because of one bug: the previous inline WAV declared a
 * zero-length data chunk, and a looping media element with zero-duration
 * audio seeks forever at main-thread speed. Enabling audio wedged the whole
 * page within seconds, in every browser. These tests make that WAV shape
 * impossible to reintroduce quietly.
 */

import { describe, expect, it } from "vitest"
import { silentWav } from "../src/lib/audio"

describe("the silent WAV", () => {
  const wav = new DataView(silentWav())
  const text = (at: number, length: number) =>
    String.fromCharCode(...new Uint8Array(wav.buffer, at, length))

  it("is a coherent RIFF/WAVE file", () => {
    expect(text(0, 4)).toBe("RIFF")
    expect(text(8, 4)).toBe("WAVE")
    expect(text(12, 4)).toBe("fmt ")
    expect(text(36, 4)).toBe("data")
    // The RIFF size field covers everything after itself.
    expect(wav.getUint32(4, true)).toBe(wav.byteLength - 8)
  })

  it("actually contains audio, because zero samples looping is a busy-loop", () => {
    const dataLength = wav.getUint32(40, true)
    expect(dataLength).toBeGreaterThan(0)
    expect(wav.byteLength).toBe(44 + dataLength)

    // At least 50ms at the declared rate: long enough that looping it is a
    // handful of events a second rather than a storm.
    const rate = wav.getUint32(24, true)
    const bytesPerFrame = wav.getUint16(32, true)
    const seconds = dataLength / bytesPerFrame / rate
    expect(seconds).toBeGreaterThanOrEqual(0.05)
  })

  it("is silence", () => {
    const samples = new Int16Array(wav.buffer, 44)
    expect(samples.every((sample) => sample === 0)).toBe(true)
  })
})
