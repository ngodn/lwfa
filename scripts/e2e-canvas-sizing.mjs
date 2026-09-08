// Native X11 geometry, monitor dimensions and input must follow the browser.
// Requires an empty isolated engine. Uses raw protocol messages so the same
// fixture can compare released engines with the current implementation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { waitForOpen } from './websocket-open.mjs';

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
const resultsDir = resolve(process.env.LWFA_TEST_RESULTS_DIR || 'target/canvas-sizing');
await mkdir(resultsDir, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'lwfa-canvas-sizing-'));
const reportPath = join(temporary, 'application.json');
const eventPath = `${reportPath}.events.jsonl`;
const binary = join(temporary, 'application');
const title = `lwfa-canvas-sizing-${process.pid}`;
const windows = new Map(), engineErrors = [];
const results = { startedAt: new Date().toISOString(), protocolVersions: [], phases: [], failures: [] };
let socket, application, id;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assert.deepEqual(engineErrors, [], 'No engine errors');
    if (await check()) return;
    await delay(25);
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
async function connect() {
  let hello = false;
  socket = new WebSocket(endpoint);
  socket.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') return;
    const message = JSON.parse(data);
    if (message.type === 'hello') {
      hello = true; windows.clear();
      for (const window of message.windows) windows.set(window.id, window);
      results.protocolVersions.push(message.protocolVersion);
    }
    if (message.window && typeof message.window === 'object') windows.set(message.window.id, message.window);
    if (message.type === 'windowClosed') windows.delete(message.id);
    if (message.type === 'error') engineErrors.push(message);
  });
  await waitForOpen(socket); await until(() => hello, 'authenticated hello');
}
const send = message => socket.send(JSON.stringify(message));
async function disconnect() {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  await new Promise(resolve => { socket.addEventListener('close', resolve, { once: true }); socket.close(); });
}
function geometry() {
  const query = spawnSync(binary, ['--query', String(application.window)], {
    env: { ...process.env, DISPLAY: application.display }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(query.status, 0, `Reading isolated fixture failed: ${query.stderr}`);
  return JSON.parse(query.stdout);
}
async function events() {
  return (await readFile(eventPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function check(phase, label, actual, expected) {
  try { assert.deepEqual(actual, expected, label); }
  catch (error) { phase.failures.push({ label, actual, expected }); results.failures.push({ phase: phase.name, label, actual, expected }); }
}
const layout = size => ({ type: 'setLayout', windows: [{ id, z: 0, rect: { x: 0, y: 0, ...size } }], animate: null });
async function phase(name, viewport, windowSize, changeViewport = true, displayScale = 1) {
  const entry = { name, viewport, requestedWindow: windowSize, displayScale, failures: [] };
  results.phases.push(entry);
  const beforeEvents = (await events()).length;
  if (changeViewport) send({ type: 'setViewport', ...viewport, scale: displayScale });
  send(layout(windowSize));
  // Geometry and output mode changes are asynchronous. Record a mismatch if
  // either stays wrong, then keep measuring the other independent invariants.
  try {
    await until(() => {
      const actual = geometry();
      return actual.width === windowSize.width && actual.height === windowSize.height && actual.monitorWidth === viewport.width && actual.monitorHeight === viewport.height;
    }, `${name} native geometry and monitor`, 3000);
  } catch (error) { entry.readinessError = error.message; }
  const actual = entry.native = geometry();
  check(entry, 'Native client size equals its canvas', { width: actual.width, height: actual.height }, windowSize);
  check(entry, 'Monitor equals browser viewport, without window growth or DPR multiplication', { width: actual.monitorWidth, height: actual.monitorHeight }, viewport);
  check(entry, 'Xwayland process survives viewport changes', await xwaylandPids(), results.xwaylandPids);
  // A wider column may extend past the visible monitor. Exercise the farthest
  // visible point instead of sending an unreachable off-screen coordinate.
  const x = Math.min(actual.width, actual.monitorWidth - actual.x) - 4;
  const y = Math.min(actual.height, actual.monitorHeight - actual.y) - 4;
  assert(x > 0 && y > 0, 'Fixture must have a visible far corner');
  const inputStart = (await events()).length;
  send({ type: 'focusWindow', id });
  // Logical coordinates are supported by both 1.4.5 and the current protocol.
  send({ type: 'pointerMotion', window: id, x, y });
  send({ type: 'pointerButton', button: 272, pressed: true });
  send({ type: 'pointerButton', button: 272, pressed: false });
  try { await until(async () => (await events()).slice(inputStart).some(event => event.kind === 'press'), `${name} corner input`, 3000); }
  catch (error) { entry.inputError = error.message; }
  entry.input = (await events()).slice(inputStart).filter(event => event.kind === 'press');
  check(entry, 'Far visible corner receives the requested pointer position', entry.input.map(({ x, y }) => ({ x, y })), [{ x, y }]);
  entry.configureEvents = (await events()).slice(beforeEvents).filter(event => event.kind === 'configure');
  entry.passed = entry.failures.length === 0;
  await writeFile(join(resultsDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
}
try {
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
  Window w=strtoul(argv[2],NULL,10),child;XWindowAttributes a,root;int x,y;
  if(!XGetWindowAttributes(d,w,&a)||!XGetWindowAttributes(d,DefaultRootWindow(d),&root))return 6;
  XTranslateCoordinates(d,w,DefaultRootWindow(d),0,0,&x,&y,&child);
  printf("{\\\"x\\\":%d,\\\"y\\\":%d,\\\"width\\\":%d,\\\"height\\\":%d,\\\"monitorWidth\\\":%d,\\\"monitorHeight\\\":%d}\\n",x,y,a.width,a.height,root.width,root.height);
  XCloseDisplay(d);return 0;
 }
 Window w=XCreateSimpleWindow(d,DefaultRootWindow(d),0,0,640,400,0,0,0x3edbc8);
 char path[4096];snprintf(path,sizeof(path),"%s.events.jsonl",argv[1]);FILE*events=fopen(path,"w");if(!events)return 7;
 FILE*f=fopen(argv[1],"w");if(!f)return 5;
 fprintf(f,"{\\\"pid\\\":%ld,\\\"window\\\":%lu,\\\"display\\\":\\\"%s\\\"}\\n",(long)getpid(),w,name);fclose(f);
 XSelectInput(d,w,StructureNotifyMask|ButtonPressMask);XStoreName(d,w,argv[2]);
 Atom close=XInternAtom(d,"WM_DELETE_WINDOW",False);XSetWMProtocols(d,w,&close,1);XMapWindow(d,w);XFlush(d);
 for(;;){XEvent e;XNextEvent(d,&e);
  if(e.type==ClientMessage&&(Atom)e.xclient.data.l[0]==close)break;
  if(e.type==ConfigureNotify)fprintf(events,"{\\\"kind\\\":\\\"configure\\\",\\\"width\\\":%d,\\\"height\\\":%d}\\n",e.xconfigure.width,e.xconfigure.height);
  if(e.type==ButtonPress)fprintf(events,"{\\\"kind\\\":\\\"press\\\",\\\"x\\\":%d,\\\"y\\\":%d}\\n",e.xbutton.x,e.xbutton.y);
  fflush(events);
 }
 fclose(events);XDestroyWindow(d,w);XCloseDisplay(d);return 0;
}
`);
  const compile = spawnSync(process.env.CC || 'cc', ['-std=c11', '-Wall', '-Wextra', join(temporary, 'application.c'), '-lX11', '-o', binary], { encoding: 'utf8', timeout: 30000 });
  assert.equal(compile.status, 0, compile.stderr);
  await connect();
  assert.equal(windows.size, 0, 'Use an empty engine with autostart disabled');
  send({ type: 'setViewport', width: 1319, height: 839, scale: 1 });
  // Released protocol 0 did not queue launches until Xwayland was ready.
  // Startup queuing is covered separately; compare sizing after initialization.
  if (results.protocolVersions.at(-1) === 0) await delay(500);
  send({ type: 'spawn', command: [binary, reportPath, title].map(value => `"${value}"`).join(' '), terminal: false });
  await until(async () => {
    try { application = JSON.parse(await readFile(reportPath, 'utf8')); return [...windows.values()].some(window => window.title === title); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  }, 'isolated fixture opens');
  assert.match(application.display, /^:\d+(?:\.\d+)?$/);
  id = [...windows.values()].find(window => window.title === title).id;
  results.xwaylandPids = await xwaylandPids();
  assert.equal(results.xwaylandPids.length, 1, 'One Xwayland server belongs to the isolated engine');
  results.application = application;
  await phase('initial-odd-viewport', { width: 1319, height: 839 }, { width: 1000, height: 600 });
  await phase('window-growth-only', { width: 1319, height: 839 }, { width: 1324, height: 600 }, false);
  for (const [name, viewport] of [
    ['landscape', { width: 1324, height: 838 }],
    ['portrait', { width: 838, height: 1324 }],
    ['landscape-return', { width: 1324, height: 838 }],
  ]) await phase(name, viewport, viewport);
  await phase('browser-dpr2', { width: 1324, height: 838 }, { width: 1324, height: 838 }, true, 2);
  await delay(300);
  const beforeReconnect = (await events()).length;
  await disconnect(); await connect();
  assert(windows.has(id), 'Reconnect preserves the native application');
  await phase('reconnect-same-viewport', { width: 1324, height: 838 }, { width: 1324, height: 838 }, true, 2);
  await delay(300);
  const reconnect = results.phases.at(-1);
  reconnect.allReconnectConfigurations = (await events()).slice(beforeReconnect).filter(event => event.kind === 'configure');
  check(reconnect, 'Same viewport reconnect produces no synthetic native reconfiguration', reconnect.allReconnectConfigurations, []);
  reconnect.passed = reconnect.failures.length === 0;
  send({ type: 'closeWindow', id });
  await until(() => !windows.has(id), 'fixture closes normally');
  results.passed = results.failures.length === 0;
  if (!results.passed) process.exitCode = 1;
} catch (error) {
  results.passed = false; results.error = error.message.replaceAll(process.env.AUTH_PASS, '<redacted>'); process.exitCode = 1;
} finally {
  if (application) {
    try { if (await readlink(`/proc/${application.pid}/exe`) === binary) process.kill(application.pid, 'SIGTERM'); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) { results.cleanupError = error.message; results.passed = false; process.exitCode = 1; } }
  }
  await disconnect();
  results.engineErrors = engineErrors;
  results.finishedAt = new Date().toISOString();
  await writeFile(join(resultsDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify(results));
}
