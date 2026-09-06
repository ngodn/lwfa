import { afterEach, describe, expect, it, vi } from "vitest"
// @ts-expect-error -- shared by standalone Node probe scripts
import { waitForOpen } from "../../../scripts/websocket-open.mjs"

class Socket extends EventTarget {
  readyState = 0
}

afterEach(() => vi.useRealTimers())

describe("probe handshake lifecycle", () => {
  it("rejects a stalled handshake and removes its listeners", async () => {
    vi.useFakeTimers()
    const socket = new Socket()
    const remove = vi.spyOn(socket, "removeEventListener")
    const result = expect(waitForOpen(socket, 50)).rejects.toThrow("timed out")
    await vi.advanceTimersByTimeAsync(50)
    await result
    expect(remove).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("rejects close during handshake without waiting for the deadline", async () => {
    vi.useFakeTimers()
    const socket = new Socket()
    const result = expect(waitForOpen(socket)).rejects.toThrow("closed before opening")
    socket.dispatchEvent(new Event("close"))
    await result
    expect(vi.getTimerCount()).toBe(0)
  })

  it("clears the deadline on open and handles already-closed sockets", async () => {
    vi.useFakeTimers()
    const socket = new Socket()
    const pending = waitForOpen(socket)
    socket.dispatchEvent(new Event("open"))
    await pending
    expect(vi.getTimerCount()).toBe(0)
    socket.readyState = 3
    await expect(waitForOpen(socket)).rejects.toThrow("closed before opening")
  })
})
