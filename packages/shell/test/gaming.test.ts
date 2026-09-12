import { afterEach, describe, expect, it, vi } from "vitest"
import { gamingReply, getGaming, parseGamingStatus, requestGaming, resetGaming } from "../src/lib/gaming"
import type { ToEngine } from "@lwfa/proto"

const inventory = {
  games: [{ appid: "123", name: "Example Game", directory: "/games/Example" }],
  profiles: { "123": { provider: "off" } }, proton: { tools: [] },
  lsfg: { installed: false, version: "1.0.0" }, framegen: { installed: false, version: "0.9.4" },
  launchOption: "'/a path/lwfa-game' %command%", streamTargetFps: 60,
}
afterEach(() => { resetGaming(); vi.useRealTimers() })

function start(action: "status" | "install" = "status") {
  const sent: ToEngine[] = []
  const send = (message: ToEngine) => { sent.push(message) }
  requestGaming(send, action, action === "install" ? { component: "lsfg" } : {})
  const message = sent[0]
  if (message?.type !== "gaming") throw new Error("Missing request")
  return { request: message.request, send, sent }
}

describe("gaming component requests", () => {
  it("keeps an install pending until its own completion, ignoring stale replies", () => {
    const { request, send, sent } = start("install")
    gamingReply({ type: "gaming", request: request - 1, data: inventory, error: null })
    expect(getGaming().pending).toContain("Installing")
    requestGaming(send, "install", { component: "proton" })
    expect(sent).toHaveLength(1)
    gamingReply({ type: "gaming", request, data: inventory, error: null })
    expect(getGaming().pending).toBeNull()
    expect(getGaming().status?.games[0]?.name).toBe("Example Game")
  })

  it("rejects a previous connection's reply after reconnect", () => {
    const previous = start()
    resetGaming()
    const next = start()
    gamingReply({ type: "gaming", request: previous.request, data: inventory, error: null })
    expect(getGaming().status).toBeNull()
    gamingReply({ type: "gaming", request: next.request, data: inventory, error: null })
    expect(getGaming().status).not.toBeNull()
  })

  it("reports failures without pretending the component installed", () => {
    const { request } = start("install")
    gamingReply({ type: "gaming", request, data: null, error: "Checksum mismatch" })
    expect(getGaming()).toMatchObject({ pending: null, error: "Checksum mismatch", status: null })
  })

  it("times out and permits a status refresh without repeating installation", () => {
    vi.useFakeTimers()
    start("install")
    vi.advanceTimersByTime(1_810_000)
    expect(getGaming().pending).toBeNull()
    expect(getGaming().error).toContain("Refresh")
    expect(start().sent).toHaveLength(1)
  })

  it("rejects malformed nested inventory before rendering it", () => {
    for (const value of [null, {}, { ...inventory, lsfg: { lsfg: inventory.lsfg } },
      { ...inventory, games: [{}] }, { ...inventory, profiles: { "123": { provider: "lsfg", lsfg: [] } } }]) {
      expect(() => parseGamingStatus(value)).toThrow()
    }
  })
})
