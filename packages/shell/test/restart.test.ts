import { afterEach, describe, expect, it, vi } from "vitest"
import { supportsRestart } from "../src/lib/restart.js"
import { decodeToEngine } from "@lwfa/proto"
import { isPending, markPending, resetPending, resolvePending } from "../src/lib/pending.js"

afterEach(() => { resetPending(); vi.useRealTimers() })

describe("service restart compatibility", () => {
  it.each([null, "invalid", "1.4.99", "1.5.3", "0.9.0"])("does not offer unsupported restart for %s", version => {
    expect(supportsRestart(version)).toBe(false)
  })
  it.each(["1.5.4", "1.5.4-dev", "1.5.10", "1.6.0", "2.0.0"])("supports restart for %s", version => {
    expect(supportsRestart(version)).toBe(true)
  })
  it("accepts only the fixed restart action, without a service or command argument", () => {
    expect(decodeToEngine('{"type":"restartEngine"}')).toEqual({ type: "restartEngine" })
    expect(() => decodeToEngine('{"type":"restartEngine","service":"other.service"}')).toThrow()
    expect(() => decodeToEngine('{"type":"restartEngine","command":"anything"}')).toThrow()
  })
  it("reenables the action and reports an unconfirmed restart after the deadline", () => {
    vi.useFakeTimers()
    const timeout = vi.fn()
    markPending("restartEngine", 30_000, timeout)
    expect(isPending("restartEngine")).toBe(true)
    vi.advanceTimersByTime(30_000)
    expect(isPending("restartEngine")).toBe(false)
    expect(timeout).toHaveBeenCalledOnce()
  })
  it("does not report a timeout after reconnect or an immediate error", () => {
    vi.useFakeTimers()
    const timeout = vi.fn()
    markPending("restartEngine", 30_000, timeout)
    resolvePending("restartEngine")
    vi.advanceTimersByTime(30_000)
    expect(timeout).not.toHaveBeenCalled()
  })
})
