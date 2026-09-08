// Explicit-mode intent and native following, using two Wine processes in each
// disposable prefix. Requires an explicitly owned loopback compositor and private
// runtime; does not modify an installed runtime or existing game prefix.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { waitForOpen } from './websocket-open.mjs';
assert.equal(process.env.LWFA_ISOLATED_TEST, '1');
for (const key of ['LWFA_TEST_URL','AUTH_PASS','LWFA_TEST_ENGINE_PID','LWFA_TEST_DISPLAY','PROTON_DIR','ZIG']) assert(process.env[key], `${key} required`);
assert.equal((await readFile(`/proc/${Number(process.env.LWFA_TEST_ENGINE_PID)}/comm`, 'utf8')).trim(),'lwfa-engine');
assert(isAbsolute(process.env.PROTON_DIR) && isAbsolute(process.env.ZIG));
for(const key of ['WINE_CANVAS_FOLLOW_HOST','WINE_CANVAS_DPI_SAFE']) assert.equal(process.env[key],'1',`${key}=1 required`);
const endpoint=new URL(process.env.LWFA_TEST_URL);
assert(['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname));
endpoint.protocol=endpoint.protocol==='https:'?'wss:':'ws:';endpoint.searchParams.set('token',process.env.AUTH_PASS);
const resultDir=resolve(process.env.LWFA_TEST_RESULTS_DIR||'target/proton-modes');await mkdir(resultDir,{recursive:true});
const temporary=await mkdtemp(join(tmpdir(),'lwfa-proton-modes-'));
const wine=join(process.env.PROTON_DIR,'files/bin/wine'),server=join(process.env.PROTON_DIR,'files/bin/wineserver');
const env={...process.env,DISPLAY:process.env.LWFA_TEST_DISPLAY,WAYLAND_DISPLAY:'',WINEDEBUG:'-all',WINEDLLOVERRIDES:'mscoree,mshtml=',WINEESYNC:'0',WINEFSYNC:'0'};delete env.LD_PRELOAD;
const report={date:new Date().toISOString(),runtime:process.env.PROTON_DIR,flags:{followHost:1,dpiSafe:1},scenarios:[],failures:[]};
const delay=ms=>new Promise(r=>setTimeout(r,ms));let socket,serial=0;
function run(binary,args,environment=env){const r=spawnSync(binary,args,{env:environment,encoding:'utf8',timeout:120000});assert(!r.error,r.error?.message);assert.equal(r.status,0,r.stderr);return r.stdout;}
async function until(test,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await test())return;await delay(50);}throw Error(`Timed out: ${label}`);}
function start(prefix,name){const child=spawn(wine,[join(temporary,'modes.exe')],{env:{...env,WINEPREFIX:prefix},stdio:['pipe','pipe','pipe']});const p={child,name,records:[],log:'',error:null,closed:false};let pending='';child.stdout.on('data',b=>{p.log+=b;pending+=b;const lines=pending.split('\n');pending=lines.pop();for(const l of lines){if(l.startsWith('{')){try{p.records.push(JSON.parse(l));}catch(e){p.error=e;}}}});child.stderr.on('data',b=>p.log+=b);child.on('error',e=>p.error=e);child.on('close',()=>p.closed=true);return p;}
async function command(p,text){assert(!p.closed && !p.error,`${p.name} exited: ${p.log}`);const n=++serial;p.child.stdin.write(`${text.split(' ')[0]} ${n} ${text.split(' ').slice(1).join(' ')}\n`);await until(()=>{assert(!p.closed && !p.error,`${p.name} exited: ${p.log}`);return p.records.some(r=>r.serial===n);},`${p.name} ${text}`);return p.records.find(r=>r.serial===n);}
function screen(){const m=/current (\d+) x (\d+)/.exec(run('xrandr',['--current']));assert(m);return [+m[1],+m[2]];}
function check(record,size){assert.equal(record.changeResult,0,'CDS succeeds');assert.deepEqual(record.monitor,size,'Monitor bounds match virtual mode');assert(record.modes.slice(0,2).every(m=>m.ok),'Current and registry display queries succeed');assert.deepEqual(record.modes[0].size,size,'Current virtual mode');assert(record.dpi.every(d=>d.result===0 && d.x>0 && d.y>0 && d.x<65536 && d.y<65536),'Every DPI query succeeds with bounded values');}
try{
 run(process.env.ZIG,['cc','-std=c11','-Wall','-Wextra','-target','x86_64-windows-gnu','scripts/fixtures/proton-display-modes.c','-o',join(temporary,'modes.exe'),'-luser32'],process.env);
 socket=new WebSocket(endpoint);let hello=false;const errors=[];socket.onmessage=({data})=>{if(typeof data!=='string')return;const m=JSON.parse(data);if(m.type==='hello'){assert.equal(m.protocolVersion,2);hello=true;}if(m.type==='error')errors.push(m);};await waitForOpen(socket);await until(()=>hello,'engine hello');
 async function viewport(size){socket.send(JSON.stringify({type:'setViewport',width:size[0],height:size[1],scale:1}));await until(()=>JSON.stringify(screen())===JSON.stringify(size),'native monitor resize');await delay(300);}
 for(const scenario of ['explicit-mode','native-follow','custom-clip']){
  const result={name:scenario,steps:[],passed:false};report.scenarios.push(result);
  const prefix=join(temporary,scenario);await mkdir(prefix);const processes=[];
  try{
   await viewport([1324,838]);
   for(const name of ['controller','observer']){const p=start(prefix,name);processes.push(p);await until(()=>{assert(!p.closed&&!p.error,p.log);return p.log.includes('READY');},`${name} ready`,60000);}
   async function sample(phase,size){const step={phase,native:screen(),processes:[]};result.steps.push(step);for(const p of processes){const r=await command(p,'sample');step.processes.push({name:p.name,...r});}for(const r of step.processes)check(r,size);assert.deepEqual(errors,[]);return step;}
   await sample('initial',[1324,838]);
   if(scenario==='explicit-mode'){
    const changed=await command(processes[0],'mode 1280 720');result.steps.push({phase:'request-1280x720',record:changed});check(changed,[1280,720]);
    await sample('explicit-before-convergence',[1280,720]);
    await viewport([1280,720]);await sample('host-converges-to-explicit',[1280,720]);
    await viewport([1490,910]);await sample('host-leaves-explicit',[1280,720]);
    const reset=await command(processes[0],'reset');result.steps.push({phase:'reset-to-native',record:reset});await delay(500);await sample('observer-after-reset',[1490,910]);check(reset,[1490,910]);
   }else if(scenario==='native-follow'){await viewport([838,1324]);await sample('portrait',[838,1324]);}
   else {
    const failures=[];
    const bounds=[100,80,900,600];
    const changed=await command(processes[0],'mode 1280 720');
    result.steps.push({phase:'explicit-before-clip',record:changed});check(changed,[1280,720]);
    const clipped=await command(processes[0],'clip');
    result.steps.push({phase:'set-custom-clip',record:clipped});check(clipped,[1280,720]);
    async function inspectClip(phase,expected){
     const step=await sample(phase,[1280,720]);step.expectedClip=expected;step.roundingTolerance=1;
     for(const process of step.processes){
      const ok=process.clip?.ok && process.clip.rect.every((value,index)=>Math.abs(value-expected[index])<=1);
      if(!ok)failures.push({phase,process:process.name,expected,actual:process.clip});
     }
    }
    await inspectClip('custom-clip-initial',bounds);
    await viewport([1490,910]);await inspectClip('custom-clip-growth',bounds);
    await viewport([838,1324]);await inspectClip('custom-clip-portrait',bounds);
    const released=await command(processes[0],'unclip');
    result.steps.push({phase:'release-clip',record:released});check(released,[1280,720]);
    await inspectClip('released-to-full',[0,0,1280,720]);
    result.clipFailures=failures;assert.deepEqual(failures,[],'Custom virtual clip survives physical resizing and release restores full virtual screen');
   }
   result.passed=true;
  }catch(e){result.error=e.message;report.failures.push({scenario,error:e.message});}
  finally{for(const p of processes){if(!p.closed)p.child.stdin.write('quit\n');await writeFile(join(resultDir,`${scenario}-${p.name}.log`),p.log.replaceAll(process.env.AUTH_PASS,'<redacted>'));}run(server,['-k'],{...env,WINEPREFIX:prefix});run(server,['-w'],{...env,WINEPREFIX:prefix});for(const p of processes)if(!p.closed)p.child.kill('SIGKILL');}
 }
 report.passed=report.failures.length===0;if(!report.passed)process.exitCode=1;
}catch(e){report.passed=false;report.failures.push({error:e.message});process.exitCode=1;}
finally{socket?.close();await writeFile(join(resultDir,'results.json'),JSON.stringify(report,null,2)+'\n');await rm(temporary,{recursive:true,force:true});console.log(JSON.stringify(report));}
