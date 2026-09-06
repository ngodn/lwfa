#!/usr/bin/env node
// Actual dock and touch controls in an isolated browser, without an engine.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(new URL("../packages/shell/package.json", import.meta.url))
const { createServer } = await import(require.resolve("vite"))
const { default: tailwindcss } = await import(require.resolve("@tailwindcss/vite"))
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright")
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/index.css';
import { SessionStateProvider, SessionActionsProvider } from '/src/session.tsx';
import { InputDock } from '/src/components/InputDock.tsx';
import { usePhysicalGamepad } from '/src/gamepad/usePhysicalGamepad.ts';
import { setDock } from '/src/lib/dock.ts';
import { setGamepad } from '/src/gamepad/store.ts';
import { patchPrefs } from '/src/lib/prefs.ts';
window.messages=[];
window.controls={setDock,setGamepad,patchPrefs};
patchPrefs('gamepad',{shield:true,haptics:false,skin:'xbox',mode:'controller',placement:'overlay'});
setDock('gamepad');
function App() {
 usePhysicalGamepad();
 return React.createElement(InputDock,{onOpenSettings:()=>{}});
}
createRoot(document.getElementById('root')).render(
 React.createElement(SessionStateProvider,{value:{status:'connected',session:'test'}},
 React.createElement(SessionActionsProvider,{value:{send:message=>messages.push(message)}},
 React.createElement(App))));
`
const server = await createServer({
  plugins: [tailwindcss(), {
    name: "gamepad-visibility-test",
    resolveId(id) { if (id === "/__gamepad-entry.js") return id },
    load(id) { if (id === "/__gamepad-entry.js") return entry },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/__gamepad") return next()
      res.setHeader("Content-Type", "text/html")
      res.end('<!doctype html><title>Gamepad visibility check</title><div id="root" style="position:relative;height:100vh;display:flex;flex-direction:column"></div><script type="module" src="/__gamepad-entry.js"></script>')
    }) },
  }],
  configFile: false,
  root: fileURLToPath(new URL("../packages/shell", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("../packages/shell/src", import.meta.url)) } },
  oxc: { jsx: { runtime: "automatic" } },
  server: { host: "127.0.0.1", port: 0, hmr: false },
})
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) })
  const page = await browser.newPage({ viewport: { width: 1194, height: 834 } })
  page.setDefaultTimeout(10000)
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(() => {
    window.WebSocket = class { constructor() { throw new Error("Visibility test must not connect to engine") } }
    window.testPads = []
    Object.defineProperty(navigator, "getGamepads", { value: () => testPads })
    for (const type of ['gamepadconnected', 'gamepaddisconnected']) {
      addEventListener(type, event => { if (event.isTrusted) event.stopImmediatePropagation() }, true)
    }
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__gamepad`)
  const pad = page.getByLabel("On-screen gamepad", { exact: true })
  const hide = page.getByRole("button", { name: "Hide on-screen controls", exact: true })
  const show = page.getByRole("button", { name: "Show on-screen controls", exact: true })
  const shield = page.getByRole("button", { name: "Let taps through to the window", exact: true })
  await pad.waitFor()
  assert.deepEqual(await page.locator("header button").evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label") || button.textContent)), [
    "Edit", "Hide on-screen controls", "Let taps through to the window", "Settings", "Hide",
  ])
  for (const width of [1194, 834, 320]) {
    await page.setViewportSize({ width, height: 834 })
    const boxes = await page.locator("header button").evaluateAll(buttons => buttons.map(button => {
      const { x, y, width, height } = button.getBoundingClientRect()
      return { x, y, width, height }
    }))
    for (const box of boxes) {
      assert(box.width >= 56 && box.height >= 44, "toolbar uses actual 56 by 44 pixel touch targets")
      assert(box.x >= 0 && box.x + box.width <= width, "toolbar fits the viewport")
    }
    for (let i = 1; i < boxes.length; i++) assert(boxes[i].x >= boxes[i - 1].x + boxes[i - 1].width, "toolbar targets do not overlap")
  }
  await page.setViewportSize({ width: 1194, height: 834 })
  await page.evaluate(() => {
    testPads.push({ index: 0, mapping: 'standard', connected: true, buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] })
    dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: testPads[0] }))
  })
  for (const [name, index] of [['LB', 4], ['RB', 5]]) {
    await page.evaluate(() => messages.length = 0)
    await page.getByRole('button', { name, exact: true }).click()
    const touch = await page.evaluate(() => messages.slice())
    assert.deepEqual(touch, [{ type: 'gamepadButton', button: index, pressed: true }, { type: 'gamepadButton', button: index, pressed: false }])
    await page.evaluate(index => { messages.length = 0; testPads[0].buttons[index] = { pressed: true, value: 1 } }, index)
    await page.waitForFunction(index => messages.some(message => message.type === 'gamepadButton' && message.button === index && message.pressed), index)
    await page.evaluate(index => { testPads[0].buttons[index] = { pressed: false, value: 0 } }, index)
    await page.waitForFunction(index => messages.some(message => message.type === 'gamepadButton' && message.button === index && !message.pressed), index)
    assert.deepEqual(await page.evaluate(() => messages), touch, `${name} physical and touch use identical press/release output`)
  }

  await page.evaluate(() => { messages.length = 0; testPads[0].buttons[4] = { pressed: true, value: 1 }; testPads[0].axes[0] = 0.75 })
  await page.waitForFunction(() => messages.some(message => message.type === 'gamepadAxis' && message.axis === 0 && message.value === 0.75))
  await hide.click()
  await pad.waitFor({ state: 'detached' })
  await page.waitForTimeout(100)
  assert.deepEqual(await page.evaluate(() => messages), [
    { type: 'gamepadButton', button: 4, pressed: true },
    { type: 'gamepadAxis', axis: 0, value: 0.75 },
  ], 'hiding idle touch controls preserves physical button and stick holds')
  await page.evaluate(() => { testPads[0].buttons[4] = { pressed: false, value: 0 }; testPads[0].axes[0] = 0 })
  await page.waitForFunction(() => messages.some(message => message.type === 'gamepadAxis' && message.axis === 0 && message.value === 0))
  assert.deepEqual(await page.evaluate(() => messages.slice(-2)), [
    { type: 'gamepadButton', button: 4, pressed: false },
    { type: 'gamepadAxis', axis: 0, value: 0 },
  ], 'physical releases still work with touch controls hidden')
  await show.click()
  await pad.waitFor()
  await page.evaluate(() => messages.length = 0)
  await hide.click()
  await pad.waitFor({ state: "detached" })
  assert(await shield.isVisible(), "shield toolbar remains available while controls are hidden")
  assert.equal(await shield.getAttribute("aria-pressed"), "true")
  assert(await page.evaluate(() => !!document.elementFromPoint(400, 300)?.matches('[aria-hidden].touch-none')), "hidden controls preserve the touch shield")
  assert.deepEqual(await page.evaluate(() => messages), [], "hiding idle controls does not reset buttons, axes, or controller ownership")
  await show.click()
  await pad.waitFor()

  // A second touch can hide the pad while the first is holding a button.
  const a = page.getByRole("button", { name: "A", exact: true })
  await a.hover()
  await page.mouse.down()
  await page.waitForFunction(() => messages.some(message => message.type === 'gamepadButton' && message.button === 0 && message.pressed))
  await hide.evaluate(button => button.click())
  await pad.waitFor({ state: "detached" })
  await page.waitForFunction(() => messages.some(message => message.type === 'gamepadButton' && message.button === 0 && !message.pressed))
  assert.deepEqual(await page.evaluate(() => messages.filter(message => message.type === 'gamepadButton' && message.button === 0).map(message => message.pressed)), [true, false], "hiding releases the held touch button")
  await page.mouse.up()
  await show.click()
  await pad.waitFor()

  const stick = page.getByLabel("Left stick", { exact: true })
  const box = await stick.boundingBox()
  await page.evaluate(() => messages.length = 0)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2)
  await page.waitForFunction(() => messages.some(message => message.type === 'gamepadAxis' && message.axis === 0 && message.value > 0))
  await hide.evaluate(button => button.click())
  await pad.waitFor({ state: "detached" })
  await page.waitForFunction(() => messages.filter(message => message.type === 'gamepadAxis' && message.axis === 0).at(-1)?.value === 0)
  await page.mouse.up()
  assert(!(await page.evaluate(() => messages.some(message => message.type === 'setGamepad' && !message.enabled))), "hiding keeps controller enabled")

  await page.getByRole("button", { name: "Edit", exact: true }).click()
  await page.getByRole("button", { name: "Done", exact: true }).waitFor()
  assert(await hide.isVisible(), "Edit reveals hidden controls")
  await page.getByRole("button", { name: "Done", exact: true }).click()
  await pad.waitFor()
  await hide.click()
  await page.evaluate(() => controls.patchPrefs('gamepad', { placement: 'stacked' }))
  const dockBox = await page.locator("#root > div").boundingBox()
  assert(dockBox.height < 100, "hidden stacked controls give the reserved space back")
  await show.click()
  await pad.waitFor()
  assert((await page.locator("#root > div").boundingBox()).height > 300, "shown stacked controls restore the dock height")

  await page.evaluate(() => controls.patchPrefs('gamepad', { mode: 'keyboard', placement: 'overlay' }))
  await page.evaluate(() => messages.length = 0)
  await a.hover()
  await page.mouse.down()
  await page.waitForFunction(() => messages.some(message => message.type === 'key' && message.pressed))
  await hide.evaluate(button => button.click())
  await pad.waitFor({ state: 'detached' })
  await page.waitForFunction(() => messages.some(message => message.type === 'key' && !message.pressed))
  const keys = await page.evaluate(() => messages.filter(message => message.type === 'key'))
  assert.equal(keys.length, 2)
  assert.equal(keys[0].key, keys[1].key)
  assert.deepEqual(keys.map(message => message.pressed), [true, false], "keyboard fallback also releases held touch input")
  await page.mouse.up()
  assert.deepEqual(errors, [])
  console.log("PASS: identical physical/touch LB/RB output, physical holds/releases while hidden, shield/controller preservation, held touch button/stick/key cleanup, Edit reveal, stacked space, 56x44 toolbar at tablet and phone widths")
} finally {
  await browser?.close()
  await server.close()
}
