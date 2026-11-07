import {IDS,names,finite,fresh,select,energy,dayPK,mergeSamples,historyRows} from './model.js';
import {cardModel} from './card-adapter.js';
window.customCards=window.customCards||[];
if(!customElements.get('ha-card'))customElements.define('ha-card',class extends HTMLElement{});
let vendorReady=false;
const vendor=import('./vendor/sunsynk-power-flow-card.js').then(()=>{vendorReady=true;render();}).catch(()=>toast('The power-flow card could not load. Refresh to retry.'));
const $=s=>document.querySelector(s), $$=s=>document.querySelectorAll(s);
const safeRead=(key,fallback)=>{try{return JSON.parse(localStorage.getItem('raja-flow-'+key))??fallback;}catch{return fallback;}};
const save=(key,v)=>{try{localStorage.setItem('raja-flow-'+key,JSON.stringify(v));}catch{}};
const state={page:'live',system:'combined',hours:6,interval:[5,10,30].includes(safeRead('interval',5))?safeRead('interval',5):5,data:null,online:false,busy:false,attempted:false,lastFetch:0,lastHistory:0,historyBusy:false,samples:safeRead('history',[]),card:null,configKey:'',sensorStates:{}};
const nf=new Intl.NumberFormat('en',{maximumFractionDigits:1});
const fmt=(v,d=1)=>finite(v)?v.toLocaleString('en',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
const kw=v=>fmt(finite(v)?v/1000:null,2);
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label=()=>state.system==='combined'?'Combined system':'Fronus '+names[state.system];
const connected=()=>state.online&&Date.now()-state.lastFetch<90000;
const age=t=>!finite(t)?'No reading':t>Date.now()+30000?'Device time ahead':Date.now()-t<60000?'Just updated':Date.now()-t<3600000?Math.floor((Date.now()-t)/60000)+' min ago':Date.now()-t<86400000?Math.floor((Date.now()-t)/3600000)+' hours ago':Math.floor((Date.now()-t)/86400000)+' days ago';
const measured=t=>finite(t)?new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Karachi',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(t)+' PKT':'Not received';
const row=(name,value)=>`<div class="detail-row"><span>${esc(name)}</span><strong>${esc(value)}</strong></div>`;
const kpi=(name,value,unit,color,icon,note)=>`<article class="kpi"><div class="kpi-label"><span>${esc(name)}</span><span class="kpi-icon ${color}">${icon}</span></div><strong class="${color}">${value}<small>${unit}</small></strong><p>${esc(note)}</p></article>`;
function toast(s){$('#toast').textContent=s;$('#toast').hidden=false;setTimeout(()=>$('#toast').hidden=true,3500);}
function placeholder(){return `<div class="flow-placeholder"><svg viewBox="0 0 500 300" role="img" aria-label="Waiting for current readings; power flow animation is paused"><g fill="none" stroke="#414653" stroke-width="2"><path d="M250 65V118M92 172H198M302 172H408"/><rect x="206" y="15" width="88" height="50" rx="6"/><rect x="198" y="118" width="104" height="108" rx="9"/><path d="M207 137h86v45h-86z"/><path d="M52 175v-38l40-30 40 30v38zM371 175l37-70 37 70m-55-35h36m-46 18h55"/></g><g fill="#9298a8" font-family="system-ui" font-size="13" text-anchor="middle"><text x="250" y="46">☀ Solar</text><text x="250" y="208">Inverter</text><text x="92" y="201">Load</text><text x="408" y="201">Grid</text><text x="250" y="93">— W</text><text x="92" y="225">— W</text><text x="408" y="225">— W</text></g></svg><p>Waiting for current readings · animation paused</p></div>`;}
function renderFlow(){
  const model=cardModel(state.data,state.system,Date.now(),connected(),{wide:$('#flow-host').clientWidth>680,animate:!matchMedia('(prefers-reduced-motion: reduce)').matches});
  $('#flow-title').textContent=label();
  if(!model||!vendorReady){
    if(state.card||!$('#flow-host .flow-placeholder svg'))$('#flow-host').innerHTML=placeholder();
    state.card=null;state.configKey='';state.sensorStates={};return;
  }
  if(!state.card){state.card=document.createElement('sunsynk-power-flow-card');$('#flow-host').replaceChildren(state.card);}
  state.sensorStates=model.hass.states;state.card.hass=model.hass;
  const key=JSON.stringify(model.config);
  if(key!==state.configKey){state.card.setConfig(model.config);state.configKey=key;}
  const currentCard=state.card;
  currentCard.updateComplete.then(()=>{
    const root=currentCard.shadowRoot, original=root?.querySelector('#inverter_power_175');
    if(!original)return;
    // The source API does not measure net AC conversion output. Preserve the
    // original component and its Lit-managed nodes, hiding its default zero.
    let style=root.querySelector('#raja-optional-sensors');
    if(!style){style=document.createElement('style');style.id='raja-optional-sensors';style.textContent='#inverter_power_175{visibility:hidden!important}';root.append(style);}
    let dash=root.querySelector('#raja-unreported-output');
    if(!dash){dash=document.createElementNS('http://www.w3.org/2000/svg','text');dash.id='raja-unreported-output';original.parentElement.append(dash);}
    for(const attr of ['x','y','class','fill','transform']){const value=original.getAttribute(attr);if(value!==null)dash.setAttribute(attr,value);else dash.removeAttribute(attr);}
    dash.textContent='—';
  });
}
function render(){
  const now=Date.now(),ok=connected(),s=select(state.data,state.system,now,ok),e=energy(state.data,state.system,now,ok);
  $('#pk-clock').textContent=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Karachi',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(now)+' PKT';
  $('#energy-date').textContent=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Karachi',day:'numeric',month:'short',year:'numeric'}).format(now);
  const n=IDS.filter(id=>ok&&fresh(state.data?.solar?.[id],now)).length;
  const status=$('#connection');status.textContent=!state.attempted?'Connecting':!ok?'Reconnecting':n===2?'Live · 2 inverters':n===1?'1 inverter current':'Readings delayed';status.className='status '+(!state.attempted?'pending':!ok?'offline':n===2?'':'pending');
  const notice=$('#notice');notice.hidden=!!ok&&n===2;
  notice.textContent=!state.attempted?'Connecting to your existing solar service. The first load may take a little longer.':!ok?'The solar service is temporarily unreachable. Reconnecting automatically; stale readings are not shown as live.':IDS.filter(id=>!fresh(state.data?.solar?.[id],now)).map(id=>`${names[id]}: ${age(state.data?.solar?.[id]?.timestamp)}`).join(' · ')+'. Select a current inverter to view its flow. Combined totals require both feeds.';
  const gridText=finite(s.gridW)?s.gridW>0?'Importing from grid':s.gridW<0?'Exporting to grid':'No grid exchange':'Waiting for current data';
  $('#power-kpis').innerHTML=kpi('Solar production',kw(s.solarW),'kW','yellow','☀',finite(s.solarW)&&s.solarW===0?'No solar generation reported':'PV input power')+kpi('Inverter load',kw(s.loadW),'kW','green','⌂','Selected inverter output loads')+kpi('Grid exchange',kw(finite(s.gridW)?Math.abs(s.gridW):null),'kW','blue','↔',gridText);
  $('#sample-age').textContent=s.complete?'Device record · '+age(s.timestamp):'Waiting for all selected readings';$('#flow-direction').textContent=gridText;
  if(state.page==='live')renderFlow();
  const b=state.data?.battery||{},bo=ok&&fresh(b,now,true);
  $('#battery-status').className='dot-status '+(bo?'live':'');$('#battery-soc').innerHTML=fmt(bo?b.soc:null,0)+'<small>%</small>';
  $('#battery-fill').style.width=(bo&&finite(b.soc)?Math.max(0,Math.min(100,b.soc)):0)+'%';
  $('#battery-mode').textContent=bo?({charging:'Charging',discharging:'Discharging',idle:'Standby'}[b.mode]||'Mode unavailable'):'Reading delayed';$('#battery-age').textContent=age(b.timestamp);
  $('#battery-metrics').innerHTML=[['Power',fmt(bo&&finite(b.power)?Math.abs(b.power):null,0)+' W'],['Voltage',fmt(bo?b.voltage:null,2)+' V'],['Temperature',fmt(bo?b.temperature:null,0)+' °C']].map(([l,v])=>`<div><strong class="purple">${v}</strong><span>${l}</span></div>`).join('');
  $('#voltage-readings').innerHTML=IDS.map(id=>{const r=state.data?.solar?.[id],good=ok&&fresh(r,now),v=good?r.gridV:null;return `<div class="voltage-row"><div class="name">${names[id]}<span>${good?age(r.timestamp):'Delayed reading'}</span></div><strong class="${finite(v)&&v>240?'red':'blue'}">${fmt(v)} <small>V</small></strong></div>`;}).join('');
  $('#energy-kpis').innerHTML=kpi('Solar generated',fmt(e.solar,2),'kWh','yellow','☀','Today · device counter')+kpi('Load consumed',fmt(e.load,2),'kWh','green','⌂','Today · inverter load')+kpi('Grid imported',fmt(e.import,2),'kWh','blue','↓','Today · device counter')+kpi('Grid exported',fmt(e.export,2),'kWh','purple','↑','Today · device counter');
  if(state.page==='history')renderHistory();if(state.page==='devices')renderDevices();
}
function renderDevices(){
  const now=Date.now(),ok=connected();
  $('#device-cards').innerHTML=IDS.map(id=>{
    const r=state.data?.solar?.[id]||{},good=ok&&fresh(r,now),v=k=>good?r[k]:null;
    return `<article class="panel device-card"><p class="eyebrow">SOLAR INVERTER</p><h2>Fronus ${names[id]}</h2><span class="status ${good?'':'pending'}">${good?'Current reading':'Delayed reading'}</span><div class="device-reading yellow">${kw(v('solarW'))} <small>kW solar</small></div>${row('Output load',kw(v('loadW'))+' kW')}${row('Grid exchange',finite(v('gridW'))?fmt(r.gridW,0)+' W':'—')}${row('Grid voltage',fmt(v('gridV'))+' V')}${row('Output voltage',fmt(v('outputV'))+' V')}${row('Temperature',fmt(v('temperature'))+' °C')}${row('Fault',good?(r.fault||'Not reported'):'Unavailable')}<p class="last-record">Measured ${esc(measured(r.timestamp))}<br>Service received ${esc(measured(r.receivedAt))}</p><button class="small-button" data-open="${id}">Open power flow →</button></article>`;
  }).join('');
  const b=state.data?.battery||{},good=ok&&fresh(b,now,true),v=k=>good?b[k]:null;
  $('#device-cards').insertAdjacentHTML('beforeend',`<article class="panel device-card"><p class="eyebrow">BATTERY MONITOR</p><h2>Fronus Matrix</h2><span class="status ${good?'':'pending'}">${good?'Current reading':'Delayed reading'}</span><div class="device-reading purple">${fmt(v('soc'),0)} <small>% charge</small></div>${row('Mode',good?(b.mode||'Unknown'):'Unavailable')}${row('Power',fmt(v('power'),0)+' W')}${row('Voltage',fmt(v('voltage'),2)+' V')}${row('Current',fmt(v('current'),2)+' A')}${row('Temperature',fmt(v('temperature'))+' °C')}<p class="last-record">Measured ${esc(measured(b.timestamp))}<br>Service received ${esc(measured(b.receivedAt))}</p><p class="fineprint">Independent battery feed. Not added to the two solar inverters’ generation, load or grid totals.</p></article>`);
}
function renderHistory(){
  const end=Date.now(),start=end-state.hours*3600000;const rows=historyRows(state.samples,state.system,start,end),el=$('#history-chart');
  $('#history-summary').textContent=`${rows.length.toLocaleString()} recorded samples · ${label()} · Last ${state.hours<24?state.hours+' hours':state.hours/24+' days'}. History combines the existing service with readings saved in this browser; it may cover only part of the selected period.`;
  if(rows.length<2){el.innerHTML='<div class="chart-empty">Waiting for recorded history.<br>Keep the dashboard open to collect readings, or select an individual inverter.</div>';return;}
  const values=rows.flatMap(r=>['solarW','loadW','gridW'].map(k=>r[k])).filter(finite);if(!values.length){el.innerHTML='<div class="chart-empty">No valid power values in this period.</div>';return;}
  const W=Math.max(280,el.clientWidth),H=W<500?240:290,L=44,R=12,T=18,B=34,min=Math.min(0,...values),max=Math.max(1000,...values),range=max-min||1000;
  const x=t=>L+(t-start)/(end-start)*(W-L-R),y=v=>H-B-(v-min)/range*(H-B-T);
  let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Recorded solar, inverter load and grid power"><g font-family="system-ui" font-size="11" fill="#999da9">`;
  for(let i=0;i<=4;i++){const v=min+range*i/4,yy=y(v);svg+=`<path d="M${L} ${yy}H${W-R}" stroke="#2c2f39"/><text x="${L-10}" y="${yy+4}" text-anchor="end">${fmt(v/1000,1)}</text>`;}
  svg+='<text x="12" y="12">kW</text>';
  const ticks=W<500?2:4;
  for(let i=0;i<=ticks;i++){const t=start+(end-start)*i/ticks;svg+=`<text x="${x(t)}" y="${H-8}" text-anchor="${i===0?'start':i===ticks?'end':'middle'}">${esc(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Karachi',...(state.hours>24?{day:'2-digit',month:'short'}:{hour:'2-digit',minute:'2-digit',hour12:false})}).format(t))}</text>`;}
  svg+='</g>';
  for(const [key,color] of [['solarW','#f4c755'],['loadW','#64d7ad'],['gridW','#6eaff5']]){
    let d='',prev=null;for(const r of rows){if(!finite(r[key])){prev=null;continue;}d+=`${prev&&r.timestamp-prev<=180000?'L':'M'}${x(r.timestamp).toFixed(2)},${y(r[key]).toFixed(2)} `;prev=r.timestamp;}
    svg+=`<path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  }
  el.innerHTML=svg+'</svg>';
}
async function request(route){const r=await fetch(route,{cache:'no-store',signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('Feed unavailable');return r.json();}
function record(data){const now=Date.now(),rows=[];for(const id of IDS){const r=data?.solar?.[id];if(fresh(r,now))rows.push({id,timestamp:r.timestamp,solarW:r.solarW,loadW:r.loadW,gridW:r.gridW});}state.samples=mergeSamples(state.samples,rows,now);save('history',state.samples);}
async function loadHistory(){
  if(state.historyBusy||Date.now()-state.lastHistory<60000)return;state.historyBusy=true;state.lastHistory=Date.now();
  try{const d=await request('/api/history'),rows=[];for(const id of IDS)for(const r of Array.isArray(d[id])?d[id]:[])rows.push({id,timestamp:r.timestamp,solarW:r.solarW,loadW:r.loadW,gridW:r.gridW});state.samples=mergeSamples(state.samples,rows);save('history',state.samples);if(state.page==='history')renderHistory();}catch{}finally{state.historyBusy=false;}
}
async function refresh(){
  if(state.busy||document.hidden)return;state.busy=true;$('#refresh').disabled=true;
  try{const d=await request('/api/overview');if(!d?.solar||typeof d.solar!=='object')throw new Error('Malformed feed');state.data=d;state.online=true;state.lastFetch=Date.now();record(d);loadHistory();}
  catch{state.online=false;}finally{state.attempted=true;state.busy=false;$('#refresh').disabled=false;render();schedule();}
}
let timer;function schedule(){clearTimeout(timer);if(!document.hidden)timer=setTimeout(refresh,state.interval*1000);}
function page(name){state.page=name;for(const el of $$('.page'))el.hidden=el.id!==name+'-page';for(const el of $$('.nav'))el.classList.toggle('active',el.dataset.page===name);$('#page-title').textContent={live:'Live power flow',history:'Energy history',devices:'My inverters'}[name];if(name==='history')loadHistory();render();}
function system(id){if(!['combined',...IDS].includes(id))return;state.system=id;for(const el of $$('[data-system]'))el.classList.toggle('selected',el.dataset.system===id);render();}
$('.brand').onclick=e=>{e.preventDefault();page('live');window.scrollTo({top:0,behavior:'smooth'});};
$$('[data-page]').forEach(b=>b.onclick=()=>page(b.dataset.page));$$('[data-system]').forEach(b=>b.onclick=()=>system(b.dataset.system));
$$('[data-hours]').forEach(b=>b.onclick=()=>{state.hours=Number(b.dataset.hours);$$('[data-hours]').forEach(x=>x.classList.toggle('selected',x===b));renderHistory();});
$('#interval').value=String(state.interval);$('#interval').onchange=()=>{state.interval=Number($('#interval').value);save('interval',state.interval);schedule();};$('#refresh').onclick=refresh;
$('#device-cards').onclick=e=>{const b=e.target.closest('[data-open]');if(b){system(b.dataset.open);page('live');window.scrollTo({top:0,behavior:'smooth'});}};
$('#flow-host').addEventListener('hass-more-info',e=>{e.stopPropagation();const s=state.sensorStates[e.detail?.entityId];if(!s)return;$('#detail-title').textContent=s.attributes.friendly_name||'Sensor reading';$('#detail-body').innerHTML=row('Value',s.state+' '+s.attributes.unit_of_measurement)+row('Measured',measured(Date.parse(s.last_updated)))+'<p class="fineprint">Read-only measurement from the selected Fronus inverter feed.</p>';$('#detail').showModal();});
$('#close-detail').onclick=()=>$('#detail').close();$('#detail').onclick=e=>{if(e.target===$('#detail'))$('#detail').close();};
$('#export').onclick=()=>{const end=Date.now(),rows=state.samples.filter(r=>r.timestamp>=end-state.hours*3600000&&r.timestamp<=end&&(state.system==='combined'||r.id===state.system));if(!rows.length)return toast('No recorded readings to export yet.');const csv='inverter,timestamp_utc,solar_w,load_w,grid_w\n'+rows.map(r=>[r.id,new Date(r.timestamp).toISOString(),...['solarW','loadW','gridW'].map(k=>finite(r[k])?r[k]:'')].join(',')).join('\n');const u=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));const a=document.createElement('a');a.href=u;a.download='Raja_Solar_'+dayPK(Date.now())+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(u),2000);};
document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(!document.hidden)refresh();});
let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(render,120);});
setInterval(()=>{if(!document.hidden)render();},5000);
render();refresh();
