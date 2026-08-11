const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const COLORS = { solar:'#f6b526', load:'#357be8', grid:'#20ad70', import:'#f04958', smart:'#f68b22', meta:'#357be8', matrix:'#7657f2' };
let live = null;
let history = { meta: [], matrix: [] };
let activeHours = 24;

function set(id, value) { const el = $(id); if (el) el.textContent = value; }
function finite(v, f=0) { const n = Number(v); return Number.isFinite(n) ? n : f; }
function fmtPower(v) { const n = finite(v); const a = Math.abs(n); return a >= 1000 ? `${(a/1000).toFixed(2)} kW` : `${Math.round(a)} W`; }
function fmtKwh(v) { return `${finite(v).toFixed(2)} kWh`; }
function fmtPct(v) { return v == null || !Number.isFinite(Number(v)) ? '--' : `${Math.round(Number(v))}%`; }
function gridMode(v) { const n = finite(v); return Math.abs(n) < 30 ? 'IDLE' : n >= 0 ? 'IMPORTING' : 'EXPORTING'; }
function ageText(ts) { const s = Math.max(0, Math.round((Date.now()-finite(ts,Date.now()))/1000)); if (s < 5) return 'Updated now'; if (s < 60) return `Updated ${s}s ago`; return `Updated ${Math.floor(s/60)}m ago`; }
function pct(v,max) { return Math.max(0, Math.min(100, Math.abs(finite(v))/max*100)); }
function gauge(id, value, max, mode) { const el=$(id); if(!el)return; el.style.strokeDasharray=`${pct(value,max).toFixed(2)} 100`; el.classList.remove('red','green'); if(mode==='grid') el.classList.add(finite(value)>=0?'red':'green'); }
function clock(){const d=new Date();set('clock',d.toLocaleTimeString('en-GB',{hour12:false}));set('date',d.toLocaleDateString('en-PK',{weekday:'short',day:'2-digit',month:'short'}));}
setInterval(clock,1000);clock();

$$('.navtab').forEach((button)=>button.addEventListener('click',()=>{
  $$('.navtab').forEach((b)=>b.classList.toggle('active',b===button));
  $$('.view').forEach((v)=>v.classList.remove('active'));
  $(button.dataset.view)?.classList.add('active');
  requestAnimationFrame(drawAll);
}));
$$('.rangeButtons button').forEach((button)=>button.addEventListener('click',()=>{
  $$('.rangeButtons button').forEach((b)=>b.classList.toggle('active',b===button));
  activeHours=Number(button.dataset.hours)||24;
  loadHistory(activeHours);
}));

async function loadLive(){
  try{
    const response=await fetch('/api/master/live',{cache:'no-store'});
    live=await response.json();
    render();
    set('liveChip',live.complete?'● LIVE':'● PARTIAL');
    $('liveChip')?.classList.toggle('live',Boolean(live.ok));
  }catch(error){set('liveChip','● ERROR');}
}
async function loadHistory(hours=24){
  try{const response=await fetch(`/api/master/history?hours=${hours}`,{cache:'no-store'});history=await response.json();drawAll();}catch(_error){}
}
async function loadWeather(){
  try{const r=await fetch('/api/master/weather',{cache:'no-store'});const w=await r.json();const d=w.data||{};const t=d.temperature??d.temperature_2m??d.current?.temperature_2m;if(Number.isFinite(Number(t)))set('weather',`☁ ${Math.round(Number(t))}° Gujrat`);}catch(_error){}
}

function render(){
  if(!live)return;
  const s=live.systems||{}; const m=s.meta; const x=s.matrix; const c=s.combined||{};
  renderStatus(m,x,c);
  renderMeta(m);
  renderMatrix(x);
  renderCombined(c,m,x);
  renderTotals(c,m,x);
  renderDetailPages(m,x,c);
  renderHealth(m,x,c,live.errors||{});
  drawAll();
}
function renderStatus(m,x,c){
  const count=[m,x].filter(Boolean).length;
  set('systemsOnline',`${count}/2`);
  set('metaOnline',m?'ONLINE':'OFFLINE'); set('metaPageStatus',m?'ONLINE':'OFFLINE');
  set('matrixOnline',x?'ONLINE':'OFFLINE'); set('matrixPageStatus',x?'ONLINE':'OFFLINE');
  set('combinedPageStatus',count===2?'ALL SYSTEMS LIVE':'PARTIAL DATA');
  ['metaOnline','metaPageStatus'].forEach(id=>$(id)?.classList.toggle('online',Boolean(m)));
  ['matrixOnline','matrixPageStatus'].forEach(id=>$(id)?.classList.toggle('online',Boolean(x)));
  if(m){set('metaFresh',ageText(m.updatedAt));} else set('metaFresh','API unavailable');
  if(x){set('matrixFresh',ageText(x.updatedAt));} else set('matrixFresh','API unavailable');
  const notice=[]; if(live.errors?.meta)notice.push(`Meta: ${live.errors.meta}`); if(live.errors?.matrix)notice.push(`Matrix: ${live.errors.matrix}`);
  const n=$('masterNotice'); if(n){n.hidden=!notice.length;n.textContent=notice.join(' • ');}
}
function renderMeta(m){
  if(!m){['metaSolarHero','metaPvSplit','metaLoadGaugeText','metaSolarGaugeText','metaGridGaugeText','metaGridMode','metaGridV','metaTodaySolar','metaTemp'].forEach(id=>set(id,'--'));return;}
  set('metaSolarHero',fmtPower(m.solarW)); set('metaPvSplit',`PV1 ${fmtPower(m.pv1W)} • PV2 ${fmtPower(m.pv2W)}`);
  set('metaLoadGaugeText',fmtPower(m.loadW)); set('metaSolarGaugeText',fmtPower(m.solarW)); set('metaGridGaugeText',fmtPower(m.gridW));
  set('metaGridMode',gridMode(m.gridW)); set('metaGridV',`${finite(m.gridV).toFixed(1)} V`); set('metaTodaySolar',fmtKwh(m.todaySolar)); set('metaTemp',`${Math.round(finite(m.temp))}°C`);
  gauge('metaLoadGauge',m.loadW,6000); gauge('metaSolarGauge',m.solarW,6780); gauge('metaGridGauge',m.gridW,6000,'grid');
}
function renderMatrix(x){
  if(!x){['matrixSolarHero','matrixPvSplit','matrixLoadGaugeText','matrixSolarGaugeText','matrixGridGaugeText','matrixGridMode','matrixGridV','matrixSmartGaugeText','matrixBattery','matrixTemp','matrixTodaySolar'].forEach(id=>set(id,'--'));return;}
  set('matrixSolarHero',fmtPower(x.solarW)); set('matrixPvSplit',`PV1 ${fmtPower(x.pv1W)} • PV2 ${fmtPower(x.pv2W)}`);
  set('matrixLoadGaugeText',fmtPower(x.loadW)); set('matrixSolarGaugeText',fmtPower(x.solarW)); set('matrixGridGaugeText',fmtPower(x.gridW)); set('matrixGridMode',gridMode(x.gridW)); set('matrixGridV',`${finite(x.gridV).toFixed(1)} V`);
  set('matrixSmartGaugeText',fmtPower(x.smartLoadW)); set('matrixBattery',`${fmtPct(x.batteryPct)} · ${fmtPower(x.batteryW)}`); set('matrixTemp',`${Math.round(finite(x.transformer||x.temp))}°C`); set('matrixTodaySolar',fmtKwh(x.todaySolar));
  gauge('matrixLoadGauge',x.loadW,6000); gauge('matrixSolarGauge',x.solarW,4360); gauge('matrixGridGauge',x.gridW,6000,'grid'); gauge('matrixSmartGauge',x.smartLoadW,6000);
}
function renderCombined(c,m,x){
  set('combinedSolarHero',fmtPower(c.solarW)); set('combinedDemandHero',fmtPower(c.siteDemandW)); set('combinedNet',fmtPower(c.gridW)); set('combinedMode',gridMode(c.gridW));
  set('combinedSolarGaugeText',fmtPower(c.solarW)); set('combinedLoadGaugeText',fmtPower(c.siteDemandW)); set('combinedGridGaugeText',fmtPower(c.gridW)); set('combinedGridMode',gridMode(c.gridW)); set('combinedSmartGaugeText',fmtPower(c.smartLoadW));
  gauge('combinedSolarGauge',c.solarW,11140); gauge('combinedLoadGauge',c.siteDemandW,12000); gauge('combinedGridGauge',c.gridW,12000,'grid'); gauge('combinedSmartGauge',c.smartLoadW,6000);
  const total=finite(c.solarW); set('metaShare',total>0?`${Math.round(finite(m?.solarW)/total*100)}%`:'--%'); set('matrixShare',total>0?`${Math.round(finite(x?.solarW)/total*100)}%`:'--%');
  set('masterBattery',x?.batteryPct!=null?`${Math.round(x.batteryPct)}%`:'--'); set('masterHealth',(m&&x)?'Excellent · 100/100':'Partial');
}
function renderTotals(c,m,x){
  set('todaySolar',fmtKwh(c.todaySolar));set('todayLoad',fmtKwh(c.todayLoad));set('todayImport',fmtKwh(c.todayImport));set('todayExport',fmtKwh(c.todayExport));
  set('totSolar',fmtKwh(c.todaySolar));set('totLoad',fmtKwh(c.todayLoad));set('totImport',fmtKwh(c.todayImport));set('totExport',fmtKwh(c.todayExport));
  const value=Math.round(finite(c.todaySolar)*finite(live.rate,60)); set('solarValue',`PKR ${value.toLocaleString()}`);set('solarValueBig',value.toLocaleString());set('rateValue',`PKR ${finite(live.rate,60).toFixed(2)}/kWh`);set('totMetaSolar',fmtKwh(m?.todaySolar));set('totMatrixSolar',fmtKwh(x?.todaySolar));
}
function metricCards(items){return items.map(([label,value,sub])=>`<div class="detailCard"><span>${label}</span><b>${value}</b><small>${sub||''}</small></div>`).join('');}
function renderDetailPages(m,x,c){
  $('metaPage').innerHTML=metricCards(m?[
    ['Solar PV',fmtPower(m.solarW),'PV input'],['House load',fmtPower(m.loadW),'Normal load'],['Grid',fmtPower(m.gridW),gridMode(m.gridW)],['Grid voltage',`${finite(m.gridV).toFixed(1)} V`,`${finite(m.gridHz).toFixed(2)} Hz`],
    ['PV1',fmtPower(m.pv1W),`${finite(m.pv1V).toFixed(1)} V • ${finite(m.pv1A).toFixed(1)} A`],['PV2',fmtPower(m.pv2W),`${finite(m.pv2V).toFixed(1)} V • ${finite(m.pv2A).toFixed(1)} A`],['AC output',fmtPower(m.acOutW),'6,000 W capacity'],['Temperature',`${Math.round(finite(m.temp))}°C`,'MPPT / inverter'],
    ['Today solar',fmtKwh(m.todaySolar),'Production'],['Today load',fmtKwh(m.todayLoad),'Consumption'],['Grid import',fmtKwh(m.todayImport),'Today'],['Grid export',fmtKwh(m.todayExport),'Today']
  ]:[['Connection','OFFLINE','Set Meta dashboard auth in Render']]);
  $('matrixPage').innerHTML=metricCards(x?[
    ['Solar PV',fmtPower(x.solarW),'PV input'],['House load',fmtPower(x.loadW),'Normal load'],['Grid',fmtPower(x.gridW),gridMode(x.gridW)],['Grid voltage',`${finite(x.gridV).toFixed(1)} V`,`${finite(x.gridHz).toFixed(2)} Hz`],
    ['PV1',fmtPower(x.pv1W),`${finite(x.pv1V).toFixed(1)} V • ${finite(x.pv1A).toFixed(1)} A`],['PV2',fmtPower(x.pv2W),`${finite(x.pv2V).toFixed(1)} V • ${finite(x.pv2A).toFixed(1)} A`],['Battery',fmtPct(x.batteryPct),`${fmtPower(x.batteryW)} • ${x.batteryMode||'--'}`],['Smart load',fmtPower(x.smartLoadW),'AC / Motor heavy load'],
    ['Transformer',`${Math.round(finite(x.transformer))}°C`,'Temperature'],['Radiator',`${Math.round(finite(x.radiator))}°C`,'Temperature'],['Today solar',fmtKwh(x.todaySolar),'Production'],['Today load',fmtKwh(x.todayLoad),'Consumption']
  ]:[['Connection','OFFLINE','Matrix API unavailable']]);
  $('combinedPage').innerHTML=metricCards([
    ['Total solar',fmtPower(c.solarW),'Meta + Matrix'],['Site demand',fmtPower(c.siteDemandW),'Normal + Smart Load'],['Grid exchange',fmtPower(c.gridW),gridMode(c.gridW)],['Smart load',fmtPower(c.smartLoadW),'Matrix AC / Motor'],
    ['Today solar',fmtKwh(c.todaySolar),'Combined'],['Today load',fmtKwh(c.todayLoad),'Combined'],['Grid import',fmtKwh(c.todayImport),'Combined today'],['Grid export',fmtKwh(c.todayExport),'Combined today'],
    ['Meta share',m&&c.solarW?`${Math.round(m.solarW/c.solarW*100)}%`:'--','Live solar share'],['Matrix share',x&&c.solarW?`${Math.round(x.solarW/c.solarW*100)}%`:'--','Live solar share'],['Battery',x?.batteryPct!=null?`${Math.round(x.batteryPct)}%`:'--','Matrix battery'],['Health',(m&&x)?'Excellent':'Partial','Connected systems']
  ]);
}
function healthRows(rows){return rows.map(([k,v,ok])=>`<div class="healthRow"><span>${k}</span><b class="${ok===false?'badText':'okText'}">${v}</b></div>`).join('');}
function renderHealth(m,x,c,errors){
  $('metaHealth').innerHTML=healthRows([['API connection',m?'ONLINE':'OFFLINE',Boolean(m)],['Last update',m?ageText(m.updatedAt):'--',Boolean(m)],['Grid status',m?gridMode(m.gridW):'--',Boolean(m)],['Health',m?'Excellent':'Needs attention',Boolean(m)]]);
  $('matrixHealth').innerHTML=healthRows([['API connection',x?'ONLINE':'OFFLINE',Boolean(x)],['Last update',x?ageText(x.updatedAt):'--',Boolean(x)],['Battery',x?fmtPct(x.batteryPct):'--',Boolean(x)],['Smart load',x?fmtPower(x.smartLoadW):'--',Boolean(x)]]);
  $('combinedHealth').innerHTML=healthRows([['Connected systems',`${[m,x].filter(Boolean).length}/2`,Boolean(m&&x)],['Total solar',fmtPower(c.solarW),Boolean(m||x)],['Grid',gridMode(c.gridW),Boolean(m||x)],['Overall',(m&&x)?'Excellent':'Degraded',Boolean(m&&x)]]);
  set('healthPill',(m&&x)?'ALL NORMAL':'ATTENTION'); $('healthPill')?.classList.toggle('good',Boolean(m&&x));
  const messages=[];if(errors.meta)messages.push(`Meta: ${errors.meta}`);if(errors.matrix)messages.push(`Matrix: ${errors.matrix}`);set('diagnosticNotice',messages.length?messages.join(' • '):'✓ Both upstream systems are connected and returning data.');
  set('alertCount',messages.length);
}

function histFor(kind){return Array.isArray(history?.[kind])?history[kind]:[];}
function mergeHistory(){
  const map=new Map();
  for(const [kind,arr] of [['meta',histFor('meta')],['matrix',histFor('matrix')]])for(const p of arr){
    const t=Math.round(finite(p.timestamp,Date.now())/60000)*60000;
    const o=map.get(t)||{timestamp:t,solarW:0,loadW:0,gridW:0,smartLoadW:0,metaSolarW:0,matrixSolarW:0};
    o.solarW+=finite(p.solarW);o.loadW+=finite(p.loadW);o.gridW+=finite(p.gridW);o.smartLoadW+=finite(p.smartLoadW);if(kind==='meta')o.metaSolarW+=finite(p.solarW);else o.matrixSolarW+=finite(p.solarW);map.set(t,o);
  }
  return [...map.values()].sort((a,b)=>a.timestamp-b.timestamp).slice(-800);
}
function canvasSize(canvas){const r=canvas.getBoundingClientRect();const dpr=window.devicePixelRatio||1;canvas.width=Math.max(1,Math.round(r.width*dpr));canvas.height=Math.max(1,Math.round(r.height*dpr));const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);return {ctx,w:r.width,h:r.height};}
function drawLineChart(id,series,{signed=false}={}){
  const canvas=$(id);if(!canvas)return;const {ctx,w,h}=canvasSize(canvas);ctx.clearRect(0,0,w,h);const pad={l:42,r:16,t:15,b:26};const values=series.flatMap(s=>s.data.map(p=>finite(p.v)));if(!values.length){ctx.fillStyle='#7893a5';ctx.font='12px Segoe UI';ctx.fillText('History will appear as samples are collected.',pad.l,h/2);return;}
  const maxAbs=Math.max(1000,...values.map(Math.abs))*1.12;const min=signed?-maxAbs:0,max=maxAbs;const y=(v)=>pad.t+(max-finite(v))/(max-min)*(h-pad.t-pad.b);const x=(i,n)=>pad.l+(n<=1?0:i/(n-1))*(w-pad.l-pad.r);
  ctx.strokeStyle='#dce9ef';ctx.lineWidth=1;for(let i=0;i<5;i++){const yy=pad.t+i*(h-pad.t-pad.b)/4;ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(w-pad.r,yy);ctx.stroke();}
  if(signed){ctx.strokeStyle='#b7ceda';ctx.beginPath();ctx.moveTo(pad.l,y(0));ctx.lineTo(w-pad.r,y(0));ctx.stroke();}
  for(const s of series){if(!s.data.length)continue;ctx.strokeStyle=s.color;ctx.lineWidth=2;ctx.beginPath();s.data.forEach((p,i)=>{const xx=x(i,s.data.length),yy=y(p.v);i?ctx.lineTo(xx,yy):ctx.moveTo(xx,yy)});ctx.stroke();}
}
function drawBars(){const c=$('barChart');if(!c||!live)return;const {ctx,w,h}=canvasSize(c);ctx.clearRect(0,0,w,h);const d=live.systems?.combined||{};const vals=[['Solar',finite(d.todaySolar),COLORS.solar],['Load',finite(d.todayLoad),COLORS.load],['Import',finite(d.todayImport),COLORS.import],['Export',finite(d.todayExport),COLORS.grid]];const max=Math.max(1,...vals.map(v=>v[1]));const gap=w/vals.length;vals.forEach((v,i)=>{const bw=Math.min(70,gap*.35);const bh=(h-90)*(v[1]/max);const xx=gap*i+gap/2-bw/2;ctx.fillStyle=v[2];ctx.fillRect(xx,h-42-bh,bw,bh);ctx.fillStyle='#062b46';ctx.font='700 12px Segoe UI';ctx.fillText(`${v[1].toFixed(2)} kWh`,xx-5,h-52-bh);ctx.fillStyle='#7893a5';ctx.fillText(v[0],xx+4,h-18);});}
function drawAll(){
  const m=histFor('meta'),x=histFor('matrix'),c=mergeHistory();
  const combinedSeries=[{color:COLORS.solar,data:c.map(p=>({v:p.solarW}))},{color:COLORS.load,data:c.map(p=>({v:p.loadW+p.smartLoadW}))},{color:COLORS.grid,data:c.map(p=>({v:-p.gridW}))},{color:COLORS.smart,data:c.map(p=>({v:p.smartLoadW}))}];
  drawLineChart('overviewChart',combinedSeries,{signed:true}); drawLineChart('combinedChart',combinedSeries,{signed:true}); drawLineChart('fullChart',combinedSeries,{signed:true});
  drawLineChart('systemSplitChart',[{color:COLORS.meta,data:c.map(p=>({v:p.metaSolarW}))},{color:COLORS.matrix,data:c.map(p=>({v:p.matrixSolarW}))}]);
  const metaSeries=[{color:COLORS.solar,data:m.map(p=>({v:p.solarW}))},{color:COLORS.load,data:m.map(p=>({v:p.loadW}))},{color:COLORS.grid,data:m.map(p=>({v:-p.gridW}))}];
  const matrixSeries=[{color:COLORS.solar,data:x.map(p=>({v:p.solarW}))},{color:COLORS.load,data:x.map(p=>({v:p.loadW}))},{color:COLORS.grid,data:x.map(p=>({v:-p.gridW}))},{color:COLORS.smart,data:x.map(p=>({v:p.smartLoadW}))}];
  drawLineChart('metaChart',metaSeries,{signed:true});drawLineChart('fullMetaChart',metaSeries,{signed:true});drawLineChart('matrixChart',matrixSeries,{signed:true});drawLineChart('fullMatrixChart',matrixSeries,{signed:true});
  drawLineChart('metaPvChart',[{color:COLORS.solar,data:m.map(p=>({v:p.pv1W}))},{color:COLORS.matrix,data:m.map(p=>({v:p.pv2W}))}]);
  drawLineChart('matrixPvChart',[{color:COLORS.solar,data:x.map(p=>({v:p.pv1W}))},{color:COLORS.matrix,data:x.map(p=>({v:p.pv2W}))}]); drawBars();
}

async function start(){await Promise.allSettled([loadLive(),loadHistory(activeHours),loadWeather()]);setInterval(loadLive,10000);setInterval(()=>loadHistory(activeHours),60000);setInterval(loadWeather,600000);}
window.addEventListener('resize',()=>requestAnimationFrame(drawAll));
start();
