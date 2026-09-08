// Isolated fullscreen Wine window -> engine stream regression. Uses a fresh
// prefix and changes only the explicitly selected test compositor's display.
// Required: LWFA_ISOLATED_TEST=1 LWFA_TEST_URL AUTH_PASS LWFA_TEST_DISPLAY
// PROTON_DIR ZIG. Optional LWFA_TEST_RESULTS_DIR (default target/proton-fullscreen).
// LWFA_TEST_DXVK=1 uses GE's native D3D11 fullscreen swapchain implementation.
// LWFA_TEST_WINDOWS_ARCH=i686 also exercises the 32-bit Wine libraries.
// LWFA_TEST_FULLSCREEN_MATRIX=1 also exercises viewport resizing and fullscreen exit.
// LWFA_TEST_ALLOW_CACHED_MODE=1 diagnoses presentation while permitting an old Wine virtual mode.
// LWFA_TEST_CANVAS_OUTPUT=1 requires monitor and app dimensions to follow each viewport.
// LWFA_TEST_DXVK_RESPONSIVE=1 also resizes fullscreen buffers on client-size changes.
// LWFA_TEST_RENDER_SIZE=1280x720 selects a smaller DXVK emulated display mode.
// LWFA_TEST_BROWSER=1 verifies the built shell's full-canvas image and mouse input.
// LWFA_TEST_MONITOR_SIZE=WxH asserts the monitor selected after the first viewport.
// Without it, query the selected monitor; explicit fixed-resolution engines work too.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFrame } from '../packages/proto/src/index.ts';
import { waitForOpen } from './websocket-open.mjs';

assert.equal(process.env.LWFA_ISOLATED_TEST, '1');
for (const name of ['LWFA_TEST_URL', 'AUTH_PASS', 'LWFA_TEST_DISPLAY', 'PROTON_DIR', 'ZIG']) assert(process.env[name], `${name} must explicitly identify the isolated environment`);
assert(isAbsolute(process.env.PROTON_DIR) && isAbsolute(process.env.ZIG));
const url = new URL(process.env.LWFA_TEST_URL);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use a loopback isolated engine');
assert(['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol));
url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
url.searchParams.set('token', process.env.AUTH_PASS);
const resultsDir = resolve(process.env.LWFA_TEST_RESULTS_DIR || 'target/proton-fullscreen');
await mkdir(resultsDir, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'lwfa-proton-fullscreen-'));
const prefix = join(temporary, 'prefix');
await mkdir(prefix);
const env = { ...process.env, DISPLAY: process.env.LWFA_TEST_DISPLAY, WAYLAND_DISPLAY: '', WINEPREFIX: prefix, WINEDEBUG: process.env.LWFA_TEST_WINE_DEBUG || '-all', WINEDLLOVERRIDES: 'mscoree,mshtml=', WINEESYNC: '0', WINEFSYNC: '0' };
const dxvk = process.env.LWFA_TEST_DXVK === '1';
const windowsArch = process.env.LWFA_TEST_WINDOWS_ARCH || 'x86_64';
assert(['x86_64', 'i686'].includes(windowsArch), 'LWFA_TEST_WINDOWS_ARCH must be x86_64 or i686');
const canvasOutput = process.env.LWFA_TEST_CANVAS_OUTPUT === '1';
const allowCachedMode = process.env.LWFA_TEST_ALLOW_CACHED_MODE === '1';
if (process.env.LWFA_TEST_DXVK_RESPONSIVE === '1') env.LWFA_FIXTURE_RESPONSIVE = '1';
let protocolVersion, expectedMonitor;
const renderSize = process.env.LWFA_TEST_RENDER_SIZE?.match(/^(\d+)x(\d+)$/);
assert(!process.env.LWFA_TEST_RENDER_SIZE || (dxvk && renderSize && Number(renderSize[1]) > 100 && Number(renderSize[2]) > 100), 'LWFA_TEST_RENDER_SIZE requires DXVK and positive WxH dimensions greater than the corner markers');
if (renderSize) {
  env.LWFA_FIXTURE_RENDER_WIDTH = renderSize[1];
  env.LWFA_FIXTURE_RENDER_HEIGHT = renderSize[2];
}
if (dxvk) {
  env.WINEDLLOVERRIDES += ';d3d11,dxgi=n';
  env.DXVK_LOG_PATH = resultsDir;
}
delete env.LD_PRELOAD;
const results = { startedAt: new Date().toISOString(), windowsArch, viewport: { width: 1324, height: 838 }, phases: [], errors: [] };
let socket, child, childError, output = '', diagnostics = '', interrupted = false;
let frames = 0, latestFrame;
const stop = () => { interrupted = true; };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assert(!interrupted, 'Interrupted');
    assert(!childError, childError?.message);
    if (check()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 30000, ...extra });
  assert(!result.error, result.error?.message);
  assert.equal(result.status, 0, `${command}: ${result.stderr?.toString()}`);
  return result.stdout;
}
function records(kind) {
  return output.split('\n').filter(line => line.startsWith(`${kind} `)).flatMap(line => {
    try { return [JSON.parse(line.slice(kind.length + 1))]; } catch { return []; }
  });
}
function x11Snapshot() {
  const geometry = JSON.parse(run(join(temporary, 'x11'), []));
  const netWmState = run('xprop', ['-id', String(geometry.id), '_NET_WM_STATE']).trim();
  return { ...geometry, netWmState, netWmFullscreen: netWmState.includes('_NET_WM_STATE_FULLSCREEN') };
}
try {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/proton-fullscreen-window.c');
  run(process.env.ZIG, ['cc', '-std=c11', '-target', `${windowsArch === 'i686' ? 'x86' : windowsArch}-windows-gnu`, fixture, '-o', join(temporary, 'fixture.exe'), '-luser32', '-lgdi32', ...(dxvk ? ['-DDXVK_FIXTURE', '-ld3d11', '-ldxgi'] : [])], { timeout: 180000 });
  if (dxvk) {
    for (const name of ['d3d11.dll', 'dxgi.dll']) await copyFile(join(process.env.PROTON_DIR, `files/lib/wine/dxvk/${windowsArch === 'i686' ? 'i386' : 'x86_64'}-windows`, name), join(temporary, name));
    results.renderer = 'DXVK D3D11 fullscreen swapchain';
  }
  // Query this test display's native geometry, independently of Wine's
  // emulated GetWindowRect result. The helper only reads the X server.
  await writeFile(join(temporary, 'x11.c'), `#include <X11/Xlib.h>
#include <stdio.h>
#include <string.h>
static int find(Display*d,Window w,int depth){char*n=NULL;XFetchName(d,w,&n);int match=n&&strcmp(n,"lwfa-proton-fullscreen-fixture")==0;if(n)XFree(n);if(match){XWindowAttributes a;XGetWindowAttributes(d,w,&a);printf("{\\"id\\":%lu,\\"x\\":%d,\\"y\\":%d,\\"width\\":%d,\\"height\\":%d}\\n",w,a.x,a.y,a.width,a.height);return 1;}Window root,parent,*kids=NULL;unsigned count=0;int found=0;if(depth<8&&XQueryTree(d,w,&root,&parent,&kids,&count)){for(unsigned i=0;i<count&&!found;i++)found=find(d,kids[i],depth+1);if(kids)XFree(kids);}return found;}
int main(void){Display*d=XOpenDisplay(NULL);if(!d)return 2;int found=find(d,DefaultRootWindow(d),0);XCloseDisplay(d);return found?0:3;}
`);
  run(process.env.CC || 'cc', ['-std=c11', join(temporary, 'x11.c'), '-lX11', '-o', join(temporary, 'x11')]);
  await writeFile(join(temporary, 'pointer.c'), `#include <X11/Xlib.h>
#include <stdio.h>
static void tree(Display*d,Window w,int depth){XWindowAttributes a;Window root,parent,*kids=NULL;unsigned count=0;
if(depth>8||!XGetWindowAttributes(d,w,&a))return;
printf("%*s0x%lx %dx%d+%d+%d class=%d mapped=%d\\n",depth,"",w,a.width,a.height,a.x,a.y,a.class,a.map_state);
if(XQueryTree(d,w,&root,&parent,&kids,&count)){for(unsigned i=0;i<count;i++)tree(d,kids[i],depth+1);if(kids)XFree(kids);}}
int main(int argc,char**argv){(void)argv;Display*d=XOpenDisplay(NULL);if(!d)return 2;Window root,child;int x,y,wx,wy;unsigned mask;
if(argc>1){tree(d,DefaultRootWindow(d),0);XCloseDisplay(d);return 0;}
if(!XQueryPointer(d,DefaultRootWindow(d),&root,&child,&x,&y,&wx,&wy,&mask))return 3;
printf("%d %d %lu\\n",x,y,child);XCloseDisplay(d);return 0;}
`);
  run(process.env.CC || 'cc', ['-std=c11', join(temporary, 'pointer.c'), '-lX11', '-o', join(temporary, 'pointer')]);
  const windows = new Map();
  let hello = false;
  socket = new WebSocket(url); socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') {
      const frame = decodeFrame(data);
      if (frame) { latestFrame = frame; frames++; }
      return;
    }
    const message = JSON.parse(data);
    if (message.type === 'hello') { protocolVersion = message.protocolVersion; hello = true; for (const window of message.windows) windows.set(window.id, window); }
    if (message.window && typeof message.window === 'object') windows.set(message.window.id, message.window);
    if (message.type === 'windowClosed') windows.delete(message.id);
    if (message.type === 'fullscreenRequest') results.phases.push({ event: message, at: new Date().toISOString() });
    if (message.type === 'error') results.errors.push(message);
  });
  await waitForOpen(socket); await until(() => hello, 'engine hello');
  assert.equal(windows.size, 0, 'Use an isolated engine with no existing application windows');
  const send = message => socket.send(JSON.stringify(message));
  send({ type: 'setViewport', ...results.viewport, scale: 1 });
  let screen;
  await until(() => {
    const query = spawnSync('xrandr', ['--current'], { env, encoding: 'utf8', timeout: 2000 });
    if (query.status !== 0) return false;
    screen = query.stdout.split('\n')[0];
    const expected = process.env.LWFA_TEST_MONITOR_SIZE || `${results.viewport.width}x${results.viewport.height}`;
    const [w,h] = expected.split('x');
    return screen.includes(`current ${w} x ${h},`);
  }, 'Xwayland ready after the first viewport');
  const dimensions = /current (\d+) x (\d+)/.exec(screen);
  const monitor = { width: Number(dimensions[1]), height: Number(dimensions[2]) };
  if (process.env.LWFA_TEST_MONITOR_SIZE) {
    const expected = /^(\d+)x(\d+)$/.exec(process.env.LWFA_TEST_MONITOR_SIZE);
    assert(expected, 'LWFA_TEST_MONITOR_SIZE must be WxH');
    assert.deepEqual(monitor, { width: Number(expected[1]), height: Number(expected[2]) }, 'Selected Xwayland monitor');
  }
  results.display = screen;
  results.monitor = monitor;
  expectedMonitor = monitor;
  child = spawn(join(process.env.PROTON_DIR, 'files/bin/wine'), [join(temporary, 'fixture.exe')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => { childError = error; });
  // Wine traces can arrive between chunks of a fixture JSON record. Keep
  // stderr separate so enabling diagnostics cannot corrupt observations.
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { diagnostics += data; });
  let id;
  await until(() => { id = [...windows.values()].find(window => window.title === 'lwfa-proton-fullscreen-fixture')?.id; return id !== undefined && output.includes('FULLSCREEN_FIXTURE_READY'); }, 'Wine fullscreen fixture', 60000);
  if (dxvk) assert(output.includes('DXVK_FIXTURE_READY'), 'D3D11 fullscreen swapchain must initialize');
  results.window = id;
  results.phases.push({ phase: 'native-fullscreen', at: new Date().toISOString(), win32: records('RECT').at(-1), x11: x11Snapshot(), metadata: windows.get(id) });
  async function checkPhase(name, messages, expectedSize, fullscreen = true) {
    const before = frames;
    const rectsBefore = records('RECT').length;
    for (const message of messages) send(message);
    await until(() => {
      const rectangles = records('RECT');
      const client = rectangles.at(-1);
      return frames >= before + 5 && rectangles.length >= rectsBefore + 3
        && (!expectedSize || latestFrame.header.width === expectedSize.width && latestFrame.header.height === expectedSize.height)
        && (!expectedSize || allowCachedMode || renderSize || client.clientWidth === expectedSize.width && client.clientHeight === expectedSize.height);
    }, `${name}: stream and Win32 resize observations`);
    const captured = latestFrame;
    const phase = { phase: name, at: new Date().toISOString(), win32: records('RECT').at(-1), desktop: records('DESKTOP').at(-1), x11: x11Snapshot(), metadata: windows.get(id), frame: captured.header };
    if (dxvk) phase.swapchain = records('SWAP').at(-1);
    results.phases.push(phase);
    assert.equal(captured.header.format, 0, 'Regression captures JPEG for independent pixel inspection');
    const jpeg = join(resultsDir, `${name}.jpg`);
    await writeFile(jpeg, captured.payload);
    const rgb = run('ffmpeg', ['-v', 'error', '-i', jpeg, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: null, maxBuffer: 32 * 1024 * 1024 });
    const { width, height } = captured.header;
    // Wine fits an emulated fullscreen mode inside its physical monitor. Its
    // letterboxing is already in the captured pixels, separately from CSS fit.
    const render = renderSize ? phase.swapchain : { width, height };
    const fit = Math.min(width / render.width, height / render.height);
    const painted = { width: render.width * fit, height: render.height * fit };
    const origin = { x: (width - painted.width) / 2, y: (height - painted.height) / 2 };
    const inFrame = ([x, y]) => [(origin.x + x * painted.width) / width, (origin.y + y * painted.height) / height];
    phase.renderedArea = { ...origin, ...painted };
    const points = [[.02,.02], [.98,.02], [.02,.98], [.98,.98]].map(inFrame);
    phase.corners = points.map(([x,y]) => [...rgb.subarray((Math.floor(y*height)*width+Math.floor(x*width))*3, (Math.floor(y*height)*width+Math.floor(x*width))*3+3)]);
    const mouseBefore = records('MOUSE').length;
    const [mouseX, mouseY] = inFrame([.98, .98]);
    send({ type: 'pointerMotion', window: id, x: protocolVersion === 0 ? mouseX * width : mouseX, y: protocolVersion === 0 ? mouseY * height : mouseY, ...(protocolVersion === 0 ? {} : { normalized: true }) });
    send({ type: 'pointerButton', button: 272, pressed: true }); send({ type: 'pointerButton', button: 272, pressed: false });
    await until(() => records('MOUSE').length > mouseBefore, 'bottom-right click');
    phase.mouse = records('MOUSE').at(-1);
    const expectedColors = [[255,0,0],[0,255,0],[0,0,255],[255,255,0]];
    phase.allCornersVisible = phase.corners.every((color, i) => color.every((channel, j) => Math.abs(channel - expectedColors[i][j]) < 60));
    phase.inputReachesClientBottomRight = phase.mouse.x > phase.win32.clientWidth - 100 && phase.mouse.y > phase.win32.clientHeight - 100;
    // WM_LBUTTONDOWN reports client coordinates, including when a retained
    // backbuffer is scaled to a resized native-mode client.
    const inputWidth = phase.win32.clientWidth;
    const inputHeight = phase.win32.clientHeight;
    phase.inputReachesBottomRight = phase.mouse.x > inputWidth - 100 && phase.mouse.y > inputHeight - 100 && phase.mouse.x < inputWidth && phase.mouse.y < inputHeight;
    phase.display = run('xrandr', ['--current']).split('\n')[0];
    assert(phase.display.includes(`current ${expectedMonitor.width} x ${expectedMonitor.height}`), 'Xwayland monitor must match the expected viewport policy');
    phase.virtualMonitorFollowsPhysical = phase.win32.monitorWidth === expectedMonitor.width && phase.win32.monitorHeight === expectedMonitor.height;
    if (!renderSize && !allowCachedMode) {
      assert.equal(phase.win32.monitorWidth, expectedMonitor.width);
      assert.equal(phase.win32.monitorHeight, expectedMonitor.height);
    }
    assert(!output.includes('GPU_ERROR'), 'GPU operations must succeed');
    assert.equal(results.errors.length, 0, 'No unexpected engine errors');
    assert(phase.allCornersVisible, `Fullscreen image cropped: ${JSON.stringify(phase.corners)}`);
    assert(phase.inputReachesBottomRight, 'Normalized bottom-right input must reach the app bottom-right');
    if (dxvk) assert.equal(phase.swapchain.fullscreen, fullscreen, 'DXGI fullscreen state');
    if (expectedSize) {
      assert.equal(phase.x11.width, expectedSize.width);
      assert.equal(phase.x11.height, expectedSize.height);
      if (!allowCachedMode) {
        const clientSize = renderSize && fullscreen
          ? { width: Number(renderSize[1]), height: Number(renderSize[2]) }
          : expectedSize;
        assert.equal(phase.win32.clientWidth, clientSize.width);
        assert.equal(phase.win32.clientHeight, clientSize.height);
      }
    }
  }
  const layout = { type: 'setLayout', windows: [{ id, z: 0, rect: { x: 0, y: 0, ...results.viewport } }], animate: null };
  await checkPhase('browser-layout', [{ type: 'focusWindow', id }, layout, { type: 'setStreams', windows: [id], codecs: [] }], renderSize ? undefined : monitor);
  if (process.env.LWFA_TEST_BROWSER === '1') {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium' });
    try {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
      const wire = [], browserErrors = [];
      page.on('pageerror', error => browserErrors.push(error.message));
      page.on('websocket', connection => connection.on('framesent', ({ payload }) => {
        if (typeof payload === 'string') { try { wire.push(JSON.parse(payload)); } catch {} }
      }));
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'getGamepads', { value: () => [] });
        localStorage.setItem('lwfa.prefs', JSON.stringify({ stream: { audio: false } }));
      });
      const shellUrl = new URL(process.env.LWFA_TEST_URL);
      shellUrl.protocol = ['https:', 'wss:'].includes(shellUrl.protocol) ? 'https:' : 'http:';
      shellUrl.searchParams.set('token', process.env.AUTH_PASS);
      await page.goto(shellUrl.toString());
      const surface = page.getByRole('application', { name: 'lwfa-proton-fullscreen-fixture', exact: true });
      await surface.waitFor();
      const canvas = surface.locator('canvas');
      await canvas.evaluate(async element => {
        const deadline = performance.now() + 15000;
        while (element.width < 1000 && performance.now() < deadline) await new Promise(resolve => requestAnimationFrame(resolve));
      });
      const geometry = await canvas.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, sourceWidth: element.width, sourceHeight: element.height, objectFit: getComputedStyle(element).objectFit };
      });
      assert.equal(geometry.objectFit, 'fill', 'Built shell must use the whole canvas');
      assert.equal(geometry.sourceWidth, latestFrame.header.width);
      assert.equal(geometry.sourceHeight, latestFrame.header.height);
      const paintedWidth = geometry.width, paintedHeight = geometry.height;
      const offsetX = 0, offsetY = 0;
      const previous = records('MOUSE').length;
      const render = records('SWAP').at(-1) || { width: geometry.sourceWidth, height: geometry.sourceHeight };
      const sourceFit = Math.min(geometry.sourceWidth / render.width, geometry.sourceHeight / render.height);
      const sourceX = ((geometry.sourceWidth - render.width * sourceFit) / 2 + render.width * sourceFit * .98) / geometry.sourceWidth;
      const sourceY = ((geometry.sourceHeight - render.height * sourceFit) / 2 + render.height * sourceFit * .98) / geometry.sourceHeight;
      await page.mouse.click(geometry.x + offsetX + paintedWidth * sourceX, geometry.y + offsetY + paintedHeight * sourceY);
      await until(() => records('MOUSE').length > previous, 'built shell bottom-right click');
      const mouse = records('MOUSE').at(-1);
      const extent = records('SWAP').at(-1) || { width: records('RECT').at(-1).clientWidth, height: records('RECT').at(-1).clientHeight };
      assert(mouse.x > extent.width - 100 && mouse.x < extent.width && mouse.y > extent.height - 100 && mouse.y < extent.height, 'Built shell click reaches rendered bottom-right');
      results.browser = { geometry, mouse, passed: false };
      const beforeReload = x11Snapshot();
      await page.reload();
      await surface.waitFor();
      await canvas.evaluate(async (element, expected) => {
        const deadline = performance.now() + 15000;
        while ((element.width !== expected.width || element.height !== expected.height) && performance.now() < deadline) {
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        if (element.width !== expected.width || element.height !== expected.height) throw new Error('Reload did not restore the fullscreen stream');
      }, { width: geometry.sourceWidth, height: geometry.sourceHeight });
      const afterReload = x11Snapshot();
      const reloadedGeometry = await canvas.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height, sourceWidth: element.width, sourceHeight: element.height };
      });
      assert.deepEqual(
        { width: afterReload.width, height: afterReload.height, fullscreen: afterReload.netWmFullscreen },
        { width: beforeReload.width, height: beforeReload.height, fullscreen: beforeReload.netWmFullscreen },
        'Reload must preserve the native game dimensions and fullscreen state',
      );
      assert(Math.abs(reloadedGeometry.width - geometry.width) <= 1 && Math.abs(reloadedGeometry.height - geometry.height) <= 1,
        'Reload must preserve the browser game rectangle');
      results.browser.reload = { before: beforeReload, after: afterReload, geometry: reloadedGeometry };
      assert.deepEqual(browserErrors, []);
      results.browser.passed = true;
      await page.screenshot({ path: join(resultsDir, 'built-shell.png') });
    } finally { await browser.close(); }
  }
  if (process.env.LWFA_TEST_FULLSCREEN_MATRIX === '1') {
    for (const [width, height] of [[1490, 910], [838, 1324], [640, 480], [1324, 838]]) {
      if (canvasOutput) expectedMonitor = { width, height };
      await checkPhase(`browser-resize-${width}x${height}`, [{ type: 'setViewport', width, height, scale: 1 }, { type: 'setLayout', windows: [{ id, z: 0, rect: { x: 0, y: 0, width, height } }], animate: null }], canvasOutput ? { width, height } : monitor);
    }
    send({ type: 'focusWindow', id });
    send({ type: 'key', key: 87, pressed: true }); send({ type: 'key', key: 87, pressed: false });
    await until(() => output.includes('FULLSCREEN_EXIT_REQUESTED'), 'fixture fullscreen exit');
    await checkPhase('windowed-restored', [layout], results.viewport, false);

  }
  results.passed = true;
} catch (error) {
  results.passed = false; results.error = error.message;
  results.observations = { frames, latestFrame: latestFrame?.header, rectangles: records('RECT').length, lastRectangle: records('RECT').at(-1), desktop: records('DESKTOP').at(-1), lastSwapchain: records('SWAP').at(-1), cursor: records('CURSOR').at(-1) };
  try {
    results.observations.nativePointer = run(join(temporary, 'pointer'), []).trim().split(' ').map(Number);
    await writeFile(join(resultsDir, 'x11-tree.txt'), run(join(temporary, 'pointer'), ['--tree']));
  } catch (diagnosticError) { results.observations.diagnosticError = diagnosticError.message; }
  if (latestFrame?.header.format === 0) await writeFile(join(resultsDir, 'last-frame.jpg'), latestFrame.payload);
  process.exitCode = 1;
} finally {
  const cleanup = spawnSync(join(process.env.PROTON_DIR, 'files/bin/wineserver'), ['-k'], { env, timeout: 5000, encoding: 'utf8' });
  if (cleanup.error || cleanup.status !== 0) { results.cleanupError = cleanup.error?.message || cleanup.stderr; process.exitCode = 1; }
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    for (let i=0;i<40 && child.exitCode === null && child.signalCode === null;i++) await delay(50);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  socket?.close();
  await writeFile(join(resultsDir, 'wine.log'), output);
  await writeFile(join(resultsDir, 'wine-stderr.log'), diagnostics);
  results.finishedAt = new Date().toISOString();
  await writeFile(join(resultsDir, 'results.json'), JSON.stringify(results, null, 2)+'\n');
  await rm(temporary, { recursive: true, force: true });
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
  console.log(JSON.stringify(results));
}
