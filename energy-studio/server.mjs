import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {solarReading,batteryReading,energyReading,totals,cleanHistory,isFresh} from './lib/telemetry.mjs';
const ROOT=path.join(path.dirname(fileURLToPath(import.meta.url)),'public');
const SOLAR=(process.env.SOLAR_API_BASE||'https://inverterzone-dashboard.onrender.com').replace(/\/$/,'');
const MATRIX=(process.env.MATRIX_API_BASE||'https://fronus-matrix-dashboard.onrender.com').replace(/\/$/,'');
const expected=process.env.MATRIX_BATTERY_DEVICE_SN||'221101401';
const paths={pv14000:'/pv14000/api',pv9000:'/api'};
const states={};
const cache={solar:{},battery:null,energy:{},history:{pv14000:[],pv9000:[]}};
const definitions={};
for(const id of Object.keys(paths)){
  definitions[id]={url:`${SOLAR}${paths[id]}/live?fresh=1`,every:5000,read:j=>cache.solar[id]=solarReading(j,id)};
  definitions[`${id}Energy`]={url:`${SOLAR}${paths[id]}/energy?period=T`,every:60000,read:j=>cache.energy[id]=energyReading(j)};
  definitions[`${id}History`]={url:`${SOLAR}${paths[id]}/history?hours=24`,every:60000,read:j=>cache.history[id]=cleanHistory(j)};
}
definitions.matrix={url:`${MATRIX}/api/battery`,every:5000,read:j=>cache.battery=batteryReading(j,expected)};
async function collect(key){
  const config=definitions[key],s=states[key]??={pending:null,attempt:0,next:0,error:null};
  if(s.pending||Date.now()<s.next)return s.pending;
  s.attempt++;
  s.pending=(async()=>{try{
    const response=await fetch(config.url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(45000)});
    if(!response.ok){const e=new Error(`Source HTTP ${response.status}`);e.status=response.status;e.retry=Number(response.headers.get('retry-after'));throw e;}
    config.read(await response.json());s.error=null;s.next=Date.now()+config.every;s.attempt=0;
  }catch(e){s.error=e.status===429?'rate_limited':e.status===404&&key==='matrix'?'connection_pending':'unavailable';s.next=Date.now()+(e.status===429?Math.max(60000,(e.retry||60)*1000):Math.min(120000,15000*2**Math.min(s.attempt-1,3)));}
  finally{s.pending=null;}})();
  return s.pending;
}
function refresh(){for(const key of Object.keys(definitions))collect(key);}
function snapshot(){
  const now=Date.now(),solar={};
  for(const id of Object.keys(paths)){
    const r=cache.solar[id],state=states[id];
    solar[id]=r?{...r,status:state?.error||!isFresh(r.timestamp,now,180000)?'stale':r.status}:{id,status:state?.error||'connecting'};
  }
  const b=cache.battery,ms=states.matrix;
  const battery=b?{...b,status:ms?.error||!isFresh(b.timestamp,now,900000)?'stale':b.status}:{id:'matrix',scope:'battery_only',status:ms?.error||'connecting'};
  return {version:'1.0.0',serverTime:now,timezone:'Asia/Karachi',solar,battery,energy:cache.energy,totals:totals(solar,cache.energy,now),
    sources:Object.fromEntries(Object.entries(states).map(([k,s])=>[k,{state:s.error||(s.pending?'refreshing':'ready'),retryAt:s.next}]))};
}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.jpeg':'image/jpeg','.json':'application/json'};
const headers={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"};
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');
  const json=(status,data)=>{res.writeHead(status,{...headers,'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(!['GET','HEAD'].includes(req.method))return json(405,{error:'Read-only dashboard'});
  if(u.pathname==='/healthz')return json(200,{ok:true,version:'1.0.0'});
  if(u.pathname==='/api/overview'){refresh();return json(200,snapshot());}
  if(u.pathname==='/api/history'){refresh();return json(200,{...cache.history,serverTime:Date.now()});}
  if(u.pathname==='/robots.txt'){res.writeHead(200,{'Content-Type':'text/plain'});return res.end('User-agent: *\nDisallow: /\n');}
  const map={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css','/mark.svg':'mark.svg','/raja-fraz-logo.jpeg':'raja-fraz-logo.jpeg'};
  if(!map[u.pathname])return json(404,{error:'Not found'});
  try{const content=await readFile(path.join(ROOT,map[u.pathname]));res.writeHead(200,{...headers,'Content-Type':mime[path.extname(map[u.pathname])],'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);}catch{json(500,{error:'Page unavailable'});}
});
const portFlag=process.argv.indexOf('--port');
const port=Number(portFlag>=0?process.argv[portFlag+1]:process.env.PORT)||3000;
server.listen(port,'0.0.0.0',()=>{console.log(`Raja Energy Studio listening on ${port}`);refresh();});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
