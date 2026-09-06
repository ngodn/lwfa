// Real native Wayland/Xwayland -> capture -> JPEG -> browser pixel checks.
// The engine must be an isolated dev instance. This changes its window layout.
// PLAYWRIGHT_MODULE points to playwright-core; AUTH_PASS, WAYLAND_DISPLAY and
// DISPLAY must refer to that dev engine. No production discovery is performed.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.AUTH_PASS, 'AUTH_PASS must be the dev password');
assert(process.env.LWFA_TEST_WAYLAND, 'LWFA_TEST_WAYLAND must name the dev socket');
assert(process.env.LWFA_TEST_DISPLAY, 'LWFA_TEST_DISPLAY must name the dev Xwayland display');
const codecs = process.env.LWFA_TEST_CODEC === 'h264' ? ['h264'] : [];
const origin = process.env.LWFA_TEST_URL || 'http://127.0.0.1:6734';
const profile = await mkdtemp(join(tmpdir(), 'lwfa-rendering-'));
const fixture = join(profile, 'pattern.html');
await writeFile(fixture, `<title>lwfa-edge-probe</title><style>html,body{margin:0;width:100%;height:100%;background:#be48ef}body{box-sizing:border-box;border:16px solid #3edbc8}i{display:block;width:30px;height:30px;background:#fddd39;position:absolute;top:40%;animation:move 2s infinite alternate linear}@keyframes move{from{left:20%}to{left:70%}}</style><i></i>`);
const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/chromium' });
let native;
try {
  const viewer = await browser.newPage();
  // Avoid starting the shell's own layout connection; this page supplies only
  // the same-origin WebSocket and browser image decoder.
  await viewer.goto(`${origin}/favicon.ico`);
  await viewer.evaluate(async ({ origin, token }) => {
    const url = new URL(origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('token', token);
    const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
    window.probe = { ws, windows: [], samples: [] };
    ws.onmessage = async ({ data }) => {
      if (typeof data === 'string') {
        const m = JSON.parse(data);
        if (m.type === 'hello') window.probe.windows = m.windows;
        if (m.type === 'windowOpened') window.probe.windows.push(m.window);
        if (m.type === 'windowChanged') window.probe.windows = window.probe.windows.map(w => w.id === m.window.id ? m.window : w);
        if (m.type === 'windowClosed') window.probe.windows = window.probe.windows.filter(w => w.id !== m.id);
        return;
      }
      const v = new DataView(data);
      if (v.getUint32(0, true) !== 0x4146574c) return;
      const id = Number(v.getBigUint64(8, true));
      const format = v.getUint8(5);
      const payload = new Uint8Array(data, 24);
      if (format === 0) {
        await sample(id, await createImageBitmap(new Blob([payload], { type: 'image/jpeg' })), 0);
      } else if (format === 1) {
        const key = (v.getUint8(6) & 1) !== 0;
        let decoder = decoders.get(id);
        if (key) {
          let codec;
          for (let i=0;i+7<payload.length;i++) {
            const n = payload[i]===0&&payload[i+1]===0&&payload[i+2]===1 ? i+3 : -1;
            if(n>=0&&(payload[n]&31)===7) {codec='avc1.'+[...payload.slice(n+1,n+4)].map(b=>b.toString(16).padStart(2,'0')).join('');break;}
          }
          if (!decoder && codec) {
            decoder = new VideoDecoder({output:async frame=>{try{await sample(id,await createImageBitmap(frame),1)}finally{frame.close()}},error:e=>{window.probe.error=e.message}});
            decoder.configure({codec,optimizeForLatency:true});
            decoders.set(id,decoder);
          }
        }
        if (decoder) decoder.decode(new EncodedVideoChunk({type:key?'key':'delta',timestamp:++timestamp*16667,data:payload}));
      }
    };
    const decoders = new Map(); let timestamp=0;
    async function sample(id,bitmap,format) {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const c = canvas.getContext('2d'); c.drawImage(bitmap, 0, 0); bitmap.close();
      const { width: w, height: h } = canvas;
      const p = c.getImageData(0, 0, w, h).data;
      const dark = (x,y) => { const i=(y*w+x)*4; return p[i]<12&&p[i+1]<12&&p[i+2]<12; };
      let right=0,bottom=0;
      while(right<w && Array.from({length:h},(_,y)=>y).every(y=>dark(w-right-1,y)))right++;
      while(bottom<h && Array.from({length:w},(_,x)=>x).every(x=>dark(x,h-bottom-1)))bottom++;
      window.probe.samples.push({id,w,h,right,bottom,format});
    }
    await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
  }, { origin, token: process.env.AUTH_PASS });
  for (const platform of ['wayland', 'x11']) {
    native = await chromium.launchPersistentContext(join(profile, platform), {
      executablePath: '/usr/bin/chromium', headless: false, viewport: null,
      env: { ...process.env, WAYLAND_DISPLAY: process.env.LWFA_TEST_WAYLAND, DISPLAY: process.env.LWFA_TEST_DISPLAY },
      args: [`--ozone-platform=${platform}`, `--app=file://${fixture}`, '--no-first-run', '--password-store=basic'],
    });
    await viewer.waitForFunction(() => window.probe.windows.some(w=>w.title?.includes('lwfa-edge-probe')));
    const id = await viewer.evaluate(() => window.probe.windows.find(w=>w.title?.includes('lwfa-edge-probe')).id);
    for (const [width,height] of [[802,602],[1192,860],[640,480],[1324,884]]) {
      await viewer.evaluate(({id,width,height,codecs})=>{
        window.probe.samples=[];
        window.probe.ws.send(JSON.stringify({type:'setLayout',windows:[{id,z:0,rect:{x:0,y:0,width,height}}],animate:null}));
        window.probe.ws.send(JSON.stringify({type:'setStreams',windows:[id],codecs}));
      },{id,width,height,codecs});
      await viewer.waitForFunction(({id,width,height})=>window.probe.samples.filter(s=>s.id===id&&s.w===width&&s.h===height).length>=3,{id,width,height},{timeout:15000});
      await viewer.waitForTimeout(2000);
      const sample = await viewer.evaluate(({id})=>window.probe.samples.filter(s=>s.id===id).at(-1),{id});
      console.log(JSON.stringify({platform,sample,client:await native.pages()[0].evaluate(()=>({w:innerWidth,h:innerHeight,outerW:outerWidth,outerH:outerHeight,dpr:devicePixelRatio}))}));
      assert.equal(sample.format,codecs.length ? 1 : 0,'actual wire codec matches requested test');
      assert.equal(sample.right,0,`${platform} ${width}x${height} black columns`);
      assert.equal(sample.bottom,0,`${platform} ${width}x${height} black rows`);
      console.log(`PASS ${platform} ${width}x${height}: right=${sample.right}, bottom=${sample.bottom}`);
    }
    await native.close(); native=undefined;
    await viewer.waitForTimeout(300);
    // Clear this test's local registry after closing its own process context.
    await viewer.evaluate(()=>{window.probe.windows=[]});
  }
} finally {
  await native?.close(); await browser.close(); await rm(profile,{recursive:true,force:true});
}
