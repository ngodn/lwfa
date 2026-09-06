#!/usr/bin/env node
// Exercise the production-minified Opus wrapper and actual WASM dependency.
// Input comes from a browser encoder fed synthetic PCM, never a microphone.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"

const require = createRequire(new URL("../packages/shell/package.json", import.meta.url))
const { build } = await import(require.resolve("vite"))
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright")
const bundle = await build({
  configFile: false,
  root: fileURLToPath(new URL("../packages/shell", import.meta.url)),
  logLevel: "error",
  build: {
    write: false,
    target: "es2022",
    minify: true,
    lib: { entry: fileURLToPath(new URL("../packages/shell/src/lib/opus.ts", import.meta.url)), formats: ["es"], fileName: () => "opus.js" },
  },
})
const files = new Map((Array.isArray(bundle) ? bundle : [bundle]).flatMap(result => result.output.map(file => ["/" + file.fileName, file.type === "chunk" ? file.code : file.source])))
const server = createServer((request, response) => {
  if (request.url === "/") {
    response.setHeader("Content-Type", "text/html")
    response.end("<!doctype html><title>Real Opus decoder check</title>")
  } else if (files.has(request.url)) {
    response.setHeader("Content-Type", "text/javascript")
    response.end(files.get(request.url))
  } else {
    response.writeHead(404).end()
  }
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
let browser
try {
  browser = await chromium.launch({headless:true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {})})
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  const result = await page.evaluate(async () => {
    const config = {codec:"opus",sampleRate:48000,numberOfChannels:2,bitrate:128000}
    if (!(await AudioEncoder.isConfigSupported(config)).supported) throw new Error("This browser cannot encode the test Opus packets")
    const packets = []
    const encoder = new AudioEncoder({
      output(chunk) { const packet = new Uint8Array(chunk.byteLength); chunk.copyTo(packet); packets.push(packet) },
      error(error) { throw error },
    })
    encoder.configure(config)
    for (let frame = 0; frame < 4; frame++) {
      const pcm = new Float32Array(1920)
      for (let i = 0; i < 960; i++) {
        pcm[i] = 0.3 * Math.sin(2 * Math.PI * 440 * (frame * 960 + i) / 48000)
        pcm[i + 960] = 0.3 * Math.sin(2 * Math.PI * 880 * (frame * 960 + i) / 48000)
      }
      const data = new AudioData({format:"f32-planar",sampleRate:48000,numberOfFrames:960,numberOfChannels:2,timestamp:frame * 20000,data:pcm})
      encoder.encode(data)
      data.close()
    }
    await encoder.flush()
    encoder.close()
    // Force the path used when a browser has no native Opus decoder.
    Object.defineProperty(globalThis, "AudioDecoder", {value:undefined,configurable:true})
    const { OpusStream } = await import("/opus.js")
    const rounds = []
    for (let round = 0; round < 12; round++) {
      const chunks = []
      const decoder = new OpusStream((left, right) => chunks.push([left,right]))
      for (const packet of packets) decoder.push(packet,960)
      const until = performance.now() + 10000
      while (chunks.length < packets.length && performance.now() < until) await new Promise(resolve => setTimeout(resolve,10))
      const path = decoder.path()
      decoder.close()
      decoder.close()
      decoder.push(packets[0],960)
      let power = 0, samples = 0, difference = 0
      for (const [left,right] of chunks) {
        if (left.length !== right.length) throw new Error("Mismatched channel lengths")
        for (let i = 0; i < left.length; i++) {
          if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) throw new Error("Non-finite decoded PCM")
          power += left[i] ** 2 + right[i] ** 2
          difference += Math.abs(left[i] - right[i])
          samples += 2
        }
      }
      rounds.push({path,chunks:chunks.length,rms:Math.sqrt(power/samples),difference})
    }
    return {packets:packets.length,rounds}
  })
  assert(result.packets > 0)
  assert.equal(result.rounds.length,12)
  for (const round of result.rounds) {
    assert.equal(round.path,"wasm")
    assert.equal(round.chunks,result.packets,"queued packets decode before teardown")
    assert(round.rms > 0.1 && round.rms < 0.4,"real waveform survives decoding")
    assert(round.difference > 1,"stereo channels remain distinct")
  }
  assert.deepEqual(errors,[])
  console.log(`PASS: production-minified WASM Opus decode, ${result.packets} packets per round, stereo PCM and 12 create/decode/free cycles`)
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
