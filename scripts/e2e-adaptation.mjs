// Dev-only transport check. Run a continuously animating window in the dev
// compositor first, then supply AUTH_PASS and ENGINE_LOG. Node 24, no packages.
// The client receives encoded bytes but does not decode or present them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

assert(process.env.AUTH_PASS, 'AUTH_PASS must be the dev engine password');
assert(process.env.ENGINE_LOG, 'ENGINE_LOG must name the dev engine log');
const codec = process.env.ADAPTATION_CODEC || 'h264';
assert(['h264', 'jpeg'].includes(codec), 'ADAPTATION_CODEC must be h264 or jpeg');
const logStart = fs.statSync(process.env.ENGINE_LOG).size;
const sockets = new Set();
let capacity = 64_000_000;
let wireBytes = 0;
let frames = 0;
let videoBytes = 0;
let keyframeBytes = 0;
let keyframes = 0;
let maxFrameBytes = 0;
let closed = false;
const phases = [];
const samples = [];

// Pull bounded amounts from upstream instead of buffering a whole stream in
// JS. TCP backpressure then reaches the actual engine's send socket.
const proxy = net.createServer(client => {
  const upstream = net.createConnection({ host: '127.0.0.1', port: 6734 });
  sockets.add(client);
  sockets.add(upstream);
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  client.pipe(upstream);
  upstream.pause();
  const timer = setInterval(() => {
    if (client.writableNeedDrain) return;
    const allowance = Math.max(1, Math.floor(capacity / 8 / 100));
    const available = upstream.readableLength;
    if (!available) {
      upstream.read(0);
      return;
    }
    const chunk = upstream.read(Math.min(allowance, available));
    if (chunk) {
      wireBytes += chunk.length;
      client.write(chunk);
    }
  }, 10);
  const cleanup = () => {
    clearInterval(timer);
    client.destroy();
    upstream.destroy();
    sockets.delete(client);
    sockets.delete(upstream);
  };
  client.on('error', cleanup);
  upstream.on('error', cleanup);
  client.on('close', cleanup);
  upstream.on('close', cleanup);
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const address = proxy.address();
const url = new URL(`ws://127.0.0.1:${address.port}/`);
url.searchParams.set('token', process.env.AUTH_PASS);
const socket = new WebSocket(url);
socket.binaryType = 'arraybuffer';
socket.addEventListener('close', () => { closed = true; });
const hello = new Promise((resolve, reject) => {
  socket.addEventListener('error', () => reject(new Error('dev socket failed')));
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') {
      const frame = Buffer.from(event.data);
      if (frame.subarray(0, 4).toString() === 'LWFA') {
        frames++;
        videoBytes += frame.length;
        maxFrameBytes = Math.max(maxFrameBytes, frame.length);
        if (frame[6] & 1) { keyframes++; keyframeBytes += frame.length; }
      }
      return;
    }
    const message = JSON.parse(event.data);
    if (message.type !== 'hello') return;
    assert(message.windows.length, 'dev engine needs an animating window');
    const id = process.env.WINDOW_ID ? Number(process.env.WINDOW_ID) : message.focused ?? message.windows[0].id;
    socket.send(JSON.stringify({ type: 'setLayout',
      windows: [{ id, z: 0, rect: { x: 0, y: 0, width: 1000, height: 700 } }], animate: null }));
    socket.send(JSON.stringify({ type: 'setStreams', windows: [id], codecs: codec === 'jpeg' ? [] : ['h264'] }));
    resolve(id);
  });
});

function changes() {
  const text = fs.readFileSync(process.env.ENGINE_LOG).subarray(logStart).toString('utf8');
  return [...text.matchAll(/stream budget is now (\d+) kbit\/s \(([^)]*)\)/g)]
    .map(match => ({ kbit: Number(match[1]), cause: match[2] }));
}

async function phase(name, bits, seconds) {
  capacity = bits;
  const beforeBytes = wireBytes;
  const beforeFrames = frames;
  const beforeChanges = changes().length;
  console.log(`phase ${name}: ${bits / 1_000_000} Mbit/s for ${seconds}s`);
  let last = { wireBytes, frames, videoBytes, keyframeBytes, keyframes };
  for (let elapsed = 0; elapsed < seconds; elapsed += 5) {
    await sleep(Math.min(5, seconds - elapsed) * 1000);
    assert(!closed, 'stream disconnected during the capacity change');
    if (process.env.ADAPTATION_TRACE || process.env.ADAPTATION_EXPECT_PACING) {
      const tcp = fs.readFileSync('/proc/net/tcp', 'utf8').trim().split('\n').slice(1)
        .map(line => line.trim().split(/\s+/))
        .filter(fields => fields[1].endsWith(':1A4E') || fields[2].endsWith(':1A4E'))
        .filter(fields => fields[3] === '01')
        .map(fields => ({ local: fields[1], remote: fields[2],
          tx: parseInt(fields[4].split(':')[0], 16), rx: parseInt(fields[4].split(':')[1], 16) }));
      const sample = { sample: name, elapsed: elapsed + 5,
        frames: frames - last.frames, mbit: (wireBytes - last.wireBytes) * 8 / 1e6,
        videoMbit: (videoBytes - last.videoBytes) * 8 / 1e6,
        keyframeMbit: (keyframeBytes - last.keyframeBytes) * 8 / 1e6,
        keyframes: keyframes - last.keyframes, maxFrameBytes, budget: changes().at(-1), tcp,
        jsQueued: [...sockets].reduce((sum, connection) => sum + connection.readableLength + connection.writableLength, 0) };
      samples.push(sample);
      console.log(JSON.stringify(sample));
      maxFrameBytes = 0;
      last = { wireBytes, frames, videoBytes, keyframeBytes, keyframes };
    }
  }
  const result = { name, frames: frames - beforeFrames,
    deliveredMbit: (wireBytes - beforeBytes) * 8 / 1_000_000,
    changes: changes().slice(beforeChanges) };
  phases.push(result);
  console.log(JSON.stringify(result));
  assert(result.frames >= 10, `${name}: insufficient motion for an adaptation check`);
}

try {
  const id = await Promise.race([hello, sleep(5000).then(() => { throw new Error('no dev greeting'); })]);
  console.log(`streaming dev window ${id} as ${codec}`);
  await phase('clear', 64_000_000, 15);
  await phase('limited', Number(process.env.LIMIT_BPS || 1_000_000), 20);
  await phase('recovered', 64_000_000, 45);
  assert(phases[1].changes.some(change => /delay rising|backpressure/.test(change.cause)),
    'limited connection did not produce a congestion response');
  assert(phases[2].changes.some(change => change.cause.startsWith('link clear')),
    'recovered connection did not raise its budget');
  if (process.env.ADAPTATION_EXPECT_PACING) {
    assert.equal(codec, 'jpeg', 'byte conformance assertion is for independent JPEG frames');
    const recovered = samples.filter(sample => sample.sample === 'recovered');
    let checked = 0;
    for (let i = 1; i < recovered.length; i++) {
      const previous = recovered[i - 1];
      const sample = recovered[i];
      if (!previous.budget || !sample.budget) continue;
      // Allow the larger endpoint budget across a climbing five-second bin,
      // plus one whole JPEG burst. Skip the first bin where TCP can drain old
      // bytes from the constrained phase.
      const allowance = Math.max(previous.budget.kbit, sample.budget.kbit) * 1000 * 5
        + sample.maxFrameBytes * 8;
      assert(sample.videoMbit * 1e6 <= allowance * 1.05,
        `JPEG exceeded its byte budget after recovery at ${sample.elapsed}s: ${sample.videoMbit} Mbit`);
      checked++;
    }
    assert(checked >= 2, 'not enough measured budget intervals to verify JPEG pacing');
    console.log('PASS: recovered JPEG traffic fits its current budget plus one independent frame');
  }
  console.log('PASS: live stream reduced its budget under throttling and raised it after recovery');
} finally {
  socket.close();
  for (const connection of sockets) connection.destroy();
  await new Promise(resolve => proxy.close(resolve));
}
