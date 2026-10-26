'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const icons=id=>`<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const valid=v=>typeof v==='number'&&Number.isFinite(v);
const fmt=(v,n=1)=>valid(v)?v.toLocaleString('en-US',{minimumFractionDigits:n,maximumFractionDigits:n}):'—';
const kw=v=>valid(v)?fmt(v/1000,2):'—';
const dateFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Karachi',day:'numeric',month:'short',year:'numeric'});
const timeFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Karachi',hour:'2-digit',minute:'2-digit',hour12:false});
const at=t=>valid(t)?timeFormat.format(t):'—';
const readStore=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
const writeStore=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{}};
const state={view:'overview',hours:1,data:null,busy:false,lastFetch:0,lastHistory:0,transportError:false,history:readStore('raja-studio-history-v1',{pv14000:[],pv9000:[]}),batteryHistory:readStore('raja-studio-battery-v1',[])};
const names={pv14000:'PV14000',pv9000:'PV9000'};
const statusLabel=s=>({live:'Live',connecting:'Connecting',connection_pending:'Connection pending',unavailable:'Unavailable',stale:'Reading delayed',device_mismatch:'Device changed',rate_limited:'Retrying'}[s]||'Unavailable');
const age=t=>{if(!valid(t))return 'No device timestamp';const secs=Math.max(0,Math.floor((Date.now()-t)/1000));return secs<60?`${secs}s ago`:secs<3600?`${Math.floor(secs/60)}m ago`:secs<86400?`${Math.floor(secs/3600)}h ago`:`${Math.floor(secs/86400)}d ago`;};
const current=r=>r?.status==='live'&&valid(r.timestamp)&&Date.now()-r.timestamp<180000&&r.timestamp-Date.now()<30000;
const batteryCurrent=b=>b?.status==='live'&&valid(b.timestamp)&&Date.now()-b.timestamp<900000&&b.timestamp-Date.now()<30000;
function metric(label,value,unit,caption=''){return `<article class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(value)}<small>${esc(unit)}</small></div><div class="kpi-footer">${esc(caption)}</div></article>`;}
function row(label,value){return `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;}
function mergeHistory(id,rows){
  const old=Array.isArray(state.history[id])?state.history[id]:[];
  const unique=new Map([...old,...rows].filter(p=>p&&valid(p.timestamp)&&p.timestamp>Date.now()-86400000&&p.timestamp<Date.now()+30000).map(p=>[p.timestamp,p]));
  state.history[id]=[...unique.values()].sort((a,b)=>a.timestamp-b.timestamp).slice(-5000);
}
function addReadings(){
  for(const id of Object.keys(names)){const r=state.data?.solar[id];if(current(r))mergeHistory(id,[{timestamp:r.timestamp,solarW:r.solarW,gridV:r.gridV,loadW:r.loadW,gridW:r.gridW}]);}
  const b=state.data?.battery;
  if(batteryCurrent(b)){state.batteryHistory=[...state.batteryHistory.filter(p=>p.timestamp!==b.timestamp&&p.timestamp>Date.now()-86400000),{...b}].sort((a,b)=>a.timestamp-b.timestamp).slice(-1500);writeStore('raja-studio-battery-v1',state.batteryHistory);}
  writeStore('raja-studio-history-v1',state.history);
}
function toast(text){const el=$('#toast');el.textContent=text;el.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.hidden=true,3500);}
async function request(url){const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(12000)});if(!r.ok)throw new Error('Connection interrupted');return r.json();}
async function refresh(manual=false){
  if(state.busy)return;state.busy=true;$('#refresh').disabled=true;
  try{state.data=await request('/api/overview');state.lastFetch=Date.now();state.transportError=false;addReadings();render();if(manual)toast('Readings refreshed.');}
  catch{state.transportError=true;render();if(manual)toast('Connection interrupted. Retrying automatically.');}
  finally{state.busy=false;$('#refresh').disabled=false;}
  if(Date.now()-state.lastHistory>45000){state.lastHistory=Date.now();try{const h=await request('/api/history');for(const id of Object.keys(names))mergeHistory(id,Array.isArray(h[id])?h[id]:[]);writeStore('raja-studio-history-v1',state.history);renderCharts();}catch{}}
}
function render(){
  const d=state.data,solar=d?.solar||{},b=d?.battery||{},transport=!state.transportError&&Date.now()-state.lastFetch<90000;
  const both=transport&&Object.keys(names).every(id=>current(solar[id]));const total=both?d.totals:{};
  const batteryOk=transport&&batteryCurrent(b),count=Object.keys(names).filter(id=>transport&&current(solar[id])).length+(batteryOk?1:0);
  $('#connection').className=`status-pill ${count===3?'live':''}`;$('#connection').innerHTML=`<i></i>${count}/3 connected`;
  for(const id of [...Object.keys(names),'matrix']){const source=id==='matrix'?b:solar[id];$(`#dot-${id}`).className=`device-dot ${transport?source?.status||'connecting':'stale'}`;}
  const notice=$('#notice');let message='';
  if(state.transportError)message='Connection interrupted. Current figures are hidden until fresh readings return.';
  else if(d&&!both)message='Waiting for fresh solar readings. Combined totals will return when both solar inverters are live.';
  else if(d&&!batteryOk)message=b.status==='stale'?'Matrix battery data is delayed. Old readings are not shown as current.':b.status==='device_mismatch'?'The Matrix connection is still pointing to the previous inverter. Battery readings are withheld.':b.status==='connection_pending'?'Matrix battery connection is being updated for your active inverter.':b.status==='unavailable'?'Matrix battery readings are temporarily unavailable.':'';
  notice.hidden=!message;notice.querySelector('span').textContent=message;
  $('#total-solar').textContent=kw(total.solarW);$('#total-load').textContent=kw(total.loadW);$('#total-grid').textContent=kw(valid(total.gridW)?Math.abs(total.gridW):null);
  $('#solar-summary').textContent=both?'PV14000 + PV9000':'Waiting for both solar inverters';
  $('#grid-title').textContent=!valid(total.gridW)?'Grid exchange':total.gridW<0?'Exporting to grid':'Importing from grid';
  $('#grid-caption').textContent=valid(total.gridW)&&total.gridW<0?'Surplus reported by the inverters':'Inverter-reported flow';
  $('#today-solar').textContent=fmt(total.todaySolar,1);$('#today-export').textContent=`Export: ${fmt(total.todayExport,1)} kWh`;
  $('#coverage').textContent=valid(total.solarW)&&valid(total.loadW)?total.solarW>=total.loadW?'Solar exceeds inverter load':'Using grid support':'Awaiting live readings';
  $('#solar-devices').innerHTML=Object.keys(names).map(id=>{const r=solar[id]||{},ok=transport&&current(r),n=id==='pv14000'?1:2;return `<div class="solar-device"><div class="device-top"><div><div class="device-name">${names[id]}</div><div class="device-subtitle">Fronus Meta · Solar ${String(n).padStart(2,'0')}</div></div><span class="tiny-state ${esc(ok?'live':r.status||'connecting')}">${esc(statusLabel(ok?'live':r.status==='live'?'stale':r.status||'connecting'))}</span></div><div class="device-power">${kw(ok?r.solarW:null)}<small>kW</small></div><div class="bar-track"><span style="width:${ok&&r.installedW?Math.min(100,Math.max(0,r.solarW/r.installedW*100)):0}%"></span></div><div class="device-bottom"><span>Grid <b>${fmt(ok?r.gridV:null)} V</b></span><span><b>${fmt(ok?r.temperature:null,0)}°C</b></span><span>${esc(age(r.timestamp))}</span></div></div>`;}).join('');
  $('#battery-status').textContent=statusLabel(batteryOk?'live':b.status==='live'?'stale':b.status||'connecting');
  $('#battery-soc').textContent=fmt(batteryOk?b.soc:null,0);$('#battery-fill').style.height=`${batteryOk&&valid(b.soc)?Math.max(0,Math.min(100,b.soc)):0}%`;
  $('#battery-mode').textContent=batteryOk?({charging:'Charging your reserve',discharging:'Battery supplying power',idle:'Battery on standby',unknown:'Battery mode not reported'}[b.mode]||'Battery mode not reported'):'Waiting for a verified battery reading';
  $('#battery-power').innerHTML=`${fmt(batteryOk&&valid(b.power)?Math.abs(b.power):null,0)} <small>W</small>`;
  $('#battery-voltage').innerHTML=`${fmt(batteryOk?b.voltage:null)} <small>V</small>`;
  $('#battery-current').innerHTML=`${fmt(batteryOk?b.current:null,2)} <small>A</small>`;
  $('#battery-temp').innerHTML=`${fmt(batteryOk?b.temperature:null)} <small>°C</small>`;
  $('#battery-note').textContent=batteryOk?`Device reading ${age(b.timestamp)}. Matrix contributes battery information only.`:valid(b.timestamp)?`Last device record: ${dateFormat.format(b.timestamp)} · ${at(b.timestamp)} PKT.`:'Battery feed is configured for your current Matrix inverter.';
  $('#voltage-mini').innerHTML=Object.keys(names).map(id=>{const r=solar[id],v=transport&&current(r)?r.gridV:null;return `<div class="watch-row"><span>${names[id]}</span><strong class="${v>240?'high':''}">${fmt(v)} <small>V</small></strong></div>`;}).join('');
  $('#last-sync').textContent=state.lastFetch?`${state.transportError?'Last response':'Updated'} ${at(state.lastFetch)} PKT`:'Connecting to your inverters';
  renderVoltageStats(solar,transport);renderBattery(b,batteryOk);renderDevices(solar,b,transport);renderCharts();
}
function renderVoltageStats(solar,transport){
  $('#voltage-stats').innerHTML=Object.keys(names).map(id=>{const r=solar[id],ok=transport&&current(r),rows=historyRows(id),high=rows.filter(x=>valid(x.gridV)&&x.gridV>240);return metric(`${names[id]} · Grid voltage`,fmt(ok?r.gridV:null),'V',`${high.length} of ${rows.filter(p=>valid(p.gridV)).length} recorded samples above 240 V`);}).join('');
}
function renderBattery(b,ok){
  $('#battery-detail').innerHTML=`<div class="battery-detail-grid"><article class="reserve-summary"><span class="eyebrow">FRONUS MATRIX · BATTERY RESERVE</span><div class="reserve-big">${fmt(ok?b.soc:null,0)}<small> %</small></div><p>Reported state of charge</p><div class="bar-track"><span style="width:${ok&&valid(b.soc)?b.soc:0}%"></span></div><div class="reserve-state">${esc(ok?b.mode[0].toUpperCase()+b.mode.slice(1):statusLabel(b.status||'connecting'))}</div><p style="margin-top:14px">${ok?`Last battery measurement ${age(b.timestamp)}.`:'Waiting for fresh data from the current inverter. Unavailable values are shown as a dash.'}</p></article><div class="detail-metrics">${metric('Battery voltage',fmt(ok?b.voltage:null),'V')}${metric('Battery current',fmt(ok?b.current:null,2),'A','Signed value from the inverter')}${metric('Battery power',fmt(ok&&valid(b.power)?Math.abs(b.power):null,0),'W',ok?b.mode:'')}${metric('Battery temperature',fmt(ok?b.temperature:null),'°C')}</div><article class="card full-span"><div class="card-head"><div><span class="eyebrow">TODAY · BATTERY ENERGY</span><h2>Charge and discharge</h2></div><span class="small-label">Battery counters only</span></div><div class="insight-grid">${metric('Energy charged',fmt(ok?b.chargedKwh:null,2),'kWh')}${metric('Energy discharged',fmt(ok?b.dischargedKwh:null,2),'kWh')}</div><p class="detail-note">Matrix solar production, AC loads and grid exchange are excluded from the dashboard totals. No backup-runtime estimate is made without a verified battery capacity.</p></article></div>`;
}
function renderDevices(solar,b,transport){
  const cards=Object.keys(names).map(id=>{const r=solar[id]||{},ok=transport&&current(r);return `<article class="card"><div class="card-head"><h2>${names[id]}</h2>${icons('device')}</div><p class="detail-status">Fronus Meta · ${esc(statusLabel(ok?'live':r.status==='live'?'stale':r.status||'connecting'))}<br>Device measurement: ${valid(r.timestamp)?`${at(r.timestamp)} PKT · ${age(r.timestamp)}`:'not yet available'}</p><dl class="detail-list">${row('Solar generation',`${kw(ok?r.solarW:null)} kW`)}${row('Inverter output load',`${kw(ok?r.loadW:null)} kW`)}${row(ok&&r.gridW<0?'Grid export':'Grid import',`${kw(ok&&valid(r.gridW)?Math.abs(r.gridW):null)} kW`)}${row('Grid voltage',`${fmt(ok?r.gridV:null)} V`)}${row('Grid frequency',`${fmt(ok?r.gridHz:null)} Hz`)}${row('Heatsink temperature',`${fmt(ok?r.temperature:null)} °C`)}${row('Reported AC rating',`${kw(r.ratingW)} kW`)}${row('Input mode',esc(r.inputMode||'—'))}${row('Fault report',esc(ok?r.fault||'Not supplied':'—'))}</dl>${ok?(r.strings||[]).map(s=>`<p class="detail-note"><strong>PV string ${s.id}</strong><br>${fmt(s.watts,0)} W · ${fmt(s.volts)} V · ${fmt(s.amps)} A</p>`).join(''):''}</article>`;});
  const ok=transport&&batteryCurrent(b);
  cards.push(`<article class="card"><div class="card-head"><h2>Matrix</h2>${icons('battery')}</div><p class="detail-status">Battery information only<br>${esc(statusLabel(ok?'live':b.status==='live'?'stale':b.status||'connecting'))}</p><dl class="detail-list">${row('State of charge',`${fmt(ok?b.soc:null,0)} %`)}${row('Battery voltage',`${fmt(ok?b.voltage:null)} V`)}${row('Battery current',`${fmt(ok?b.current:null,2)} A`)}${row('Battery power',`${fmt(ok&&valid(b.power)?Math.abs(b.power):null,0)} W`)}${row('Battery state',esc(ok?b.mode:'Unknown'))}${row('Battery temperature',`${fmt(ok?b.temperature:null)} °C`)}</dl><p class="detail-note">Battery readings are independent of the two solar inverters and are not added to solar, load or grid totals.</p><button class="text-button" style="margin-top:22px" data-view="battery">Explore battery reserve <span>↗</span></button></article>`);
  $('#device-detail').innerHTML=`<div class="detail-grid">${cards.join('')}</div>`;
}
function historyRows(id){return (Array.isArray(state.history[id])?state.history[id]:[]).filter(p=>valid(p.timestamp)&&p.timestamp>=Date.now()-state.hours*3600000&&p.timestamp<=Date.now()+30000);}
function chart(target,key){
  const colors=['#568466','#cca94d'],all=Object.keys(names).map(id=>historyRows(id).filter(p=>valid(p[key])));const flat=all.flat();
  if(!flat.length){$(target).innerHTML=`<div class="chart-empty">${icons('chart')}<b>Waiting for measured samples</b><span>Available history will appear here automatically.</span></div>`;return;}
  const W=700,H=240,left=40,right=14,top=12,bottom=32,pw=W-left-right,ph=H-top-bottom,voltage=key==='gridV';
  const start=Math.max(Date.now()-state.hours*3600000,Math.min(...flat.map(p=>p.timestamp))-60000),end=Math.max(Date.now(),start+120000),values=flat.map(p=>p[key]);
  const low=voltage?Math.floor(Math.min(...values,240)/5)*5-2:0,high=voltage?Math.ceil(Math.max(...values,240)/5)*5+2:Math.max(1000,Math.ceil(Math.max(...values)/1000)*1000);
  const x=t=>left+(t-start)/(end-start)*pw,y=v=>top+ph-(v-low)/(high-low)*ph;
  let svg=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${voltage?'Grid voltage':'Solar production'} chart of measured inverter samples">`;
  for(let i=0;i<=4;i++){const yy=top+ph*i/4,v=high-(high-low)*i/4;svg+=`<line class="gridline" x1="${left}" x2="${W-right}" y1="${yy}" y2="${yy}"/><text x="${left-9}" y="${yy+3}" text-anchor="end">${voltage?fmt(v,0):fmt(v/1000,1)}</text>`;}
  for(let i=0;i<=4;i++)svg+=`<text x="${left+pw*i/4}" y="${H-7}" text-anchor="${i===0?'start':i===4?'end':'middle'}">${at(start+(end-start)*i/4)}</text>`;
  if(voltage)svg+=`<line x1="${left}" x2="${W-right}" y1="${y(240)}" y2="${y(240)}" stroke="#ba7545" stroke-dasharray="6 5"/><text x="${W-right-4}" y="${y(240)-6}" text-anchor="end">240 V watch</text>`;
  all.forEach((rows,index)=>{let d='',last=null;rows.forEach(p=>{d+=`${!last||p.timestamp-last>600000?'M':'L'}${x(p.timestamp).toFixed(2)},${y(p[key]).toFixed(2)} `;last=p.timestamp;});svg+=`<path class="series" stroke="${colors[index]}" d="${d}"/>`;const step=Math.max(1,Math.floor(rows.length/180));rows.forEach((p,i)=>{if(i%step&&i!==rows.length-1)return;const caption=`${Object.values(names)[index]} · ${at(p.timestamp)} PKT · ${fmt(p.gridV)} V · ${fmt(p.solarW,0)} W`;svg+=`<circle class="point" data-sample="${esc(caption)}" cx="${x(p.timestamp)}" cy="${y(p[key])}" r="${rows.length<20?3.5:2.3}" fill="${colors[index]}"><title>${esc(caption)}</title></circle>`;});});
  svg+='</svg>';$(target).innerHTML=svg;
}
function renderCharts(){
  chart('#generation-chart','solarW');chart('#voltage-chart','gridV');
  const rows=Object.keys(names).flatMap(id=>historyRows(id).map(p=>({...p,id}))).sort((a,b)=>b.timestamp-a.timestamp);
  $('#chart-coverage').textContent=rows.length?`${rows.length} samples · ${at(Math.min(...rows.map(p=>p.timestamp)))}–${at(Math.max(...rows.map(p=>p.timestamp)))} PKT · gaps preserved`:'Collecting measured samples…';
  const high=rows.filter(p=>valid(p.gridV)&&p.gridV>240),selected=(high.length?high:rows).slice(0,12);
  $('#observations').innerHTML=selected.length?selected.map(p=>`<tr><td>${at(p.timestamp)}</td><td>${names[p.id]}</td><td>${fmt(p.gridV)} V</td><td>${fmt(p.solarW,0)} W</td><td><span class="tag ${p.gridV>240?'high':''}">${p.gridV>240?'Above 240 V':'Below / at 240 V'}</span></td></tr>`).join(''):'<tr><td class="empty-row" colspan="5">No measured samples available in this window yet.</td></tr>';
  if(state.data)renderVoltageStats(state.data.solar,!state.transportError);
}
const viewCopy={overview:['Energy overview','A brighter view of your energy.','Two solar inverters. One battery reserve. All in one place.'],voltage:['Voltage insights','Understand the voltage story.','Watch grid voltage and solar output with real, time-stamped readings.'],battery:['Battery reserve','Keep your reserve in view.','Battery information from your Matrix inverter, clearly separated.'],devices:['Inverter details','Every connection. Every reading.','Detailed solar telemetry and a dedicated battery-only view.']};
function setView(view){if(!viewCopy[view])return;state.view=view;$$('[data-panel]').forEach(p=>p.hidden=p.dataset.panel!==view);$$('.nav-button').forEach(b=>{b.classList.toggle('active',b.dataset.view===view);b.setAttribute('aria-current',b.dataset.view===view?'page':'false');});const [crumb,title,sub]=viewCopy[view];$('#breadcrumb').textContent=crumb;$('#page-title').textContent=title;$('#page-subtitle').textContent=sub;history.replaceState(null,'',view==='overview'?'/':`/#${view}`);window.scrollTo({top:0,behavior:'instant'});renderCharts();}
function exportCsv(){
  const rows=[['Source','Timestamp (ISO)','Solar W','Inverter load W','Grid W (positive import)','Grid V','Battery SOC %','Battery V','Battery A','Battery W (positive discharge)','Battery temperature C']];
  for(const id of Object.keys(names))for(const p of historyRows(id))rows.push([names[id],new Date(p.timestamp).toISOString(),p.solarW,p.loadW,p.gridW,p.gridV,'','','','','']);
  for(const b of state.batteryHistory.filter(b=>b.timestamp>Date.now()-state.hours*3600000))rows.push(['Matrix battery',new Date(b.timestamp).toISOString(),'','','','',b.soc,b.voltage,b.current,b.power,b.temperature]);
  if(rows.length===1)return toast('No recorded readings to export yet.');
  const csv=rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`Raja-Energy-${new Date().toISOString().slice(0,10)}-${state.hours}h.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast(`${rows.length-1} recorded readings exported.`);
}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(b?.dataset.view)setView(b.dataset.view);if(b?.dataset.hours){state.hours=Number(b.dataset.hours);$$('[data-hours]').forEach(x=>x.classList.toggle('active',Number(x.dataset.hours)===state.hours));renderCharts();}const point=e.target.closest('[data-sample]');if(point)toast(point.dataset.sample);});
$('#refresh').addEventListener('click',()=>refresh(true));
$('#export-all').addEventListener('click',exportCsv);$('#export-voltage').addEventListener('click',exportCsv);
$('#theme').addEventListener('click',()=>{document.documentElement.classList.toggle('dark');writeStore('raja-studio-dark',document.documentElement.classList.contains('dark'));});
$('#fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{toast('Full-screen is unavailable in this browser.');}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
document.documentElement.classList.toggle('dark',readStore('raja-studio-dark',false));
$('#date-label').textContent=dateFormat.format(Date.now()).toUpperCase()+' · GUJRAT, PAKISTAN';
function clock(){ $('#clock').textContent=at(Date.now())+' PKT';if(state.data)render(); }
setView(location.hash.slice(1)||'overview');render();refresh();setInterval(()=>{if(!document.hidden)refresh();},15000);setInterval(clock,10000);clock();
