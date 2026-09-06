import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as audio from "../src/lib/audio"

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

let moduleLoad: ReturnType<typeof deferred> | null = null
let contextClose: ReturnType<typeof deferred> | null = null

class Context {
  static instances: Context[] = []
  state = "running"
  currentTime = 1
  sampleRate = 48000
  destination = {}
  audioWorklet = moduleLoad ? { addModule: () => moduleLoad!.promise } : undefined
  sources: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = []
  constructor() { Context.instances.push(this) }
  createGain() {
    return { connect() {}, disconnect() {}, gain: { setTargetAtTime() {} } }
  }
  createBuffer(_channels: number, frames: number) {
    return { getChannelData: () => new Float32Array(frames), copyToChannel() {} }
  }
  createBufferSource() {
    const source = { connect() {}, disconnect() {}, start: vi.fn(), stop: vi.fn(), onended: null }
    this.sources.push(source)
    return source
  }
  async resume() { this.state = "running" }
  async close() { this.state = "closed"; await contextClose?.promise }
}

beforeEach(() => {
  Context.instances = []
  moduleLoad = null
  contextClose = null
  vi.stubGlobal("navigator", { audioSession: { type: "auto" } })
  vi.stubGlobal("AudioContext", Context)
  vi.stubGlobal("AudioWorkletNode", class {
    port = { postMessage() {}, onmessage: null }
    connect() {}
    disconnect() {}
  })
})

afterEach(async () => {
  moduleLoad?.resolve()
  contextClose?.resolve()
  await audio.stop()
  vi.unstubAllGlobals()
})

describe("audio graph lifecycle", () => {
  it("reuses scheduled playback on reconnect", async () => {
    expect(await audio.start()).toBe(true)
    expect(await audio.start()).toBe(true)
    expect(Context.instances).toHaveLength(1)
  })

  it("reports success to concurrent starts without a worklet", async () => {
    expect(await Promise.all([audio.start(), audio.start()])).toEqual([true, true])
    expect(Context.instances).toHaveLength(1)
  })

  it("finishes graph setup while autoplay keeps resume pending", async () => {
    const pending = deferred()
    vi.spyOn(Context.prototype, "resume").mockImplementation(() => pending.promise)
    const started = await Promise.race([
      audio.start(),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 25)),
    ])
    pending.resolve()
    vi.restoreAllMocks()
    expect(started).toBe(true)
  })

  it("does not resurrect audio switched off during worklet loading", async () => {
    moduleLoad = deferred()
    const starting = audio.start()
    await audio.stop()
    moduleLoad.resolve()
    expect(await starting).toBe(false)
    expect(audio.playbackPath()).toBe("none")
    expect(Context.instances[0]!.state).toBe("closed")
  })

  it("does not clear a new graph when the old context finishes closing", async () => {
    await audio.start()
    contextClose = deferred()
    const stopping = audio.stop()
    await audio.start()
    contextClose.resolve()
    await stopping
    expect(audio.isRunning()).toBe(true)
  })

  it("cancels queued scheduled audio before re-priming after reconnect", async () => {
    await audio.start()
    for (let i = 0; i < 8; i++) audio.play(new Int16Array(1920))
    const ctx = Context.instances[0]!
    const stale = [...ctx.sources]
    audio.flush()
    audio.play(new Int16Array(1920))
    expect(stale.every((source) => source.stop.mock.calls.length === 1)).toBe(true)
    expect(ctx.sources.at(-1)!.stop).not.toHaveBeenCalled()
  })

  it("cancels scheduled audio when a loaded worklet takes over playback", async () => {
    moduleLoad = deferred()
    const starting = audio.start()
    for (let i = 0; i < 8; i++) audio.play(new Int16Array(1920))
    const ctx = Context.instances[0]!
    const scheduledBeforeWorklet = [...ctx.sources]
    expect(scheduledBeforeWorklet.length).toBeGreaterThan(0)
    moduleLoad.resolve()
    expect(await starting).toBe(true)
    expect(audio.playbackPath()).toBe("worklet")
    expect(scheduledBeforeWorklet.every((source) => source.stop.mock.calls.length === 1)).toBe(true)
  })

  it("does not flush a new graph when an old worklet load finishes", async () => {
    const oldModule = deferred()
    moduleLoad = oldModule
    const oldStart = audio.start()
    await audio.stop()
    moduleLoad = null
    await audio.start()
    audio.play(new Int16Array(1920))
    const current = Context.instances[1]!
    expect(current.sources).toHaveLength(1)
    oldModule.resolve()
    expect(await oldStart).toBe(false)
    expect(current.sources[0]!.stop).not.toHaveBeenCalled()
    expect(audio.playbackPath()).toBe("scheduled")
  })

})
