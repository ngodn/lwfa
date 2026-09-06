#!/usr/bin/env node
// Real controlled overlays in an isolated browser. No engine connection.
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
import { PanelHost } from '/src/components/PanelHost.tsx';
import { FileDialog } from '/src/components/FileDialog.tsx';
import { AlreadyRunning } from '/src/components/AlreadyRunning.tsx';
import { blocked, clearBlocked } from '/src/lib/alreadyRunning.ts';
import { opened, closed } from '/src/lib/fileDialog.ts';
window.dialogs = { blocked, clearBlocked, opened, closed };
function App() {
 const [active,setActive]=React.useState(null);
 window.setPanel=setActive;
 return React.createElement(React.Fragment,null,
 React.createElement('nav', {'data-shell-nav':true},
 React.createElement('button', {id:'opener',onClick:()=>setActive('gamepad')}, 'Open gamepad settings'),
 React.createElement('button', {id:'switcher',onClick:()=>setActive('mouse')}, 'Switch panel')),
 React.createElement('input', {id:'outside','aria-label':'Outside input'}),
 React.createElement('div', {id:'desktop'}, 'Desktop surface'),
 React.createElement(PanelHost,{active,onClose:()=>setActive(null)}),
 React.createElement(FileDialog),React.createElement(AlreadyRunning));
}
window.root=createRoot(document.getElementById('root'));
root.render(React.createElement(SessionStateProvider,{value:{status:'connected',session:'test'}},
 React.createElement(SessionActionsProvider,{value:{send:()=>{},fileCancel:()=>{},fileChosen:()=>{},listDir:()=>{}}},React.createElement(App))));
`
const server = await createServer({
  plugins: [{ name: "focus-restoration-test",
    resolveId(id) { if (id === "/__focus-entry.js") return id },
    load(id) { if (id === "/__focus-entry.js") return entry },
    configureServer(server) { server.middlewares.use((req,res,next) => {
      if (req.url !== "/__focus") return next()
      res.setHeader("Content-Type","text/html")
      res.end('<!doctype html><title>Focus restoration check</title><div id="root"></div><script type="module" src="/__focus-entry.js"></script>')
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
  browser = await chromium.launch({ headless:true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath:process.env.CHROMIUM_EXECUTABLE } : {}) })
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", e => errors.push(e.message))
  await page.addInitScript(() => {
    window.WebSocket = class { constructor() { throw new Error("Focus test must not connect to engine") } }
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__focus`)
  const openPanel = async () => {
    await page.locator('#opener').click()
    await page.getByRole('button',{name:'Reset physical controller',exact:true}).waitFor()
    await page.waitForFunction(() => document.activeElement?.closest('[role=dialog]'))
  }
  const active = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName)
  const settleClosed = async () => {
    await page.getByRole('dialog').waitFor({state:'detached'})
    // Radix unmount restoration runs in a timer after removing the content.
    await page.waitForTimeout(50)
  }
  await openPanel()
  await page.getByRole('button',{name:'Close',exact:true}).click()
  await settleClosed()
  assert.equal(await active(),'opener','closing panel must restore its opener')
  await openPanel()
  await page.keyboard.press('Escape')
  await settleClosed()
  assert.equal(await active(),'opener','Escape must restore opener')
  await openPanel()
  await page.locator('#outside').click()
  await settleClosed()
  assert.equal(await active(),'outside','outside input keeps intentional focus')
  await openPanel()
  await page.locator('#desktop').click()
  await settleClosed()
  assert.notEqual(await active(),'opener','outside canvas-like click must not restore opener')
  await openPanel()
  await page.locator('#switcher').click()
  await page.getByRole('dialog').waitFor()
  assert.equal(await active(),'switcher','switching panels must preserve rail focus')
  await page.evaluate(() => setPanel(null))
  await settleClosed()
  assert.equal(await active(),'switcher','programmatic close must not steal outside focus')

  const openBlocked = async () => {
    await page.locator('#outside').focus()
    await page.evaluate(() => dialogs.blocked({command:'test',terminal:false,program:'Test',pid:123}))
    await page.getByRole('dialog').waitFor()
    await page.waitForFunction(() => document.activeElement?.closest('[role=dialog]'))
  }
  await openBlocked()
  await page.keyboard.press('Tab')
  assert(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')),'modal retains keyboard focus')
  await page.getByRole('button',{name:'Cancel',exact:true}).click()
  await settleClosed()
  assert.equal(await active(),'outside','already-running dialog restores previous element')

  await page.locator('#outside').focus()
  await page.evaluate(() => dialogs.opened({type:'fileChooser',request:1,mode:'open',multiple:false,directory:false,title:'Files',appId:'test',acceptLabel:null,suggestedName:null,filters:[],names:[],places:[],ticket:'isolated-test'}))
  await page.getByRole('dialog').waitFor()
  await page.waitForFunction(() => document.activeElement?.closest('[role=dialog]'))
  await page.getByRole('button',{name:'Cancel',exact:true}).click()
  await settleClosed()
  assert.equal(await active(),'outside','file dialog restores previous element')

  await page.locator('#outside').focus()
  await page.evaluate(() => {
    for (const request of [2,3]) dialogs.opened({type:'fileChooser',request,mode:'open',multiple:false,directory:false,title:'Files '+request,appId:'test',acceptLabel:null,suggestedName:null,filters:[],names:[],places:[],ticket:'isolated-test'})
  })
  await page.getByText('Files 2',{exact:true}).waitFor()
  await page.getByRole('button',{name:'Cancel',exact:true}).click()
  await page.getByText('Files 3',{exact:true}).waitFor()
  await page.waitForTimeout(100)
  assert(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')),'previous queued dialog must not steal new dialog focus')
  await page.getByRole('button',{name:'Cancel',exact:true}).click()
  await settleClosed()
  assert.equal(await active(),'outside','last queued file dialog returns to original element')

  await openPanel()
  await page.evaluate(() => {
    setPanel(null)
    dialogs.blocked({command:'test',terminal:false,program:'Replacement',pid:123})
  })
  await page.getByText('Replacement is already open on the desktop',{exact:true}).waitFor()
  await page.waitForTimeout(100)
  assert(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')),'closing panel must not steal focus from replacement dialog')
  await page.getByRole('button',{name:'Cancel',exact:true}).click()
  await settleClosed()
  await openPanel()
  await page.evaluate(() => document.getElementById('opener').remove())
  await page.keyboard.press('Escape')
  await settleClosed()
  assert.deepEqual(errors,[])
  console.log('PASS: controlled panel/dialog restoration, Escape, modal autofocus/trap, outside input/surface, panel switch, replacement and queued dialogs, removed opener')
} finally {
  await browser?.close()
  await server.close()
}
