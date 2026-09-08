// First browser viewport -> Xwayland monitor and inherited application DISPLAY.
// Run against a freshly started, empty, isolated engine. Never discovers production.
// Required: LWFA_ISOLATED_TEST=1 LWFA_TEST_URL AUTH_PASS LWFA_TEST_ENGINE_PID.
// Optional: LWFA_TEST_BROWSER=1 checks a built-shell refresh preserves a chosen column width.
// LWFA_TEST_RESULTS_DIR defaults to target/client-display. The caller owns the engine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { waitForOpen } from './websocket-open.mjs';
import { PROTOCOL_VERSION } from '../packages/proto/src/index.ts';

assert.equal(process.env.LWFA_ISOLATED_TEST, '1');
for (const name of ['LWFA_TEST_URL', 'AUTH_PASS', 'LWFA_TEST_ENGINE_PID']) assert(process.env[name], `${name} is required`);
const enginePid = Number(process.env.LWFA_TEST_ENGINE_PID);
assert(Number.isSafeInteger(enginePid) && enginePid > 1);
assert.equal((await readFile(`/proc/${enginePid}/comm`, 'utf8')).trim(), 'lwfa-engine');
const endpoint = new URL(process.env.LWFA_TEST_URL);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'Use a loopback isolated engine');
assert(['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol));
endpoint.protocol = ['https:', 'wss:'].includes(endpoint.protocol) ? 'wss:' : 'ws:';
endpoint.searchParams.set('token', process.env.AUTH_PASS);
const viewport = { width: 1324, height: 838 };
const resultsDir = resolve(process.env.LWFA_TEST_RESULTS_DIR || 'target/client-display');
await mkdir(resultsDir, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'lwfa-client-display-'));
const reportPath = join(temporary, 'application.json');
const title = `lwfa-client-display-${process.pid}`;
const windows = new Map(), errors = [];
const results = { startedAt: new Date().toISOString(), viewport, protocolVersion: PROTOCOL_VERSION, greetings: [], phases: [] };
async function wineCanvasOptions(pid) {
  const entries = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0');
  return Object.fromEntries(['WINE_CANVAS_FOLLOW_HOST', 'WINE_CANVAS_DPI_SAFE'].map(name =>
    [name, entries.find(entry => entry.startsWith(`${name}=`))?.slice(name.length + 1) ?? null]));
}
const engineOptions = await wineCanvasOptions(enginePid);
let socket, application, interrupted = false;
const stop = () => { interrupted = true; };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assert(!interrupted, 'Interrupted');
    assert.deepEqual(errors, [], 'No engine errors');
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function xwaylandPids() {
  const children = (await readFile(`/proc/${enginePid}/task/${enginePid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
  const matches = await Promise.all(children.map(async pid => {
    try { return (await readFile(`/proc/${pid}/comm`, 'utf8')).trim() === 'Xwayland' ? Number(pid) : null; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }));
  return matches.filter(pid => pid !== null);
}
function monitor(display) {
  const query = spawnSync('xrandr', ['--current'], { env: { ...process.env, DISPLAY: display }, encoding: 'utf8', timeout: 5000 });
  assert.equal(query.status, 0, `Reading isolated display failed: ${query.stderr}`);
  const match = /current (\d+) x (\d+)/.exec(query.stdout);
  assert(match, 'Xrandr must report the current monitor size');
  return { width: Number(match[1]), height: Number(match[2]) };
}
async function connect() {
  let hello = false;
  socket = new WebSocket(endpoint);
  socket.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') return;
    const message = JSON.parse(data);
    if (message.type === 'hello') {
      results.greetings.push({ protocolVersion: message.protocolVersion, windows: message.windows.length });
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        errors.push({ type: 'protocolMismatch', expected: PROTOCOL_VERSION, actual: message.protocolVersion });
        return;
      }
      hello = true; windows.clear(); for (const window of message.windows) windows.set(window.id, window);
    }
    if (message.window && typeof message.window === 'object') windows.set(message.window.id, message.window);
    if (message.type === 'windowClosed') windows.delete(message.id);
    if (message.type === 'error') errors.push(message);
  });
  await waitForOpen(socket); await until(() => hello, 'authenticated hello');
}
const send = message => socket.send(JSON.stringify(message));
async function disconnect() {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  await new Promise(resolve => { socket.addEventListener('close', resolve, { once: true }); socket.close(); });
}
try {
  // This native app records the DISPLAY supplied by lwfa and opens its own window.
  // Xlib reads screen dimensions; it does not request display mode changes.
  await writeFile(join(temporary, 'application.c'), `#include <X11/Xlib.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc,char**argv){
  if(argc!=3)return 2;
  const char*name=getenv("DISPLAY");if(!name)return 3;
  Display*d=XOpenDisplay(NULL);if(!d)return 4;
  if(strcmp(argv[1],"--query")==0){
    XWindowAttributes a;if(!XGetWindowAttributes(d,strtoul(argv[2],NULL,10),&a))return 6;
    printf("{\\\"x\\\":%d,\\\"y\\\":%d,\\\"width\\\":%d,\\\"height\\\":%d}\\n",a.x,a.y,a.width,a.height);
    XCloseDisplay(d);return 0;
  }
  Window w=XCreateSimpleWindow(d,DefaultRootWindow(d),0,0,640,400,0,0,0);
  FILE*f=fopen(argv[1],"w");if(!f)return 5;
  fprintf(f,"{\\\"pid\\\":%ld,\\\"window\\\":%lu,\\\"display\\\":\\\"%s\\\",\\\"width\\\":%d,\\\"height\\\":%d}\\n",(long)getpid(),w,name,DisplayWidth(d,DefaultScreen(d)),DisplayHeight(d,DefaultScreen(d)));fclose(f);
  char path[4096];snprintf(path,sizeof(path),"%s.geometry.jsonl",argv[1]);
  FILE*geometry=fopen(path,"w");if(!geometry)return 7;
  XSelectInput(d,w,StructureNotifyMask);XStoreName(d,w,argv[2]);
  Atom close=XInternAtom(d,"WM_DELETE_WINDOW",False);XSetWMProtocols(d,w,&close,1);XMapWindow(d,w);XFlush(d);
  for(;;){XEvent event;XNextEvent(d,&event);
    if(event.type==ClientMessage&&(Atom)event.xclient.data.l[0]==close)break;
    if(event.type==ConfigureNotify){fprintf(geometry,"{\\\"width\\\":%d,\\\"height\\\":%d}\\n",event.xconfigure.width,event.xconfigure.height);fflush(geometry);}
  }
  fclose(geometry);XDestroyWindow(d,w);XCloseDisplay(d);return 0;
}
`);
  const binary = join(temporary, 'application');
  const compile = spawnSync(process.env.CC || 'cc', ['-std=c11', '-Wall', '-Wextra', join(temporary, 'application.c'), '-lX11', '-o', binary], { encoding: 'utf8', timeout: 30000 });
  assert.equal(compile.status, 0, compile.stderr);
  await connect();
  assert.equal(windows.size, 0, 'Use an empty engine with autostart disabled');
  results.before = { xwaylandPids: await xwaylandPids() };
  assert.deepEqual(results.before.xwaylandPids, [], 'Automatic Xwayland must await the first valid browser viewport');
  // Paths are generated by mkdtemp without shell metacharacters. Quote each
  // argument for lwfa's command-line parser, never invoke a command shell.
  send({ type: 'spawn', command: [binary, reportPath, title].map(value => `"${value}"`).join(' '), terminal: false });
  send({ type: 'setViewport', width: 100, height: 100, scale: 1 });
  await delay(300);
  await assert.rejects(access(reportPath), { code: 'ENOENT' }, 'Early launch must remain queued before a valid viewport');
  assert.deepEqual(await xwaylandPids(), [], 'An invalid viewport must not initialize Xwayland');
  results.phases.push({ phase: 'queued-before-valid-viewport', viewport: { width: 100, height: 100 }, xwaylandPids: [], applicationStarted: false });
  send({ type: 'setViewport', ...viewport, scale: 2 });
  await until(async () => {
    try { application = JSON.parse(await readFile(reportPath, 'utf8')); return [...windows.values()].some(window => window.title === title); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  }, 'queued application inherits the initialized Xwayland display');
  assert.match(application.display, /^:\d+(?:\.\d+)?$/);
  results.applicationWineOptions = await wineCanvasOptions(application.pid);
  assert.deepEqual(results.applicationWineOptions, { WINE_CANVAS_FOLLOW_HOST: '1', WINE_CANVAS_DPI_SAFE: '1' },
    'Nested applications inherit the compatible Wine tool options');
  assert.deepEqual(await wineCanvasOptions(enginePid), engineOptions,
    'Launching nested apps must not change the parent engine environment');
  assert.deepEqual({ width: application.width, height: application.height }, viewport, 'Application must observe the first browser viewport, without multiplying by browser DPR');
  const id = [...windows.values()].find(window => window.title === title).id;
  const serverPids = await xwaylandPids();
  assert.equal(serverPids.length, 1, 'One Xwayland server belongs to the isolated engine');
  results.application = application;
  results.phases.push({ phase: 'first-viewport', viewport, monitor: monitor(application.display), xwaylandPids: serverPids, window: id });
  for (const [name, size] of [['page-refresh', viewport], ['changed-viewport', { width: 1490, height: 910 }]]) {
    await disconnect(); await connect();
    assert(windows.has(id), 'Reconnect preserves the running application');
    send({ type: 'setViewport', ...size, scale: 2 });
    await until(() => {
      const current = monitor(application.display);
      return current.width === size.width && current.height === size.height;
    }, `${name} monitor follows the browser canvas`);
    const observed = { phase: name, viewport: size, monitor: monitor(application.display), xwaylandPids: await xwaylandPids() };
    results.phases.push(observed);
    assert.deepEqual(observed.monitor, size, 'Monitor follows the current browser canvas without multiplying by DPR');
    assert.deepEqual(observed.xwaylandPids, serverPids, 'Reconnect must not restart Xwayland');
    process.kill(application.pid, 0);
  }
  if (process.env.LWFA_TEST_BROWSER === '1') {
    await disconnect();
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium' });
    const nativeGeometry = () => {
      const query = spawnSync(binary, ['--query', String(application.window)], {
        env: { ...process.env, DISPLAY: application.display }, encoding: 'utf8', timeout: 5000,
      });
      assert.equal(query.status, 0, `Reading fixture geometry failed: ${query.stderr}`);
      return JSON.parse(query.stdout);
    };
    const geometryEvents = async () => (await readFile(`${reportPath}.geometry.jsonl`, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const page = await browser.newPage({ viewport: { width: 1389, height: 838 } });
    try {
      const wire = [], browserErrors = [];
      page.on('pageerror', error => browserErrors.push(error.message));
      page.on('websocket', connection => connection.on('framesent', ({ payload }) => {
        if (typeof payload === 'string') { try { wire.push(JSON.parse(payload)); } catch {} }
      }));
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'getGamepads', { value: () => [] });
        localStorage.setItem('lwfa.prefs', JSON.stringify({ stream: { audio: false }, nav: { size: 'md', edge: 'left' } }));
      });
      const shellUrl = new URL(process.env.LWFA_TEST_URL);
      shellUrl.protocol = ['https:', 'wss:'].includes(shellUrl.protocol) ? 'https:' : 'http:';
      shellUrl.searchParams.set('token', process.env.AUTH_PASS);
      await page.goto(shellUrl.toString());
      const surface = page.getByRole('application', { name: title, exact: true });
      await surface.waitFor();
      await until(() => wire.some(message => message.type === 'setViewport'), 'built shell reports its viewport');
      const measured = wire.filter(message => message.type === 'setViewport').at(-1);
      if (measured.width !== viewport.width || measured.height !== viewport.height) {
        const size = page.viewportSize();
        await page.setViewportSize({ width: size.width + viewport.width - measured.width, height: size.height + viewport.height - measured.height });
      }
      await until(() => {
        const size = nativeGeometry();
        return size.width === 1192 && size.height === 814;
      }, 'default 90% column is 1192×814');
      await until(() => {
        const current = monitor(application.display);
        return current.width === viewport.width && current.height === viewport.height;
      }, 'built shell restores the monitor to its canvas size');
      const beforeChoice = nativeGeometry();
      const monitorBeforeChoice = monitor(application.display);
      await page.getByRole('navigation', { name: 'Shell navigation' }).getByRole('button', { name: 'Windows', exact: true }).click();
      const actions = page.getByRole('button', { name: `Actions for ${title}`, exact: true });
      if (await actions.getAttribute('aria-expanded') !== 'true') await actions.click();
      await page.getByLabel('50% wide', { exact: true }).click();
      await page.getByRole('navigation', { name: 'Shell navigation' }).getByRole('button', { name: 'Windows', exact: true }).click();
      await until(() => {
        const size = nativeGeometry();
        return size.width === 662 && size.height === 814;
      }, 'deliberately selected 50% column is 662×814');
      await delay(300);
      const before = nativeGeometry();
      const monitorBeforeReload = monitor(application.display);
      const eventCount = (await geometryEvents()).length;
      wire.length = 0;
      await page.reload();
      await surface.waitFor();
      await until(() => wire.some(message => message.type === 'setLayout' && message.windows.some(window => window.id === id)), 'reloaded shell restores its layout');
      await delay(750);
      const after = nativeGeometry();
      const reloadGeometry = (await geometryEvents()).slice(eventCount);
      const declarations = wire.filter(message => message.type === 'setLayout').flatMap(message => message.windows.filter(window => window.id === id));
      const monitorAfterReload = monitor(application.display);
      const browserServerPids = await xwaylandPids();
      results.browser = { beforeChoice, before, after, monitorBeforeChoice, monitorBeforeReload, monitorAfterReload, xwaylandPids: browserServerPids, reloadGeometry, declarations, passed: false };
      assert.deepEqual(monitorBeforeReload, viewport, 'Choosing a narrower column must not shrink the shared monitor');
      assert.deepEqual(monitorAfterReload, viewport, 'Reload preserves the canvas-sized monitor');
      assert.deepEqual(browserServerPids, serverPids, 'Browser layout and reload must not restart Xwayland');
      assert.deepEqual({ width: after.width, height: after.height }, { width: before.width, height: before.height }, 'Page reload preserves the chosen native window size');
      assert(reloadGeometry.every(size => size.width === before.width && size.height === before.height), 'Reload must not briefly resize the application to the default width');
      assert(declarations.length > 0 && declarations.every(window => Math.round(window.rect.width) === 662 && Math.round(window.rect.height) === 814), 'Every reconnect layout preserves the selected column width');
      assert.deepEqual(browserErrors, []);
      results.browser.passed = true;
      await page.screenshot({ path: join(resultsDir, 'reloaded-column.png') });
    } catch (error) {
      await page.screenshot({ path: join(resultsDir, 'browser-failure.png') }).catch(() => {});
      results.browserFailure = await page.locator('button').evaluateAll(buttons => buttons.map(button => ({
        label: button.getAttribute('aria-label'), role: button.getAttribute('role'), text: button.textContent,
      }))).catch(() => []);
      throw error;
    } finally { await browser.close(); }
    await connect();
  }
  send({ type: 'closeWindow', id });
  await until(() => !windows.has(id), 'fixture closes normally');
  results.passed = true;
} catch (error) {
  results.passed = false; results.error = error.message.replaceAll(process.env.AUTH_PASS, '<redacted>'); process.exitCode = 1;
} finally {
  if (application) {
    try {
      if (await readlink(`/proc/${application.pid}/exe`) === join(temporary, 'application')) process.kill(application.pid, 'SIGTERM');
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) { results.cleanupError = error.message; results.passed = false; process.exitCode = 1; }
    }
  }
  await disconnect();
  results.finishedAt = new Date().toISOString();
  await writeFile(join(resultsDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  await rm(temporary, { recursive: true, force: true });
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
  console.log(JSON.stringify(results));
}
