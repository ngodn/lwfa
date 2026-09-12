#!/usr/bin/env node
// Built shell served locally, with every engine connection mocked in memory.
// Build first. PLAYWRIGHT_MODULE and CHROMIUM_EXECUTABLE can select existing tools.
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright")
const root = fileURLToPath(new URL("../", import.meta.url))
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version
const dist = path.join(root, "packages/shell/dist")
const artifacts = path.join(root, "target/immersive-e2e")
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
server.on("upgrade", (_request, socket) => socket.destroy())
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const results = []
const settle = page => page.waitForTimeout(350)
const mutations = wire => wire.filter(message => [
  "setViewport", "setLayout", "setStreams", "setGamepad", "key", "pointerButton",
  "touchDown", "touchMotion", "touchUp", "gamepadButton", "gamepadAxis",
].includes(message.type))
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) })
  for (const scenario of ["native", "rejected", "follower", "standalone"]) {
    const context = await browser.newContext({ viewport: { width: 1324, height: 900 }, serviceWorkers: "block" })
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    const page = await context.newPage()
    const wire = [], errors = []
    let engineSocket
    page.on("pageerror", error => errors.push(error.message))
    await page.routeWebSocket(/.*/, socket => {
      engineSocket = socket
      assert.equal(new URL(socket.url()).host, new URL(origin).host)
      socket.onMessage(raw => {
        const message = JSON.parse(raw)
        wire.push(message)
        if (message.type === "ping") socket.send(JSON.stringify({ type: "pong" }))
      })
      const output = { width: 1324, height: 900, scale: 1 }
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 2, output,
        windows: [{ id: 1, title: "Mock game", appId: "fixture", fullscreen: false }], focused: 1,
        permissions: { mode: "interact", allowedApps: null }, account: "owner",
        session: 1, primary: scenario !== "follower", peers: [] }))
      socket.send(JSON.stringify({ type: "engineVersion", version }))
      socket.send(JSON.stringify({ type: "layout", output, windows: [{ id: 1, z: 0, rect: { x: 0, y: 0, width: 1324, height: 900 } }] }))
    })
    await page.addInitScript(mode => {
      Object.defineProperty(navigator, "getGamepads", { value: () => [] })
      localStorage.setItem("lwfa.prefs", JSON.stringify({ stream: { audio: false } }))
      globalThis.immersiveFullscreenCalls = 0
      const request = Element.prototype.requestFullscreen
      Element.prototype.requestFullscreen = function (...args) {
        globalThis.immersiveFullscreenCalls++
        if (mode === "rejected") return Promise.reject(new DOMException("Fixture policy denied fullscreen", "NotAllowedError"))
        return request.apply(this, args)
      }
      if (mode === "standalone") {
        const media = globalThis.matchMedia
        globalThis.matchMedia = function (query) {
          const result = media.call(this, query)
          if (query === "(display-mode: standalone)") Object.defineProperty(result, "matches", { value: true })
          return result
        }
      }
    }, scenario)
    await page.goto(`${origin}/?token=isolated-immersive-fixture`)
    const application = page.getByRole("application", { name: "Mock game" })
    const rail = page.getByRole("navigation", { name: "Shell navigation" })
    await application.waitFor()
    await page.getByRole("button", { name: "Gamepad", exact: true }).click()
    const gamepad = page.getByLabel("On-screen gamepad", { exact: true })
    const showGamepad = page.getByRole("switch", { name: "Show the gamepad", exact: true })
    await showGamepad.waitFor({ timeout: 5000 })
    assert.equal(await gamepad.count(), 0, "Opening Gamepad settings does not show the controller")
    assert.equal(await showGamepad.getAttribute("aria-checked"), "false")
    await showGamepad.click()
    await gamepad.waitFor()
    await showGamepad.click()
    await gamepad.waitFor({ state: "hidden" })
    await showGamepad.click()
    await gamepad.waitFor()
    await rail.getByRole("button", { name: "Gamepad", exact: true }).click()
    await showGamepad.waitFor({ state: "hidden" })
    assert.equal(await gamepad.count(), 1, "Closing settings leaves the controller visible")
    assert.equal(await rail.getByRole("button", { name: "Gamepad", exact: true }).getAttribute("aria-pressed"), "false", "Navigation highlights the panel, not controller visibility")
    await page.locator("main").getByRole("button", { name: "Settings", exact: true }).click()
    await showGamepad.waitFor()
    assert.equal(await showGamepad.getAttribute("aria-checked"), "true", "Toolbar settings share controller visibility")
    await page.getByRole("button", { name: "Close", exact: true }).click()
    await page.locator("main").getByRole("button", { name: "Edit", exact: true }).click()
    await page.locator("main").getByRole("button", { name: "Hide", exact: true }).click()
    await rail.getByRole("button", { name: "Gamepad", exact: true }).click()
    await showGamepad.waitFor()
    assert.equal(await showGamepad.getAttribute("aria-checked"), "false", "Toolbar close updates the settings switch")
    assert(await page.getByRole("button", { name: "Edit", exact: true }).isDisabled(), "Hiding the controller exits edit mode")
    await showGamepad.click()
    await gamepad.waitFor()
    await page.getByRole("button", { name: "Windows", exact: true }).click()
    const enter = page.getByRole("button", { name: "Enter immersive mode", exact: true }).and(page.locator(":enabled"))
    await enter.waitFor()
    const enterBox = await enter.boundingBox()
    const fullBox = await page.getByRole("button", { name: "Fullscreen", exact: true }).boundingBox()
    if (scenario === "follower") {
      assert(await enter.isEnabled(), "Followers can enter fullscreen locally")
      assert(await page.getByRole("button", { name: "Fullscreen", exact: true }).isDisabled(), "Follower app fullscreen remains disabled")
    } else {
      assert(enterBox.x + enterBox.width <= fullBox.x, "Immersive precedes app fullscreen")
    }
    await page.evaluate(() => {
      globalThis.immersiveFixtureNodes = {
        app: document.querySelector('[role="application"]'),
        canvas: document.querySelector('[role="application"] canvas'),
        pad: document.querySelector('[aria-label="On-screen gamepad"]'),
      }
    })
    await settle(page)
    const normalBox = await page.getByRole("main").boundingBox()
    const beforeEnter = wire.length
    await enter.click()
    if (scenario === "rejected") {
      await page.getByRole("alert").filter({ hasText: "The browser could not enter fullscreen" }).waitFor()
      await settle(page)
      assert(await rail.isVisible(), "A rejected request must keep navigation available")
      assert.equal(await page.getByRole("button", { name: "Show navigation", exact: true }).count(), 0)
      assert.equal(await page.evaluate(() => document.fullscreenElement), null)
      assert.deepEqual(await page.getByRole("main").boundingBox(), normalBox)
      assert.deepEqual(mutations(wire.slice(beforeEnter)), [], "Rejected fullscreen must leave engine state alone")
      assert(await gamepad.isVisible())
      assert.deepEqual(errors, [])
      results.push({ scenario, passed: true, canvas: normalBox })
      await context.close()
      continue
    }
    const show = page.getByRole("button", { name: "Show navigation", exact: true })
    await show.waitFor()
    await rail.waitFor({ state: "hidden" })
    await settle(page)
    assert.equal(await page.evaluate(() => document.fullscreenElement === document.documentElement), scenario !== "standalone")
    assert.equal(await page.evaluate(() => globalThis.immersiveFullscreenCalls), scenario === "standalone" ? 0 : 1)
    assert.equal(wire.slice(beforeEnter).some(message => message.type === "setViewport"), scenario !== "follower",
      "Only the primary client updates the engine viewport")
    const immersiveBox = await page.getByRole("main").boundingBox()
    assert(immersiveBox.width > normalBox.width, "Hidden navigation releases canvas width")
    const assertRetained = async () => {
      assert(await page.evaluate(() => {
        const nodes = globalThis.immersiveFixtureNodes
        return nodes.app === document.querySelector('[role="application"]') &&
          nodes.canvas === document.querySelector('[role="application"] canvas') &&
          nodes.pad === document.querySelector('[aria-label="On-screen gamepad"]')
      }), "The app, decoder canvas and on-screen controls must stay mounted")
    }
    await assertRetained()
    const beforeShow = wire.length
    await show.click()
    await rail.waitFor()
    await settle(page)
    assert.deepEqual(await page.getByRole("main").boundingBox(), immersiveBox, "Navigation overlays the canvas")
    assert.deepEqual(mutations(wire.slice(beforeShow)), [], "Opening navigation must not resize or send game input")
    await page.screenshot({ path: path.join(artifacts, `${scenario}-navigation.png`), animations: "disabled" })
    if (scenario === "native") {
      const latestRect = () => wire.findLast(message => message.type === "setLayout").windows.find(window => window.id === 1).rect
      const viewport = wire.findLast(message => message.type === "setViewport")
      const fullRect = { x: 0, y: 0, width: viewport.width, height: viewport.height }
      const columnRect = latestRect()
      assert.notDeepEqual(columnRect, fullRect, "The fixture starts with a windowed game")
      const requestFullscreen = fullscreen => engineSocket.send(JSON.stringify({ type: "fullscreenRequest", window: 1, fullscreen }))

      // An app still owns fullscreen entered through its own controls.
      requestFullscreen(true)
      await settle(page)
      assert.deepEqual(latestRect(), fullRect, "App-requested fullscreen fills the canvas")
      requestFullscreen(false)
      await settle(page)
      assert.deepEqual(latestRect(), columnRect, "The app can leave its own fullscreen")

      await page.getByRole("button", { name: "Windows", exact: true }).click()
      await page.getByRole("button", { name: "Fullscreen", exact: true }).click()
      await settle(page)
      assert.deepEqual(latestRect(), fullRect, "The Windows panel fullscreen button fills the immersive canvas")
      const beforeReplay = wire.length
      // Replay the enter/leave pair seen about 80 ms apart in the live X11 log.
      // There is one user click; neither incoming message comes from the UI.
      requestFullscreen(true)
      await page.waitForTimeout(80)
      requestFullscreen(false)
      await settle(page)
      const replayLayouts = wire.slice(beforeReplay).filter(message => message.type === "setLayout")
      await writeFile(path.join(artifacts, "fullscreen-request-replay.json"), `${JSON.stringify({
        fullRect, columnRect, incoming: [{ fullscreen: true, delayMs: 0 }, { fullscreen: false, delayMs: 80 }],
        layouts: replayLayouts, actualRect: latestRect(),
        browserFullscreen: await page.evaluate(() => document.fullscreenElement === document.documentElement),
      }, null, 2)}\n`)
      assert.deepEqual(latestRect(), fullRect, "An app fullscreen notification must not undo fullscreen selected in the Windows panel")
      assert.deepEqual(replayLayouts, [], "Ignored app fullscreen feedback must not send redundant layouts")
      assert.equal(await page.evaluate(() => document.fullscreenElement === document.documentElement), true,
        "App fullscreen requests must not exit browser immersive mode")
      assert(!wire.slice(beforeReplay).some(message => ["key", "pointerButton", "touchDown"].includes(message.type)),
        "The replay generates no extra user input")
      await page.getByRole("button", { name: "Exit fullscreen", exact: true }).click()
      await settle(page)
      assert.deepEqual(latestRect(), columnRect, "The user can explicitly leave shell fullscreen")
      const beforeExitReplay = wire.length
      requestFullscreen(true)
      await page.waitForTimeout(80)
      requestFullscreen(false)
      await settle(page)
      assert.deepEqual(latestRect(), columnRect, "App fullscreen feedback must not undo the user's explicit exit")
      assert.deepEqual(wire.slice(beforeExitReplay).filter(message => message.type === "setLayout"), [],
        "Ignored feedback after exit must not send redundant layouts")
      await page.getByRole("button", { name: "Windows", exact: true }).click()
    }
    const hide = page.getByRole("button", { name: "Hide navigation", exact: true })
    const beforeHide = wire.length
    await hide.click()
    await rail.waitFor({ state: "hidden" })
    await settle(page)
    assert.deepEqual(await page.getByRole("main").boundingBox(), immersiveBox)
    assert.deepEqual(mutations(wire.slice(beforeHide)), [], "Hiding navigation must not change game state")

    const beforeKeyboard = wire.length
    await show.focus()
    await page.keyboard.press("Enter")
    await rail.waitFor()
    await hide.focus()
    await page.keyboard.press("Space")
    await rail.waitFor({ state: "hidden" })
    await settle(page)
    assert.deepEqual(mutations(wire.slice(beforeKeyboard)), [], "Keyboard activation of the FAB must not reach the game")

    const initial = await show.boundingBox()
    const beforeDrag = wire.length
    await page.mouse.move(initial.x + initial.width / 2, initial.y + initial.height / 2)
    await page.mouse.down()
    await page.mouse.move(1180, 720, { steps: 12 })
    await page.mouse.up()
    await settle(page)
    const moved = await show.boundingBox()
    assert(Math.hypot(moved.x - initial.x, moved.y - initial.y) > 100, "The FAB follows dragging")
    assert(!await rail.isVisible(), "Finishing a drag must not toggle navigation")
    assert.deepEqual(mutations(wire.slice(beforeDrag)), [], "Dragging the FAB must not reach the game or resize it")
    await assertRetained()
    await page.screenshot({ path: path.join(artifacts, `${scenario}-immersive.png`), animations: "disabled" })

    const cdp = await context.newCDPSession(page)
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true })
    const beforeTouch = wire.length
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: moved.x + 24, y: moved.y + 24 }] })
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 230, y: 200 }] })
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await settle(page)
    const touched = await show.boundingBox()
    assert(Math.hypot(touched.x - moved.x, touched.y - moved.y) > 100, "Native touch dragging moves the FAB")
    assert(!await rail.isVisible(), "A touch drag must not toggle navigation")
    assert.deepEqual(mutations(wire.slice(beforeTouch)), [], "Touch dragging must not reach the game")
    await cdp.detach()

    await page.setViewportSize({ width: 768, height: 1024 })
    await settle(page)
    const clamped = await show.boundingBox()
    assert(clamped.x >= 0 && clamped.y >= 0 && clamped.x + clamped.width <= 768 && clamped.y + clamped.height <= 1024,
      "The FAB remains reachable after orientation changes")
    await assertRetained()

    const beforeExit = wire.length
    if (scenario === "standalone") {
      await show.click()
      await page.getByRole("button", { name: "Exit immersive mode", exact: true }).click()
    } else {
      // Use the browser API to exercise an exit that did not come from our UI.
      await page.evaluate(() => document.exitFullscreen())
    }
    await rail.waitFor()
    await show.waitFor({ state: "hidden" })
    await settle(page)
    assert.equal(await page.evaluate(() => document.fullscreenElement), null)
    assert.equal(wire.slice(beforeExit).some(message => message.type === "setViewport"), scenario !== "follower")
    await assertRetained()
    await page.getByRole("button", { name: "Windows", exact: true }).click()
    await enter.click()
    await show.waitFor()
    await show.click()
    const beforeKeyboardExit = wire.length
    await page.getByRole("button", { name: "Exit immersive mode", exact: true }).focus()
    await page.keyboard.press("Enter")
    await show.waitFor({ state: "hidden" })
    await rail.waitFor()
    assert.equal(await page.evaluate(() => document.fullscreenElement), null)
    assert(!wire.slice(beforeKeyboardExit).some(message => message.type === "key"), "Keyboard exit must not reach the game")
    if (scenario === "follower") assert(!wire.some(message => message.type === "setViewport"), "Followers never change the engine viewport")
    await assertRetained()
    assert.deepEqual(errors, [])
    results.push({ scenario, passed: true, normalCanvas: normalBox, immersiveCanvas: immersiveBox,
      draggedFab: moved, touchDraggedFab: touched, portraitFab: clamped,
      viewportUpdates: wire.filter(message => message.type === "setViewport") })
    await context.close()
  }
  await writeFile(path.join(artifacts, "results.json"), `${JSON.stringify(results, null, 2)}\n`)
  console.log(JSON.stringify(results))
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
