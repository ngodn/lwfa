// Stock Zen capability probe using a disposable profile and a loopback page.
// Does not connect to lwfa or touch an existing browser profile.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { codecFromAnnexB } from '../packages/shell/src/lib/codecs.ts';

const executable = process.env.ZEN_EXECUTABLE || '/usr/bin/zen-browser';
const resultPath = resolve(process.env.LWFA_TEST_RESULTS || 'target/zen-codecs/results.json');
await mkdir(dirname(resultPath), { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'lwfa-zen-codecs-'));
const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 });
assert.equal(version.status, 0, version.stderr);
const headless = process.env.LWFA_TEST_HEADED !== '1';
if (!headless) {
 assert.equal(process.env.LWFA_ISOLATED_TEST, '1', 'Headed probes require an explicitly isolated compositor');
 assert(process.env.XDG_RUNTIME_DIR && process.env.LWFA_TEST_WAYLAND, 'Supply the isolated runtime and Wayland socket');
 assert(process.env.XDG_RUNTIME_DIR.startsWith('/tmp/lwfa-'), 'Headed probes require an owned temporary lwfa test runtime');
}
const enableH265 = process.env.LWFA_TEST_ENABLE_H265 === '1';
const report = { executable, version: version.stdout.trim(), date: new Date().toISOString(), headless, disposableProfile: true,
 codecPreferences: enableH265 ? { 'dom.media.webcodecs.h265.enabled': true } : {} };
const live = process.env.LWFA_TEST_LIVE_HEVC === '1';
let liveEndpoint, nativeCommand;
if (live) {
 assert.equal(process.env.LWFA_ISOLATED_TEST, '1');
 for (const name of ['LWFA_TEST_URL', 'AUTH_PASS', 'LWFA_TEST_ENGINE_PID']) assert(process.env[name], `${name} is required`);
 assert.equal((await readFile(`/proc/${Number(process.env.LWFA_TEST_ENGINE_PID)}/comm`, 'utf8')).trim(), 'lwfa-engine');
 liveEndpoint = new URL(process.env.LWFA_TEST_URL);
 assert(['127.0.0.1', 'localhost', '[::1]'].includes(liveEndpoint.hostname), 'Live probe requires an isolated loopback engine');
 liveEndpoint.protocol = 'ws:'; liveEndpoint.searchParams.set('token', process.env.AUTH_PASS);
 const nativeBinary = join(profile, 'native-fixture');
 const compiled = spawnSync(process.env.CC || 'cc', ['-std=c11', '-Wall', '-Wextra', resolve('scripts/fixtures/zen-hevc-window.c'), '-lX11', '-o', nativeBinary], { encoding: 'utf8', timeout: 30000 });
 assert.equal(compiled.status, 0, compiled.stderr);
 nativeCommand = `"${nativeBinary}"`;
 report.liveEngine = { pid: Number(process.env.LWFA_TEST_ENGINE_PID), origin: liveEndpoint.origin };
}
const packet = process.env.LWFA_TEST_HEVC_PACKET ? await readFile(process.env.LWFA_TEST_HEVC_PACKET) : null;
if (packet) report.packet = { path: resolve(process.env.LWFA_TEST_HEVC_PACKET), bytes: packet.length, codec: codecFromAnnexB(packet, 'hevc') };
const matrixPackets = [];
let decoderBundle = '';
if (process.env.LWFA_TEST_HEVC_MANIFEST) {
 const manifestPath = resolve(process.env.LWFA_TEST_HEVC_MANIFEST);
 const rows = JSON.parse(await readFile(manifestPath, 'utf8')).filter(row => row.codec === 'hevc');
 for (const row of rows) {
  const path = join(dirname(manifestPath), `hevc-${row.stage}-${row.recovery ? 2 : 0}.hevc`);
  const bytes = await readFile(path);
  matrixPackets.push({ ...row, path, bytes, browserCodec: codecFromAnnexB(bytes, 'hevc') });
 }
 report.matrixManifest = manifestPath;
}
if (matrixPackets.length || live) {
 const require = createRequire(resolve('packages/shell/package.json'));
 const { build } = await import(require.resolve('vite'));
 const bundled = await build({ configFile: false, root: resolve('packages/shell'), logLevel: 'error',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: { alias: [{ find: '@lwfa/proto', replacement: resolve('packages/proto/src/index.ts') }, { find: '@', replacement: resolve('packages/shell/src') }] },
  plugins: [{ name: 'zen-decoder-probe', resolveId(id) { if (id.endsWith('virtual:zen-decoder')) return '\0zen-decoder'; },
   load(id) { if (id === '\0zen-decoder') return 'import {FrameDecoder} from "@/decode"; import {decodeFrame} from "@lwfa/proto"; window.LWFA_TEST_DECODER = FrameDecoder; window.LWFA_TEST_DECODE_FRAME = decodeFrame;'; } }],
  build: { write: false, minify: true, lib: { entry: 'virtual:zen-decoder', name: 'LWFA_TEST_DECODER', formats: ['iife'] } },
 });
 decoderBundle = (Array.isArray(bundled) ? bundled[0] : bundled).output.find(item => item.type === 'chunk').code;
}
const key = randomBytes(16).toString('hex');
const codecs = [...new Set(['avc1.4D0028', 'avc1.640029', 'hvc1.1.6.L93.B0', 'hvc1.1.6.L120.B0', 'hvc1.1.6.H123.90', 'hvc1.1.6.L180.90', ...(packet ? [report.packet.codec] : [])])];
codecs.push(...codecs.filter(codec => codec.startsWith('hvc1')).map(codec => codec.replace('hvc1', 'hev1')));
const page = `<!doctype html><meta charset=utf-8><title>lwfa isolated codec probe</title>${decoderBundle ? `<script src="/${key}/decoder.js"></script>` : ''}<script>
(async () => {
 const result = { userAgent: navigator.userAgent, secureContext: isSecureContext, videoDecoder: typeof VideoDecoder !== 'undefined', checks: [] };
 try {
  if (result.videoDecoder) {
   for (const codec of ${JSON.stringify(codecs)}) for (const hardwareAcceleration of ['no-preference', 'prefer-hardware', 'prefer-software']) {
    const config = { codec, codedWidth: 1920, codedHeight: 1080, hardwareAcceleration, optimizeForLatency: true };
    try { const answer = await VideoDecoder.isConfigSupported(config); result.checks.push({ ...config, supported: answer.supported }); }
    catch (error) { result.checks.push({ ...config, error: error.name + ': ' + error.message }); }
   }
   ${packet ? `
   const bytes = new Uint8Array(await (await fetch('/${key}/packet')).arrayBuffer());
   result.decode = { codec: ${JSON.stringify(report.packet.codec)}, frames: [], errors: [] };
   const decoder = new VideoDecoder({ output(frame) { result.decode.frames.push({ width: frame.displayWidth, height: frame.displayHeight }); frame.close(); }, error(error) { result.decode.errors.push(error.name + ': ' + error.message); } });
   try {
    decoder.configure({ codec: result.decode.codec, optimizeForLatency: true });
    decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: bytes }));
    await Promise.race([decoder.flush(), new Promise((_, reject) => setTimeout(() => reject(new Error('Decode timed out')), 10000))]);
   } catch (error) { result.decode.errors.push(error.name + ': ' + error.message); }
   finally { if (decoder.state !== 'closed') decoder.close(); }
   ` : ''}
   ${matrixPackets.length ? `
   result.matrix = { cases: [], errors: [], keyframeRequests: [] };
   let active;
   const matrixDecoder = new window.LWFA_TEST_DECODER((id, bitmap) => { active?.resolve(bitmap); },
     (codec, detail) => { result.matrix.errors.push({ codec, detail }); active?.reject(new Error(detail)); },
     id => result.matrix.keyframeRequests.push(id));
   try {
    for (const row of ${JSON.stringify(matrixPackets.map(({ bytes, ...row }, index) => ({ ...row, index })))}) {
     const payload = new Uint8Array(await (await fetch('/${key}/matrix/' + row.index)).arrayBuffer());
     let timeout;
     try {
      const output = new Promise((resolve, reject) => { active = { resolve, reject }; timeout = setTimeout(() => reject(new Error('FrameDecoder output timed out')), 10000); });
      await matrixDecoder.handle({ header: { window: 1, width: row.sourceWidth, height: row.sourceHeight, format: 2, keyframe: true }, payload });
      const bitmap = await output;
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let maxChannelError = 0;
      for (const y of [2, Math.floor(row.sourceHeight / 4), Math.floor(row.sourceHeight * 3 / 4), row.sourceHeight - 3]) {
       for (const x of [2, Math.floor(row.sourceWidth / 4), Math.floor(row.sourceWidth * 3 / 4), row.sourceWidth - 3]) {
        const expected = [40, 100, 160, 220][Number(x >= Math.floor(row.sourceWidth / 2)) + 2 * Number(y >= Math.floor(row.sourceHeight / 2))];
        for (let channel = 0; channel < 3; channel++) maxChannelError = Math.max(maxChannelError, Math.abs(pixels[(y * canvas.width + x) * 4 + channel] - expected));
       }
      }
      const dark = (x, y) => [0, 1, 2].every(channel => pixels[(y * canvas.width + x) * 4 + channel] < 12);
      let right = 0, bottom = 0;
      while (right < canvas.width && Array.from({ length: canvas.height }, (_, y) => y).every(y => dark(canvas.width - right - 1, y))) right++;
      while (bottom < canvas.height && Array.from({ length: canvas.width }, (_, x) => x).every(x => dark(x, canvas.height - bottom - 1))) bottom++;
      result.matrix.cases.push({ stage: row.stage, recovery: row.recovery, codec: row.browserCodec,
       width: canvas.width, height: canvas.height, sourceWidth: row.sourceWidth, sourceHeight: row.sourceHeight,
       maxChannelError, right, bottom,
       passed: canvas.width === row.stream.width && canvas.height === row.stream.height && maxChannelError <= 10 && right === 0 && bottom === 0 });
     } catch (error) { result.matrix.cases.push({ stage: row.stage, recovery: row.recovery, passed: false, error: error.name + ': ' + error.message }); }
     finally { clearTimeout(timeout); active = null; }
    }
   } finally { matrixDecoder.close(); }
   ` : ''}
   ${live ? `
   {
   result.live = { phases: [], errors: [], keyframeRequests: [], wireFormats: [] };
   const link = new WebSocket(${JSON.stringify(liveEndpoint?.toString())});
   link.binaryType = 'arraybuffer';
   let windows = [], greeted = false, frameCount = 0, latest, nativeId;
   const decoder = new window.LWFA_TEST_DECODER((id, bitmap) => {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let maxChannelError = 0;
    for (const y of [2, Math.floor(canvas.height / 4), Math.floor(canvas.height * 3 / 4), canvas.height - 3]) {
     for (const x of [2, Math.floor(canvas.width / 4), Math.floor(canvas.width * 3 / 4), canvas.width - 3]) {
      const expected = [40, 100, 160, 220][Number(x >= Math.floor(canvas.width / 2)) + 2 * Number(y >= Math.floor(canvas.height / 2))];
      for (let channel = 0; channel < 3; channel++) maxChannelError = Math.max(maxChannelError, Math.abs(pixels[(y * canvas.width + x) * 4 + channel] - expected));
     }
    }
    const dark = (x, y) => [0, 1, 2].every(channel => pixels[(y * canvas.width + x) * 4 + channel] < 12);
    let right = 0, bottom = 0;
    while (right < canvas.width && Array.from({ length: canvas.height }, (_, y) => y).every(y => dark(canvas.width - right - 1, y))) right++;
    while (bottom < canvas.height && Array.from({ length: canvas.width }, (_, x) => x).every(x => dark(x, canvas.height - bottom - 1))) bottom++;
    latest = { count: ++frameCount, width: canvas.width, height: canvas.height, maxChannelError, right, bottom };
   }, (codec, detail) => result.live.errors.push({ codec, detail }), id => result.live.keyframeRequests.push(id));
   const send = message => link.send(JSON.stringify(message));
   link.onmessage = async ({data}) => {
    if (typeof data === 'string') {
     const message = JSON.parse(data);
     if (message.type === 'hello') { greeted = true; windows = message.windows; }
     if (message.type === 'windowOpened') windows.push(message.window);
     if (message.type === 'error') result.live.errors.push(message);
    } else {
     const frame = window.LWFA_TEST_DECODE_FRAME(data);
     if (!frame) return;
     result.live.wireFormats.push(frame.header.format);
     try { await decoder.handle(frame); } catch(error) { result.live.errors.push(error.message); }
    }
   };
   const wait = async (check, label) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve,25)); }
    throw new Error(label + ' timed out');
   };
   try {
    await wait(() => greeted, 'Engine greeting');
    if (windows.length) throw new Error('Live test requires an empty isolated engine');
    send({type:'setViewport',width:1000,height:640,scale:1});
    send({type:'spawn',command:${JSON.stringify(nativeCommand)},terminal:false});
    await wait(() => windows.some(w => w.title === 'lwfa-zen-hevc-probe'), 'Native fixture');
    nativeId = windows.find(w => w.title === 'lwfa-zen-hevc-probe').id;
    send({type:'setStreams',windows:[nativeId],codecs:['hevc']});
    for (const [width,height] of [[1000,640],[1324,838],[838,1324],[1324,838],[1000,640]]) {
     const previous = frameCount;
     const wireStart = result.live.wireFormats.length;
     send({type:'setViewport',width,height,scale:1});
     send({type:'setLayout',windows:[{id:nativeId,z:0,rect:{x:0,y:0,width,height}}],animate:null});
     await wait(() => latest?.width === width && latest?.height === height && frameCount >= previous + 3 && latest.maxChannelError <= 10 && latest.right === 0 && latest.bottom === 0, 'HEVC resize ' + width + 'x' + height);
     const wireFormats = [...new Set(result.live.wireFormats.slice(wireStart))];
     result.live.phases.push({...latest,requestedWidth:width,requestedHeight:height,decodedFrames:frameCount-previous,wireFormats,
      passed: wireFormats.length === 1 && wireFormats[0] === 2 });
    }
   } catch(error) { result.live.errors.push(error.message); result.live.lastFrame = latest; }
   finally { if (nativeId && link.readyState === WebSocket.OPEN) send({type:'closeWindow',id:nativeId}); decoder.close(); link.close(); }
   result.live.wireFormats = [...new Set(result.live.wireFormats)];
   }
   ` : ''}
  }
 } catch (error) { result.error = error.name + ': ' + error.message; }
 await fetch('/${key}/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
})();
</script>`;
let receive, rejectResult;
const completed = new Promise((resolve, reject) => { receive = resolve; rejectResult = reject; });
const server = createServer(async (request, response) => {
 if (request.url === `/${key}/page`) { response.setHeader('Content-Type', 'text/html'); response.end(page); return; }
 if (request.url === `/${key}/packet` && packet) { response.end(packet); return; }
 if (request.url === `/${key}/decoder.js` && decoderBundle) { response.setHeader('Content-Type', 'text/javascript'); response.end(decoderBundle); return; }
 if (request.url?.startsWith(`/${key}/matrix/`)) {
  const index = Number(request.url.slice(`/${key}/matrix/`.length));
  if (Number.isInteger(index) && matrixPackets[index]) { response.end(matrixPackets[index].bytes); return; }
 }
 if (request.url === `/${key}/result` && request.method === 'POST') {
  let body = '';
  for await (const chunk of request) { body += chunk; if (body.length > 1000000) { response.writeHead(413).end(); return; } }
  try { const result = JSON.parse(body); response.end('ok'); receive(result); }
  catch (error) { response.writeHead(400).end(); rejectResult(error); }
  return;
 }
 response.writeHead(404).end();
});
let child, timeout;
let output = '';
try {
 // Only the explicitly requested experimental codec pref differs from defaults.
 await writeFile(join(profile, 'user.js'), 'user_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("browser.aboutwelcome.enabled", false);\nuser_pref("browser.startup.page", 0);\nuser_pref("zen.welcome-screen.seen", true);\n' + (enableH265 ? 'user_pref("dom.media.webcodecs.h265.enabled", true);\n' : ''));
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const url = `http://127.0.0.1:${server.address().port}/${key}/page`;
 const browserEnv = { ...process.env };
 if (headless) browserEnv.MOZ_HEADLESS = '1';
 else {
  delete browserEnv.MOZ_HEADLESS;
  Object.assign(browserEnv, { MOZ_ENABLE_WAYLAND: '1', WAYLAND_DISPLAY: process.env.LWFA_TEST_WAYLAND, DISPLAY: '' });
 }
 child = spawn(executable, [...(headless ? ['--headless'] : []), '--no-remote', '--profile', profile, url], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: browserEnv });
 child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
 child.on('error', rejectResult);
 child.on('exit', (code, signal) => rejectResult(new Error(`Browser exited before report: ${code ?? signal}`)));
 timeout = setTimeout(() => rejectResult(new Error('Browser report timed out')), matrixPackets.length || live ? 240000 : 45000);
 report.capabilities = await completed;
 if (matrixPackets.length || live) {
  const matrix = report.capabilities.matrix;
  const streaming = report.capabilities.live;
  report.passed = (!matrixPackets.length || (matrix?.cases.length === matrixPackets.length && matrix.cases.every(row => row.passed) && matrix.errors.length === 0))
   && (!live || (streaming?.phases.length === 5 && streaming.phases.every(row => row.passed) && streaming.errors.length === 0 && streaming.wireFormats.length === 1 && streaming.wireFormats[0] === 2));
  if (!report.passed) process.exitCode = 1;
 }
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
 clearTimeout(timeout);
 if (child?.pid && child.exitCode === null) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await new Promise(resolve => {
   const force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} resolve(); }, 5000);
   child.once('exit', () => { clearTimeout(force); resolve(); });
  });
 }
 server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
 const redact = value => process.env.AUTH_PASS ? value.replaceAll(process.env.AUTH_PASS, '<redacted>') : value;
 await writeFile(resultPath, redact(JSON.stringify(report, null, 2) + '\n'));
 await writeFile(`${resultPath}.browser.log`, redact(output));
 await rm(profile, { recursive: true, force: true });
}
console.log(process.env.AUTH_PASS ? JSON.stringify(report).replaceAll(process.env.AUTH_PASS, '<redacted>') : JSON.stringify(report));
