import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const origin = 'https://raja-energy-studio.onrender.com';
const routes = new Map([['/api/overview', 4000], ['/api/history', 30000]]);
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpeg':'image/jpeg','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8'};
const headers = {
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

// Narrow, read-only proxy. No user-supplied host, inverter controls or credentials.
export function createApp({fetcher = fetch, now = Date.now} = {}) {
  const cache = new Map(), pending = new Map();
  async function upstream(route) {
    const old = cache.get(route);
    if (old && now() - old.at < routes.get(route)) return old.body;
    if (pending.has(route)) return pending.get(route);
    const promise = (async () => {
      const response = await fetcher(origin + route, {signal:AbortSignal.timeout(25000), headers:{Accept:'application/json'}});
      if (!response.ok) throw new Error('Upstream unavailable');
      const text = await response.text();
      if (text.length > 6_000_000) throw new Error('Oversized response');
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid response');
      const body = route === '/api/overview' ? JSON.stringify({
        version:data.version,serverTime:data.serverTime,timezone:data.timezone,
        solar:data.solar,battery:data.battery,energy:data.energy,
      }) : JSON.stringify({pv14000:data.pv14000,pv9000:data.pv9000});
      cache.set(route,{at:now(),body});
      return body;
    })().finally(()=>pending.delete(route));
    pending.set(route,promise);
    return promise;
  }
  return http.createServer(async(req,res)=>{
    for (const [k,v] of Object.entries(headers)) res.setHeader(k,v);
    if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405,{Allow:'GET, HEAD'});return res.end();}
    let url;
    try {url=new URL(req.url,'http://localhost');}catch{res.writeHead(400);return res.end();}
    if (url.pathname === '/healthz') {res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"status":"ok"}');}
    if (routes.has(url.pathname)) {
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
      try {const body=await upstream(url.pathname);res.writeHead(200);return res.end(req.method==='HEAD'?undefined:body);}
      catch {res.writeHead(502);return res.end('{"error":"Solar feed temporarily unavailable. Retrying automatically."}');}
    }
    let pathname;
    try {pathname=decodeURIComponent(url.pathname);} catch {res.writeHead(400);return res.end();}
    if (pathname.includes('\0') || pathname.split('/').some(p=>p.startsWith('.'))) {res.writeHead(404);return res.end();}
    if (pathname === '/') pathname='/index.html';
    const filename=path.resolve(root,'.'+pathname);
    if (!filename.startsWith(root) || !types[path.extname(filename)]) {res.writeHead(404);return res.end();}
    try {
      const body=await readFile(filename);
      res.writeHead(200,{'Content-Type':types[path.extname(filename)],'Cache-Control':pathname.includes('/vendor/')?'public, max-age=86400':'no-cache'});
      res.end(req.method==='HEAD'?undefined:body);
    } catch {res.writeHead(404);res.end('Not found');}
  });
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const portArg=process.argv.indexOf('--port');
  const app=createApp();const port=Number(process.env.PORT)||Number(portArg>=0?process.argv[portArg+1]:0)||3000;
  app.listen(port,'0.0.0.0',()=>console.log(`Raja Solar Power Flow listening on ${port}`));
  process.on('SIGTERM',()=>app.close(()=>process.exit(0)));
}
