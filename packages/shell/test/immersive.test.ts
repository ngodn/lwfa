import { describe, expect, it, vi } from "vitest"
import { boundedPosition, createImmersive, type FullscreenHost } from "../src/lib/immersive"

function fixture() {
  let active = false
  let changed = () => {}
  const host: FullscreenHost = {
    available: () => true,
    active: () => active,
    standalone: () => false,
    enter: vi.fn(async () => { active = true; changed() }),
    exit: vi.fn(async () => { active = false; changed() }),
    listen: (listener) => { changed = listener; return () => { changed = () => {} } },
  }
  const mode = createImmersive(host)
  const stop = mode.start()
  return { host, mode, stop, browserExit: () => { active = false; changed() } }
}

describe("immersive browser lifecycle", () => {
  it("requests fullscreen synchronously and reveals navigation independently", async () => {
    const { host, mode } = fixture()
    const entered = mode.toggle()
    expect(host.enter).toHaveBeenCalledOnce()
    await entered
    expect(mode.snapshot()).toMatchObject({ mode: "fullscreen", navigation: false, pending: false })
    mode.toggleNavigation()
    expect(mode.snapshot().navigation).toBe(true)
    mode.toggleNavigation()
    expect(mode.snapshot().navigation).toBe(false)
    expect(host.enter).toHaveBeenCalledOnce()
    expect(host.exit).not.toHaveBeenCalled()
  })

  it("restores ordinary chrome after browser-driven exit", async () => {
    const { mode, browserExit } = fixture()
    await mode.toggle()
    mode.toggleNavigation()
    browserExit()
    expect(mode.snapshot()).toEqual({ mode: "off", navigation: false, pending: false, error: null })
  })

  it("keeps navigation available when fullscreen is denied", async () => {
    const { host, mode } = fixture()
    host.enter = vi.fn().mockRejectedValue(new Error("Denied"))
    await mode.toggle()
    expect(mode.snapshot()).toMatchObject({ mode: "off", pending: false })
    expect(mode.snapshot().error).toContain("could not enter fullscreen")
  })

  it("does not pretend unsupported fullscreen succeeded", async () => {
    const { host, mode } = fixture()
    host.available = () => false
    await mode.toggle()
    expect(host.enter).not.toHaveBeenCalled()
    expect(mode.snapshot().mode).toBe("off")
    expect(mode.snapshot().error).toContain("unavailable")
  })

  it("can hide chrome in an already installed standalone app", async () => {
    const { host, mode } = fixture()
    host.standalone = () => true
    host.available = () => false
    await mode.toggle()
    expect(mode.snapshot().mode).toBe("standalone")
    expect(host.enter).not.toHaveBeenCalled()
    await mode.toggle()
    expect(mode.snapshot().mode).toBe("off")
    expect(host.exit).not.toHaveBeenCalled()
  })

  it("ignores repeated entry clicks until the browser settles", async () => {
    const { host, mode } = fixture()
    let reject!: (error: Error) => void
    host.enter = vi.fn(() => new Promise<void>((_, no) => { reject = no }))
    const first = mode.toggle()
    await mode.toggle()
    expect(host.enter).toHaveBeenCalledOnce()
    reject(new Error("Denied"))
    await first
    expect(mode.snapshot().pending).toBe(false)
  })

  it("preserves the exit control if browser exit fails", async () => {
    const { host, mode } = fixture()
    await mode.toggle()
    mode.toggleNavigation()
    host.exit = vi.fn().mockRejectedValue(new Error("Denied"))
    await mode.toggle()
    expect(mode.snapshot()).toMatchObject({ mode: "fullscreen", navigation: true, pending: false })
    expect(mode.snapshot().error).toContain("Could not exit")
  })

  it("leaves owned fullscreen when the shell unmounts", async () => {
    const { host, mode, stop } = fixture()
    await mode.toggle()
    stop()
    expect(host.exit).toHaveBeenCalledOnce()
    expect(mode.snapshot().mode).toBe("off")
  })

  it("cleans up a fullscreen request accepted after the shell unmounts", async () => {
    const { host, mode, stop } = fixture()
    let resolve!: () => void
    host.enter = vi.fn(() => new Promise<void>((yes) => { resolve = yes }))
    const entering = mode.toggle()
    stop()
    host.active = () => true
    resolve()
    await entering
    expect(host.exit).toHaveBeenCalledOnce()
    expect(mode.snapshot().mode).toBe("off")
  })
})

it("keeps saved floating positions within the screen after resize or malformed storage", () => {
  expect(boundedPosition({ x: -5, y: 8 })).toEqual({ x: 0, y: 1 })
  expect(boundedPosition({ x: NaN, y: Infinity })).toEqual({ x: 0.5, y: 0.5 })
  expect(boundedPosition({ x: 0.2, y: 0.7 })).toEqual({ x: 0.2, y: 0.7 })
})
