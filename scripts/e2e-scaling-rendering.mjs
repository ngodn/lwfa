// Native Chromium -> isolated compositor -> encoded stream -> browser pixels.
// Never discovers or connects to a production engine. The caller owns the dev
// engine lifetime and supplies its URL, password and both display sockets.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
for (const name of ['AUTH_PASS', 'LWFA_TEST_URL', 'LWFA_TEST_WAYLAND', 'LWFA_TEST_DISPLAY']) {
  assert(process.env[name], `${name} must explicitly identify the isolated test engine`);
}
const origin = process.env.LWFA_TEST_URL;
const codecs = ['h264', 'hevc'].includes(process.env.LWFA_TEST_CODEC) ? [process.env.LWFA_TEST_CODEC] : [];
const factors = process.env.LWFA_TEST_FACTORS?.split(',').map(Number) || [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const platforms = process.env.LWFA_TEST_PLATFORM ? [process.env.LWFA_TEST_PLATFORM] : ['wayland', 'x11'];
const width = Number(process.env.LWFA_TEST_WIDTH || 1000), height = Number(process.env.LWFA_TEST_HEIGHT || 640);
const profile = await mkdtemp(join(tmpdir(), 'lwfa-scaling-'));
const fixture = join(profile, 'pattern.html');
const resultPath = resolve(process.env.LWFA_TEST_RESULTS || 'docs/research/fixtures/window-scaling-measurements.json');
const results = { date: new Date().toISOString(), origin, codec: codecs[0] || 'jpeg', cases: [], failures: [], limitations: [] };
results.decoder = 'packages/shell/src/decode.ts FrameDecoder';
try {
  const prior = JSON.parse(await readFile(resultPath, 'utf8'));
  const diagnostic = prior.x11InputDiagnostic || prior.preFixX11InputDiagnostic;
  if (diagnostic) results.preFixX11InputDiagnostic = diagnostic;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await writeFile(fixture, `<!doctype html><title>lwfa-scaling-probe</title>
<style>html,body{margin:0;width:100%;height:100%;background:#be48ef}body{box-sizing:border-box;border:16px solid #3edbc8}
#grating{position:absolute;left:100px;top:100px;width:128px;height:48px;background:repeating-linear-gradient(to right,#000 0px,#000 .5px,#fff .5px,#fff 1px)}
#target{position:absolute;left:55%;top:65%;width:90px;height:50px;background:#fddd39;touch-action:none}
#menu{position:absolute;left:40px;top:190px;width:200px;font:20px sans-serif}
i{position:absolute;left:40%;top:30%;width:20px;height:20px;background:white;animation:pulse .5s infinite alternate}@keyframes pulse{to{background:#777}}
</style><div id=grating></div><button id=target>Hit</button><select id=menu><option style="background:#f00">Alpha</option><option style="background:#0f0">Beta</option><option style="background:#00f">Gamma</option></select><i></i>
<script>window.events=[];window.allEvents=[];for(const kind of ['pointerdown','pointerup','touchstart','touchend']){document.addEventListener(kind,e=>window.allEvents.push({kind,x:e.clientX,y:e.clientY,pointerType:e.pointerType,target:e.target.id}),true);target.addEventListener(kind,e=>{window.events.push({kind,x:e.clientX,y:e.clientY,pointerType:e.pointerType});if(kind==='touchstart')e.preventDefault()},{passive:false});}</script>`);
const require = createRequire(resolve('packages/shell/package.json'));
const { build } = await import(require.resolve('vite'));
const bundled = await build({
  configFile: false, root: resolve('packages/shell'), logLevel: 'error',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: { alias: { '@': resolve('packages/shell/src') } },
  plugins: [{ name: 'scaling-decoder-fixture', resolveId(id) { if (id.endsWith('virtual:scaling-decoder')) return '\0scaling-decoder'; }, load(id) { if (id === '\0scaling-decoder') return 'import { FrameDecoder } from "@/decode"; import { decodeFrame } from "@lwfa/proto"; import { decodable, codecFromAnnexB } from "@/lib/codecs"; globalThis.LWFA_TEST_DECODER = { FrameDecoder, decodeFrame, decodable, codecFromAnnexB };'; } }],
  build: { write: false, minify: false, lib: { entry: 'virtual:scaling-decoder', name: 'LWFA_TEST_DECODER', formats: ['iife'] } },
});
const decoderBundle = (Array.isArray(bundled) ? bundled[0] : bundled).output.find(item => item.type === 'chunk').code;
const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/chromium' });
results.runtime = { node: process.version, chromium: browser.version() };
let native, peer;
try {
  // The isolated viewer injects the bundled shell decoder instead of loading
  // the shell application, so allow that test-owned inline script here.
  const viewer = await browser.newPage({ bypassCSP: true });
  viewer.on('pageerror', error => console.error('Viewer script error:', error.message));
  await viewer.goto(`${origin}/favicon.ico`);
  await viewer.addScriptTag({ content: decoderBundle });
  results.browserCodecs = await viewer.evaluate(() => window.LWFA_TEST_DECODER.decodable());
  if (codecs.length && !results.browserCodecs.includes(codecs[0])) {
    results.unsupported = codecs[0];
    results.limitations.push(`This Chromium environment does not advertise ${codecs[0]} decoding; no native matrix was run for that codec.`);
    console.log(JSON.stringify({ unsupported: codecs[0], browserCodecs: results.browserCodecs }));
  } else {
  await viewer.evaluate(async ({ origin, token }) => {
    const url = new URL(origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('token', token);
    const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
    const p = window.probe = { ws, windows: [], frames: {}, errors: [], serial: 0, supportChecks: [], parameterSets: [], formats: {} };
    const { FrameDecoder, decodeFrame, codecFromAnnexB } = window.LWFA_TEST_DECODER;
    const check = VideoDecoder.isConfigSupported.bind(VideoDecoder);
    VideoDecoder.isConfigSupported = async config => {
      const result = await check(config);
      p.supportChecks.push({ ...config, supported: result.supported });
      return result;
    };
    function deliver(id, bitmap, format, serial) {
      if (serial < (p.frames[id]?.serial || 0)) { bitmap.close(); return; }
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
      p.frames[id] = { canvas, width: canvas.width, height: canvas.height, format, serial };
    }
    const decoder = new FrameDecoder((id, bitmap) => deliver(id, bitmap, p.formats[id], p.serial), codec => p.errors.push({ unsupportedCodec: codec }));
    ws.onmessage = async ({ data }) => {
      if (typeof data === 'string') {
        const m = JSON.parse(data);
        if (m.type === 'hello') p.windows = m.windows;
        if (m.type === 'windowOpened') p.windows.push(m.window);
        if (m.type === 'windowChanged') p.windows = p.windows.map(w => w.id === m.window.id ? m.window : w);
        if (m.type === 'windowClosed') { p.windows = p.windows.filter(w => w.id !== m.id); decoder.forget(m.id); }
        if (m.type === 'error') p.errors.push(m);
        return;
      }
      const frame = decodeFrame(data);
      if (!frame) return;
      ++p.serial;
      const { window: id, format, keyframe } = frame.header;
      p.formats[id] = format;
      try {
        if (keyframe && format !== 0) p.parameterSets.push({ ...frame.header, codec: codecFromAnnexB(frame.payload, format === 2 ? 'hevc' : 'h264') });
        await decoder.handle(frame);
      } catch (error) { p.errors.push(String(error)); }
    };
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  }, { origin, token: process.env.AUTH_PASS });
  const send = messages => viewer.evaluate(messages => { for (const message of messages) window.probe.ws.send(JSON.stringify(message)); }, messages);
  await send([{ type: 'setViewport', width, height, scale: 1 }]);

  for (const platform of platforms) {
    native = await chromium.launchPersistentContext(join(profile, platform), {
      executablePath: '/usr/bin/chromium', headless: false, viewport: null,
      env: { ...process.env, WAYLAND_DISPLAY: process.env.LWFA_TEST_WAYLAND, DISPLAY: process.env.LWFA_TEST_DISPLAY },
      args: [`--ozone-platform=${platform}`, `--app=file://${fixture}`, '--no-first-run', '--password-store=basic'],
    });
    const app = native.pages()[0];
    await app.waitForFunction(() => !!document.querySelector('#target'));
    await viewer.waitForFunction(() => window.probe.windows.some(w => w.title?.includes('lwfa-scaling-probe')));
    const id = await viewer.evaluate(() => window.probe.windows.find(w => w.title?.includes('lwfa-scaling-probe')).id);
    await send([{ type: 'setLayout', windows: [{ id, z: 0, rect: { x: 0, y: 0, width, height } }], animate: null }, { type: 'setStreams', windows: [id], codecs }]);
    const cases = process.env.LWFA_TEST_MULTI_ONLY ? [] : [...(platform === 'wayland' ? factors.map(scale => ({ mode: 'sharp', scale })) : []), ...(process.env.LWFA_TEST_MODES === 'sharp' ? [] : factors.map(scale => ({ mode: 'workspace', scale }))), { mode: 'sharp', scale: 1, reset: true }, ...(platform === 'wayland' ? [{ mode: 'sharp', scale: null, displayScale: 2 }] : [])];
    for (const test of cases) {
      const entry = { platform, ...test };
      try {
        if (test.displayScale) await send([{ type: 'setViewport', width, height, scale: test.displayScale }]);
        const start = await viewer.evaluate(() => window.probe.serial);
        await send([{ type: 'setWindowScaling', id, scaling: { mode: test.mode, scale: test.scale } }]);
        const factor = test.scale ?? test.displayScale;
        const frameWidth = width * factor, frameHeight = height * factor;
        await viewer.waitForFunction(({ id, frameWidth, frameHeight, start }) => {
          const frame = window.probe.frames[id];
          return frame?.width === frameWidth && frame.height === frameHeight && frame.serial > start + 2;
        }, { id, frameWidth, frameHeight, start }, { timeout: 18000 });
        await viewer.waitForTimeout(500);
        entry.client = await app.evaluate(() => {
          const r = document.querySelector('#target').getBoundingClientRect();
          return { innerWidth, innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio, target: { x: r.x + r.width / 2, y: r.y + r.height / 2 } };
        });
        entry.metadata = await viewer.evaluate(id => window.probe.windows.find(w => w.id === id), id);
        entry.sample = await viewer.evaluate(({ id, client }) => {
          const frame = window.probe.frames[id], { canvas } = frame;
          const c = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
          const p = c.getImageData(0, 0, w, h).data;
          const dark = (x, y) => { const i = (y * w + x) * 4; return p[i] < 12 && p[i + 1] < 12 && p[i + 2] < 12; };
          let right = 0, bottom = 0;
          while (right < w && Array.from({ length: h }, (_, y) => y).every(y => dark(w - right - 1, y))) right++;
          while (bottom < h && Array.from({ length: w }, (_, x) => x).every(x => dark(x, h - bottom - 1))) bottom++;
          const density = w / client.outerWidth;
          const contentX = (client.outerWidth - client.innerWidth) / 2, contentY = client.outerHeight - client.innerHeight;
          const x = Math.round((contentX + 104) * density), y = Math.round((contentY + 122) * density);
          const count = Math.round(112 * density), values = [];
          for (let i = 0; i < count; i++) { const at = (y * w + x + i) * 4; values.push((p[at] + p[at + 1] + p[at + 2]) / 3); }
          const mean = values.reduce((a, b) => a + b, 0) / values.length;
          const contrast = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
          const transitions = values.slice(1).filter((v, i) => (v >= 128) !== (values[i] >= 128)).length;
          return { width: w, height: h, format: frame.format, right, bottom, grating: { density, x, y, mean, contrast, transitions, count } };
        }, { id, client: entry.client });
        assert.equal(entry.sample.right, 0, 'no black right strip');
        assert.equal(entry.sample.bottom, 0, 'no black bottom strip');
        assert.equal(entry.sample.format, codecs[0] === 'hevc' ? 2 : codecs.length ? 1 : 0, 'wire codec');
        const logicalFactor = test.mode === 'workspace' ? factor : 1;
        assert.equal(entry.client.outerWidth, width * logicalFactor, 'application logical width');
        assert.equal(entry.client.outerHeight, height * logicalFactor, 'application logical height');
        assert.equal(entry.client.dpr, test.mode === 'sharp' ? factor : 1, 'native app rendering density');

        await app.evaluate(() => { window.events = []; window.allEvents = []; });
        const client = entry.client;
        const x = (client.target.x + (client.outerWidth - client.innerWidth) / 2) / client.outerWidth;
        const y = (client.target.y + client.outerHeight - client.innerHeight) / client.outerHeight;
        entry.stage = 'pointer';
        await send([{ type: 'pointerMotion', window: id, x, y, normalized: true }, { type: 'pointerButton', button: 272, pressed: true }, { type: 'pointerButton', button: 272, pressed: false }]);
        await app.waitForFunction(() => window.events.some(e => e.kind === 'pointerdown' && e.pointerType === 'mouse'), null, { timeout: 3000 });
        entry.stage = 'touch';
        await send([{ type: 'touchDown', window: id, id: 7, x, y, normalized: true }, { type: 'touchUp', id: 7 }]);
        await app.waitForFunction(() => window.events.some(e => e.kind === 'touchstart'), null, { timeout: 3000 });
        entry.input = await app.evaluate(() => window.events);
        if (test.reset || test.scale === 2) {
          entry.stage = 'popup';
          const menu = await app.evaluate(() => { document.querySelector('#menu').selectedIndex = 0; const r = document.querySelector('#menu').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
          const menuX = (menu.x + (client.outerWidth - client.innerWidth) / 2) / client.outerWidth;
          const menuY = (menu.y + client.outerHeight - client.innerHeight) / client.outerHeight;
          const click = (x, y) => send([{ type: 'pointerMotion', window: id, x, y, normalized: true }, { type: 'pointerButton', button: 272, pressed: true }, { type: 'pointerButton', button: 272, pressed: false }]);
          await click(menuX, menuY);
          // Native menus are separate Wayland popup or X11 override-redirect
          // surfaces. Find the green option in the composited stream rather
          // than guessing toolkit-dependent row heights.
          await viewer.waitForFunction(id => {
            const frame = window.probe.frames[id];
            const pixels = frame.canvas.getContext('2d').getImageData(0, 0, frame.width, frame.height).data;
            let count = 0;
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 55 && pixels[i + 1] > 200 && pixels[i + 2] < 55) count++;
            return count > 100;
          }, id, { timeout: 5000 });
          const option = await viewer.evaluate(id => {
            const frame = window.probe.frames[id], { width: w, height: h } = frame;
            const p = frame.canvas.getContext('2d').getImageData(0, 0, w, h).data;
            let sumX = 0, sumY = 0, count = 0;
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
              const i = (y * w + x) * 4;
              if (p[i] < 55 && p[i + 1] > 200 && p[i + 2] < 55) { sumX += x; sumY += y; count++; }
            }
            return { x: sumX / count / w, y: sumY / count / h, pixels: count };
          }, id);
          await click(option.x, option.y);
          await app.waitForFunction(() => document.querySelector('#menu').selectedIndex === 1, null, { timeout: 3000 });
          entry.popup = { selected: 'Beta', ...option };
        }
        entry.stage = 'complete';
        entry.pass = true;
      } catch (error) {
        entry.pass = false; entry.error = String(error);
        entry.input = await app.evaluate(() => window.events);
        entry.allInput = await app.evaluate(() => window.allEvents);
        entry.engineErrors = await viewer.evaluate(() => window.probe.errors);
        entry.lastFrame = await viewer.evaluate(id => { const f = window.probe.frames[id]; return f && { width: f.width, height: f.height, serial: f.serial }; }, id);
        results.failures.push({ platform, ...test, error: entry.error });
      }
      results.cases.push(entry);
      console.log(JSON.stringify(entry));
      await writeFile(resultPath, JSON.stringify(results, null, 2) + '\n');
    }
    if (platform === 'x11' && process.env.LWFA_TEST_MULTI_ONLY) {
      peer = await chromium.launchPersistentContext(join(profile, 'x11-peer'), {
        executablePath: '/usr/bin/chromium', headless: false, viewport: null,
        env: { ...process.env, WAYLAND_DISPLAY: process.env.LWFA_TEST_WAYLAND, DISPLAY: process.env.LWFA_TEST_DISPLAY },
        args: ['--ozone-platform=x11', `--app=file://${fixture}`, '--no-first-run', '--password-store=basic'],
      });
      const peerApp = peer.pages()[0];
      await peerApp.waitForFunction(() => !!document.querySelector('#target'));
      await viewer.waitForFunction(id => window.probe.windows.some(w => w.id !== id && w.title?.includes('lwfa-scaling-probe')), id);
      const peerId = await viewer.evaluate(id => window.probe.windows.find(w => w.id !== id && w.title?.includes('lwfa-scaling-probe')).id, id);
      results.multipleWindows = [];
      for (const scenario of [{ name: 'overlapping-native-geometries', x: 0, width: 1000, a: 2, b: 0.75 }, { name: 'negative-left-reduced-workspace', x: -1000, width: 2000, a: 0.5, b: 1 }, { name: 'negative-left-expanded-workspace', x: -1000, width: 2000, a: 2, b: 0.75 }]) {
        const entry = { ...scenario, checks: [] };
        try {
          await send([{ type: 'setViewport', width: 2000, height: 640, scale: 1 }, { type: 'setLayout', windows: [{ id, z: 0, rect: { x: scenario.x, y: 0, width: scenario.width, height: 640 } }, { id: peerId, z: 1, rect: { x: 1000, y: 0, width: 1000, height: 640 } }], animate: null }, { type: 'setWindowScaling', id, scaling: { mode: 'workspace', scale: scenario.a } }, { type: 'setWindowScaling', id: peerId, scaling: { mode: 'workspace', scale: scenario.b } }, { type: 'setStreams', windows: [id, peerId], codecs }]);
          await viewer.waitForFunction(({ id, peerId, scenario }) => {
            const a = window.probe.frames[id], b = window.probe.frames[peerId];
            return a?.width === scenario.width * scenario.a && a.height === 640 * scenario.a && b?.width === 1000 * scenario.b && b.height === 640 * scenario.b;
          }, { id, peerId, scenario }, { timeout: 18000 });
          for (const target of [{ name: 'first', page: app, other: peerApp, id }, { name: 'second', page: peerApp, other: app, id: peerId }, { name: 'first-again', page: app, other: peerApp, id }]) {
            await app.evaluate(() => { window.events = []; window.allEvents = []; });
            await peerApp.evaluate(() => { window.events = []; window.allEvents = []; });
            const point = await target.page.evaluate(() => {
              const r = document.querySelector('#target').getBoundingClientRect();
              return { x: (r.x + r.width / 2 + (outerWidth - innerWidth) / 2) / outerWidth, y: (r.y + r.height / 2 + outerHeight - innerHeight) / outerHeight, outerWidth, outerHeight };
            });
            await send([{ type: 'focusWindow', id: target.id }, { type: 'pointerMotion', window: target.id, x: point.x, y: point.y, normalized: true }, { type: 'pointerButton', button: 272, pressed: true }, { type: 'pointerButton', button: 272, pressed: false }, { type: 'touchDown', window: target.id, id: 7, x: point.x, y: point.y, normalized: true }, { type: 'touchUp', id: 7 }]);
            await target.page.waitForFunction(() => window.events.some(e => e.kind === 'pointerdown' && e.pointerType === 'mouse') && window.events.some(e => e.kind === 'touchstart'), null, { timeout: 3000 });
            const input = await target.page.evaluate(() => window.events);
            const otherInput = await target.other.evaluate(() => window.allEvents);
            assert.equal(otherInput.length, 0, 'other window must not receive this input');
            entry.checks.push({ target: target.name, point, input, otherInput });
          }
          entry.pass = true;
        } catch (error) {
          entry.pass = false; entry.error = String(error);
          entry.input = await app.evaluate(() => window.allEvents);
          entry.peerInput = await peerApp.evaluate(() => window.allEvents);
          results.failures.push({ scenario: scenario.name, error: entry.error });
        }
        results.multipleWindows.push(entry);
        console.log(JSON.stringify(entry));
        await writeFile(resultPath, JSON.stringify(results, null, 2) + '\n');
      }
      await peer.close(); peer = undefined;
    }
    await native.close(); native = undefined;
    await viewer.waitForTimeout(300);
    await send([{ type: 'setViewport', width, height, scale: 1 }]);
  }
  const one = results.cases.find(c => c.platform === 'wayland' && c.mode === 'sharp' && c.scale === 1)?.sample?.grating;
  const two = results.cases.find(c => c.platform === 'wayland' && c.mode === 'sharp' && c.scale === 2)?.sample?.grating;
  if (platforms.includes('wayland') && factors.includes(1) && factors.includes(2)) {
    results.detail = { one, two, pass: !!one && !!two && two.contrast > one.contrast + 30 && two.transitions > one.transitions + 80 };
    if (!results.detail.pass) results.failures.push({ error: 'Native 2x did not resolve substantially more half-CSS-pixel grating detail than 1x.' });
  }
  results.decoderSupportChecks = await viewer.evaluate(() => window.probe.supportChecks);
  results.streamParameterSets = await viewer.evaluate(() => window.probe.parameterSets);
  }
} finally {
  await peer?.close(); await native?.close(); await browser.close(); await rm(profile, { recursive: true, force: true });
  await writeFile(resultPath, JSON.stringify(results, null, 2) + '\n');
}
assert.equal(results.failures.length, 0, `${results.failures.length} scaling checks failed; see ${resultPath}`);
