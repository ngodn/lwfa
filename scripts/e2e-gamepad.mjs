// Browser-to-kernel check against the separate dev engine on port 6734.
// Supply PLAYWRIGHT_MODULE, GAMEPAD_EVENT and AUTH_PASS as described in
// docs/controller-input.md. The Gamepad API is simulated; evdev is real.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import fs from 'node:fs';
import assert from 'node:assert/strict';
assert(process.env.GAMEPAD_EVENT, 'GAMEPAD_EVENT must name the dev controller event node');
assert(process.env.AUTH_PASS, 'AUTH_PASS must be the dev engine password');
const fd = fs.openSync(process.env.GAMEPAD_EVENT, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
const events = [];
const buffer = Buffer.alloc(24 * 256);
function drain() {
  while (true) {
    let n;
    try { n = fs.readSync(fd, buffer); } catch(e) { if(e.code === 'EAGAIN') return; throw e; }
    if (!n) return;
    for (let i=0; i<n; i+=24) events.push({type:buffer.readUInt16LE(i+16),code:buffer.readUInt16LE(i+18),value:buffer.readInt32LE(i+20)});
  }
}
const reader = setInterval(drain, 2);
const browser = await chromium.launch({headless:true});
const wire = [];
try {
 const page = await browser.newPage();
 page.on('pageerror', e=>console.log('PAGE ERROR',e.message));
 let hello = false;
 page.on('websocket', ws => {
   assert.equal(new URL(ws.url()).port,'6734');
   ws.on('framereceived', e=>{if(typeof e.payload==='string' && JSON.parse(e.payload).type==='hello') hello=true});
   ws.on('framesent', e=>{if(typeof e.payload==='string') {const m=JSON.parse(e.payload);if(m.type==='gamepadButton'||m.type==='gamepadAxis')wire.push(m)}});
 });
 await page.addInitScript(()=>{
   // The engine's virtual pads are visible to the local browser too. Ignore
   // their native connection events so only the simulated client pads drive it.
   for (const type of ['gamepadconnected','gamepaddisconnected']) {
     addEventListener(type, event => { if (event.isTrusted) event.stopImmediatePropagation(); }, true);
   }
   window.testPads=[];window.polls=0;
   window.makePad = index => ({index, mapping:'standard', connected:true, buttons:Array.from({length:17},()=>({pressed:false,value:0,touched:false})),axes:[0,0,0,0]});
   Object.defineProperty(navigator,'getGamepads',{value:()=>{window.polls++;return window.testPads}});
 });
 const url = new URL('http://127.0.0.1:6734/');
 url.searchParams.set('token',process.env.AUTH_PASS);
 await page.goto(url.toString());
 for(let i=0;!hello&&i<100;i++)await page.waitForTimeout(50);
 assert(hello,'shell authenticated');
 await page.waitForTimeout(1000);
 const builtIndex=fs.readFileSync(new URL('../packages/shell/dist/index.html',import.meta.url),'utf8');
 const scripts=await page.evaluate(()=>[...document.scripts].map(s=>new URL(s.src).pathname));
 assert(scripts.some(src=>builtIndex.includes(src)), 'dev engine must serve this checkout build');
 await page.evaluate(()=>{
   window.testPads=[window.makePad(0)];
   dispatchEvent(Object.assign(new Event('gamepadconnected'),{gamepad:window.testPads[0]}));
   // Stall future rendering callbacks, without stopping input tasks.
   window.requestAnimationFrame=()=>1;
 });
 await page.waitForTimeout(100);
 wire.length=0; drain();events.length=0;
 await page.evaluate(async()=>{
   const sleep=ms=>new Promise(r=>setTimeout(r,ms));
   for(let i=0;i<100;i++){
     window.testPads[0].buttons[0]={pressed:true,value:1};await sleep(24);
     window.testPads[0].buttons[0]={pressed:false,value:0};await sleep(24);
   }
 });
 await page.waitForTimeout(100);drain();
 const buttons=events.filter(e=>e.type===1&&e.code===304).map(e=>e.value);
 assert.deepEqual(buttons,Array.from({length:200},(_,i)=>i%2===0?1:0));
 assert.equal(wire.filter(m=>m.type==='gamepadButton'&&m.button===0).length,200);
 console.log('PASS: 100 presses + 100 releases through shell, WebSocket and evdev with rAF stalled');
 wire.length=0;events.length=0;
 await page.evaluate(async()=>{
   for(let i=0;i<=100;i++){
     testPads[0].axes[0]=i/100;testPads[0].buttons[6].value=i/100;
     await new Promise(r=>setTimeout(r,10));
   }
   testPads[0].axes[0]=0;testPads[0].buttons[6].value=0;
 });
 await page.waitForTimeout(100);drain();
 for(const code of [0,2]){
   const values=events.filter(e=>e.type===3&&e.code===code).map(e=>e.value);
   assert(values.some(v=>v>(code===0?31000:970)),'analog approaches full travel');
   assert.equal(values.at(-1),0,'analog returns to neutral');
 }
 console.log('PASS: slow stick/trigger sweeps reach near full travel and return to zero in evdev');
 await page.evaluate(()=>{testPads[0].buttons[0]={pressed:true,value:1};testPads.push(makePad(1));dispatchEvent(Object.assign(new Event('gamepadconnected'),{gamepad:testPads[1]}))});
 await page.waitForTimeout(50);drain();events.length=0;
 await page.evaluate(()=>{const old=testPads[0];testPads[0]=null;dispatchEvent(Object.assign(new Event('gamepaddisconnected'),{gamepad:old}))});
 await page.waitForTimeout(100);drain();
 assert(events.some(e=>e.type===1&&e.code===304&&e.value===0),'active controller disconnect releases A while second controller remains');
 console.log('PASS: controller handoff releases previous held input');
} finally {
 await browser.close();clearInterval(reader);fs.closeSync(fd);
}
