#!/usr/bin/env node
// Browser audio graph check. No engine, system capture, or credentials needed.
// PLAYWRIGHT_MODULE may point to an installed playwright-core/index.mjs.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { stripTypeScriptTypes } from "node:module"

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright")
const source = readFileSync(new URL("../packages/shell/src/lib/audio.ts", import.meta.url), "utf8")
const module = stripTypeScriptTypes(source)
const worklet = readFileSync(new URL("../packages/shell/public/audio-worklet.js", import.meta.url))
const server = createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/" ? "text/html" : "text/javascript")
  response.end(request.url === "/audio.js" ? module : request.url === "/audio-worklet.js" ? worklet : "<!doctype html><title>Audio playback check</title>")
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
let browser
try {
  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"], ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) })
  for (const path of ["scheduled", "worklet"]) {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    const result = await page.evaluate(async (path) => {
      const contexts = []
      const NativeContext = window.AudioContext
      window.AudioContext = class extends NativeContext {
        constructor(options) {
          super(options)
          if (path === "scheduled") Object.defineProperty(this, "audioWorklet", { value: undefined })
          contexts.push(this)
        }
        createGain() {
          const gain = super.createGain()
          this.playerGain = gain
          return gain
        }
        createBufferSource() {
          const source = super.createBufferSource()
          const stop = source.stop.bind(source)
          source.stop = (...args) => { source.wasStopped = true; return stop(...args) }
          ;(this.sources ??= []).push(source)
          return source
        }
      }
      const audio = await import("/audio.js")
      const starts = await Promise.all([audio.start(), audio.start()])
      await audio.start()
      const ctx = contexts[0]
      const analyser = ctx.createAnalyser()
      ctx.playerGain.connect(analyser)
      analyser.connect(ctx.destination)
      let position = 0
      const feed = () => {
        const samples = new Int16Array(1920)
        for (let i = 0; i < 960; i++, position++) {
          samples[i * 2] = samples[i * 2 + 1] = Math.round(10000 * Math.sin(2 * Math.PI * 440 * position / 48000))
        }
        audio.play(samples)
      }
      feed(); feed(); feed()
      const timer = setInterval(feed, 20)
      // The audio device and worklet start asynchronously. A single fixed
      // 250ms snapshot can land on silence when builds compete for CPU, even
      // though the graph produces the expected waveform moments later. Keep
      // feeding and require three consecutive observations of the real PCM.
      const waveform = new Float32Array(analyser.fftSize)
      const startedAt = performance.now()
      const deadline = startedAt + 5000
      let peak = 0
      let rms = 0
      let observations = 0
      let consecutive = 0
      try {
        while (performance.now() < deadline && consecutive < 3) {
          await new Promise((resolve) => setTimeout(resolve, 20))
          analyser.getFloatTimeDomainData(waveform)
          let squares = 0
          peak = 0
          for (const sample of waveform) {
            peak = Math.max(peak, Math.abs(sample))
            squares += sample * sample
          }
          rms = Math.sqrt(squares / waveform.length)
          observations++
          // The supplied 440Hz sine has amplitude 10000/32768 (~0.305)
          // and RMS ~0.216. Silence or arbitrary graph setup is not success.
          consecutive = peak > 0.25 && peak < 0.36 && rms > 0.15 && rms < 0.26
            ? consecutive + 1 : 0
        }
      } finally {
        clearInterval(timer)
      }
      const observedAfterMs = Math.round(performance.now() - startedAt)
      // Exercise cancellation with fresh queued sources even if a delayed
      // timer let the previous scheduled chunk end just before the probe.
      feed(); feed(); feed()
      const stale = [...(ctx.sources ?? [])]
      audio.flush()
      const cancelled = stale.filter((source) => source.wasStopped).length
      const diagnostics = audio.diagnostics()
      await audio.stop()
      return { starts, contexts: contexts.length, peak, rms, observations, consecutive, observedAfterMs, cancelled, diagnostics, states: contexts.map((c) => c.state) }
    }, path)
    assert.deepEqual(result.starts, [true, true])
    assert.equal(result.contexts, 1, `${path}: reconnect reused graph`)
    assert.equal(result.consecutive, 3,
      `${path}: expected PCM did not remain observable within 5s (peak=${result.peak}, rms=${result.rms}, observations=${result.observations})`)
    assert.equal(result.diagnostics.path, path)
    if (path === "scheduled") {
      assert(result.cancelled > 0, "flush cancelled outstanding scheduled sources")
      assert.equal(result.diagnostics.bufferedMs, 0)
    }
    assert.deepEqual(result.states, ["closed"])
    console.log(`PASS ${path}: one context, PCM waveform peak ${result.peak.toFixed(3)}, RMS ${result.rms.toFixed(3)} after ${result.observedAfterMs}ms, flush and teardown`)
    await page.close()
  }
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}
