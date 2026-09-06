#!/usr/bin/env node
// Real App with an intercepted engine socket: passive followers cannot steal focus.
// PLAYWRIGHT_MODULE can point to an existing playwright/index.mjs installation.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(new URL("../packages/shell/package.json", import.meta.url))
const { createServer } = await import(require.resolve("vite"))
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright")
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '/src/App.tsx';
createRoot(document.getElementById('root')).render(React.createElement(App));
`

function serveRecovery(req, res, next) {
  if (!req.url.startsWith("/__controller-recovery")) return next()
  res.setHeader("Content-Type", "text/html")
  res.end(`<!doctype html><title>Controller recovery check</title><div id="root"></div>
    <script type="module" src="/__recovery-entry.js"></script>`)
}
const server = await createServer({
  plugins: [{ name: "controller-recovery-test",
    resolveId(id) { if (id === "/__recovery-entry.js") return id },
    load(id) { if (id === "/__recovery-entry.js") return entry },
    configureServer(server) { server.middlewares.use(serveRecovery) },
  }],
  configFile: false,
  root: fileURLToPath(new URL("../packages/shell", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("../packages/shell/src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
})

let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) })
  const windowInfo = id => ({ id, appId: 'test', title: `Test window ${id}`, fullscreen: false })
  for (const mode of ['interact', 'view']) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
    const errors = []
    page.on('pageerror', e => { errors.push(e.message); console.error(e.message) })
    page.on('console', m => { if(m.type()==='error') console.error(m.text()) })
    const wire = []
    let peer
    await page.routeWebSocket(/.*/, ws => {
      assert.equal(new URL(ws.url()).hostname, '127.0.0.1')
      peer = ws
      ws.onMessage(raw => {
        const message = JSON.parse(raw)
        wire.push(message)
        if (message.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
      })
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: 0,
        output: { width: 1000, height: 700, scale: 1 },
        windows: [windowInfo(1), windowInfo(2)], focused: 1,
        permissions: { mode, allowedApps: null }, account: 'test', session: 1, primary: false, peers: [] }))
      ws.send(JSON.stringify({ type: 'layout', output: { width: 1000, height: 700, scale: 1 },
        windows: [1, 2].map((id, i) => ({ id, z: i, rect: { x: i * 450, y: 0, width: 450, height: 600 } })) }))
    })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'getGamepads', { value: () => [] })
      localStorage.setItem('lwfa.prefs', JSON.stringify({stream:{audio:false}}))
    })
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__controller-recovery?token=isolated-test`)
    await page.waitForFunction(() => document.querySelectorAll('[role="application"]').length === 2)
    await page.waitForTimeout(100)
    assert.deepEqual(errors, [])
    assert.equal(wire.filter(m => m.type === 'focusWindow').length, 0, `${mode} follower must not change focus on hello`)
    peer.send(JSON.stringify({type:'windowOpened',window:windowInfo(3)}))
    peer.send(JSON.stringify({type:'focusChanged',id:2}))
    peer.send(JSON.stringify({type:'outputChanged',output:{width:1000,height:700,scale:1}}))
    await page.waitForTimeout(100)
    assert.equal(wire.filter(m => m.type === 'focusWindow').length, 0, `${mode} follower must not change focus during server updates`)
    await page.locator('[role="application"]').first().click({force:true})
    await page.waitForTimeout(100)
    assert.equal(wire.filter(m => m.type === 'focusWindow').length, mode === 'interact' ? 1 : 0, 'only an interactive follower sends deliberate focus')
    assert(!wire.some(m => m.type === 'setLayout'), 'followers never declare layout')
    assert.deepEqual(errors, [])
    if (mode === 'interact') {
      // Permission changes arrive as another hello on the existing socket.
      wire.length = 0
      const hello = changedMode => ({ type: 'hello', protocolVersion: 0,
        output: { width: 1000, height: 700, scale: 1 },
        windows: [windowInfo(1), windowInfo(2)], focused: 1,
        permissions: { mode: changedMode, allowedApps: null }, account: 'test', session: 1, primary: false, peers: [] })
      peer.send(JSON.stringify(hello('view')))
      await page.waitForTimeout(50)
      await page.locator('[role="application"]').first().click({force:true})
      await page.waitForTimeout(50)
      assert.equal(wire.filter(m => m.type === 'focusWindow').length, 0, 'demotion immediately stops focus commands')
      peer.send(JSON.stringify(hello('interact')))
      await page.waitForTimeout(50)
      assert.equal(wire.filter(m => m.type === 'focusWindow').length, 0, 'restored permissions do not steal focus on resync')
      await page.locator('[role="application"]').first().click({force:true})
      await page.waitForTimeout(50)
      assert.equal(wire.filter(m => m.type === 'focusWindow').length, 1, 'restored permissions allow deliberate focus again')
    }
    console.log(`PASS ${mode}: follower resync is passive; explicit focus respects permissions`)
    await page.close()
  }

} finally {
  await browser?.close()
  await server.close()
}
