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
 label:'Scaling target',streamed:true,blank:false,onFocus:()=>{},onInput:(id,event)=>sent.push(event)
}));
`
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../packages/shell", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("../packages/shell/src", import.meta.url)) } },
  oxc: { jsx: { runtime: "automatic" } },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [tailwindcss(), {
    name: "scaling-input-test",
    resolveId(id) { if (id === "/__scaling.js") return id },
    load(id) { if (id === "/__scaling.js") return entry },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/__scaling") return next()
      res.setHeader("Content-Type", "text/html")
      res.end('<!doctype html><div id="root"></div><script type="module" src="/__scaling.js"></script>')
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
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__scaling`)
    const surface = page.getByLabel("Scaling target", { exact: true })
    await surface.waitFor()
    for (const scale of [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
      await page.evaluate(async scale => { await paint(1000 * scale, 500 * scale) }, scale)
      await page.waitForFunction(scale => document.querySelector('canvas')?.width === 1000 * scale, scale)
      const box = await surface.boundingBox()
      assert.equal(box.width, 1000)
      assert.equal(box.height, 500)
      for (const [x, y] of [[0.1, 0.1], [0.5, 0.5], [0.9, 0.9]]) {
        await page.evaluate(() => sent.length = 0)
        await page.mouse.click(box.x + box.width * x, box.y + box.height * y)
        const point = await page.evaluate(() => sent.find(event => event.kind === 'motion'))
        assert(Math.abs(point.x - x) < 0.001 && Math.abs(point.y - y) < 0.001, `pointer at ${scale}x DPR${dpr}`)
        await page.evaluate(() => sent.length = 0)
        await page.touchscreen.tap(box.x + box.width * x, box.y + box.height * y)
        const touch = await page.evaluate(() => sent.find(event => event.kind === 'touchDown'))
        assert(Math.abs(touch.x - x) < 0.001 && Math.abs(touch.y - y) < 0.001, `touch at ${scale}x DPR${dpr}`)
      }
    }
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log("PASS: pointer/touch alignment and 1000x500 CSS layout at all seven frame scales on DPR1 and DPR2")
} finally {
  await browser?.close()
  await server.close()
}
