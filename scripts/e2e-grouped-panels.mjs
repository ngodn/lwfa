#!/usr/bin/env node
// Real shell chrome and panels, isolated from every engine and production session.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import path from "node:path"

const require = createRequire(new URL("../packages/shell/package.json", import.meta.url))
const { createServer } = await import(require.resolve("vite"))
const { default: tailwindcss } = await import(require.resolve("@tailwindcss/vite"))
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright")
const root = fileURLToPath(new URL("../", import.meta.url))
const artifacts = path.join(root, "target/grouped-panels")
await mkdir(artifacts, { recursive: true })
const panels = ["info", "connections", "access", "theme", "settings", "apps", "clipboard", "workspaces", "keyboard", "gamepad", "mouse"]
const labels = { info: "Session", connections: "Connections", access: "Access", theme: "Appearance", settings: "Settings", apps: "Apps", clipboard: "Clipboard", workspaces: "Windows", keyboard: "Keyboard", gamepad: "Gamepad", mouse: "Mouse" }
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SessionStateProvider,SessionActionsProvider} from '/src/session.tsx';
import {ShellChrome} from '/src/components/ShellChrome.tsx';
import {PanelHost} from '/src/components/PanelHost.tsx';
import {ThemeProvider} from '/src/components/ThemeProvider.tsx';
import {TooltipProvider} from '/src/components/ui/tooltip.tsx';
import {EMPTY,addWindow,DEFAULT_CONFIG} from '/src/strip.ts';
import {setApps,setWindowless} from '/src/lib/apps.ts';
import {setAccounts} from '/src/lib/accounts.ts';
import {clipReady,clipHistory} from '/src/lib/clipboard.ts';
import {getPrefs,setPrefs,patchPrefs} from '/src/lib/prefs.ts';
import {SHELL_VERSION} from '/src/generated/config.ts';
import '/src/index.css';
window.messages=[];
window.configure=({theme,edge,size='md'})=>setPrefs(p=>({...p,theme,nav:{...p.nav,edge,size}}));
window.getPrefs=getPrefs;
window.patchPrefs=patchPrefs;
const output={width:1280,height:800};
const windows=new Map([
 [1,{id:1,title:'capture.rs - lwfa - Visual Studio Code',appId:'code',fullscreen:false,xwayland:false,scaling:{mode:'sharp',scale:1},effectiveScale:1}],
 [2,{id:2,title:'Wayland documentation - Chromium',appId:'chromium',fullscreen:false,xwayland:false,scaling:{mode:'workspace',scale:1.25},effectiveScale:1.25}],
 [3,{id:3,title:'Terminal',appId:'alacritty',fullscreen:false,xwayland:true,scaling:{mode:'sharp',scale:1},effectiveScale:1}],
]);
let strip=EMPTY;
for(const id of windows.keys()) strip=addWindow(strip,id,output,DEFAULT_CONFIG);
const apps=[['code','Visual Studio Code','Code editor','code'],['chromium','Chromium','Web browser','chromium'],['alacritty','Alacritty','Terminal emulator','alacritty'],['steam','Steam','Game library','steam'],['files','Files','File manager','nautilus']].map(([id,name,description,exec])=>({id,name,description,exec,icon:null,categories:[],terminal:false}));
setApps(apps);
setWindowless([{pid:123456,program:'background-example'}]);
const accounts=[{id:2,name:'Living room',permissions:{mode:'interact',allowedApps:null}},{id:3,name:'Guest',permissions:{mode:'view',allowedApps:['chromium']}}];
setAccounts(accounts);
clipReady(1,'isolated-fixture');
const clips=[{id:1,at:Date.now()-60000,origin:'desktop',device:null,kind:'text',bytes:32,mime:'text/plain',preview:'A useful note from the desktop',whole:true,width:null,height:null,path:null}];
const state={status:'connected',output,windows,strip,endpoint:'https://desktop.example.test',permissions:{mode:'interact',allowedApps:null},account:'owner',session:1,primary:true,peers:[{id:1,account:'owner',mode:'interact',primary:true,device:'Chrome on Linux'},{id:2,account:'Guest',mode:'view',primary:false,device:'Safari on iPad'}],engineVersion:SHELL_VERSION};
const actions=new Proxy({send(message){window.messages.push(message);if(message.type==='listAccounts')queueMicrotask(()=>setAccounts(accounts));if(message.type==='clipList')queueMicrotask(()=>clipHistory(message.request,clips,false));}},{get(target,key){return target[key]??((...args)=>window.messages.push({type:key,args}));}});
function Fixture(){
 const [panel,setPanel]=React.useState(null);
 window.openPanel=setPanel;
 return <SessionStateProvider value={state}><SessionActionsProvider value={actions}><ThemeProvider/><TooltipProvider>
  <ShellChrome><div id="fixture-desktop" tabIndex={0} style={{height:'100%',padding:36,background:'var(--backdrop)'}}><p style={{fontSize:13,color:'var(--muted-foreground)'}}>Isolated desktop fixture</p><button id="fixture-opener" onClick={()=>setPanel('info')} style={{position:'absolute',right:24,bottom:24}}>Open session fixture</button><input id="fixture-outside" aria-label="Desktop note" placeholder="Desktop note" style={{position:'absolute',right:24,bottom:72,width:150}}/></div></ShellChrome>
  <PanelHost active={panel} onClose={()=>setPanel(null)}/>
 </TooltipProvider></SessionActionsProvider></SessionStateProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`
const server = await createServer({
  plugins: [tailwindcss(), { name: "grouped-panels-fixture",
    resolveId(id) { if (id === "/__grouped-entry.jsx") return id },
    load(id) { if (id === "/__grouped-entry.jsx") return entry },
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url === "/__grouped") {
        res.setHeader("Content-Type", "text/html")
        res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grouped panels fixture</title><div id="root"></div><script type="module" src="/__grouped-entry.jsx"></script>')
      } else if (req.url === "/__reference" || req.url === "/support.js") {
        const name = req.url === "/__reference" ? "lwfa shell - grouped.dc.html" : "support.js"
        try { res.setHeader("Content-Type", name.endsWith("html") ? "text/html" : "application/javascript"); res.end(await readFile(path.join(root, "redesign/Navigation and panels redesign", name))) }
        catch { res.statusCode = 404; res.end("Local reference unavailable") }
      } else next()
    }) },
  }],
  configFile: false,
  root: path.join(root, "packages/shell"),
  resolve: { alias: { "@": path.join(root, "packages/shell/src") } },
  oxc: { jsx: { runtime: "automatic" } },
  server: { host: "127.0.0.1", port: 0, hmr: false },
})
let browser
const report = { screenshots: [], layouts: [], errors: [] }
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) })
  if (process.env.LWFA_CAPTURE_REFERENCE === "1") {
    const reference = await browser.newPage({viewport:{width:1280,height:980}})
    await reference.goto(`${origin}/__reference`)
    await reference.getByText("Grouped", {exact:false}).first().waitFor()
    await reference.waitForTimeout(2500)
    for (const theme of ["dark", "light"]) {
      await reference.locator("select").first().selectOption(theme)
      await reference.screenshot({path:path.join(artifacts, `reference-${theme}.png`),fullPage:true})
      for (const id of panels) {
        await reference.locator("select").nth(1).selectOption(id)
        await reference.screenshot({path:path.join(artifacts, `reference-${theme}-${id}.png`),fullPage:true})
      }
    }
    await reference.close()
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, reducedMotion: "reduce" })
  page.setDefaultTimeout(10000)
  page.on("pageerror", error => report.errors.push(error.message))
  await page.addInitScript(() => { window.WebSocket = class { constructor() { throw new Error("Grouped panel fixture must not connect to an engine") } } })
  await page.route("**/*", route => new URL(route.request().url()).origin === origin || route.request().url().startsWith("data:") ? route.continue() : route.abort())
  await page.goto(`${origin}/__grouped`)
  await page.locator("[data-shell-nav]").waitFor()
  await page.evaluate(() => document.fonts.ready)
  const close = async () => {
    if (await page.getByRole("dialog").count()) await page.keyboard.press("Escape")
    await page.getByRole("dialog").waitFor({state:"hidden"})
  }
  const open = async id => {
    await close()
    await page.evaluate(id => window.openPanel(id), id)
    await page.getByRole("dialog").getByRole("heading", {name:labels[id],exact:true,level:2}).waitFor()
    await page.getByText("Loading…", {exact:true}).waitFor({state:"hidden"})
    await page.waitForTimeout(150)
  }
  const onlyReads = () => page.evaluate(() => messages.filter(message => !['listApps','listAccounts','clipList','listAppIcons'].includes(message.type)))
  for (const [device,width,height,edge] of (process.env.LWFA_SKIP_SCREENSHOTS === "1" ? [] : [["desktop",1440,1000,"left"],["tablet",1024,768,"right"],["phone",390,844,"bottom"]])) {
    await page.setViewportSize({width,height})
    for (const theme of ["dark", "light"]) {
      await page.evaluate(config => configure(config), {theme,edge})
      for (const id of panels) {
        await open(id)
        const dialog = page.getByRole("dialog")
        const box = await dialog.boundingBox()
        assert(box.x >= -1 && box.y >= -1 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1, `${device} ${id}: sheet stays inside viewport ${JSON.stringify(box)}`)
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${device} ${id}: no page overflow`)
        const overflow = await dialog.locator('[data-radix-scroll-area-viewport]').evaluateAll(elements => elements.map(el => ({width:el.clientWidth,scrollWidth:el.scrollWidth,height:el.clientHeight,scrollHeight:el.scrollHeight})))
        assert(overflow.every(item => item.scrollWidth <= item.width + 1), `${device} ${id}: no horizontal panel overflow ${JSON.stringify(overflow)}`)
        const name = `${device}-${theme}-${id}.png`
        await page.screenshot({path:path.join(artifacts,name)})
        report.screenshots.push(name)
        report.layouts.push({device,theme,panel:id,box,overflow})
      }
    }
  }
  assert.deepEqual(await onlyReads(), [], "Opening any panel sends no remote input or window actions")
  await close()
  for (const edge of ["left", "right", "top", "bottom"]) {
    await page.setViewportSize({width:1024,height:768})
    await page.evaluate(edge => configure({theme:'dark',edge}), edge)
    await open("settings")
    const rail = await page.locator('[data-shell-nav]').boundingBox()
    const sheet = await page.getByRole('dialog').boundingBox()
    const overlap = Math.min(rail.x+rail.width,sheet.x+sheet.width)>Math.max(rail.x,sheet.x)+1 && Math.min(rail.y+rail.height,sheet.y+sheet.height)>Math.max(rail.y,sheet.y)+1
    assert(!overlap, `${edge}: panel does not cover the rail`)
    const railTargets=await page.locator('[data-shell-nav] button').evaluateAll(buttons=>buttons.map(button=>{const rect=button.getBoundingClientRect();return {label:button.getAttribute('aria-label'),width:rect.width,height:rect.height}}))
    assert(railTargets.every(button=>button.width>=44&&button.height>=44), `${edge}: default rail controls have 44px touch targets`)
    await page.screenshot({path:path.join(artifacts,`rail-${edge}.png`)})
    await close()
  }
  // The actual rail switches panels without remote focus or keyboard traffic.
  await page.setViewportSize({width:1440,height:1200})
  await page.evaluate(() => configure({theme:'dark',edge:'left'}))
  const rail = page.locator('[data-shell-nav]')
  await rail.getByRole('button',{name:'Session',exact:true}).click()
  await page.getByRole('dialog').getByRole('heading',{name:'Session',exact:true,level:2}).waitFor()
  await rail.getByRole('button',{name:'Appearance',exact:true}).click()
  await page.getByRole('dialog').getByRole('heading',{name:'Appearance',exact:true,level:2}).waitFor()
  await close()
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Appearance', 'Escape restores the rail opener')
  assert.deepEqual(await onlyReads(), [], 'Rail panel switching sends no input')
  // Deliberate focus outside a panel stays outside it on dismissal.
  await page.locator('#fixture-opener').click()
  await page.getByRole('dialog').waitFor()
  await page.locator('#fixture-outside').click()
  await page.getByRole('dialog').waitFor({state:'hidden'})
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'fixture-outside')
  // Overflowed merged tabs remain reachable with the keyboard and scroll.
  await page.setViewportSize({width:390,height:844})
  await page.evaluate(() => configure({theme:'dark',edge:'bottom'}))
  await page.evaluate(() => openPanel('more'))
  await page.getByRole('dialog').waitFor()
  const tabs = page.getByRole('dialog').getByRole('tablist').first().getByRole('tab')
  assert(await tabs.count() >= 6, 'merged More exposes every management panel')
  for (let index=0;index<await tabs.count();index++) {
    const tab=tabs.nth(index)
    await tab.scrollIntoViewIfNeeded()
    await tab.click()
    assert.equal(await tab.getAttribute('aria-selected'), 'true')
    const box=await tab.boundingBox()
    assert(box.x >= -1 && box.x+box.width <= 391, 'merged tab can be scrolled into view')
  }
  await tabs.first().focus()
  await page.keyboard.press('End')
  await page.waitForTimeout(100)
  assert.equal(await tabs.last().getAttribute('aria-selected'), 'true', 'End reaches the final merged tab')
  const lastTabBox=await tabs.last().boundingBox()
  assert(lastTabBox.x>=-1&&lastTabBox.x+lastTabBox.width<=391,'Keyboard navigation scrolls the final tab into view')
  await close()
  // A search edits local state without launching; an explicit launch fires once.
  await open('apps')
  await page.getByRole('textbox',{name:'Search applications'}).fill('Chromium')
  await page.getByRole('dialog').getByRole('button',{name:/Chromium/}).click()
  assert.deepEqual(await onlyReads(), [{type:'spawn',args:['chromium',false]}])
  await page.evaluate(() => {messages=[]})
  await close()
  await open('theme')
  // Capture touch hitboxes after layout settles, including controls below the fold.
  const smallTargets=[]
  for (const id of panels) {
    await open(id)
    const targets=page.getByRole('dialog').locator('button:not([disabled]), input:not([type=hidden]):not([disabled]), textarea:not([disabled]), [data-slot=slider]')
    for(let i=0;i<await targets.count();i++){
      const target=targets.nth(i)
      if(!await target.isVisible())continue
      await target.evaluate(el=>el.scrollIntoView({block:'center',inline:'nearest'}))
      const hitbox=await target.evaluate(el=>{
        const box=el.getBoundingClientRect()
        let width=box.width,height=box.height
        for(const pseudo of ['::before','::after']) {
          const style=getComputedStyle(el,pseudo)
          if(style.content==='none'||style.content==='normal'||style.pointerEvents==='none')continue
          width=Math.max(width,parseFloat(style.width)||0)
          height=Math.max(height,parseFloat(style.height)||0)
        }
        const center={x:box.x+box.width/2,y:box.y+box.height/2}
        const points=[{x:center.x-21,y:center.y},{x:center.x+21,y:center.y},{x:center.x,y:center.y-21},{x:center.x,y:center.y+21}]
        const hittable=points.map(point=>{const hit=document.elementFromPoint(point.x,point.y);return {point,hit:!!hit&&(hit===el||el.contains(hit))}})
        return {width,height,visualWidth:box.width,visualHeight:box.height,hittable}
      })
      if(hitbox.width < 43.5 || hitbox.height < 43.5 || hitbox.hittable.some(point=>!point.hit))smallTargets.push({panel:id,label:await target.getAttribute('aria-label') || (await target.innerText()).slice(0,70),...hitbox})
    }
  }
  report.smallTargets=smallTargets
  // The compact switch's expanded lower edge is a real target. It must toggle
  // this row without also toggling the adjacent setting underneath it.
  await open('theme')
  const beforeMotion=await page.evaluate(()=>({animate:getPrefs().motion.animate,follow:getPrefs().followEngineScroll}))
  const movement=page.getByRole('switch',{name:'Animate window movement',exact:true})
  await movement.evaluate(el=>el.scrollIntoView({block:'center'}))
  const movementBox=await movement.boundingBox()
  await page.mouse.click(movementBox.x+movementBox.width/2,movementBox.y+movementBox.height/2+20)
  assert.deepEqual(await page.evaluate(()=>({animate:getPrefs().motion.animate,follow:getPrefs().followEngineScroll})),{animate:!beforeMotion.animate,follow:beforeMotion.follow},'Expanded switch edge toggles only its own row')
  await page.getByRole('dialog').locator('[data-slot=toggle-group-item][aria-label=Light]').click()
  assert(await page.evaluate(()=>!document.documentElement.classList.contains('dark')), 'Appearance changes the portal and document theme')
  await open('mouse')
  const slider=page.getByRole('dialog').locator('[data-slot=slider]')
  await slider.evaluate(el=>el.scrollIntoView({block:'center'}))
  const sliderBox=await slider.boundingBox()
  const beforeSpeed=await page.evaluate(()=>getPrefs().mouse.scrollSpeed)
  await page.mouse.click(sliderBox.x+sliderBox.width*0.85,sliderBox.y+sliderBox.height/2+20)
  assert.notEqual(await page.evaluate(()=>getPrefs().mouse.scrollSpeed),beforeSpeed,'Slider track responds at its 44px touch boundary')
  assert.deepEqual(await onlyReads(), [], 'Local setting edits do not send remote input')
  await page.evaluate(()=>document.fonts.ready)
  report.fonts=await page.evaluate(()=>[...document.fonts].filter(font=>font.status==='loaded').map(font=>font.family))
  assert(report.fonts.some(family=>family.includes('Inter')), 'The local Inter font loaded')
  assert(report.fonts.some(family=>family.includes('JetBrains')), 'The local monospace font loaded')
  await writeFile(path.join(artifacts,'results.json'), JSON.stringify(report,null,2)+'\n')
  assert.deepEqual(report.errors, [], 'No browser exceptions')
  assert.deepEqual(smallTargets, [], 'Interactive panel controls provide 44px targets')
  console.log(`PASS: all eleven panels in both themes on desktop/tablet/phone, four rail edges, focus return, merged tabs, launch isolation, local fonts, and 44px controls. Screenshots: ${artifacts}`)
} finally {
  await writeFile(path.join(artifacts,'results.json'), JSON.stringify(report,null,2)+'\n')
  await browser?.close()
  await server.close()
}
