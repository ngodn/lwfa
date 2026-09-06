import { describe, expect, it } from "vitest"
// @ts-expect-error -- the Node CLI intentionally ships as standalone JavaScript
import { decodeEvents, limits, validateDeviceName } from "../../../scripts/record-gamepad.mjs"

function event(seconds: bigint, micros: bigint, type: number, code: number, value: number) {
  const bytes = Buffer.alloc(24)
  bytes.writeBigInt64LE(seconds)
  bytes.writeBigInt64LE(micros, 8)
  bytes.writeUInt16LE(type, 16)
  bytes.writeUInt16LE(code, 18)
  bytes.writeInt32LE(value, 20)
  return bytes
}

describe("passive kernel controller recording", () => {
  it("preserves two edges a few microseconds apart inside one read", () => {
    const bytes = Buffer.concat([event(123n, 10n, 1, 304, 1), event(123n, 15n, 1, 304, 0)])
    expect(decodeEvents(bytes, 987654321n, 2)).toEqual([
      { kernelTimeUs: "123000010", observedMonotonicUs: "987654321", type: 1, code: 304, value: 1 },
      { kernelTimeUs: "123000015", observedMonotonicUs: "987654321", type: 1, code: 304, value: 0 },
    ])
  })

  it("keeps signed axes and kernel overflow markers", () => {
    const decoded = decodeEvents(Buffer.concat([event(1n, 0n, 3, 0, -32767), event(1n, 1n, 0, 3, 0)]), 1n, 2)
    expect(decoded[0].value).toBe(-32767)
    expect(decoded[1]).toMatchObject({ type: 0, code: 3 })
  })

  it("caps a final batch at remaining capacity and rejects partial records", () => {
    const bytes = Buffer.concat([event(1n, 0n, 1, 304, 1), event(1n, 1n, 1, 304, 0)])
    expect(decodeEvents(bytes, 1n, 1)).toHaveLength(1)
    expect(decodeEvents(bytes, 1n, 0)).toHaveLength(0)
    expect(() => decodeEvents(bytes.subarray(0, 25), 1n, 2)).toThrow("Partial")
  })

  it("bounds recording duration and event capacity", () => {
    expect(limits()).toEqual({ duration: 30, maxEvents: 50000 })
    for (const seconds of ["0", "121", "NaN", "Infinity"]) expect(() => limits(seconds)).toThrow()
    for (const count of ["0", "1.5", "100001", "Infinity"]) expect(() => limits("1", count)).toThrow()
  })

  it("refuses keyboard and lookalike device names", () => {
    expect(() => validateDeviceName("lwfa virtual controller\n")).not.toThrow()
    for (const name of ["AT Translated Set 2 keyboard", "lwfa virtual controller keyboard", "mouse"]) {
      expect(() => validateDeviceName(name)).toThrow("Refusing")
    }
  })
})
