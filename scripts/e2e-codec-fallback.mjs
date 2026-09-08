#!/usr/bin/env node
// Real App and FrameDecoder over an intercepted socket. No production engine.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(new URL("../packages/shell/package.json", import.meta.url))
const { createServer } = await import(require.resolve("vite"))
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright")
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from '/src/App.tsx';
import {useFrame} from '/src/lib/frames.ts';
import {patchPrefs} from '/src/lib/prefs.ts';
window.patchStream = changes => patchPrefs('stream',changes);
function ObserveFrames() {
  const one=useFrame(1),two=useFrame(2);
  React.useEffect(() => { window.observedFrames={one,two}; },[one,two]);
  return null;
}
createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,
  React.createElement(App),React.createElement(ObserveFrames)));

`
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../packages/shell", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("../packages/shell/src", import.meta.url)) } },
  oxc: { jsx: { runtime: "automatic" } },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "codec-fallback-test",
    resolveId(id) { if (id === "/__codec.js") return id },
    load(id) { if (id === "/__codec.js") return entry },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (!req.url.startsWith("/__codec")) return next()
      if (req.url === "/__codec.js") return next()
      res.setHeader("Content-Type", "text/html")
      res.end('<!doctype html><div id="root"></div><script type="module" src="/__codec.js"></script>')
    }) },
  }],
})
function video(format, id = 1) {
  const payload = format === 2
    ? [0,0,0,1,0x42,1,1,1,0x60,0,0,3,0,0xb0,0,0,3,0,0,3,0,180]
    : [0,0,0,1,0x67,0x4d,0,0x33]
  return packet(format,4000,3000,payload,id)
}
function packet(format,width,height,payload,id = 1) {
  const data = Buffer.alloc(24 + payload.length)
  data.set([0x4c,0x57,0x46,0x41,0,format,1,0])
  data.writeBigUInt64LE(BigInt(id),8)
  data.writeUInt32LE(width,16)
  data.writeUInt32LE(height,20)
  data.set(payload,24)
  return data
}
let browser
try {
  await server.listen()
  browser = await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {})})
  for (const scenario of ["auto", "pinned-hevc", "late-probe", "configure", "async-error", "resync", "preference-retry", "resize-retry", "close-retry", "delta-recovery", ...(process.env.LWFA_CODEC_PROBE_DIR ? ["real-resize"] : [])]) {
    const page = await browser.newPage({viewport:{width:1000,height:700}})
    const errors = []
    page.on('pageerror',error => errors.push(error.message))
    const wire = []
    let peer
    let connections = 0
    const hello = (ids,mode = 'interact') => ({type:'hello',protocolVersion:2,output:{width:1000,height:700,scale:1},
      windows:ids.map(id => ({id,title:`Codec target ${id}`,appId:'fixture',fullscreen:false})),focused:ids[0],
      permissions:{mode,allowedApps:null},account:'test',session:1,primary:false,peers:[]})
    const watchers = new Set()
    const waitForCodecs = (codecs, after = 0) => new Promise((resolve,reject) => {
      const check = () => {
        if (!wire.slice(after).some(message => message.type === 'setStreams' && JSON.stringify(message.codecs) === JSON.stringify(codecs))) return
        clearTimeout(timer)
        watchers.delete(check)
        resolve()
      }
      const timer = setTimeout(() => { watchers.delete(check); reject(new Error(`${scenario}: no setStreams ${JSON.stringify(codecs)} in ${JSON.stringify(wire)}`)) },5000)
      watchers.add(check)
      check()
    })
    await page.routeWebSocket(/.*/,ws => {
      assert.equal(new URL(ws.url()).hostname,'127.0.0.1')
      peer = ws
      ws.onMessage(raw => {
        const message = JSON.parse(raw)
        wire.push(message)
        for (const check of watchers) check()
        if (message.type === 'ping') ws.send(JSON.stringify({type:'pong'}))
      })
      const ids = scenario === 'resync' ? (++connections > 1 ? [2] : [1,2]) : scenario === 'close-retry' ? [1,2] : [1]
      ws.send(JSON.stringify(hello(ids)))
      ws.send(JSON.stringify({type:'layout',output:{width:1000,height:700,scale:1},
        windows:ids.map((id,z) => ({id,z,rect:{x:z*450,y:0,width:450,height:600}}))}))
    })
    await page.addInitScript(scenario => {
      localStorage.setItem('lwfa.prefs',JSON.stringify({stream:{audio:false,codec:scenario === 'pinned-hevc' ? 'hevc' : scenario === 'real-resize' ? 'h264' : 'auto'}}))
      Object.defineProperty(navigator,'getGamepads',{value:()=>[]})
      window.probes = []
      window.decoderConfigs = []
      window.decodedChunks = []
      window.initialProbes = []
      window.decoders = []
      window.pendingConversions = []
      const createBitmap = window.createImageBitmap.bind(window)
      window.createImageBitmap = async (...args) => {
        const bitmap = await createBitmap(...args)
        if (!window.holdConversions) return bitmap
        return new Promise(resolve => pendingConversions.push({bitmap,resolve}))
      }
      window.emitFrame = (index,timestamp) => {
        const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180
        canvas.getContext('2d').fillRect(0,0,320,180)
        const video = new VideoFrame(canvas,{timestamp})
        decoders[index].init.output(video)
        return video
      }
      if (scenario === 'real-resize') return
      window.VideoDecoder = class {
        state = 'unconfigured'
        constructor(init) { this.init = init; window.decoders.push(this) }
        static async isConfigSupported(config) {
          window.probes.push(config)
          if (config.codedWidth === 1920) {
            if (scenario === 'late-probe') await new Promise(resolve => window.initialProbes.push(resolve))
            return {supported:true,config}
          }
          return {supported:window.allowReal || scenario === 'configure' || scenario === 'async-error' || scenario === 'resync' || scenario === 'delta-recovery',config}
        }
        configure(config) {
          window.decoderConfigs.push(config)
          if (scenario === 'configure') throw new DOMException('fixture rejected real resolution','NotSupportedError')
          this.state = 'configured'
          if (scenario === 'async-error') queueMicrotask(() => this.init.error(new DOMException('fixture decode failure','EncodingError')))
        }
        decode(chunk) { window.decodedChunks.push(chunk.type) }
        close() { this.state = 'closed' }
      }
    },scenario)
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__codec?token=isolated-test`)
    await page.waitForFunction(() => document.querySelector('[role="application"]'))
    if (scenario === 'real-resize') {
      await waitForCodecs(['h264'])
      const stages=[[1000,640],[4000,3000],[1000,640],[1192,860],[1490,1075],[1788,1290],[2384,1720],[1001,641],[1192,860]]
      const start=wire.length
      for (const [stage,[width,height]] of stages.entries()) {
        const payload=await readFile(path.join(process.env.LWFA_CODEC_PROBE_DIR,`h264-${stage}-0.h264`))
        peer.send(packet(1,width,height,payload))
        await page.waitForFunction(({width,height}) => observedFrames.one?.width === width && observedFrames.one?.height === height,{width,height})
      }
      assert(!wire.slice(start).some(message=>message.type==='setStreams' && !message.codecs.includes('h264')),
        'actual scaled H264 streams preserve the selected codec through App negotiation')
      assert.deepEqual(errors,[])
      console.log('PASS real-resize: native browser decoder and actual App retain selected H264 through nine NVENC sizes')
      await page.close()
      continue
    }
    if (scenario === 'late-probe') {
      await page.waitForFunction(() => initialProbes.length === 2)
    } else await waitForCodecs(scenario === 'pinned-hevc' ? ['hevc'] : ['hevc','h264'])
    if (scenario === 'resync') {
      peer.send(video(1,1))
      peer.send(video(1,2))
      await page.waitForFunction(() => decoders.length === 2)
      await page.evaluate(() => { emitFrame(0,16667);emitFrame(1,16667) })
      await page.waitForFunction(() => observedFrames.one && observedFrames.two)
      await page.evaluate(() => {
        window.initialFrames = {...observedFrames}
        window.holdConversions = true
        window.pendingVideo = emitFrame(0,33334)
      })
      await page.waitForFunction(() => pendingConversions.length === 1)
      const beforePermission = wire.length
      peer.send(JSON.stringify(hello([1,2],'view')))
      await waitForCodecs(['hevc','h264'],beforePermission)
      assert(await page.evaluate(() => decoders.every(decoder => decoder.state === 'configured') &&
        observedFrames.one === initialFrames.one && observedFrames.two === initialFrames.two),
        'permission hello preserves both decoders and displayed frames')
      await peer.close({code:1012,reason:'isolated reconnect'})
      await page.waitForFunction(() => observedFrames.one === null && decoders[0].state === 'closed')
      assert.equal(connections,2,'the test exercised a real socket reconnect')
      assert(await page.evaluate(() => initialFrames.one.width === 0 &&
        initialFrames.two.width === 320 && observedFrames.two === initialFrames.two && decoders[1].state === 'configured'),
        'only the missing window loses its decoder and displayed bitmap')
      await page.evaluate(() => pendingConversions[0].resolve(pendingConversions[0].bitmap))
      await page.waitForFunction(() => pendingConversions[0].bitmap.width === 0 && pendingVideo.displayWidth === 0)
      assert(await page.evaluate(() => observedFrames.one === null), 'late bitmap cannot resurrect a missing window')
      assert.deepEqual(errors,[])
      console.log('PASS resync: missing window decoder, stored bitmap, and pending conversion retired; permission hello and surviving window preserved')
      await page.close()
      continue
    }
    if (scenario === 'delta-recovery') {
      peer.send(video(2))
      await page.waitForFunction(() => decodedChunks.length === 1)
      await page.evaluate(() => emitFrame(0,16667))
      await page.waitForFunction(() => observedFrames.one)
      const delta=video(2);delta[6]=0
      peer.send(delta)
      await page.waitForFunction(() => decodedChunks.at(-1) === 'delta')
      const beforeRecovery=wire.length
      await page.evaluate(() => {
        window.beforeRecovered=observedFrames.one
        decoders[0].init.error(new DOMException('transient decode failure','EncodingError'))
      })
      // This idle engine supplies nothing until the client requests a new IDR.
      await waitForCodecs(['hevc','h264'],beforeRecovery)
      assert(!wire.slice(beforeRecovery).some(message=>message.type==='setStreams' && message.codecs.length<2))
      peer.send(video(2))
      await page.waitForFunction(() => decoders.length === 2)
      await page.evaluate(() => emitFrame(1,16667))
      await page.waitForFunction(() => observedFrames.one && observedFrames.one !== beforeRecovered)
      assert.deepEqual(errors,[])
      console.log('PASS delta-recovery: idle video requests a fresh keyframe and recovers without JPEG')
      await page.close()
      continue
    }
    const beforeFailure = wire.length
    peer.send(video(2))
    await page.waitForFunction(() => decoderConfigs.some(config => config.codec === 'hvc1.1.6.L180.B0' && config.codedWidth === 4000 && config.codedHeight === 3000))
    if (scenario === 'late-probe') {
      await page.waitForFunction(() => probes.some(config => config.codedWidth === 4000))
      await page.evaluate(() => { for (const resolve of initialProbes) resolve() })
    }
    await waitForCodecs(scenario === 'pinned-hevc' ? [] : ['h264'],beforeFailure)
    assert(!wire.slice(beforeFailure).some(message => message.type === 'setStreams' && message.codecs.includes('hevc')),
      'a late family probe cannot restore a failed codec')
    if (scenario !== 'pinned-hevc') {
      const beforeH264 = wire.length
      peer.send(video(1))
      await waitForCodecs([],beforeH264)
    }
    // The negotiated JPEG fallback must reach the real surface, not just update control messages.
    const jpeg = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');canvas.width=320;canvas.height=180
      const context=canvas.getContext('2d');context.fillStyle='#25b46b';context.fillRect(0,0,320,180)
      const blob=await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg'))
      return [...new Uint8Array(await blob.arrayBuffer())]
    })
    if (['preference-retry','resize-retry','close-retry'].includes(scenario)) {
      const beforeRetry = wire.length
      // A stable fallback must not repeatedly reopen a rejected decoder.
      peer.send(packet(0,4000,3000,jpeg))
      await page.waitForTimeout(100)
      assert(!wire.slice(beforeRetry).some(message => message.type === 'setStreams' && message.codecs.length),
        'same-size JPEG does not retry a rejected video configuration')
      await page.evaluate(() => { window.allowReal = true })
      if (scenario === 'preference-retry') {
        await page.evaluate(() => patchStream({codec:'hevc'}))
        await waitForCodecs(['hevc'],beforeRetry)
      } else if (scenario === 'close-retry') {
        peer.send(JSON.stringify({type:'windowClosed',id:1}))
        await waitForCodecs(['hevc','h264'],beforeRetry)
      } else {
        peer.send(packet(0,2000,1500,jpeg))
        await waitForCodecs(['hevc','h264'],beforeRetry)
      }
      const payload = [...video(2).subarray(24)]
      const beforeVideo = await page.evaluate(() => decoderConfigs.length)
      peer.send(packet(2,2000,1500,payload,scenario === 'close-retry' ? 2 : 1))
      await page.waitForFunction(before => decoderConfigs.length > before, beforeVideo)
      await page.evaluate(scenario => {
        window.beforeRecovered = observedFrames[scenario === 'close-retry' ? 'two' : 'one']
        emitFrame(decoders.length-1,16667)
      },scenario)
      await page.waitForFunction(scenario => {
        const recovered=observedFrames[scenario === 'close-retry' ? 'two' : 'one']
        return recovered?.width === 320 && recovered !== beforeRecovered
      },scenario)
      assert.deepEqual(errors,[])
      console.log(`PASS ${scenario}: selected codec is retried and video reaches the surface without reload`)
      await page.close()
      continue
    }
    peer.send(packet(0,320,180,jpeg))
    await page.waitForFunction(() => [...document.querySelectorAll('canvas')].some(canvas => canvas.width === 320 && canvas.height === 180))
    assert.deepEqual(errors,[])
    console.log(`PASS ${scenario}: actual stream rejection renegotiates immediately and JPEG reaches the surface`)
    await page.close()
  }
} finally {
  await browser?.close()
  await server.close()
}
