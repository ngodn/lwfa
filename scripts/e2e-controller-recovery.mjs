#!/usr/bin/env node
// Real React hook and settings button, simulated Gamepad API, no engine connection.
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
      import { SessionStateProvider, SessionActionsProvider } from '/src/session.tsx';
      import { usePhysicalGamepad } from '/src/gamepad/usePhysicalGamepad.ts';
      import GamepadPanel from '/src/panels/GamepadPanel.tsx';
      function App() { usePhysicalGamepad(); return React.createElement(GamepadPanel); }
      window.root = createRoot(document.getElementById('root'));
      root.render(React.createElement(SessionStateProvider, {value:{status:'connected',session:'test'}},
        React.createElement(SessionActionsProvider, {value:{send:m=>window.sent.push(m)}}, React.createElement(App))));
`
function serveRecovery(req, res, next) {
  if (req.url !== "/__controller-recovery") return next()
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
  const page = await browser.newPage()
  const errors = []
  page.on("console", m => { if (m.type() === "error") console.error(m.text()) })
  page.on("response", r => { if (r.status() >= 400) console.error(r.status(), r.url()) })
  page.on("pageerror", e => { errors.push(e.message); console.error(e.message) })
  await page.addInitScript(() => {
    window.sent = []
    window.pad = { index: 0, connected: true, mapping: "standard", id: "test", timestamp: 1,
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })), axes: [0, 0, 0, 0] }
    Object.defineProperty(navigator, "getGamepads", { value: () => [window.pad] })
    for (const type of ["gamepadconnected", "gamepaddisconnected"]) {
      addEventListener(type, e => { if (e.isTrusted) e.stopImmediatePropagation() }, true)
    }
    window.WebSocket = class { constructor() { throw new Error("This test must not connect to an engine") } }
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__controller-recovery`)
  const reset = page.getByRole("button", { name: "Reset physical controller", exact: true })
  await reset.waitFor({ timeout: 15000 })
  await page.evaluate(() => { pad.buttons[1] = { pressed: true, value: 1 } })
  await page.waitForFunction(() => sent.some(m => m.button === 1 && m.pressed))
  await reset.click()
  await page.waitForFunction(() => sent.some(m => m.button === 1 && m.pressed === false))
  await page.evaluate(() => { sent.length = 0 })
  await page.waitForTimeout(50)
  assert.deepEqual(await page.evaluate(() => sent), [], "reset must not replay a stale held B")
  await page.evaluate(() => { pad.buttons[4] = { pressed: true, value: 1 } })
  await page.waitForFunction(() => sent.some(m => m.button === 4 && m.pressed))
  await page.evaluate(() => dispatchEvent(new Event("blur")))
  await page.waitForFunction(() => sent.some(m => m.button === 4 && m.pressed === false))
  await page.evaluate(() => { sent.length = 0; dispatchEvent(new Event("focus")) })
  await page.waitForTimeout(50)
  assert.deepEqual(await page.evaluate(() => sent), [], "focus must not replay held B or LB")
  await page.evaluate(() => { pad.buttons[4] = { pressed: false, value: 0 } })
  await page.waitForTimeout(30)
  await page.evaluate(() => { pad.buttons[4] = { pressed: true, value: 1 } })
  await page.waitForFunction(() => sent.some(m => m.button === 4 && m.pressed))
  assert.deepEqual(errors, [])
  await page.evaluate(() => root.unmount())
  console.log("PASS: real settings reset releases held B; stale B does not block LB; blur releases; focus waits for neutral; LB rearms")
} finally {
  await browser?.close()
  await server.close()
}
