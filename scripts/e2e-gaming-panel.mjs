// Isolated UI fixture. No engine connection, installs, or game launches.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from '../packages/shell/node_modules/vite/dist/node/index.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const shell = fileURLToPath(new URL('../packages/shell/', import.meta.url));
const name = `.gaming-test-${process.pid}`;
const html = `${shell}${name}.html`;
const source = `${shell}${name}.tsx`;
let server, browser;
try {
  await fs.writeFile(html, `<div id="root"></div><script type="module" src="/${name}.tsx"></script>`);
  await fs.writeFile(source, `
import React from 'react';
import {createRoot} from 'react-dom/client';
import GamepadPanel from './src/panels/GamepadPanel';
import {SessionStateProvider,SessionActionsProvider} from './src/session';
import {gamingReply} from './src/lib/gaming';
import './src/index.css';
const inventory={games:[{appid:'123',name:'Test Game',directory:'/games/Test'}],profiles:{},proton:{tools:[]},lsfg:{installed:false,version:'1.0.0',dll_compatible:true},framegen:{installed:false,version:'0.9.4',overlaySupported:true},launchOption:"'/a path/lwfa-game' %command%",streamTargetFps:60};
window.requests=[];
const send=message=>{window.requests.push(message);setTimeout(()=>{
if(message.action==='install' && message.component!=='proton')inventory[message.component].installed=true;
if(message.action==='saveProfile')inventory.profiles[message.appid]=message.profile;
gamingReply({type:'gaming',request:message.request,data:structuredClone(inventory),error:null});
},30)};
const actions={send};
function Fixture(){const[account,setAccount]=React.useState('owner');window.setAccount=setAccount;return <SessionStateProvider value={{account,status:'connected'}}><SessionActionsProvider value={actions}><div style={{width:'min(380px,100vw)',padding:16}}><GamepadPanel/></div></SessionActionsProvider></SessionStateProvider>}
document.documentElement.classList.add('dark');
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
  server = await createServer({ root: shell, configFile: `${shell}vite.config.ts`, server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${name}.html`);
  await page.getByRole('switch', { name: 'Show the gamepad', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'LSFG', exact: true }).click();
  await page.getByRole('switch', { name: 'Use lsfg', exact: true }).waitFor();
  assert(await page.getByRole('switch', { name: 'Use lsfg', exact: true }).isDisabled(), 'missing component cannot be enabled');
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await page.getByText('Installed', { exact: true }).waitFor();
  await page.getByRole('switch', { name: 'Use lsfg', exact: true }).click();
  await page.getByLabel('Multiplier', { exact: true }).selectOption('3');
  await page.getByRole('button', { name: 'Save for next launch' }).click();
  await page.waitForFunction(() => window.requests.some(r => r.action === 'saveProfile' && r.profile.lsfg.multiplier === 3));
  await page.getByRole('button', { name: 'Save for next launch' }).waitFor({ state: 'visible' });
  await page.waitForTimeout(70);
  await page.getByRole('tab', { name: 'Framegen', exact: true }).click();
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await page.getByText('Installed', { exact: true }).waitFor();
  await page.getByRole('switch', { name: 'Use framegen', exact: true }).click();
  await page.getByLabel('Game integration', { exact: true }).selectOption('nukems');
  assert(await page.getByLabel('Frame generation backend', { exact: true }).isDisabled());
  await page.getByRole('button', { name: 'Save for next launch' }).click();
  await page.waitForFunction(() => window.requests.some(r => r.action === 'saveProfile' && r.profile.provider === 'framegen' && r.profile.framegen.output === 'nukems'));
  await page.getByText('Saved: Framegen. Applies on the next launch.', { exact: true }).waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'panel fits mobile width');
  if (process.env.GAMING_SCREENSHOT) await page.screenshot({ path: process.env.GAMING_SCREENSHOT, fullPage: true });
  await page.evaluate(() => window.setAccount('guest'));
  await page.getByText('Gaming components are managed by the session owner.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save for next launch' }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('Gaming panel: controller controls, installation, per-game save, provider switch, mobile width, and owner visibility passed.');
} finally {
  await browser?.close();
  await server?.close();
  await Promise.all([fs.rm(html, { force: true }), fs.rm(source, { force: true })]);
}
