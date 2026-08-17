const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const COLORS = {
  solar:'#f6b526', load:'#357be8', grid:'#18a96b', import:'#ef4655', smart:'#f68b22',
  pv14000:'#2f7bf0', pv9000:'#7657f2', matrix:'#0aa6a6', battery:'#21a86a', combined:'#082b43'
};
let live = null;
let history = { pv14000: [], pv9000: [], matrix: [], combined: [], storage: 'loading', samples: 0 };
let activeHours = 24;
let activeEnergyPeriod = 'T';
let energy = null;
let tuyaRangeMode = 'day';
let tuyaQuickLoaded = false;

function set(id, value) { const el = $(id); if (el) el.textContent = value; }
function finite(v, f=0) { const n = Number(v); return Number.isFinite(n) ? n : f; }
function fmtPower(v) { const n=finite(v); const a=Math.abs(n); return a>=1000?`${(a/1000).toFixed(2)} kW`:`${Math.round(a)} W`; }
function fmtSignedPower(v) { const n=finite(v); const sign=n<0?'−':''; const a=Math.abs(n); return a>=1000?`${sign}${(a/1000).toFixed(2)} kW`:`${sign}${Math.round(a)} W`; }
function fmtKwh(v) { return `${finite(v).toFixed(2)} kWh`; }
function fmtPct(v) { return v==null || !Number.isFinite(Number(v)) ? '--' : `${Math.round(Number(v))}%`; }
function gridMode(v) { const n=finite(v); return Math.abs(n)<30?'IDLE':n>=0?'IMPORTING':'EXPORTING'; }
function ageText(ts) { const s=Math.max(0,Math.round((Date.now()-finite(ts,Date.now()))/1000)); if(s<5)return'Updated now'; if(s<60)return`Updated ${s}s ago`; return`Updated ${Math.floor(s/60)}m ago`; }
function pct(v,max) { return Math.max(0,Math.min(100,Math.abs(finite(v))/Math.max(1,max)*100)); }
function gauge(id,value,max,mode) { const el=$(id); if(!el)return; el.style.strokeDasharray=`${pct(value,max).toFixed(2)} 100`; el.classList.remove('red','green'); if(mode==='grid')el.classList.add(finite(value)>=0?'red':'green'); }
function fixedGauge(id,value,max,colorClass) { const el=$(id); if(!el)return; el.style.strokeDasharray=`${pct(value,max).toFixed(2)} 100`; el.classList.remove('red','green'); if(colorClass)el.classList.add(colorClass); }
function liveCapacityPct(value,max) { return Math.max(0,Math.abs(finite(value))/Math.max(1,max)*100); }
function setLiveGaugePercent(id,value,max,label='') { const p=liveCapacityPct(value,max); set(id,`${p.toFixed(1)}%${label?` ${label}`:''}`); const el=$(id); if(el)el.classList.toggle('over',p>100); }
function batteryFlowMode(value, modeText='') { const m=String(modeText||'').toLowerCase(); if(m.includes('dis')) return 'DISCHARGING'; if(m.includes('char')) return 'CHARGING'; const n=finite(value); if(Math.abs(n)<20) return 'IDLE'; return n>=0 ? 'CHARGING' : 'DISCHARGING'; }
function batteryGauge(id,value,max,modeText='') { const el=$(id); if(!el)return; el.style.strokeDasharray=`${pct(value,max).toFixed(2)} 100`; el.classList.remove('red','green'); const mode=batteryFlowMode(value, modeText); el.classList.add(mode==='DISCHARGING'?'red':'green'); return mode; }
function clock(){const d=new Date();set('clock',d.toLocaleTimeString('en-GB',{hour12:false}));set('date',d.toLocaleDateString('en-PK',{weekday:'short',day:'2-digit',month:'short'}));}
function pkParts(){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const o={};parts.forEach(p=>{if(p.type!=='literal')o[p.type]=p.value});return o;
}
function pkToday(){const p=pkParts();return `${p.year}-${p.month}-${p.day}`;}
function pkMonth(){const p=pkParts();return `${p.year}-${p.month}`;}
function nullableKwh(v){return v==null||!Number.isFinite(Number(v))?'-- kWh':`${Number(v).toFixed(2)} kWh`;}
setInterval(clock,1000); clock();

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
$$('#energyPeriod button').forEach((button)=>button.addEventListener('click',()=>{
  $$('#energyPeriod button').forEach((b)=>b.classList.toggle('active',b===button));
  activeEnergyPeriod=button.dataset.period||'T';
  loadEnergy(activeEnergyPeriod);
}));

$$('#tuyaRangeMode button').forEach((button)=>button.addEventListener('click',()=>{
  tuyaRangeMode=button.dataset.tuyaRange||'day';
  $$('#tuyaRangeMode button').forEach(b=>b.classList.toggle('active',b===button));
  const day=$('tuyaDayPicker'),month=$('tuyaMonthPicker');
  if(day)day.hidden=tuyaRangeMode!=='day'; if(month)month.hidden=tuyaRangeMode!=='month';
  loadSelectedTuyaEnergy();
}));
$('tuyaLoadPeriod')?.addEventListener('click',loadSelectedTuyaEnergy);
$('tuyaDayPicker')?.addEventListener('change',loadSelectedTuyaEnergy);
$('tuyaMonthPicker')?.addEventListener('change',loadSelectedTuyaEnergy);

async function wakeMasterSources(){
  set('liveChip','◌ WAKING SOURCES…');
  $('liveChip')?.classList.remove('live');
  try{
    const response=await fetch('/api/master/wake',{cache:'no-store'});
    const data=await response.json();
    const ready=finite(data.readyCount); const total=finite(data.totalConfigured);
    if(data.allReady){
      set('liveChip','● SOURCES READY');
      $('liveChip')?.classList.add('live');
    }else{
      set('liveChip',`◌ READY ${ready}/${total}`);
    }
    return data;
  }catch(error){
    set('liveChip','◌ WAKE RETRY');
    return null;
  }
}
async function loadLive(){
  try{
    const response=await fetch('/api/master/live',{cache:'no-store'});
    live=await response.json();
    render();
    set('liveChip',live.complete?'● LIVE':live.ok?'● PARTIAL':'● OFFLINE');
    $('liveChip')?.classList.toggle('live',Boolean(live.ok));
  }catch(error){set('liveChip','● ERROR');}
}
async function loadHistory(hours=24){
  try{
    const response=await fetch(`/api/master/history?hours=${hours}`,{cache:'no-store'});
    history=await response.json();
    const online=history.storage==='postgres';
    set('historyChip',online?`History • ${finite(history.samples)} online samples`:'History • source fallback');
    $('historyChip')?.classList.toggle('onlineHistory',online);
    drawAll();
  }catch(_error){set('historyChip','History • unavailable');}
}
async function loadEnergy(period='T'){
  try{
    const response=await fetch(`/api/master/energy?period=${encodeURIComponent(period)}`,{cache:'no-store'});
    energy=await response.json();
    renderEnergy();
  }catch(error){const n=$('energyNotice');if(n){n.hidden=false;n.textContent=`Totals unavailable: ${error.message}`;}}
}

async function fetchTuyaRange(type,value){
  const key=type==='day'?'date':'month';
  const response=await fetch(`/api/master/tuya-energy?type=${encodeURIComponent(type)}&${key}=${encodeURIComponent(value)}`,{cache:'no-store'});
  const data=await response.json();
  if(!response.ok||data.success===false)throw new Error(data.error||data.msg||'Tuya history unavailable');
  return data;
}
async function fetchTuyaStats(){
  const response=await fetch('/api/master/tuya-energy-stats',{cache:'no-store'});
  const data=await response.json();
  if(!response.ok||data.success===false)throw new Error(data.error||data.msg||'Tuya today totals unavailable');
  return data;
}
function setTuyaEnergyNotice(message=''){
  const n=$('tuyaEnergyNotice');if(!n)return;n.hidden=!message;n.textContent=message;
}
async function loadTuyaQuickTotals(){
  const month=pkMonth();
  const notices=[];
  let todayOk=false, monthOk=false;

  try{
    const stats=await fetchTuyaStats();
    const t=stats.today||{};
    set('tuyaTodayImport',nullableKwh(t.importKwh));
    set('tuyaTodayExport',nullableKwh(t.exportKwh));
    set('tuyaTodayLabel','Today • Tuya meter');
    todayOk=true;
  }catch(error){
    try{
      const d=await fetchTuyaRange('day',pkToday());
      set('tuyaTodayImport',nullableKwh(d.importKwh));
      set('tuyaTodayExport',nullableKwh(d.exportKwh));
      set('tuyaTodayLabel',d.label||'Today');
      todayOk=true;
    }catch(fallbackError){
      set('tuyaTodayImport','-- kWh'); set('tuyaTodayExport','-- kWh');
      notices.push(`Today totals: ${fallbackError.message||error.message}`);
    }
  }

  try{
    const m=await fetchTuyaRange('month',month);
    set('tuyaMonthImport',nullableKwh(m.importKwh));
    set('tuyaMonthExport',nullableKwh(m.exportKwh));
    set('tuyaMonthLabel',m.label||'This month');
    monthOk=true;
  }catch(error){
    set('tuyaMonthImport','-- kWh'); set('tuyaMonthExport','-- kWh');
    notices.push(`This month: ${error.message}`);
  }

  tuyaQuickLoaded=todayOk||monthOk;
  setTuyaEnergyNotice(notices.join(' • '));
}
async function loadSelectedTuyaEnergy(){
  const day=$('tuyaDayPicker'),month=$('tuyaMonthPicker');
  const value=tuyaRangeMode==='day'?(day?.value||pkToday()):(month?.value||pkMonth());
  set('tuyaSelectedLabel','Loading…');set('tuyaSelectedStatus','Reading Tuya energy data');
  try{
    let d;
    if(tuyaRangeMode==='day' && value===pkToday()){
      const stats=await fetchTuyaStats();
      const t=stats.today||{};
      d={label:new Date().toLocaleDateString('en-GB',{timeZone:'Asia/Karachi',day:'2-digit',month:'short',year:'numeric'}),importKwh:t.importKwh,exportKwh:t.exportKwh,netKwh:t.netKwh,complete:false,note:''};
    }else{
      d=await fetchTuyaRange(tuyaRangeMode,value);
    }
    set('tuyaSelectedLabel',d.label||value);set('tuyaSelectedImport',nullableKwh(d.importKwh));set('tuyaSelectedExport',nullableKwh(d.exportKwh));set('tuyaSelectedNet',nullableKwh(d.netKwh));
    if(tuyaRangeMode==='day' && value===pkToday()){set('tuyaTodayImport',nullableKwh(d.importKwh));set('tuyaTodayExport',nullableKwh(d.exportKwh));}
    if(tuyaRangeMode==='month' && value===pkMonth()){set('tuyaMonthImport',nullableKwh(d.importKwh));set('tuyaMonthExport',nullableKwh(d.exportKwh));}
    set('tuyaSelectedStatus',d.complete?'Complete period':'Current period • updates automatically');setTuyaEnergyNotice(d.note||'');
  }catch(error){set('tuyaSelectedLabel',value);set('tuyaSelectedImport','-- kWh');set('tuyaSelectedExport','-- kWh');set('tuyaSelectedNet','-- kWh');set('tuyaSelectedStatus','Unavailable');setTuyaEnergyNotice(`Selected Tuya period: ${error.message}`);}
}
function initTuyaPickers(){
  const today=pkToday(),month=pkMonth();const d=$('tuyaDayPicker'),m=$('tuyaMonthPicker');
  if(d){d.value=today;d.max=today;} if(m){m.value=month;m.max=month;}
}
async function loadWeather(){
  try{const r=await fetch('/api/master/weather',{cache:'no-store'});const w=await r.json();const d=w.data||{};const t=d.temperature??d.temperature_2m??d.current?.temperature_2m;if(Number.isFinite(Number(t)))set('weather',`☁ ${Math.round(Number(t))}° Gujrat`);}catch(_error){}
}

function render(){
  if(!live)return;
  const s=live.systems||{}; const a=s.pv14000; const b=s.pv9000; const u=s.matrix; const c=s.combined||{}; const m=live.meter||null;
  renderStatus(a,b,u,c,m);
  renderPv14000(a);
  renderPv9000(b);
  renderMatrix(u);
  renderTuya(m);
  renderCombined(c,a,b,u);
  renderQuickTotals(c);
  renderDetailPages(a,b,u,c);
  renderHealth(a,b,u,c,m,live.errors||{});
  drawAll();
}
function setState(id,online){set(id,online?'ONLINE':'OFFLINE');$(id)?.classList.toggle('online',Boolean(online));}
function renderStatus(a,b,u,c,m){
  const count=[a,b,u].filter(Boolean).length;
  set('systemsOnline',`${count}/3`);
  setState('pv14000Online',a); setState('pv14000PageStatus',a);
  setState('pv9000Online',b); setState('pv9000PageStatus',b);
  setState('matrixOnline',u); setState('matrixPageStatus',u);
  set('combinedPageStatus',count===3?'ALL SYSTEMS LIVE':`${count}/3 SYSTEMS`);
  $('combinedPageStatus')?.classList.toggle('online',count===3);
  set('pv14000Fresh',a?ageText(a.updatedAt):'API unavailable');
  set('pv9000Fresh',b?ageText(b.updatedAt):'API not configured / unavailable');
  set('matrixFresh',u?ageText(u.updatedAt):'API unavailable');
  setState('tuyaOnline',Boolean(m?.online)); set('tuyaFresh',m?ageText(m.updatedAt):'Meter API unavailable');
  const notice=[];
  if(live.errors?.pv14000)notice.push(`PV14000: ${live.errors.pv14000}`);
  if(live.errors?.pv9000)notice.push(`PV9000: ${live.errors.pv9000}`);
  if(live.errors?.matrix)notice.push(`Matrix: ${live.errors.matrix}`);
  if(live.errors?.tuya)notice.push(`Tuya meter: ${live.errors.tuya}`);
  const n=$('masterNotice'); if(n){n.hidden=!notice.length;n.textContent=notice.join(' • ');}
}
function blank(ids){ids.forEach(id=>set(id,'--'));}
function renderPv14000(a){
  if(!a){blank(['pv14000SolarHero','pv14000PvSplit','pv14000LoadGaugeText','pv14000SolarGaugeText','pv14000GridGaugeText','pv14000GridMode','pv14000GridV','pv14000TodaySolar','pv14000Temp']);return;}
  set('pv14000SolarHero',fmtPower(a.solarW)); set('pv14000PvSplit',`PV1 ${fmtPower(a.pv1W)} • PV2 ${fmtPower(a.pv2W)}`);
  set('pv14000LoadGaugeText',fmtPower(a.loadW)); set('pv14000SolarGaugeText',fmtPower(a.solarW)); set('pv14000GridGaugeText',fmtPower(a.gridW));
  set('pv14000GridMode',gridMode(a.gridW)); set('pv14000GridV',`${finite(a.gridV).toFixed(1)} V`); set('pv14000TodaySolar',fmtKwh(a.todaySolar)); set('pv14000Temp',`${Math.round(finite(a.temp))}°C`);
  gauge('pv14000LoadGauge',a.loadW,10000); gauge('pv14000SolarGauge',a.solarW,6780); gauge('pv14000GridGauge',a.gridW,10000,'grid');
}
function renderPv9000(b){
  if(!b){blank(['pv9000SolarHero','pv9000PvSplit','pv9000LoadGaugeText','pv9000SolarGaugeText','pv9000GridGaugeText','pv9000GridMode','pv9000GridV','pv9000SmartGaugeText','pv9000TodaySolar','pv9000Temp']);return;}
  set('pv9000SolarHero',fmtPower(b.solarW)); set('pv9000PvSplit',`PV1 ${fmtPower(b.pv1W)} • PV2 ${fmtPower(b.pv2W)}`);
  set('pv9000LoadGaugeText',fmtPower(b.loadW)); set('pv9000SolarGaugeText',fmtPower(b.solarW)); set('pv9000GridGaugeText',fmtPower(b.gridW)); set('pv9000SmartGaugeText',fmtPower(b.smartLoadW));
  set('pv9000GridMode',gridMode(b.gridW)); set('pv9000GridV',`${finite(b.gridV).toFixed(1)} V`); set('pv9000TodaySolar',fmtKwh(b.todaySolar)); set('pv9000Temp',`${Math.round(finite(b.temp))}°C`);
  gauge('pv9000LoadGauge',b.loadW,6000); gauge('pv9000SolarGauge',b.solarW,4360); gauge('pv9000GridGauge',b.gridW,6000,'grid'); gauge('pv9000SmartGauge',b.smartLoadW,6000);
}
function renderMatrix(u){
  if(!u){blank(['matrixInputGaugeText','matrixInputV','matrixLoadGaugeText','matrixBattery','matrixBatteryPower','matrixTemp']);return;}
  set('matrixInputGaugeText',fmtPower(u.acInputW)); set('matrixInputV',`${finite(u.acInputV).toFixed(1)} V`); set('matrixLoadGaugeText',fmtPower(u.loadW));
  set('matrixBattery',fmtPct(u.batteryPct)); set('matrixBatteryPower',fmtSignedPower(u.batteryW)); set('matrixTemp',`${Math.round(finite(u.transformer||u.temp))}°C`);
  gauge('matrixInputGauge',u.acInputW,6000); gauge('matrixLoadGauge',u.loadW,6000);
}
function renderTuya(m){
  const modeEl=$('tuyaMode');
  if(!m){
    blank(['tuyaImportGaugeText','tuyaExportGaugeText','tuyaImportPercent','tuyaExportPercent','tuyaImportTotal','tuyaExportTotal','tuyaVoltage','tuyaCurrent','tuyaPf','tuyaTemp']);
    $('tuyaImportPercent')?.classList.remove('over'); $('tuyaExportPercent')?.classList.remove('over');
    fixedGauge('tuyaImportGauge',0,5000,'red'); fixedGauge('tuyaExportGauge',0,6000,'green');
    set('tuyaMode','OFFLINE'); if(modeEl)modeEl.className='tuyaDirection idle'; return;
  }
  const mode=String(m.mode||'IDLE').toUpperCase();
  set('tuyaImportGaugeText',fmtPower(m.importW)); set('tuyaExportGaugeText',fmtPower(m.exportW));
  setLiveGaugePercent('tuyaImportPercent',m.importW,5000,'MDI'); setLiveGaugePercent('tuyaExportPercent',m.exportW,6000,'DG');
  set('tuyaImportTotal',m.importKwh==null?'-- kWh total':`${finite(m.importKwh).toFixed(2)} kWh total`);
  set('tuyaExportTotal',m.exportKwh==null?'-- kWh total':`${finite(m.exportKwh).toFixed(2)} kWh total`);
  set('tuyaVoltage',m.voltage==null?'-- V':`${finite(m.voltage).toFixed(1)} V`);
  set('tuyaCurrent',m.currentA==null?'-- A':`${finite(m.currentA).toFixed(3)} A`);
  set('tuyaPf',m.powerFactor==null?'--':finite(m.powerFactor).toFixed(3));
  set('tuyaTemp',m.temperatureC==null?'-- °C':`${Math.round(finite(m.temperatureC))} °C`);
  fixedGauge('tuyaImportGauge',m.importW,5000,'red'); fixedGauge('tuyaExportGauge',m.exportW,6000,'green');
  set('tuyaMode',mode); if(modeEl)modeEl.className=`tuyaDirection ${mode==='IMPORTING'?'importing':mode==='EXPORTING'?'exporting':'idle'}`;
}
function renderCombined(c,a,b,u){
  set('combinedSolarHero',fmtPower(c.solarW)); set('combinedDemandHero',fmtPower(c.siteDemandW)); set('combinedNet',fmtPower(c.gridW)); set('combinedMode',gridMode(c.gridW));
  set('combinedSolarGaugeText',fmtPower(c.solarW)); set('combinedLoadGaugeText',fmtPower(c.siteDemandW)); set('combinedGridGaugeText',fmtPower(c.gridW)); set('combinedGridMode',gridMode(c.gridW));
  const batteryMode=batteryGauge('combinedBatteryGauge',u?.batteryW,6000,u?.batteryMode);
  set('combinedBatteryGaugeText',u?fmtPower(u.batteryW):'--'); set('combinedBatteryMode',u?batteryMode:'--'); set('combinedBatteryVoltage',u?`${finite(u.batteryV).toFixed(1)} V`:'-- V');
  gauge('combinedSolarGauge',c.solarW,11140); gauge('combinedLoadGauge',c.siteDemandW,16000); gauge('combinedGridGauge',c.gridW,16000,'grid');
  const total=finite(c.solarW);
  set('pv14000Share',total>0?`${Math.round(finite(a?.solarW)/total*100)}%`:'--%');
  set('pv9000Share',total>0?`${Math.round(finite(b?.solarW)/total*100)}%`:'--%');
  set('masterBattery',u?.batteryPct!=null?`${Math.round(u.batteryPct)}%`:'--');
  set('masterHealth',[a,b,u].filter(Boolean).length===3?'Excellent · 100/100':'Partial');
}
function renderQuickTotals(c){
  set('todaySolar',fmtKwh(c.todaySolar)); set('todayLoad',fmtKwh(c.todayLoad)); set('todayImport',fmtKwh(c.todayImport)); set('todayExport',fmtKwh(c.todayExport));
  if(energy)renderEnergy();
}
function metricCards(rows){return rows.map(([label,value,small,cls=''])=>`<div class="detailCard ${cls}"><span>${label}</span><b>${value}</b><small>${small||''}</small></div>`).join('');}
function renderDetailPages(a,b,u,c){
  $('pv14000Page').innerHTML=metricCards(a?[
    ['Solar PV',fmtPower(a.solarW),'6.78 kWp installed'],['AC output / load',fmtPower(a.loadW),'10 kW capacity'],['Utility grid',fmtPower(a.gridW),gridMode(a.gridW)],['Grid voltage',`${finite(a.gridV).toFixed(1)} V`,`${finite(a.gridHz).toFixed(2)} Hz`],
    ['PV1',fmtPower(a.pv1W),`${finite(a.pv1V).toFixed(1)} V • ${finite(a.pv1A).toFixed(1)} A`],['PV2',fmtPower(a.pv2W),`${finite(a.pv2V).toFixed(1)} V • ${finite(a.pv2A).toFixed(1)} A`],['Today solar',fmtKwh(a.todaySolar),'Production'],['Temperature',`${Math.round(finite(a.temp))}°C`,'Inverter']
  ]:[['Connection','OFFLINE','PV14000 API unavailable','alertDetail']]);

  $('pv9000Page').innerHTML=metricCards(b?[
    ['Solar PV',fmtPower(b.solarW),'4.36 kWp installed'],['AC output / load',fmtPower(b.loadW),'Feeds UPS path'],['Utility grid',fmtPower(b.gridW),gridMode(b.gridW)],['Smart Load',fmtPower(b.smartLoadW),'Direct from PV9000'],
    ['PV1',fmtPower(b.pv1W),`${finite(b.pv1V).toFixed(1)} V • ${finite(b.pv1A).toFixed(1)} A`],['PV2',fmtPower(b.pv2W),`${finite(b.pv2V).toFixed(1)} V • ${finite(b.pv2A).toFixed(1)} A`],['Today solar',fmtKwh(b.todaySolar),'Production'],['Temperature',`${Math.round(finite(b.temp))}°C`,'Inverter']
  ]:[['Connection','OFFLINE','Set PV9000_API_BASE in Render','alertDetail']]);

  $('matrixPage').innerHTML=metricCards(u?[
    ['Role','UPS / BACKUP','PV disabled'],['PV installed','0 W','No solar contribution'],['AC input',fmtPower(u.acInputW),'From PV9000 • internal transfer'],['AC input voltage',`${finite(u.acInputV).toFixed(1)} V`,`${finite(u.acInputHz).toFixed(2)} Hz`],
    ['UPS output load',fmtPower(u.loadW),'6 kW capacity'],['Battery SOC',fmtPct(u.batteryPct),u.batteryMode||'Battery'],['Battery power',fmtSignedPower(u.batteryW),`${finite(u.batteryV).toFixed(1)} V`],['Transformer',`${Math.round(finite(u.transformer||u.temp))}°C`,'Temperature']
  ]:[['Connection','OFFLINE','Matrix API unavailable','alertDetail']]);

  $('combinedPage').innerHTML=metricCards([
    ['Total solar',fmtPower(c.solarW),'PV14000 + PV9000'],['Installed PV','11.14 kWp','6.78 + 4.36 kWp'],['Site demand',fmtPower(c.siteDemandW),'Topology-corrected'],['Utility grid',fmtPower(c.gridW),gridMode(c.gridW)],
    ['Smart Load',fmtPower(c.smartLoadW),'Direct from PV9000'],['UPS load',fmtPower(c.upsLoadW),'Informational • excluded from double-count'],['UPS AC input',fmtPower(c.upsAcInputW),'Internal PV9000 → Matrix transfer'],['Connected systems',`${finite(c.connectedSystems)}/3`,c.health]
  ]);
}
function healthRows(rows){return rows.map(([k,v,ok])=>`<div class="healthRow"><span>${k}</span><b class="${ok===false?'badText':'okText'}">${v}</b></div>`).join('');}
function renderHealth(a,b,u,c,m,errors){
  $('pv14000Health').innerHTML=healthRows([['API connection',a?'ONLINE':'OFFLINE',Boolean(a)],['Last update',a?ageText(a.updatedAt):'--',Boolean(a)],['PV capacity','6.78 kWp',true],['AC capacity','10 kW',true]]);
  $('pv9000Health').innerHTML=healthRows([['API connection',b?'ONLINE':'OFFLINE',Boolean(b)],['Last update',b?ageText(b.updatedAt):'--',Boolean(b)],['PV capacity','4.36 kWp',true],['Feeds','UPS + Smart Load',Boolean(b)]]);
  $('matrixHealth').innerHTML=healthRows([['API connection',u?'ONLINE':'OFFLINE',Boolean(u)],['Role','UPS / BACKUP',true],['PV installed','0 W',true],['Battery',u?fmtPct(u.batteryPct):'--',Boolean(u)]]);
  const historyOnline=Boolean(live?.history?.online); const count=[a,b,u].filter(Boolean).length;
  $('combinedHealth').innerHTML=healthRows([['Connected systems',`${count}/3`,count===3],['Tuya physical meter',m?.online?'ONLINE':'OFFLINE',Boolean(m?.online)],['Tuya direction',m?.mode||'--',Boolean(m?.online)],['Total PV','11.14 kWp',true],['Utility grid sources','PV14000 + PV9000',true],['Online history',historyOnline?'PostgreSQL ACTIVE':'Fallback',historyOnline],['Overall',count===3?'Excellent':'Partial',count===3]]);
  set('healthPill',count===3?'ALL NORMAL':'ATTENTION'); $('healthPill')?.classList.toggle('good',count===3);
  const messages=[]; if(errors.pv14000)messages.push(`PV14000: ${errors.pv14000}`); if(errors.pv9000)messages.push(`PV9000: ${errors.pv9000}`); if(errors.matrix)messages.push(`Matrix: ${errors.matrix}`); if(errors.tuya)messages.push(`Tuya meter: ${errors.tuya}`);
  set('diagnosticNotice',messages.length?messages.join(' • '):'✓ Three-system topology is connected. Matrix internal AC transfer is excluded from utility-grid totals.'); set('alertCount',messages.length);
}

function renderEnergy(){
  if(!energy)return;
  const a=energy.pv14000||{}, b=energy.pv9000||{}, u=energy.matrix||{}, c=energy.combined||{};
  const labels={T:'Today',Y:'Yesterday',TM:'This month',LM:'Last month'}; const label=labels[energy.period]||'Selected period';
  set('totSolar',fmtKwh(c.solarKwh)); set('totLoad',fmtKwh(c.loadKwh)); set('totImport',fmtKwh(c.importKwh)); set('totExport',fmtKwh(c.exportKwh));
  ['totPeriodSolar','totPeriodLoad','totPeriodImport','totPeriodExport'].forEach(id=>set(id,`${label} • topology corrected`));
  set('energyPeriodLabel',`${label} · PV14000 + PV9000 + Combined`);
  set('solarValueBig',Math.round(finite(c.solarKwh)*finite(energy.rate,60)).toLocaleString('en-PK'));
  set('rateValue',`PKR ${finite(energy.rate,60).toFixed(2)}/kWh`);
  set('totPv14000Solar',fmtKwh(a.solarKwh)); set('totPv9000Solar',fmtKwh(b.solarKwh)); set('totCombinedSolar',fmtKwh(c.solarKwh));
  set('totPv14000Load',fmtKwh(a.loadKwh)); set('totPv9000Load',fmtKwh(b.loadKwh)); set('totMatrixLoad',fmtKwh(u.loadKwh));
  set('totCombinedImport',fmtKwh(c.importKwh)); set('totCombinedExport',fmtKwh(c.exportKwh));
  const notice=$('energyNotice'); const errs=energy.errors||{}; const messages=[]; if(errs.pv14000)messages.push(`PV14000: ${errs.pv14000}`); if(errs.pv9000)messages.push(`PV9000: ${errs.pv9000}`); if(errs.matrix)messages.push(`Matrix: ${errs.matrix}`); if(notice){notice.hidden=!messages.length;notice.textContent=messages.join(' • ');}
  drawEnergyBars();
}

function histFor(kind){return Array.isArray(history?.[kind])?history[kind]:[];}
function mergeHistory(){
  const stored=histFor('combined'); if(stored.length)return stored.slice(-24000);
  const map=new Map();
  for(const [kind,arr] of [['pv14000',histFor('pv14000')],['pv9000',histFor('pv9000')]])for(const p of arr){
    const t=Math.round(finite(p.timestamp,Date.now())/60000)*60000;
    const o=map.get(t)||{timestamp:t,solarW:0,loadW:0,gridW:0,smartLoadW:0};
    o.solarW+=finite(p.solarW); o.loadW+=finite(p.loadW); o.gridW+=finite(p.gridW); if(kind==='pv9000'){o.smartLoadW+=finite(p.smartLoadW); o.loadW+=finite(p.smartLoadW);} map.set(t,o);
  }
  return [...map.values()].sort((x,y)=>x.timestamp-y.timestamp).slice(-1200);
}
function canvasSize(canvas){const r=canvas.getBoundingClientRect();const dpr=window.devicePixelRatio||1;canvas.width=Math.max(1,Math.round(r.width*dpr));canvas.height=Math.max(1,Math.round(r.height*dpr));const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);return{ctx,w:r.width,h:r.height};}
function drawLineChart(id,series,{signed=false}={}){
  const canvas=$(id);if(!canvas)return;const{ctx,w,h}=canvasSize(canvas);ctx.clearRect(0,0,w,h);const pad={l:42,r:16,t:17,b:27};const values=series.flatMap(s=>s.data.map(p=>finite(p.v)));if(!values.length){ctx.fillStyle='#7893a5';ctx.font='12px Segoe UI';ctx.fillText('History will appear as samples are collected.',pad.l,h/2);return;}
  let min=0,max=Math.max(1000,...values.map(Math.abs))*1.12;if(signed){const abs=Math.max(1000,...values.map(Math.abs))*1.12;min=-abs;max=abs;}
  const y=(v)=>pad.t+(max-finite(v))/(max-min)*(h-pad.t-pad.b);const x=(i,n)=>pad.l+(n<=1?0:i/(n-1))*(w-pad.l-pad.r);
  ctx.strokeStyle='#dce9ef';ctx.lineWidth=1;for(let i=0;i<5;i++){const yy=pad.t+i*(h-pad.t-pad.b)/4;ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(w-pad.r,yy);ctx.stroke();}
  if(signed){ctx.strokeStyle='#b7ceda';ctx.beginPath();ctx.moveTo(pad.l,y(0));ctx.lineTo(w-pad.r,y(0));ctx.stroke();}
  for(const s of series){if(!s.data.length)continue;ctx.strokeStyle=s.color;ctx.lineWidth=2;ctx.beginPath();s.data.forEach((p,i)=>{const xx=x(i,s.data.length),yy=y(p.v);i?ctx.lineTo(xx,yy):ctx.moveTo(xx,yy)});ctx.stroke();}
}
function drawEnergyBars(){
  const canvas=$('barChart');if(!canvas||!energy)return;const{ctx,w,h}=canvasSize(canvas);ctx.clearRect(0,0,w,h);const a=energy.pv14000||{},b=energy.pv9000||{},c=energy.combined||{};
  const groups=[['Solar','solarKwh',COLORS.solar],['Load','loadKwh',COLORS.load],['Import','importKwh',COLORS.import],['Export','exportKwh',COLORS.grid]];
  const max=Math.max(1,...groups.flatMap(([,key])=>[finite(a[key]),finite(b[key]),finite(c[key])]));const left=34,right=18,top=32,bottom=56,groupW=(w-left-right)/groups.length;
  ctx.strokeStyle='#dce9ef';ctx.lineWidth=1;for(let i=0;i<4;i++){const yy=top+i*(h-top-bottom)/3;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(w-right,yy);ctx.stroke();}
  groups.forEach(([label,key],gi)=>{const vals=[finite(a[key]),finite(b[key]),finite(c[key])];const center=left+groupW*(gi+.5);const bw=Math.min(28,groupW*.18),gap=7;const colors=[COLORS.pv14000,COLORS.pv9000,COLORS.combined];vals.forEach((v,j)=>{const bh=(h-top-bottom)*(v/max);const xx=center+(j-1)*(bw+gap)-bw/2;const yy=h-bottom-bh;ctx.fillStyle=colors[j];ctx.fillRect(xx,yy,bw,bh);if(v>0){ctx.fillStyle='#082b43';ctx.font='700 10px Segoe UI';ctx.textAlign='center';ctx.fillText(v.toFixed(1),xx+bw/2,Math.max(12,yy-5));}});ctx.fillStyle='#7893a5';ctx.font='700 11px Segoe UI';ctx.textAlign='center';ctx.fillText(label,center,h-20);});ctx.textAlign='start';
}
function drawAll(){
  const a=histFor('pv14000'),b=histFor('pv9000'),u=histFor('matrix'),c=mergeHistory();
  const master=[{color:COLORS.solar,data:c.map(p=>({v:p.solarW}))},{color:COLORS.load,data:c.map(p=>({v:p.loadW}))},{color:COLORS.grid,data:c.map(p=>({v:p.gridW}))},{color:COLORS.smart,data:c.map(p=>({v:p.smartLoadW}))}];
  drawLineChart('overviewChart',master,{signed:true});drawLineChart('combinedChart',master,{signed:true});drawLineChart('fullChart',master,{signed:true});
  drawLineChart('systemSplitChart',[{color:COLORS.pv14000,data:a.map(p=>({v:p.solarW}))},{color:COLORS.pv9000,data:b.map(p=>({v:p.solarW}))}]);
  const sA=[{color:COLORS.solar,data:a.map(p=>({v:p.solarW}))},{color:COLORS.load,data:a.map(p=>({v:p.loadW}))},{color:COLORS.grid,data:a.map(p=>({v:p.gridW}))}];
  const sB=[{color:COLORS.solar,data:b.map(p=>({v:p.solarW}))},{color:COLORS.load,data:b.map(p=>({v:p.loadW}))},{color:COLORS.grid,data:b.map(p=>({v:p.gridW}))},{color:COLORS.smart,data:b.map(p=>({v:p.smartLoadW}))}];
  const sU=[{color:COLORS.matrix,data:u.map(p=>({v:p.acInputW}))},{color:COLORS.load,data:u.map(p=>({v:p.loadW}))},{color:COLORS.battery,data:u.map(p=>({v:p.batteryW}))}];
  drawLineChart('pv14000Chart',sA,{signed:true});drawLineChart('fullPv14000Chart',sA,{signed:true});
  drawLineChart('pv9000Chart',sB,{signed:true});drawLineChart('fullPv9000Chart',sB,{signed:true});
  drawLineChart('matrixChart',sU,{signed:true});drawLineChart('fullMatrixChart',sU,{signed:true});
  drawLineChart('pv14000PvChart',[{color:COLORS.solar,data:a.map(p=>({v:p.pv1W}))},{color:COLORS.pv9000,data:a.map(p=>({v:p.pv2W}))}]);
  drawLineChart('pv9000PvChart',[{color:COLORS.solar,data:b.map(p=>({v:p.pv1W}))},{color:COLORS.pv9000,data:b.map(p=>({v:p.pv2W}))}]);
  drawEnergyBars();
}

async function start(){initTuyaPickers();await wakeMasterSources();await Promise.allSettled([loadLive(),loadHistory(activeHours),loadEnergy(activeEnergyPeriod),loadWeather(),loadTuyaQuickTotals()]);await loadSelectedTuyaEnergy();setInterval(loadLive,10000);setInterval(()=>loadHistory(activeHours),60000);setInterval(()=>loadEnergy(activeEnergyPeriod),60000);setInterval(loadTuyaQuickTotals,300000);setInterval(loadWeather,600000);}
window.addEventListener('resize',()=>requestAnimationFrame(drawAll));
start();
