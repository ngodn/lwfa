#!/usr/bin/env node
// Real streaming surface, controlled frames, no engine connection.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(new URL("../packages/shell/package.json", import.meta.url))
const { createServer } = await import(require.resolve("vite"))
const { default: tailwindcss } = await import(require.resolve("@tailwindcss/vite"))
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright")
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import '/src/index.css';
import {WindowSurface} from '/src/WindowSurface.tsx';
import {publishFrame} from '/src/lib/frames.ts';
import {setDock} from '/src/lib/dock.ts';
window.sent=[];
setDock('none');
window.paint=async function(width,height) {
 const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
 const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);
 ctx.fillStyle='#000';ctx.fillRect(width/2,0,Math.max(1,width/1000),height);
 publishFrame(1,await createImageBitmap(canvas));
};
createRoot(document.getElementById('root')).render(React.createElement(WindowSurface,{
 id:1,rect:{x:0,y:0,width:1000,height:500},z:0,filling:false,focused:true,
 label:'Window input target',streamed:true,blank:false,onFocus:()=>{},onInput:(id,event)=>sent.push(event)
}));
`
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../packages/shell", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("../packages/shell/src", import.meta.url)) } },
  oxc: { jsx: { runtime: "automatic" } },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [tailwindcss(), {
    name: "window-input-test",
    resolveId(id) { if (id === "/__window-input.js") return id },
    load(id) { if (id === "/__window-input.js") return entry },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/__window-input") return next()
      res.setHeader("Content-Type", "text/html")
      res.end('<!doctype html><div id="root"></div><script type="module" src="/__window-input.js"></script>')
    }) },
  }],
})
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) })
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: dpr, hasTouch: true })
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", error => errors.push(error.message))
    await page.addInitScript(() => { window.WebSocket = class { constructor() { throw new Error("Input fixture must not connect to an engine") } } })
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__window-input`)
    const surface = page.getByLabel("Window input target", { exact: true })
    await surface.waitFor()
    // Different frame sizes can arrive during a resize or from HiDPI clients.
    for (const [width, height] of [[1000, 500], [2000, 1000], [1324, 970], [2560, 1440]]) {
      await page.evaluate(async ({ width, height }) => { await paint(width, height) }, { width, height })
      await page.waitForFunction(({ width, height }) => {
        const canvas = document.querySelector('canvas')
        return canvas?.width === width && canvas?.height === height
      }, { width, height })
      assert.equal(await surface.locator('canvas').evaluate(canvas => getComputedStyle(canvas).objectFit), 'fill')
      const box = await surface.boundingBox()
      assert.equal(box.width, 1000)
      assert.equal(box.height, 500)
      // Sample the browser's composed pixels, not just the backing canvas.
      // A contained old-aspect frame would leave dark margins at these points.
      const screenshot = await surface.screenshot()
      const corners = await page.evaluate(async encoded => {
        const blob = await (await fetch('data:image/png;base64,' + encoded)).blob()
        const bitmap = await createImageBitmap(blob)
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width; canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(bitmap, 0, 0)
        bitmap.close()
        return [[0.01, 0.01], [0.99, 0.01], [0.01, 0.99], [0.99, 0.99]].map(([x, y]) =>
          Array.from(ctx.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data))
      }, screenshot.toString('base64'))
      for (const pixel of corners) assert(pixel.slice(0, 3).every(value => value >= 240), `canvas margin at ${width}x${height} DPR${dpr}: ${pixel}`)
      for (const [x, y] of [[0.01, 0.01], [0.5, 0.5], [0.99, 0.99]]) {
        await page.evaluate(() => sent.length = 0)
        await page.mouse.click(box.x + box.width * x, box.y + box.height * y)
        const point = await page.evaluate(() => sent.find(event => event.kind === 'motion'))
        assert(Math.abs(point.x - x) < 0.001 && Math.abs(point.y - y) < 0.001, `pointer at ${width}x${height} DPR${dpr}`)
        await page.evaluate(() => sent.length = 0)
        await page.touchscreen.tap(box.x + box.width * x, box.y + box.height * y)
        const touch = await page.evaluate(() => sent.find(event => event.kind === 'touchDown'))
        assert(Math.abs(touch.x - x) < 0.001 && Math.abs(touch.y - y) < 0.001, `touch at ${width}x${height} DPR${dpr}`)
      }
    }
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log("PASS: full 1000x500 canvas and pointer/touch alignment across four frame sizes on DPR1 and DPR2")
} finally {
  await browser?.close()
  await server.close()
}
