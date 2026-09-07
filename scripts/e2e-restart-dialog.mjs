#!/usr/bin/env node
// Built shell, static files and a fully mocked socket. Never contacts an engine.
// Build first. PLAYWRIGHT_MODULE may name an existing playwright/index.mjs.
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright")
const root = fileURLToPath(new URL("../", import.meta.url))
const dist = path.join(root, "packages/shell/dist")
const artifacts = path.join(root, "target/restart-dialog")
await mkdir(artifacts, { recursive: true })
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" }
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://fixture.invalid").pathname)
    const file = path.resolve(dist, `.${pathname === "/" ? "/index.html" : pathname}`)
    if (!file.startsWith(`${dist}${path.sep}`)) { response.writeHead(403).end(); return }
    response.setHeader("Content-Type", mime[path.extname(file)] || "application/octet-stream")
    response.end(await readFile(file))
  } catch { response.writeHead(404).end() }
})
// Even an accidentally unmocked socket can never reach a server implementation.
server.on("upgrade", (_request, socket) => socket.destroy())
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const results = []
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) })
  for (const scenario of [
    { account: "owner", version: "1.5.4" },
    { account: "guest", version: "1.5.4" },
    { account: "owner", version: "1.5.3" },
  ]) {
    const context = await browser.newContext({ viewport: { width: 1324, height: 900 }, serviceWorkers: "block" })
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    const page = await context.newPage()
    const wire = [], errors = []
    page.on("pageerror", error => errors.push(error.message))
    await page.routeWebSocket(/.*/, socket => {
      assert.equal(new URL(socket.url()).host, new URL(origin).host)
      // No connectToServer(): Playwright handles both sides entirely in memory.
      socket.onMessage(raw => {
        const message = JSON.parse(raw)
        wire.push(message)
        if (message.type === "ping") socket.send(JSON.stringify({ type: "pong" }))
      })
      const output = { width: 1324, height: 900, scale: 1 }
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, output,
        windows: [{ id: 1, title: "Mock game", appId: "fixture", fullscreen: false }], focused: 1,
        permissions: { mode: "interact", allowedApps: null }, account: scenario.account,
        session: 1, primary: true, peers: [] }))
      socket.send(JSON.stringify({ type: "engineVersion", version: scenario.version }))
      socket.send(JSON.stringify({ type: "layout", output, windows: [{ id: 1, z: 0, rect: { x: 0, y: 0, width: 1324, height: 900 } }] }))
    })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "getGamepads", { value: () => [] })
      localStorage.setItem("lwfa.prefs", JSON.stringify({ stream: { audio: false } }))
    })
    await page.goto(`${origin}/?token=isolated-restart-fixture`)
    await page.getByRole("application", { name: "Mock game" }).waitFor()
    await page.getByRole("button", { name: "Session", exact: true }).click()
    const signOut = page.getByRole("button", { name: "Sign out of this device", exact: true })
    await signOut.waitFor()
    const restart = page.getByRole("button", { name: "Restart lwfa", exact: true })
    if (scenario.account !== "owner") {
      assert.equal(await restart.count(), 0, "Guests must not see service restart")
    } else if (scenario.version === "1.5.3") {
      assert(await restart.isDisabled(), "Older engines must not accept restart")
    } else {
      assert(await restart.isEnabled())
      const signOutBox = await signOut.boundingBox(), restartBox = await restart.boundingBox()
      assert(restartBox.y >= signOutBox.y + signOutBox.height, "Restart appears below Sign out")
      const modal = page.getByRole("dialog", { name: "Restart lwfa?", exact: true })
      const open = async () => {
        await restart.click()
        await modal.waitFor()
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Cancel")
        assert.match(await modal.textContent(), /Everyone will disconnect/)
        assert.match(await modal.textContent(), /apps and games may close/)
      }
      await open()
      await page.screenshot({ path: path.join(artifacts, "confirmation.png"), fullPage: true, animations: "disabled" })
      await modal.getByRole("button", { name: "Cancel", exact: true }).click()
      await modal.waitFor({ state: "hidden" })
      assert.equal(wire.filter(message => message.type === "restartEngine").length, 0)
      await open()
      const beforeCancelEnter = wire.length
      await page.keyboard.press("Enter")
      await modal.waitFor({ state: "hidden" })
      assert.equal(wire.filter(message => message.type === "restartEngine").length, 0, "Default Enter cancels")
      assert(!wire.slice(beforeCancelEnter).some(message => message.type === "key"), "Modal Enter must not reach the game")
      await open()
      const beforeEscape = wire.length
      await page.keyboard.press("Escape")
      await modal.waitFor({ state: "hidden" })
      assert.equal(wire.filter(message => message.type === "restartEngine").length, 0)
      assert(!wire.slice(beforeEscape).some(message => message.type === "key"), "Modal Escape must not reach the game")
      await open()
      const beforeConfirm = wire.length
      await page.keyboard.press("Tab")
      assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Restart lwfa")
      await page.keyboard.press("Enter")
      await page.getByRole("button", { name: "Restarting lwfa…", exact: true }).waitFor()
      assert.deepEqual(wire.filter(message => message.type === "restartEngine"), [{ type: "restartEngine" }])
      assert(!wire.slice(beforeConfirm).some(message => message.type === "key"), "Modal Tab and confirmation Enter must not reach the game")
      assert(!wire.some(message => message.type === "spawn"), "Restart must never become a shell command")
    }
    assert.deepEqual(errors, [])
    results.push({ ...scenario, passed: true, restartRequests: wire.filter(message => message.type === "restartEngine").length })
    await context.close()
  }
  await writeFile(path.join(artifacts, "results.json"), `${JSON.stringify(results, null, 2)}\n`)
  console.log(JSON.stringify(results))
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
