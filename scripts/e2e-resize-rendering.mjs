// Native Chromium -> isolated compositor -> encoded stream -> browser pixels.
// Never discovers or connects to a production engine. The caller owns the dev
// engine lifetime and supplies its URL, password and both display sockets.
// LWFA_TEST_SIZES=1000x640,1192x814,1324x838 selects the resize sequence.
// Defaults fit inside a 1324x838 isolated monitor. Override deliberately when
// testing larger monitors. This fixture never discovers a host display.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
for (const name of ['AUTH_PASS', 'LWFA_TEST_URL', 'LWFA_TEST_WAYLAND', 'LWFA_TEST_DISPLAY']) {
  assert(process.env[name], `${name} must explicitly identify the isolated test engine`);
}
const origin = process.env.LWFA_TEST_URL;
const requestedCodec = process.env.LWFA_TEST_CODEC || 'jpeg';
assert(['jpeg', 'h264', 'hevc'].includes(requestedCodec), 'LWFA_TEST_CODEC must be jpeg, h264 or hevc');
const codecs = requestedCodec === 'jpeg' ? [] : [requestedCodec];
const platforms = process.env.LWFA_TEST_PLATFORM ? [process.env.LWFA_TEST_PLATFORM] : ['wayland', 'x11'];
assert(platforms.every(platform => ['wayland', 'x11'].includes(platform)), 'LWFA_TEST_PLATFORM must be wayland or x11');
const sizeList = process.env.LWFA_TEST_SIZES || '1000x640,1192x814,1000x640,1324x838,1000x640';
const sizes = sizeList.split(',').map(size => {
  const match = size.match(/^(\d+)x(\d+)$/);
  assert(match, `Invalid LWFA_TEST_SIZES entry: ${size}`);
  const width = Number(match[1]), height = Number(match[2]);
  assert(width >= 480 && height >= 320 && width % 2 === 0 && height % 2 === 0, 'Fixture sizes must be even dimensions of at least 480x320');
  return { width, height };
});
const { width, height } = sizes[0];
const nativeExecutable = process.env.LWFA_TEST_CHROMIUM || '/usr/bin/chromium';
const profile = await mkdtemp(join(tmpdir(), 'lwfa-resize-'));
const fixture = join(profile, 'pattern.html');
const resultPath = resolve(process.env.LWFA_TEST_RESULTS || 'target/resize-rendering-measurements.json');
const results = { date: new Date().toISOString(), origin, codec: codecs[0] || 'jpeg', cases: [], failures: [], limitations: [] };
results.decoder = process.env.LWFA_TEST_DECODER_SOURCE || 'packages/shell/src/decode.ts FrameDecoder';
await mkdir(dirname(resultPath), { recursive: true });
await writeFile(fixture, `<!doctype html><title>lwfa-resize-probe</title>
<style>html,body{margin:0;width:100%;height:100%;background:#be48ef}body{box-sizing:border-box;border:16px solid #3edbc8}
#grating{position:absolute;left:100px;top:100px;width:128px;height:48px;background:repeating-linear-gradient(to right,#000 0px,#000 .5px,#fff .5px,#fff 1px)}
#target{position:absolute;left:55%;top:65%;width:90px;height:50px;background:#fddd39;touch-action:none}
#edge{position:absolute;right:18px;bottom:18px;width:18px;height:18px;padding:0;border:0;background:#ff8040;touch-action:none}
#menu{position:absolute;left:40px;top:190px;width:200px;font:20px sans-serif}
i{position:absolute;left:40%;top:30%;width:20px;height:20px;background:white;animation:pulse .5s infinite alternate}@keyframes pulse{to{background:#777}}
</style><div id=grating></div><button id=target>Hit</button><button id=edge aria-label="Edge target"></button><select id=menu><option style="background:#f00">Alpha</option><option style="background:#0f0">Beta</option><option style="background:#00f">Gamma</option></select><i></i>
<script>window.events=[];window.allEvents=[];for(const kind of ['pointerdown','pointerup','touchstart','touchend']){document.addEventListener(kind,e=>window.allEvents.push({kind,x:e.clientX,y:e.clientY,pointerType:e.pointerType,target:e.target.id}),true);for(const button of [target,edge])button.addEventListener(kind,e=>{window.events.push({kind,x:e.clientX,y:e.clientY,pointerType:e.pointerType,target:e.target.id});if(kind==='touchstart')e.preventDefault()},{passive:false});}</script>`);
const require = createRequire(resolve('packages/shell/package.json'));
const { build } = await import(require.resolve('vite'));
const bundled = await build({
  configFile: false, root: resolve('packages/shell'), logLevel: 'error',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: { alias: [...(process.env.LWFA_TEST_DECODER_SOURCE ? [{ find: '@/decode', replacement: resolve(process.env.LWFA_TEST_DECODER_SOURCE) }] : []), { find: '@lwfa/proto', replacement: resolve('packages/proto/src/index.ts') }, { find: '@', replacement: resolve('packages/shell/src') }] },
  plugins: [{ name: 'resize-decoder-fixture', resolveId(id) { if (id.endsWith('virtual:resize-decoder')) return '\0resize-decoder'; }, load(id) { if (id === '\0resize-decoder') return 'import { FrameDecoder } from "@/decode"; import { decodeFrame } from "@lwfa/proto"; import { decodable, codecFromAnnexB } from "@/lib/codecs"; globalThis.LWFA_TEST_DECODER = { FrameDecoder, decodeFrame, decodable, codecFromAnnexB };'; } }],
  build: { write: false, minify: false, lib: { entry: 'virtual:resize-decoder', name: 'LWFA_TEST_DECODER', formats: ['iife'] } },
});
const decoderBundle = (Array.isArray(bundled) ? bundled[0] : bundled).output.find(item => item.type === 'chunk').code;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || nativeExecutable });
results.runtime = { node: process.version, chromium: browser.version() };
let native;
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
    const p = window.probe = { ws, windows: [], frames: {}, decodedCounts: {}, errors: [], serial: 0, supportChecks: [], parameterSets: [], formats: {}, wireFrames: [], wireFormatCounts: {} };
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
      p.decodedCounts[id] = (p.decodedCounts[id] || 0) + 1;
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
      p.wireFormatCounts[format] = (p.wireFormatCounts[format] || 0) + 1;
      p.wireFrames.push({ serial: p.serial, ...frame.header });
      if (p.wireFrames.length > 2000) p.wireFrames.shift();
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
      executablePath: nativeExecutable, headless: false, viewport: null,
      env: { ...process.env, WAYLAND_DISPLAY: process.env.LWFA_TEST_WAYLAND, DISPLAY: process.env.LWFA_TEST_DISPLAY },
      args: [`--ozone-platform=${platform}`, `--app=file://${fixture}`, '--no-first-run', '--password-store=basic'],
    });
    const app = native.pages()[0];
    await app.waitForFunction(() => !!document.querySelector('#target'));
    await viewer.waitForFunction(() => window.probe.windows.some(w => w.title?.includes('lwfa-resize-probe')));
    const id = await viewer.evaluate(() => window.probe.windows.find(w => w.title?.includes('lwfa-resize-probe')).id);
    await send([{ type: 'setLayout', windows: [{ id, z: 0, rect: { x: 0, y: 0, width, height } }], animate: null }, { type: 'setStreams', windows: [id], codecs }]);
    const cases = sizes.map((size, index) => ({ ...size, phase: `resize-${index + 1}`, displayScale: 1, popup: index === 0 || index === sizes.length - 1 }));
    // Browser density must not resurrect per-window density controls.
    cases.push({ ...sizes.at(-1), phase: 'browser-dpr2', displayScale: 2 });
    cases.push({ ...sizes.at(-1), phase: 'browser-dpr1', displayScale: 1 });
    for (const test of cases) {
      const entry = { platform, ...test, window: id, startedAt: new Date().toISOString() };
      try {
        const start = await viewer.evaluate(() => window.probe.serial);
        const decodedStart = await viewer.evaluate(id => window.probe.decodedCounts[id] || 0, id);
        await send([
          { type: 'setViewport', width: test.width, height: test.height, scale: test.displayScale },
          { type: 'setLayout', windows: [{ id, z: 0, rect: { x: 0, y: 0, width: test.width, height: test.height } }], animate: null },
        ]);
        const expected = { width: test.width, height: test.height };
        const frameWidth = expected.width, frameHeight = expected.height;
        entry.expectedFrame = expected;
        await viewer.waitForFunction(({ id, frameWidth, frameHeight, start, decodedStart }) => {
          const frame = window.probe.frames[id];
          return frame?.width === frameWidth && frame.height === frameHeight && frame.serial > start + 2 && window.probe.decodedCounts[id] >= decodedStart + 3;
        }, { id, frameWidth, frameHeight, start, decodedStart }, { timeout: 18000 });
        await app.waitForFunction(({ width, height }) => outerWidth === width && outerHeight === height,
          expected, { timeout: 10000 });
        entry.client = await app.evaluate(() => {
          const r = document.querySelector('#target').getBoundingClientRect();
          return { innerWidth, innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio, target: { x: r.x + r.width / 2, y: r.y + r.height / 2 } };
        });
        entry.metadata = await viewer.evaluate(id => window.probe.windows.find(w => w.id === id), id);
        // Chrome can report new outer dimensions before its page has painted
        // them, and its transient fullscreen hint obscures the top border.
        // Require all four strict markers before measuring the settled frame.
        // A persistent crop or missing border still fails this bounded wait.
        const markerWaitStarted = Date.now();
        entry.contentReady = { reason: 'Wait for the resized page to paint all content edges and the fullscreen hint to clear', timeoutMs: 10000 };
        const ready = await viewer.waitForFunction(({ id, client }) => {
          const frame = window.probe.frames[id];
          const density = frame.width / client.outerWidth;
          const contentX = (client.outerWidth - client.innerWidth) / 2;
          const contentY = client.outerHeight - client.innerHeight;
          const positions = [[contentX + 8, contentY + client.innerHeight / 2],
            [contentX + client.innerWidth - 8, contentY + client.innerHeight / 2],
            [contentX + client.innerWidth / 2, contentY + 8],
            [contentX + client.innerWidth / 2, contentY + client.innerHeight - 8]];
          const c = frame.canvas.getContext('2d');
          const colors = positions.map(([x, y]) => Array.from(c.getImageData(Math.round(x * density), Math.round(y * density), 1, 1).data).slice(0, 3));
          return colors.every(rgb => [62, 219, 200].every((value, index) => Math.abs(rgb[index] - value) < 45)) && { serial: frame.serial, colors };
        }, { id, client: entry.client }, { timeout: 10000 });
        Object.assign(entry.contentReady, await ready.jsonValue(), { elapsedMs: Date.now() - markerWaitStarted });
        await ready.dispose();
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
          const pixel = (x, y) => {
            const offset = (Math.min(h - 1, Math.max(0, Math.round(y * density))) * w + Math.min(w - 1, Math.max(0, Math.round(x * density)))) * 4;
            return Array.from(p.slice(offset, offset + 3));
          };
          const border = {
            left: pixel(contentX + 8, contentY + client.innerHeight / 2),
            right: pixel(contentX + client.innerWidth - 8, contentY + client.innerHeight / 2),
            top: pixel(contentX + client.innerWidth / 2, contentY + 8),
            bottom: pixel(contentX + client.innerWidth / 2, contentY + client.innerHeight - 8),
          };
          return { width: w, height: h, format: frame.format, right, bottom, border, grating: { density, x, y, mean, contrast, transitions, count } };
        }, { id, client: entry.client });
        assert.equal(entry.sample.right, 0, 'no black right strip');
        assert.equal(entry.sample.bottom, 0, 'no black bottom strip');
        assert.equal(entry.sample.format, codecs[0] === 'hevc' ? 2 : codecs.length ? 1 : 0, 'wire codec');
        assert.equal(entry.client.outerWidth, expected.width, 'application logical width follows canvas');
        assert.equal(entry.client.outerHeight, expected.height, 'application logical height follows canvas');
        assert.equal(entry.client.dpr, 1, 'browser DPR does not change application rendering density');
        for (const [side, rgb] of Object.entries(entry.sample.border)) {
          assert(rgb.every((value, index) => Math.abs(value - [62, 219, 200][index]) < 45), `colored ${side} content edge is visible: ${rgb}`);
        }

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
        entry.stage = 'edge-input';
        const edgePoint = await app.evaluate(() => {
          window.events = []; window.allEvents = [];
          const r = document.querySelector('#edge').getBoundingClientRect();
          return { x: (r.x + r.width / 2 + (outerWidth - innerWidth) / 2) / outerWidth, y: (r.y + r.height / 2 + outerHeight - innerHeight) / outerHeight };
        });
        await send([{ type: 'pointerMotion', window: id, ...edgePoint, normalized: true }, { type: 'pointerButton', button: 272, pressed: true }, { type: 'pointerButton', button: 272, pressed: false }, { type: 'touchDown', window: id, id: 7, ...edgePoint, normalized: true }, { type: 'touchUp', id: 7 }]);
        await app.waitForFunction(() => window.events.some(e => e.target === 'edge' && e.kind === 'pointerdown' && e.pointerType === 'mouse') && window.events.some(e => e.target === 'edge' && e.kind === 'touchstart'), null, { timeout: 3000 });
        entry.edgeInput = { point: edgePoint, events: await app.evaluate(() => window.events) };
        if (test.popup) {
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
        entry.wireFormats = await viewer.evaluate(({ id, start }) => [...new Set(window.probe.wireFrames.filter(frame => frame.window === id && frame.serial > start).map(frame => frame.format))], { id, start });
        entry.frameCounts = await viewer.evaluate(({ id, start, decodedStart }) => ({ decoded: window.probe.decodedCounts[id] - decodedStart, received: window.probe.wireFrames.filter(frame => frame.window === id && frame.serial > start).length, keyframes: window.probe.wireFrames.filter(frame => frame.window === id && frame.serial > start && frame.keyframe).length }), { id, start, decodedStart });
        assert.deepEqual(entry.wireFormats, [codecs[0] === 'hevc' ? 2 : codecs.length ? 1 : 0], 'no transient codec fallback during resize');
        entry.stage = 'complete';
        entry.pass = true;
      } catch (error) {
        entry.pass = false; entry.error = String(error);
        const diagnosticPrefix = `${resultPath}.${platform}.${test.phase}`;
        await app.screenshot({ path: `${diagnosticPrefix}.app.png` });
        const capturedPng = await viewer.evaluate(async id => {
          const frame = window.probe.frames[id];
          if (!frame) return null;
          return Array.from(new Uint8Array(await (await frame.canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()));
        }, id);
        if (capturedPng) await writeFile(`${diagnosticPrefix}.stream.png`, Buffer.from(capturedPng));
        entry.diagnosticImages = { application: `${diagnosticPrefix}.app.png`, stream: `${diagnosticPrefix}.stream.png` };
        entry.input = await app.evaluate(() => window.events);
        entry.allInput = await app.evaluate(() => window.allEvents);
        entry.engineErrors = await viewer.evaluate(() => window.probe.errors);
        entry.lastFrame = await viewer.evaluate(id => { const f = window.probe.frames[id]; return f && { width: f.width, height: f.height, format: f.format, serial: f.serial }; }, id);
        results.failures.push({ platform, ...test, error: entry.error });
      }
      entry.endedAt = new Date().toISOString();
      results.cases.push(entry);
      console.log(JSON.stringify(entry));
      await writeFile(resultPath, JSON.stringify(results, null, 2) + '\n');
    }
    await native.close(); native = undefined;
    await viewer.waitForTimeout(300);
    await send([{ type: 'setViewport', width, height, scale: 1 }]);
  }
  results.decoderSupportChecks = await viewer.evaluate(() => window.probe.supportChecks);
  results.streamParameterSets = await viewer.evaluate(() => window.probe.parameterSets);
  results.wireFormatCounts = await viewer.evaluate(() => window.probe.wireFormatCounts);
  results.decoderErrors = await viewer.evaluate(() => window.probe.errors);
  if (results.decoderErrors.length) results.failures.push({ error: 'Decoder or engine errors occurred', details: results.decoderErrors });
  }
} finally {
  await native?.close(); await browser.close(); await rm(profile, { recursive: true, force: true });
  await writeFile(resultPath, JSON.stringify(results, null, 2) + '\n');
}
assert.equal(results.failures.length, 0, `${results.failures.length} resize checks failed; see ${resultPath}`);
