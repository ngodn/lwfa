// Read-only Wine DPI queries while changing an isolated compositor's layout.
// Required: LWFA_ISOLATED_TEST=1, LWFA_TEST_URL, AUTH_PASS,
// LWFA_TEST_DISPLAY, PROTON_DIR, and ZIG (absolute binary path).
// The caller starts and stops the isolated engine. No installed game or prefix
// is used. Optional LWFA_TEST_BROWSER_RESIZE=1 adds a viewport resize case.
// Results and Wine child-process logs: LWFA_TEST_RESULTS_DIR, or target/proton-display.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForOpen } from './websocket-open.mjs';

assert.equal(process.env.LWFA_ISOLATED_TEST, '1', 'Explicitly confirm an isolated test engine with LWFA_ISOLATED_TEST=1');
for (const name of ['LWFA_TEST_URL', 'AUTH_PASS', 'LWFA_TEST_DISPLAY', 'PROTON_DIR', 'ZIG']) {
  assert(process.env[name], `${name} is required; production settings are never discovered`);
}
assert(isAbsolute(process.env.PROTON_DIR), 'PROTON_DIR must be absolute');
assert(isAbsolute(process.env.ZIG), 'ZIG must be an explicit absolute binary path (for example from mise where zig@0.16.0)');
const endpoint = new URL(process.env.LWFA_TEST_URL);
assert(['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol), 'Expected an HTTP or WebSocket engine URL');
assert(['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname), 'The isolated engine must run on loopback');
endpoint.protocol = ['https:', 'wss:'].includes(endpoint.protocol) ? 'wss:' : 'ws:';
endpoint.searchParams.set('token', process.env.AUTH_PASS);

const source = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const resultDir = resolve(process.env.LWFA_TEST_RESULTS_DIR || 'target/proton-display');
await mkdir(resultDir, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'lwfa-proton-display-'));
const wine = join(process.env.PROTON_DIR, 'files/bin/wine');
const wineserver = join(process.env.PROTON_DIR, 'files/bin/wineserver');
const displayEnv = { ...process.env, DISPLAY: process.env.LWFA_TEST_DISPLAY, WAYLAND_DISPLAY: '' };
delete displayEnv.LD_PRELOAD;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const owned = new Set();
let socket;
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

function run(command, args, env = process.env, timeout = 120_000) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout });
  assert(!result.error, `${command}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function start(command, args, env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  owned.add(child);
  const state = { child, output: '', error: null, closed: false, code: null };
  const append = chunk => { state.output += chunk; };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', error => { state.error = error; });
  child.on('close', code => { state.closed = true; state.code = code; owned.delete(child); });
  return state;
}

async function waitUntil(check, label, timeout = 15_000, cleaningUp = false) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assert(cleaningUp || !interrupted, 'Test interrupted');
    if (check()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try { await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 'child termination', 2000, true); }
  catch { child.kill('SIGKILL'); }
}

function screen() {
  const output = run('xrandr', ['--current'], displayEnv, 5000);
  const match = /current (\d+) x (\d+)/.exec(output);
  assert(match, `Cannot read isolated X11 screen dimensions: ${output}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

const assertion = output => /monitor_get_dpi[^\n]*Assertion|num \* dpi \/ d < 65536/.test(output);
const results = [];
try {
  run(process.env.CC || 'cc', ['-std=c11', '-Wall', '-Wextra', join(source, 'proton-display-window.c'), '-lX11', '-o', join(temporary, 'window')]);
  run(process.env.ZIG, ['cc', '-std=c11', '-target', 'x86_64-windows-gnu', join(source, 'proton-display-dpi.c'), '-o', join(temporary, 'dpi.exe'), '-luser32'], process.env, 180_000);
  const windows = new Map();
  const errors = [];
  let hello = false;
  socket = new WebSocket(endpoint);
  socket.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') return;
    const message = JSON.parse(data);
    if (message.type === 'hello') {
      hello = true;
      for (const window of message.windows) windows.set(window.id, window);
    }
    if (message.window) windows.set(message.window.id, message.window);
    if (message.type === 'windowClosed') windows.delete(message.id);
    if (message.type === 'error') errors.push(message);
  });
  await waitForOpen(socket);
  await waitUntil(() => hello, 'authenticated engine hello');
  assert.equal(windows.size, 0, 'The isolated engine must have no pre-existing application windows');
  const send = message => socket.send(JSON.stringify(message));
  const setViewport = width => send({ type: 'setViewport', width, height: 839, scale: 1 });
  const scenarios = ['window-growth', 'workspace-scaling'];
  if (process.env.LWFA_TEST_BROWSER_RESIZE === '1') scenarios.push('browser-resize');
  for (const name of scenarios) {
    const prefix = join(temporary, `prefix-${name}`);
    await mkdir(prefix);
    const env = { ...displayEnv, WINEPREFIX: prefix, WINEDEBUG: '-all', WINEDLLOVERRIDES: 'mscoree,mshtml=', WINEESYNC: '0', WINEFSYNC: '0' };
    let native, probe;
    const result = { name, before: null, after: null, assertion: false, completed: false };
    try {
      errors.length = 0;
      setViewport(1319);
      await delay(300);
      native = start(join(temporary, 'window'), [], displayEnv);
      let id;
      await waitUntil(() => {
        assert(!native.error, native.error?.message);
        assert(!native.closed, `X11 fixture exited: ${native.output}`);
        id = [...windows.values()].find(window => window.title === 'lwfa-dpi-window-fixture')?.id;
        return id !== undefined;
      }, 'native fixture window');
      const layout = width => send({ type: 'setLayout', windows: [{ id, z: 0, rect: { x: 0, y: 0, width, height: 600 } }], animate: null });
      layout(1000);
      await delay(300);
      result.before = screen();
      probe = start(wine, [join(temporary, 'dpi.exe'), '20'], env);
      await waitUntil(() => {
        assert(!probe.error, probe.error?.message);
        assert(!assertion(probe.output), 'Wine DPI assertion before the test action');
        assert(!probe.closed, `DPI probe exited before readiness: ${probe.output}`);
        return probe.output.includes('dpi type=2');
      }, 'initial Wine DPI query', 60_000);
      if (name === 'window-growth') layout(1324);
      else if (name === 'workspace-scaling') send({ type: 'setWindowScaling', id, scaling: { mode: 'workspace', scale: 1.5 } });
      else setViewport(1324);
      await delay(500);
      result.after = screen();
      await waitUntil(() => {
        assert(!probe.error, probe.error?.message);
        return assertion(probe.output) || probe.output.includes('DPI_PROBE_OK') || probe.closed;
      }, 'DPI probe completion', 30_000);
      result.assertion = assertion(probe.output);
      result.completed = probe.output.includes('DPI_PROBE_OK');
      assert(!result.assertion, 'Wine child process hit monitor_get_dpi assertion');
      assert(result.completed, 'Wine child process did not finish all DPI queries');
      assert.equal(errors.length, 0, `Engine errors: ${JSON.stringify(errors)}`);
      if (name !== 'browser-resize') assert.deepEqual(result.after, result.before, 'Individual window changes must preserve the shared display dimensions');
      result.passed = true;
    } catch (error) {
      result.passed = false;
      result.error = error.message;
      process.exitCode = 1;
    } finally {
      // Only this fresh prefix's server is addressed. Never use killall or a
      // wineserver command without the temporary WINEPREFIX.
      const cleanup = spawnSync(wineserver, ['-k'], { env, encoding: 'utf8', timeout: 5000 });
      if (cleanup.error || cleanup.status !== 0) {
        result.cleanupError = cleanup.error?.message || cleanup.stderr;
        result.passed = false;
        process.exitCode = 1;
      }
      await stop(probe?.child);
      await stop(native?.child);
      await delay(100);
      result.assertion = assertion(probe?.output || '');
      if (result.assertion) { result.passed = false; process.exitCode = 1; }
      await writeFile(join(resultDir, `${name}.log`), probe?.output || 'Probe did not start.\n');
      results.push(result);
      console.log(JSON.stringify(result));
      await writeFile(join(resultDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
      await waitUntil(() => ![...windows.values()].some(window => window.title === 'lwfa-dpi-window-fixture'), 'fixture window removal');
    }
  }
} finally {
  socket?.close();
  for (const child of owned) await stop(child);
  await rm(temporary, { recursive: true, force: true });
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
