import http from 'node:http';
import { pathToFileURL } from 'node:url';

const upstream = 'https://raja-tech-ai.nalrajhi-9480.chatgpt.site';
const routes = new Set(['/', '/api/market', '/styles.css', '/app.js', '/robots.txt', '/sitemap.xml', '/solar-panel-price-pakistan', '/solar-inverter-price-pakistan', '/solar-battery-price-pakistan', ...['gujrat','lahore','karachi','islamabad','faisalabad'].map(c=>'/solar-panel-price/'+c)]);
export function allowedPath(path) {
 return routes.has(path) || /^\/assets\/[a-zA-Z0-9_-]+\.(?:webp|jpe?g|png|svg|ttf|woff2?)$/.test(path);
}
export function rewritePublicUrls(text, origin) { return text.split(upstream).join(origin); }
export function createServer({fetcher=fetch, publicOrigin=process.env.RENDER_EXTERNAL_URL||process.env.PUBLIC_ORIGIN}={}) {
 const origin=publicOrigin ? new URL(publicOrigin).origin : 'http://localhost:10000';
 return http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;}
  if((req.url||'').length>2048){res.writeHead(414);res.end();return;}
  const url=new URL(req.url||'/',origin);
  if(url.pathname==='/healthz'){res.writeHead(200,{'Content-Type':'text/plain'});res.end(req.method==='HEAD'?undefined:'ok');return;}
  if(!allowedPath(url.pathname)){res.writeHead(404,{'Content-Type':'text/plain'});res.end('Page not found');return;}
  const target=new URL(url.pathname,upstream);
  if(url.searchParams.has('page')){
   const n=Number(url.searchParams.get('page'));
   if(Number.isInteger(n)&&n>0&&n<=1000)target.searchParams.set('page',String(n));
  }
  try {
   const response=await fetcher(target,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(25000),headers:{Accept:'*/*','X-Raja-Public-Gateway':'1'}});
   if(response.status>=300&&response.status<400)throw new Error('Unexpected upstream redirect');
   const type=response.headers.get('content-type')||'application/octet-stream';
   const bytes=Buffer.from(await response.arrayBuffer());
   const textual=/text\/|json|javascript|xml|svg/.test(type);
   const body=textual?Buffer.from(rewritePublicUrls(bytes.toString('utf8'),origin)):bytes;
   res.writeHead(response.status,{'Content-Type':type,'Cache-Control':response.ok?(url.pathname.startsWith('/assets/')?'public, max-age=86400':'public, max-age=300'):'no-store','Content-Length':body.length});
   res.end(req.method==='HEAD'?undefined:body);
  } catch {
   const body='<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RAJA TECH AI</title><body style="font-family:system-ui;max-width:700px;margin:15vh auto;padding:24px"><h1>RAJA TECH AI</h1><p>Our website is temporarily unavailable. Please try again shortly.</p><p><a href="mailto:rajafraz1992@gmail.com">rajafraz1992@gmail.com</a></p></body></html>';
   res.writeHead(503,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Retry-After':'30'});
   res.end(req.method==='HEAD'?undefined:body);
  }
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const server=createServer();server.listen(Number(process.env.PORT||10000),'0.0.0.0',()=>console.log('RAJA TECH AI public site ready'));
 process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
}
