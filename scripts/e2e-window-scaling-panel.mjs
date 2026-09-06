#!/usr/bin/env node
// Real WindowsPanel with server metadata supplied by an isolated fixture.
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
import { SessionStateProvider, SessionActionsProvider } from '/src/session.tsx';
import { EMPTY, addWindow, DEFAULT_CONFIG } from '/src/strip.ts';
import { TooltipProvider } from '/src/components/ui/tooltip.tsx';
import WindowsPanel from '/src/panels/WindowsPanel.tsx';
import '/src/index.css';
window.messages = [];
window.acceptChanges = true;
const output = { width: 1000, height: 500 };
function App() {
  const [info, setInfo] = React.useState({ id: 1, title: 'Scale test', appId: 'scale-test', fullscreen: false,
    xwayland: false, scaling: {mode:'sharp',scale:1}, effectiveScale:1 });
  const [primary, setPrimary] = React.useState(true);
  window.updateInfo = patch => setInfo(info => ({ ...info, ...patch }));
  window.setPrimary = setPrimary;
  const actions = React.useMemo(() => new Proxy({send(message) {
    window.messages.push(message);
    if (message.type === 'setWindowScaling' && window.acceptChanges)
      setInfo(info => ({ ...info, scaling:message.scaling, effectiveScale:message.scaling.scale ?? 2 }));
  }}, {get(target,key) { return target[key] ?? (() => { window.messages.push({type:key}); }); }}), []);
  const state = {output, windows:new Map([[1,info]]), strip:addWindow(EMPTY,1,output,DEFAULT_CONFIG),
    primary, peers:[], permissions:{mode:'interact',allowedApps:null}, status:'connected',session:1};
  return React.createElement(SessionStateProvider,{value:state},
    React.createElement(SessionActionsProvider,{value:actions},
      React.createElement(TooltipProvider,null,React.createElement(WindowsPanel))));
}
createRoot(document.getElementById('root')).render(React.createElement(App));
`
const server = await createServer({
  plugins: [tailwindcss(), { name: "window-scaling-panel-test",
    resolveId(id) { if (id === "/__scaling-entry.js") return id },
    load(id) { if (id === "/__scaling-entry.js") return entry },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/__scaling") return next()
      res.setHeader("Content-Type", "text/html")
      res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Window scaling panel</title><div id="root" style="max-width:360px;padding:12px"></div><script type="module" src="/__scaling-entry.js"></script>')
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
  const page = await browser.newPage({viewport:{width:360,height:900},deviceScaleFactor:2})
  const errors = []
  page.on("pageerror", e => errors.push(e.message))
  await page.addInitScript(() => {
    window.WebSocket = class { constructor() { throw new Error("Scaling panel test must not connect to engine") } }
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__scaling`)
  const mode = name => page.getByRole("group", {name:"Scaling mode"}).getByRole("button", {name,exact:true})
  const factor = value => page.getByRole("group", {name:"Render scale"}).getByRole("button", {name:`${value}×`,exact:true})
  await mode("Sharper").waitFor()
  assert.equal(await mode("Sharper").getAttribute("aria-pressed"), "true")
  await factor(1).click()
  assert.deepEqual(await page.evaluate(() => messages), [], "selecting the current factor sends nothing")

  for (const name of ["Sharper", "More space"]) {
    await mode(name).click()
    for (const scale of [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
      await factor(scale).click()
      await page.waitForFunction(({mode, scale}) => messages.at(-1)?.scaling.mode === mode && messages.at(-1)?.scaling.scale === scale,
        {mode:name === "Sharper" ? "sharp" : "workspace",scale})
      assert.equal(await factor(scale).getAttribute("aria-pressed"), "true")
      const box = await factor(scale).boundingBox()
      assert(box.width >= 44 && box.height >= 44, "scale has a 44px touch target")
    }
  }
  assert(!await page.getByRole("button", {name:"Auto",exact:true}).count(), "Auto is only a Sharper mode option")
  await mode("Sharper").click()
  await page.getByRole("button", {name:"Auto",exact:true}).click()
  assert.deepEqual(await page.evaluate(() => messages.at(-1)), {type:"setWindowScaling",id:1,scaling:{mode:"sharp",scale:null}})
  await page.getByText("Capture density: 2×.", {exact:false}).waitFor()
  const count = await page.evaluate(() => messages.length)
  await mode("Sharper").click()
  assert.equal(await page.evaluate(() => messages.length), count, "selecting the current mode preserves Auto")
  await mode("More space").click()
  assert.equal(await factor(1).getAttribute("aria-pressed"), "true", "Auto becomes explicit 1x in More space")

  await page.evaluate(() => { acceptChanges = false })
  await factor(2).click()
  assert.equal(await factor(1).getAttribute("aria-pressed"), "true", "rejected request never becomes a selected factor")
  await page.evaluate(() => { acceptChanges = true; updateInfo({scaling:{mode:'workspace',scale:2},effectiveScale:1.75}) })
  await page.getByText("Workspace request: 1.75×.", {exact:false}).waitFor()
  await page.getByText("Apps may round or limit the requested size.", {exact:false}).waitFor()
  assert.equal(await factor(2).getAttribute("aria-pressed"), "true", "selection and bounded workspace request remain distinct")
  assert.equal(await page.getByText("Applied:", {exact:false}).count(), 0, "a workspace request does not claim the app accepted that size")

  await page.evaluate(() => updateInfo({xwayland:true}))
  await mode("Sharper").click()
  assert.equal(await factor(1).getAttribute("aria-pressed"), "true")
  assert(await factor(2).isDisabled())
  assert(await page.getByRole("button", {name:"Auto",exact:true}).isDisabled())
  await page.getByText("This Xwayland app uses 1× here.", {exact:false}).waitFor()
  await mode("More space").click()
  assert(await factor(2).isEnabled(), "Xwayland supports More space")
  await factor(2).click()

  await page.evaluate(() => setPrimary(false))
  await page.getByText("Another device", {exact:false}).waitFor()
  assert(await mode("Sharper").isDisabled(), "follower cannot change mode")
  assert(await factor(2).isDisabled(), "follower cannot change factor")
  await page.evaluate(() => { setPrimary(true); updateInfo({scaling:undefined}) })
  await page.getByText("Scaling requires an updated engine.").waitFor()
  assert(await mode("Sharper").isDisabled(), "older engine does not offer dead controls")

  assert(!(await page.evaluate(() => messages.some(message => message.type === 'focusWindow'))), "scaling never focuses the remote app")
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "panel fits phone width")
  assert.deepEqual(errors, [])
  console.log("PASS: seven factors in both modes, Auto, server-driven selection, effective scale, Xwayland limits, follower and old-engine restrictions, 44px targets, narrow layout, no focus commands")
} finally {
  await browser?.close()
  await server.close()
}
