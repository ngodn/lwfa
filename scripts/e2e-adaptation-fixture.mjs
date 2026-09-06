// Launch a private native Wayland Chromium fixture, run the dev transport
// check, then close both. Use ADAPTATION_FIXTURE=noise for the entropy stress
// case; the default is a scrolling document. See reliability-adaptation.md.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.LWFA_TEST_WAYLAND, 'LWFA_TEST_WAYLAND must name the isolated dev compositor');
assert(process.env.AUTH_PASS, 'AUTH_PASS must be the dev engine password');
const profile = await mkdtemp(join(tmpdir(), 'lwfa-adaptation-'));
const fixture = join(profile, 'motion.html');
const noise = `<style>html,body{margin:0;overflow:hidden}canvas{width:100vw;height:100vh}</style><canvas width="1000" height="700"></canvas><script>const c=document.querySelector('canvas').getContext('2d');let frame=0;function draw(){for(let y=0;y<700;y+=12)for(let x=0;x<1000;x+=12){const v=(Math.imul(x+frame,1664525)^Math.imul(y+frame,1013904223))>>>0;c.fillStyle='#'+(v&0xffffff).toString(16).padStart(6,'0');c.fillRect(x,y,12,12)}frame++;requestAnimationFrame(draw)}draw()</script>`;
const document = `<style>html,body{margin:0;background:#fafafa;color:#242424;font:16px/24px sans-serif;overflow:hidden}header{height:48px;background:#234673;color:white;padding-left:180px;display:flex;align-items:center}aside{position:absolute;top:48px;bottom:0;width:144px;background:#e6edf4;padding:8px}main{position:absolute;left:180px;right:20px;top:64px;bottom:0;overflow:hidden}p{margin:0 0 16px}</style><header>lwfa remote document</header><aside>Documents<br>Projects<br>Settings</aside><main><article></article></main><script>const article=document.querySelector('article');for(let i=0;i<100;i++){const p=document.createElement('p');p.textContent='Paragraph '+i+': Remote desktop streaming should keep text readable while the page scrolls. This moving document exercises ordinary window content, with a fixed toolbar and navigation sidebar.';article.append(p)}let frame=0;function draw(){article.style.transform='translateY(-'+((frame++*2)%2000)+'px)';requestAnimationFrame(draw)}draw()</script>`;
await writeFile(fixture, `<title>lwfa-adaptation-probe</title>${process.env.ADAPTATION_FIXTURE === 'noise' ? noise : document}`);
let native;
try {
  native = await chromium.launchPersistentContext(join(profile, 'native'), {
    executablePath: '/usr/bin/chromium', headless: false, viewport: null,
    env: { ...process.env, WAYLAND_DISPLAY: process.env.LWFA_TEST_WAYLAND },
    args: ['--ozone-platform=wayland', `--app=file://${fixture}`, '--no-first-run', '--password-store=basic'],
  });
  await new Promise(resolve => setTimeout(resolve, 1500));
  const child = spawn(process.execPath, ['scripts/e2e-adaptation.mjs'], { stdio: 'inherit', env: process.env });
  process.exitCode = (await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); })) ?? 1;
} finally {
  await native?.close();
  await rm(profile, { recursive: true, force: true });
}
