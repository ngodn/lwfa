#!/usr/bin/env node
// Decode real NVENC diagnostic packets through the production FrameDecoder.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import path from 'node:path'

const root=fileURLToPath(new URL('../',import.meta.url))
const packetDir=process.env.LWFA_CODEC_PROBE_DIR
assert(packetDir,'Set LWFA_CODEC_PROBE_DIR to the isolated hardware probe output')
const require=createRequire(path.join(root,'packages/shell/package.json'))
const {build}=await import(require.resolve('vite'))
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright')
const built=await build({
  configFile:false,root:path.join(root,'packages/shell'),logLevel:'error',
  define:{'process.env.NODE_ENV':JSON.stringify('production')},
  resolve:{alias:{'@':path.join(root,'packages/shell/src')}},
  plugins:[{
    name:'codec-packet-fixture',
    resolveId(id){if(id.endsWith('virtual:codec-packet'))return '\0codec-packet'},
    load(id){
      if(id==='\0codec-packet')return `import {FrameDecoder} from '@/decode';import {decodable,codecFromAnnexB} from '@/lib/codecs';window.fixture={FrameDecoder,decodable,codecFromAnnexB};`
    },
  }],
  build:{write:false,minify:false,lib:{entry:'virtual:codec-packet',name:'CodecPacketFixture',formats:['iife']}},
})
const bundle=(Array.isArray(built)?built[0]:built).output.find(item=>item.type==='chunk').code
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Isolated codec packets</title>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let browser
const results={runtime:{node:process.version},browserCodecs:[],cases:[],errors:[]}
try{
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})})
  results.runtime.chromium=browser.version()
  const page=await browser.newPage()
  page.on('pageerror',error=>results.errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.addScriptTag({content:bundle})
  results.browserCodecs=await page.evaluate(()=>fixture.decodable())
  assert(results.browserCodecs.includes('h264'),'This browser must support H.264 for the integration test')
  await page.evaluate(()=>{
    window.runPacket=async({base64,family,width,height,windowId,reset=false})=>{
      const payload=Uint8Array.from(atob(base64),c=>c.charCodeAt(0))
      const codec=fixture.codecFromAnnexB(payload,family)
      const config={codec,codedWidth:width,codedHeight:height,optimizeForLatency:true}
      const support=await VideoDecoder.isConfigSupported(config)
      if(!window.probe||reset){
        window.probe?.decoder.close()
        window.probe={fallbacks:[],frames:[]}
        const p=probe
        p.decoder=new fixture.FrameDecoder((id,bitmap)=>{
          const canvas=new OffscreenCanvas(bitmap.width,bitmap.height)
          const ctx=canvas.getContext('2d',{willReadFrequently:true})
          ctx.drawImage(bitmap,0,0)
          const width=bitmap.width,height=bitmap.height
          const samples=[]
          for(const y of [2,Math.floor(height/4),Math.floor(height*3/4),height-3]){
            for(const x of [2,Math.floor(width/4),Math.floor(width*3/4),width-3]){
              samples.push({x,y,rgb:[...ctx.getImageData(x,y,1,1).data].slice(0,3)})
            }
          }
          p.frames.push({window:id,width:bitmap.width,height:bitmap.height,samples})
          bitmap.close()
        },codec=>p.fallbacks.push(codec))
      }
      const before=probe.frames.length
      await probe.decoder.handle({header:{window:windowId,width,height,format:family==='hevc'?2:1,keyframe:true},payload})
      const started=performance.now()
      while(probe.frames.length===before&&!probe.fallbacks.length&&performance.now()-started<5000){
        await new Promise(resolve=>setTimeout(resolve,20))
      }
      const frame=probe.frames.at(before)||null
      return {codec,config,supported:support.supported,frame,fallbacks:[...probe.fallbacks],elapsedMs:Math.round(performance.now()-started)}
    }
  })
  const dimensions=[[1000,640],[4000,3000],[1000,640],[1192,860],[1490,1075],[1788,1290],[2384,1720],[1001,641],[1192,860]]
  const files=await readdir(packetDir)
  for(const family of ['h264','hevc']){
    const available=files.filter(name=>new RegExp(`^${family}-[0-8]-[02]\\.${family}$`).test(name)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))
    assert.equal(available.length,18,`${family}: expected two keyframes at each of nine sizes`)
    for(const file of available){
      const stage=Number(file.split('-')[1]);const [width,height]=dimensions[stage]
      const base64=(await readFile(path.join(packetDir,file))).toString('base64')
      for(const alignment of (width%2||height%2?['requested','aligned']:['requested'])){
        const w=alignment==='aligned'?Math.ceil(width/2)*2:width,h=alignment==='aligned'?Math.ceil(height/2)*2:height
        const outcome=await page.evaluate(async params=>runPacket(params),{base64,family,width:w,height:h,windowId:1,reset:results.cases.length===0||alignment==='aligned'||family==='hevc'})
        const maxChannelError=outcome.frame?Math.max(...outcome.frame.samples.flatMap(sample=>{
          const quadrant=Number(sample.x>=Math.floor(w/2))+2*Number(sample.y>=Math.floor(h/2))
          return sample.rgb.map(value=>Math.abs(value-[40,100,160,220][quadrant]))
        })):null
        results.cases.push({file,family,stage,alignment,requestedWidth:w,requestedHeight:h,maxChannelError,...outcome})
        if(family==='h264'||outcome.supported){
          assert(outcome.frame,`${file}: supported codec must deliver pixels`)
          assert.deepEqual(outcome.fallbacks,[],`${file}: no fallback for supported configuration`)
          assert.equal(outcome.frame.width,w)
          assert.equal(outcome.frame.height,h)
          assert(maxChannelError<=10,`${file}: quadrants and edges differ by ${maxChannelError}`)
        }else{
          assert.equal(outcome.frame,null,`${file}: unsupported configuration delivers no frame`)
          assert.deepEqual(outcome.fallbacks,[family],`${file}: unsupported configuration requests fallback`)
        }
        console.log(`${file} ${alignment} ${w}x${h}: supported=${outcome.supported}, output=${outcome.frame?.width}x${outcome.frame?.height}, fallback=${outcome.fallbacks.join(',')||'none'}`)
      }
    }
  }
  await page.evaluate(()=>probe?.decoder.close())
  assert.deepEqual(results.errors,[])
}finally{
  const destination=process.env.LWFA_CODEC_BROWSER_RESULTS||path.join(packetDir,'browser-results.json')
  await mkdir(path.dirname(destination),{recursive:true})
  await writeFile(destination,JSON.stringify(results,null,2)+'\n')
  await browser?.close()
  await new Promise(resolve=>server.close(resolve))
}
