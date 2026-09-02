const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const $q = (sel) => document.querySelector(sel);
const COLORS = {
  solar:'#f6b526', load:'#357be8', grid:'#18a96b', import:'#ef4655', smart:'#f68b22',
  pv14000:'#2f7bf0', pv9000:'#7657f2', matrix:'#0aa6a6', battery:'#21a86a', combined:'#082b43'
};
const PHYSICAL_PV_CAPACITY_W = 11140;
const MONITORED_PV_CAPACITY_W = 4360;
const MONITORED_SOLAR_KWP = 4.36;
const MONITORED_SYSTEM_COUNT = 2; // PV9000 + Matrix
const MONITORED_SOURCE_COUNT = 3; // PV9000 + Matrix + Tuya physical meter
let live = null;
let history = { pv14000: [], pv9000: [], matrix: [], combined: [], storage: 'loading', samples: 0 };
let activeHours = 24;
let activeEnergyPeriod = 'T';
let energy = null;
let tuyaRangeMode = 'day';
let tuyaQuickLoaded = false;
let analytics = null;
let timelineHistory = { pv14000: [], pv9000: [], matrix: [], combined: [] };
let todayEnergy = null;
let connectionAlertCount = 0;
let smartAlertCount = 0;
let aiStatusData = null;
let aiBusy = false;
let aiHistory = [];
let notifyStatusData = null;
const localNotifySent = new Map();
let ultraEvents = [];
let ultraLastState = null;
let toolsInitialized = false;
let toolsSeededFromLive = false;
let toolHasSavedPrefs = false;
let powerSmartState = { connected:false };
let powerSmartData = null;
let powerSmartBusy = false;

function set(id, value) { const el = $(id); if (el) el.textContent = value; }
function uiIcon(name, cls='') { return `<svg class="uiIcon ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`; }
function iconMetaForLabel(label='') {
  const s=String(label).toLowerCase();
  if(s.includes('solar') || s==='pv1' || s==='pv2' || s.includes('pv installed') || s.includes('pv capacity')) return ['sun','icon-solar'];
  if(s.includes('import')) return ['import','icon-import'];
  if(s.includes('export')) return ['export','icon-export'];
  if(s.includes('grid') || s.includes('voltage')) return ['grid','icon-grid'];
  if(s.includes('battery')) return ['battery','icon-battery'];
  if(s.includes('smart load')) return ['smart','icon-smart'];
  if(s.includes('temperature') || s.includes('transformer')) return ['temp','icon-temp'];
  if(s.includes('ups') || s.includes('ac input') || s.includes('role')) return ['ups','icon-ups'];
  if(s.includes('load') || s.includes('output')) return ['load','icon-load'];
  if(s.includes('connection') || s.includes('system') || s.includes('overall') || s.includes('health')) return ['health','icon-health'];
  if(s.includes('current')) return ['current','icon-current'];
  return ['meter','icon-neutral'];
}
function iconLabelHtml(label) { const [name,cls]=iconMetaForLabel(label); return `<span class="detailLabel iconLabel ${cls}">${uiIcon(name,cls)}<span>${label}</span></span>`; }
function finite(v, f=0) { const n = Number(v); return Number.isFinite(n) ? n : f; }
function monitoredPvCapacityW(){const api=finite(live?.capacities?.monitoredPvW);return api>0?api:MONITORED_PV_CAPACITY_W;}
function monitoredSolarKwp(){return monitoredPvCapacityW()/1000;}
function monitoredSystemTarget(){return Math.max(MONITORED_SYSTEM_COUNT,finite(live?.totalSystems,MONITORED_SYSTEM_COUNT));}
function monitoredSourceTarget(){return monitoredSystemTarget()+1;}
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
function clock(){const d=new Date();const time=d.toLocaleTimeString('en-GB',{hour12:false}),date=d.toLocaleDateString('en-PK',{weekday:'short',day:'2-digit',month:'short'});set('clock',time);set('date',date);set('controlClock',time);set('controlDate',date);}
function pkParts(){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const o={};parts.forEach(p=>{if(p.type!=='literal')o[p.type]=p.value});return o;
}
function pkToday(){const p=pkParts();return `${p.year}-${p.month}-${p.day}`;}
function pkMonth(){const p=pkParts();return `${p.year}-${p.month}`;}
function nullableKwh(v){return v==null||!Number.isFinite(Number(v))?'-- kWh':`${Number(v).toFixed(2)} kWh`;}
function fmtPkr(v){return `PKR ${Math.round(finite(v)).toLocaleString('en-PK')}`;}
function fmtTimePk(ts){if(!ts)return'--';const d=new Date(ts);if(!Number.isFinite(d.getTime()))return'--';return d.toLocaleTimeString('en-GB',{timeZone:'Asia/Karachi',hour:'2-digit',minute:'2-digit',hour12:false});}
function fmtDuration(hours){const h=Number(hours);if(!Number.isFinite(h)||h<=0)return'--';const whole=Math.floor(h),mins=Math.round((h-whole)*60);return whole>0?`${whole}h ${mins}m`:`${mins} min`;}
function clamp(v,min=0,max=100){return Math.max(min,Math.min(max,finite(v)));}
function meterSignedW(m){if(!m?.online)return null;const mode=String(m.mode||'').toUpperCase();if(mode==='IMPORTING')return finite(m.importW);if(mode==='EXPORTING')return-finite(m.exportW);if(mode==='IDLE')return 0;return null;}
function fmtGridSigned(v){if(v==null||!Number.isFinite(Number(v)))return'UNKNOWN';const n=Number(v);if(Math.abs(n)<30)return'IDLE 0 W';return `${n>=0?'IMPORT':'EXPORT'} ${fmtPower(Math.abs(n))}`;}
function pkDateKey(ts=Date.now()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ts));}
function statusFromPct(p){return p>=100?'LIMIT':p>=90?'HIGH':p>=80?'WATCH':'NORMAL';}
function classFromPct(p){return p>=100?'danger':p>=80?'warn':'good';}
function updateAlertBadge(){set('alertCount',String(connectionAlertCount+smartAlertCount));}
setInterval(clock,1000); clock();

function activateDashboardView(button){
  if(!button)return;
  $$('.navtab').forEach((b)=>b.classList.toggle('active',b===button));
  $$('.view').forEach((v)=>v.classList.remove('active'));
  $(button.dataset.view)?.classList.add('active');
  $$('.mobileDock [data-mobile-view]').forEach((b)=>b.classList.toggle('active',b.dataset.mobileView===button.dataset.view||(b.dataset.mobileView==='command'&&button.dataset.view==='mission')));
  const isControl=button.dataset.view==='mission';document.body.classList.toggle('controlRoomActive',isControl);
  if(!isControl&&document.body.classList.contains('controlFocusMode'))setControlFocus(false);
  try{window.history.replaceState(null,'',`${location.pathname}?view=${encodeURIComponent(button.dataset.view)}`);}catch(_error){}
  requestAnimationFrame(drawAll);
}
$$('.navtab').forEach((button)=>button.addEventListener('click',()=>activateDashboardView(button)));
$$('.mobileDock [data-mobile-view]').forEach((button)=>button.addEventListener('click',()=>{
  const target=$q(`.navtab[data-view="${button.dataset.mobileView}"]`);if(target)activateDashboardView(target);window.scrollTo({top:0,behavior:'smooth'});
}));
const requestedView=new URLSearchParams(location.search).get('view');
if(requestedView&&$(requestedView)){const btn=$q(`.navtab[data-view="${requestedView.replace(/[^a-z0-9_-]/gi,'')}"]`);if(btn)btn.click();}
else if(matchMedia('(max-width:700px) and (orientation:portrait)').matches){$q('.navtab[data-view="command"]')?.click();}
$('ultraRibbonOpen')?.addEventListener('click',()=>{$q('.navtab[data-view="mission"]')?.click();window.scrollTo({top:0,behavior:'smooth'});});
$('ultraFullscreen')?.addEventListener('click',async()=>{try{if(!document.fullscreenElement)await document.documentElement.requestFullscreen();else await document.exitFullscreen();}catch(_error){}});

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


function aiPin(){return localStorage.getItem('rajaFrazAiPin')||'';}
function setAiBusy(busy){
  aiBusy=busy;
  const send=$('aiSend'); if(send)send.disabled=busy||!aiStatusData?.configured;
  $$('.aiQuick').forEach((b)=>b.disabled=busy||!aiStatusData?.configured);
  if($('aiTyping'))$('aiTyping').hidden=!busy;
}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function aiInlineMarkdown(value){
  let out=escapeHtml(value);
  out=out.replace(/`([^`]+)`/g,'<code>$1</code>');
  out=out.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  return out;
}
function renderAiMarkdown(value){
  const lines=String(value||'').replace(/\r/g,'').split('\n');let html='',list=null,firstText=true;
  const closeList=()=>{if(list){html+=`</${list}>`;list=null;}};
  for(const raw of lines){const line=raw.trim();if(!line){closeList();continue;}
    let m;if((m=line.match(/^###\s+(.+)/))){closeList();html+=`<h4>${aiInlineMarkdown(m[1])}</h4>`;firstText=false;continue;}
    if((m=line.match(/^##\s+(.+)/))){closeList();html+=`<h3>${aiInlineMarkdown(m[1])}</h3>`;firstText=false;continue;}
    if((m=line.match(/^#\s+(.+)/))){closeList();html+=`<div class="aiVerdict">${aiInlineMarkdown(m[1])}</div>`;firstText=false;continue;}
    if(/^---+$/.test(line)){closeList();html+='<div class="aiDivider"></div>';continue;}
    if((m=line.match(/^[-*]\s+(.+)/))){if(list!=='ul'){closeList();list='ul';html+='<ul>';}html+=`<li>${aiInlineMarkdown(m[1])}</li>`;firstText=false;continue;}
    if((m=line.match(/^\d+[.)]\s+(.+)/))){if(list!=='ol'){closeList();list='ol';html+='<ol>';}html+=`<li>${aiInlineMarkdown(m[1])}</li>`;firstText=false;continue;}
    if((m=line.match(/^>\s*(.+)/))){closeList();html+=`<blockquote>${aiInlineMarkdown(m[1])}</blockquote>`;firstText=false;continue;}
    closeList();const rendered=aiInlineMarkdown(line);html+=firstText?`<div class="aiVerdict">${rendered}</div>`:`<p>${rendered}</p>`;firstText=false;
  }
  closeList();return html||'<p>No response text returned.</p>';
}
function addAiMessage(role,text,{error=false}={}){
  const chat=$('aiChat'); if(!chat)return;
  const wrap=document.createElement('div');wrap.className=`aiMessage ${role}${error?' error':''}`;
  const avatar=document.createElement('div');avatar.className='aiAvatar';avatar.textContent=role==='user'?'YOU':'AI';
  const bubble=document.createElement('div');bubble.className='aiBubble';
  if(role==='assistant'&&!error)bubble.innerHTML=renderAiMarkdown(text);else bubble.textContent=String(text||'');
  wrap.append(avatar,bubble);chat.appendChild(wrap);chat.scrollTop=chat.scrollHeight;
}
function renderAiLiveContext(){
  const c=live?.systems?.combined||{};const meter=live?.meter;
  const connected=finite(live?.connected);const solar=fmtPower(c.solarW);const demand=fmtPower(c.siteDemandW);
  const grid=meter?.online?`${meter.mode||'UNKNOWN'} ${fmtPower(meter.powerW)}`:'Tuya offline';
  set('aiContextSummary',`${connected}/${monitoredSystemTarget()} live systems • Monitored solar ${solar} • Demand ${demand} • Grid ${grid} • ${live?.systems?.pv14000?'PV14000 live':'PV14000 logger pending'}`);
}
async function loadAiStatus(){
  try{
    const r=await fetch('/api/master/ai/status',{cache:'no-store'});const d=await r.json();aiStatusData=d;
    const pill=$('aiStatusPill');
    if(d.configured){set('aiStatusPill','✦ AI READY');pill?.classList.add('aiReady');pill?.classList.remove('aiOff');}
    else{set('aiStatusPill','AI NOT CONFIGURED');pill?.classList.add('aiOff');pill?.classList.remove('aiReady');}
    set('aiModelLabel',`${d.provider||'AI'} • ${d.model||'--'}${d.fallbackProvider?` • ${d.fallbackProvider} fallback`:''}${d.pinRequired?' • PIN protected':''}`);
    if($('aiPinBox'))$('aiPinBox').hidden=!d.pinRequired;
    if(d.pinRequired&&$('aiPinInput'))$('aiPinInput').value=aiPin();
    setAiBusy(false);
    if(!d.configured)addAiMessage('assistant','# 🤖 AI NOT CONFIGURED\nAdd **GEMINI_API_KEY** in Render Environment, then redeploy/restart the service.');
  }catch(error){
    aiStatusData={configured:false};set('aiStatusPill','AI STATUS ERROR');$('aiStatusPill')?.classList.add('aiOff');set('aiModelLabel',error.message);setAiBusy(false);
  }
}
async function askAi(message){
  const q=String(message||'').trim();if(!q||aiBusy)return;
  if(!aiStatusData?.configured){addAiMessage('assistant','AI is not configured on Render yet.',{error:true});return;}
  addAiMessage('user',q);aiHistory.push({role:'user',text:q});aiHistory=aiHistory.slice(-8);setAiBusy(true);set('aiUsage','Analyzing current Master telemetry…');
  try{
    const headers={'Content-Type':'application/json'};const pin=aiPin();if(pin)headers['X-AI-PIN']=pin;
    const r=await fetch('/api/master/ai/chat',{method:'POST',headers,body:JSON.stringify({message:q,history:aiHistory.slice(0,-1)})});
    const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||`AI HTTP ${r.status}`);
    addAiMessage('assistant',d.answer);aiHistory.push({role:'assistant',text:d.answer});aiHistory=aiHistory.slice(-8);
    const u=d.usage;const p=d.provider?`${d.provider} • `:'';const fb=d.fallbackUsed?' • fallback used':'';set('aiUsage',u?`${p}${d.model||'AI'} • ${finite(u.totalTokens)} tokens${fb} • live snapshot ${new Date(d.telemetryAt||Date.now()).toLocaleTimeString('en-GB',{hour12:false})}`:`${p}${d.model||'AI'} • response complete${fb}`);
  }catch(error){
    const msg=String(error.message||error);addAiMessage('assistant',msg,{error:true});set('aiUsage','AI request failed');
    if(msg.toLowerCase().includes('pin'))$('aiPinInput')?.focus();
  }finally{setAiBusy(false);}
}
$('aiForm')?.addEventListener('submit',(event)=>{event.preventDefault();const input=$('aiInput');const q=input?.value||'';if(input)input.value='';askAi(q);});
$('aiInput')?.addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();$('aiForm')?.requestSubmit();}});
$$('.aiQuick').forEach((button)=>button.addEventListener('click',()=>askAi(button.dataset.aiPrompt||button.textContent)));
$('aiClear')?.addEventListener('click',()=>{aiHistory=[];const chat=$('aiChat');if(chat)chat.innerHTML='';addAiMessage('assistant','Chat cleared. I will use a fresh live telemetry snapshot for your next question.');set('aiUsage','No AI request yet');});
$('aiSavePin')?.addEventListener('click',()=>{const pin=String($('aiPinInput')?.value||'').trim();if(pin)localStorage.setItem('rajaFrazAiPin',pin);else localStorage.removeItem('rajaFrazAiPin');addAiMessage('assistant',pin?'AI PIN saved in this browser.':'AI PIN cleared from this browser.');});

function notifyPin(){return localStorage.getItem('rajaFrazAiPin')||'';}
function notifyHeaders(){const h={'Content-Type':'application/json'};const pin=notifyPin();if(pin){h['X-Notify-Pin']=pin;h['X-AI-PIN']=pin;}return h;}
function notifyToast(message,type='ok'){const el=$('notifyToast');if(!el)return;el.textContent=message;el.className=`notifyToast ${type}`;el.hidden=false;clearTimeout(notifyToast._timer);notifyToast._timer=setTimeout(()=>{el.hidden=true;},5000);}
function setNotifyState(id,label,state=''){const el=$(id);if(!el)return;el.textContent=label;el.classList.remove('ready','partial','off');if(state)el.classList.add(state);}
function base64UrlToUint8Array(value){const padding='='.repeat((4-value.length%4)%4);const base64=(value+padding).replace(/-/g,'+').replace(/_/g,'/');const raw=atob(base64);return Uint8Array.from([...raw].map((c)=>c.charCodeAt(0)));}
async function getPushRegistration(){if(!('serviceWorker'in navigator))throw new Error('Service Worker is not supported in this browser.');return navigator.serviceWorker.register('/sw.js',{scope:'/'});}
async function currentPushSubscription(){if(!('serviceWorker'in navigator)||!('PushManager'in window))return null;const reg=await getPushRegistration();return reg.pushManager.getSubscription();}
async function showLocalBrowserNotification(title,body,{tag='raja-fraz-local'}={}){if(!('Notification'in window))throw new Error('Browser notifications are not supported.');if(Notification.permission!=='granted')throw new Error('Browser notification permission is not granted.');const reg=await getPushRegistration();await reg.showNotification(title,{body,tag,icon:'/assets/raja-fraz-logo.jpeg',badge:'/assets/raja-fraz-logo.jpeg',data:{url:location.origin+'/?view=notifications'}});}
async function loadNotificationHistory(){try{const r=await fetch('/api/master/notifications/history?limit=20',{cache:'no-store'});const d=await r.json();const box=$('notifyHistory');if(!box)return;if(!r.ok||!d.ok)throw new Error(d.error||`HTTP ${r.status}`);if(!Array.isArray(d.events)||!d.events.length){box.innerHTML='<div class="notifyHistoryEmpty">No notification history yet.</div>';return;}box.innerHTML=d.events.map((e)=>{const ts=new Date(e.created_at||Date.now()).toLocaleString('en-GB',{timeZone:'Asia/Karachi',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:false});const channels=Array.isArray(e.channels)?e.channels.map(x=>x.channel).filter(Boolean).join(', '):'';return `<div class="notifyHistoryItem ${escapeHtml(e.severity||'info')}"><b>${escapeHtml((e.is_recovery?'✅ ':'')+(e.title||'Alert'))}</b><span>${escapeHtml(ts)}${channels?` • ${escapeHtml(channels)}`:''}</span><p>${escapeHtml(e.message||'')}</p></div>`;}).join('');}catch(error){const box=$('notifyHistory');if(box)box.innerHTML=`<div class="notifyHistoryEmpty">History unavailable: ${escapeHtml(error.message)}</div>`;}}
async function renderBrowserNotifyState(){const supported=('Notification'in window)&&('serviceWorker'in navigator);const localEnabled=localStorage.getItem('rajaFrazLocalNotifications')==='1';let sub=null;try{sub=await currentPushSubscription();}catch{}const remoteReady=Boolean(notifyStatusData?.channels?.webPush?.configured);if(!supported){setNotifyState('notifyBrowserState','UNSUPPORTED','off');set('notifyBrowserSub','This browser does not support required notification APIs.');return;}if(sub){setNotifyState('notifyBrowserState','PUSH ACTIVE','ready');set('notifyBrowserSub',`True Web Push subscribed • server subscriptions ${notifyStatusData?.channels?.webPush?.subscriptions??'--'}`);}else if(localEnabled&&Notification.permission==='granted'){setNotifyState('notifyBrowserState',remoteReady?'LOCAL ONLY':'LOCAL ONLY','partial');set('notifyBrowserSub',remoteReady?'Permission granted; click Enable again to create the server Push subscription.':'Local alerts work while this dashboard is open. Add VAPID keys for background Web Push.');}else{setNotifyState('notifyBrowserState',remoteReady?'READY TO ENABLE':'LOCAL AVAILABLE',remoteReady?'partial':'partial');set('notifyBrowserSub',remoteReady?'VAPID configured. Click Enable browser alerts.':'No VAPID keys yet; local browser alerts can still work while the dashboard is open.');}}
function renderNotifyPolicy(){const p=notifyStatusData?.policy||{};const rules=[['🌙 Night import',`${Math.round(finite(p.nightImportLimitW,5000))} W • warning at 90%`],['☀ Day export',`${Math.round(finite(p.dayExportLimitW,6000))} W • warning at 90%`],['📡 Connectivity',`PV / Matrix / Tuya offline or >${Math.round(finite(p.staleSeconds,180))}s stale`],['🔋 Battery',`Alert below ${Math.round(finite(p.batteryLowPct,20))}% SOC`],['🌡 Temperature',`Alert above ${Math.round(finite(p.temperatureLimitC,65))}°C`],['↔ Meter match',`Alert above ${Math.round(finite(p.reconciliationAlertW,500))} W difference`],['⏱ Anti-spam',`${Math.round(finite(p.cooldownMinutes,30))} min repeat cooldown`],['🔒 Safety','Notifications are read-only; no breaker/inverter writes']];const box=$('notifyPolicy');if(box)box.innerHTML=rules.map(([a,b])=>`<div class="notifyRule"><b>${escapeHtml(a)}</b><small>${escapeHtml(b)}</small></div>`).join('');set('notifyPolicySummary',`${Math.round(finite(p.nightImportLimitW,5000))/1000} kW night • ${Math.round(finite(p.dayExportLimitW,6000))/1000} kW day • ${Math.round(finite(p.batteryLowPct,20))}% battery • ${Math.round(finite(p.temperatureLimitC,65))}°C temp`);}
async function loadNotificationStatus(){try{const r=await fetch('/api/master/notifications/status',{cache:'no-store'});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||`HTTP ${r.status}`);notifyStatusData=d;const c=d.channels||{};const configured=['webPush','telegram','whatsapp','sms'].filter(k=>c[k]?.configured);set('notifyStatusPill',configured.length?'🔔 ALERTS READY':'SETUP AVAILABLE');$('notifyStatusPill')?.classList.toggle('good',configured.length>0);set('notifyChannelSummary',configured.length?`${configured.length}/4 remote channels configured`:'Local browser alerts available now');set('notifyDeliveryState',configured.length?`${configured.length} REMOTE CHANNEL${configured.length===1?'':'S'} READY`:'LOCAL WEB ALERTS ONLY');set('notifyPinState',d.pinRequired?'PIN PROTECTED':'NO PIN SET');setNotifyState('notifyTelegramState',c.telegram?.configured?'READY':'SETUP','telegram'&&c.telegram?.configured?'ready':'partial');setNotifyState('notifyWhatsAppState',c.whatsapp?.configured?'READY':'SETUP',c.whatsapp?.configured?'ready':'partial');setNotifyState('notifySmsState',c.sms?.configured?'READY':'SETUP',c.sms?.configured?'ready':'partial');if($('notifyTestTelegram'))$('notifyTestTelegram').disabled=!c.telegram?.configured;if($('notifyTestWhatsApp'))$('notifyTestWhatsApp').disabled=!c.whatsapp?.configured;if($('notifyTestSms'))$('notifyTestSms').disabled=!c.sms?.configured;renderNotifyPolicy();await renderBrowserNotifyState();await loadNotificationHistory();$('notifyNavBadge')?.toggleAttribute('hidden',false);if($('notifyNavBadge'))$('notifyNavBadge').textContent=configured.length?String(configured.length):'•';}catch(error){notifyStatusData=null;set('notifyStatusPill','STATUS ERROR');set('notifyChannelSummary',error.message);}}
async function enableBrowserNotifications(){try{if(!('Notification'in window))throw new Error('Browser notifications are not supported here.');const permission=Notification.permission==='granted'?'granted':await Notification.requestPermission();if(permission!=='granted')throw new Error('Notification permission was not granted.');localStorage.setItem('rajaFrazLocalNotifications','1');const remote=notifyStatusData?.channels?.webPush;if(remote?.configured&&remote.publicKey&&('PushManager'in window)){const reg=await getPushRegistration();let sub=await reg.pushManager.getSubscription();if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:base64UrlToUint8Array(remote.publicKey)});const r=await fetch('/api/master/notifications/subscribe',{method:'POST',headers:notifyHeaders(),body:JSON.stringify({subscription:sub.toJSON()})});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||`Subscribe HTTP ${r.status}`);notifyToast('True Web Push enabled on this browser.','ok');}else notifyToast('Local browser alerts enabled. Add VAPID keys later for background Web Push.','ok');await loadNotificationStatus();}catch(error){notifyToast(error.message,'error');}}
async function disableBrowserNotifications(){try{localStorage.removeItem('rajaFrazLocalNotifications');const sub=await currentPushSubscription();if(sub){await fetch('/api/master/notifications/unsubscribe',{method:'POST',headers:notifyHeaders(),body:JSON.stringify({endpoint:sub.endpoint})}).catch(()=>{});await sub.unsubscribe();}notifyToast('Browser alerts disabled on this device.','ok');await loadNotificationStatus();}catch(error){notifyToast(error.message,'error');}}
async function testNotification(channel){try{if(channel==='webPush'&&!notifyStatusData?.channels?.webPush?.configured){await showLocalBrowserNotification('🔔 Raja Fraz Solar Test','Local browser notifications are working.',{tag:'raja-fraz-test'});notifyToast('Local browser notification sent.','ok');return;}const r=await fetch('/api/master/notifications/test',{method:'POST',headers:notifyHeaders(),body:JSON.stringify({channel})});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||`Test HTTP ${r.status}`);const failed=(d.results||[]).filter(x=>x.ok===false&&!x.skipped);notifyToast(failed.length?`Test completed with ${failed.length} channel error(s).`:'Notification test sent.','ok');await loadNotificationHistory();}catch(error){notifyToast(error.message,'error');}}
async function runNotificationCheck(){try{const r=await fetch('/api/master/notifications/check',{method:'POST',headers:notifyHeaders(),body:'{}'});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||`Check HTTP ${r.status}`);notifyToast(`Alert check complete • ${finite(d.activeAlerts)} active condition(s).`,'ok');await loadNotificationHistory();}catch(error){notifyToast(error.message,'error');}}
function localAlertKey(alert){let h=0;for(const ch of String(alert.level+'|'+alert.text)){h=((h<<5)-h)+ch.charCodeAt(0);h|=0;}return `rajaFrazLocalAlert:${h}`;}
function maybeLocalBrowserAlerts(alerts){if(localStorage.getItem('rajaFrazLocalNotifications')!=='1'||!('Notification'in window)||Notification.permission!=='granted')return;const cooldown=(finite(notifyStatusData?.policy?.cooldownMinutes,30))*60*1000;for(const alert of alerts.filter(a=>a.level==='danger'||a.level==='warn')){const key=localAlertKey(alert);const prev=Number(localStorage.getItem(key)||0);if(Date.now()-prev<cooldown)continue;localStorage.setItem(key,String(Date.now()));showLocalBrowserNotification(alert.level==='danger'?'🚨 Raja Fraz Solar Alert':'⚠️ Raja Fraz Solar Watch',alert.text,{tag:key.slice(-24)}).catch(()=>{});}}
$('notifyEnableBrowser')?.addEventListener('click',enableBrowserNotifications);
$('notifyDisableBrowser')?.addEventListener('click',disableBrowserNotifications);
$('notifyTestBrowser')?.addEventListener('click',()=>testNotification('webPush'));
$('notifyTestTelegram')?.addEventListener('click',()=>testNotification('telegram'));
$('notifyTestWhatsApp')?.addEventListener('click',()=>testNotification('whatsapp'));
$('notifyTestSms')?.addEventListener('click',()=>testNotification('sms'));
$('notifyTestAll')?.addEventListener('click',()=>testNotification('all'));
$('notifyCheckNow')?.addEventListener('click',runNotificationCheck);

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
    renderIntelligenceCenter();
  }catch(_error){set('historyChip','History • unavailable');}
}
async function loadAnalytics(){
  try{
    const response=await fetch('/api/master/analytics',{cache:'no-store'});
    analytics=await response.json();
    renderIntelligenceCenter();
    renderCommandView();
    renderOperatorTools();
    if(live){const s=live.systems||{};renderControlRoom(s.pv14000,s.pv9000,s.matrix,s.combined||{},live.meter||null);}
    drawDailyTimeline();
  }catch(_error){analytics=null;set('intelStatus','ANALYTICS OFFLINE');}
}
async function loadTimelineHistory(){
  try{
    const response=await fetch('/api/master/history?hours=24',{cache:'no-store'});
    timelineHistory=await response.json();
    drawDailyTimeline();
    renderIntelligenceCenter();
  }catch(_error){}
}
async function loadTodayEnergy(){
  if(activeEnergyPeriod==='T' && energy){todayEnergy=energy;renderIntelligenceCenter();renderOperatorTools();return;}
  try{const r=await fetch('/api/master/energy?period=T',{cache:'no-store'});todayEnergy=await r.json();renderIntelligenceCenter();renderOperatorTools();}catch(_error){}
}
async function loadEnergy(period='T'){
  try{
    const response=await fetch(`/api/master/energy?period=${encodeURIComponent(period)}`,{cache:'no-store'});
    energy=await response.json();
    if(period==='T') todayEnergy=energy;
    renderEnergy();
    renderIntelligenceCenter();
    renderOperatorTools();
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

function powerSmartMessage(id,text='',kind='error'){
  const box=$(id);if(!box)return;box.hidden=!text;box.textContent=text;box.classList.toggle('ok',kind==='ok');
}
function powerSmartSetBusy(busy,label='Connecting…'){
  powerSmartBusy=busy;const button=$('powerSmartConnectButton');if(button){button.disabled=busy;button.textContent=busy?label:'Connect official account';}
  ['powerSmartRefresh','powerSmartReload','powerSmartDisconnect','powerSmartMeterSelect'].forEach(id=>{const el=$(id);if(el)el.disabled=busy;});
}
function powerSmartSessionText(expiresAt){
  if(!expiresAt)return'--';const ms=new Date(expiresAt).getTime()-Date.now();if(!Number.isFinite(ms)||ms<=0)return'EXPIRED';const hours=Math.floor(ms/3600000),minutes=Math.max(0,Math.floor(ms%3600000/60000));return hours?`${hours}h ${minutes}m`:`${minutes} min`;
}
function renderPowerSmartState(){
  const connected=Boolean(powerSmartState?.connected);const login=$('powerSmartLoginPanel'),panel=$('powerSmartConnectedPanel');if(login)login.hidden=connected;if(panel)panel.hidden=!connected;
  set('powerSmartStatus',connected?'CONNECTED':'NOT CONNECTED');$('powerSmartStatus')?.classList.toggle('connected',connected);set('powerSmartNavState',connected?'LIVE':'NEW');
  set('powerSmartFreshness',connected?(powerSmartState.lastFetchAt?`Updated ${ageText(powerSmartState.lastFetchAt)}`:'Account connected'):'Sign in once per server session');
  if(!connected)return;
  set('powerSmartAccountName',powerSmartState.accountName||'Power Smart User');set('powerSmartMeterRef',powerSmartState.selectedMeterRef||'Meter');set('powerSmartCategory',powerSmartState.selectedCategory||'--');set('powerSmartSession',powerSmartSessionText(powerSmartState.expiresAt));
  const select=$('powerSmartMeterSelect');if(select){const selected=powerSmartState.selectedMeterId;select.replaceChildren();for(const meter of powerSmartState.meters||[]){const option=document.createElement('option');option.value=meter.id;option.textContent=`${meter.refMasked}${meter.isDefault?' • default':''}${meter.category?` • ${meter.category}`:''}`;option.selected=meter.id===selected;select.appendChild(option);}}
}
function renderPowerSmartBars(rows=[]){
  const box=$('powerSmartBars');if(!box)return;box.replaceChildren();const usable=rows.filter(row=>Number.isFinite(Number(row.kwh))).slice(-12);if(!usable.length){const empty=document.createElement('div');empty.className='powerSmartEmpty';empty.textContent='PITC connected, but no monthly consumption rows were returned for this meter.';box.appendChild(empty);return;}
  const max=Math.max(1,...usable.map(row=>Number(row.kwh)));for(const row of usable){const bar=document.createElement('div');bar.className='powerSmartBar';const value=document.createElement('b');value.textContent=`${Number(row.kwh).toFixed(1)} kWh`;const column=document.createElement('i');column.style.setProperty('--bar-height',`${Math.max(4,Number(row.kwh)/max*100)}%`);const label=document.createElement('span');label.textContent=[row.label,row.year].filter(Boolean).join(' ');bar.append(value,column,label);box.appendChild(bar);}
}
function renderPowerSmartData(){
  if(!powerSmartData){set('powerSmartCurrentKwh','--');set('powerSmartRecordCount','--');renderPowerSmartBars([]);return;}
  const current=powerSmartData.current||powerSmartData.latest;set('powerSmartCurrentKwh',current?.kwh==null?'--':`${Number(current.kwh).toFixed(2)} kWh`);set('powerSmartCurrentLabel',current?.label||'Latest official record');set('powerSmartRecordCount',String(finite(powerSmartData.records)));set('powerSmartUpdated',powerSmartData.refreshedAt?new Date(powerSmartData.refreshedAt).toLocaleString('en-PK',{timeZone:'Asia/Karachi'}):'--');
  renderPowerSmartBars(powerSmartData.history||[]);renderPowerSmartComparison();
}
function renderPowerSmartComparison(){
  const meter=live?.meter||null,c=live?.systems?.combined||{};const physical=meterSignedW(meter);set('powerSmartTuyaPower',physical==null?'OFFLINE':fmtGridSigned(physical));set('powerSmartTuyaMode',meter?.online?`${meter.mode||'LIVE'} • ${ageText(meter.updatedAt)}`:'Independent physical meter unavailable');set('powerSmartTuyaDetail',physical==null?'Tuya meter unavailable':`${fmtGridSigned(physical)} • ${finite(meter.voltage).toFixed(1)} V`);set('powerSmartInverterDetail',live?fmtGridSigned(finite(c.gridW)):'Waiting for PV9000');
}
async function loadPowerSmartStatus(){
  try{const response=await fetch('/api/master/powersmart/status',{cache:'no-store',credentials:'same-origin'});const data=await response.json();powerSmartState=data;renderPowerSmartState();if(data.connected)await loadPowerSmartData(false);}catch(error){powerSmartState={connected:false};renderPowerSmartState();powerSmartMessage('powerSmartLoginMessage',`Power Smart bridge unavailable: ${error.message}`);}
}
async function loadPowerSmartData(force=false){
  if(!powerSmartState.connected||powerSmartBusy)return;powerSmartSetBusy(true,'Loading…');powerSmartMessage('powerSmartDataMessage','');
  try{const response=await fetch(`/api/master/powersmart/data${force?'?fresh=1':''}`,{cache:'no-store',credentials:'same-origin'});const data=await response.json();if(!response.ok||!data.ok)throw Object.assign(new Error(data.error||'Power Smart data failed'),{status:response.status});powerSmartData=data;powerSmartState={...powerSmartState,lastFetchAt:Date.now()};renderPowerSmartState();renderPowerSmartData();powerSmartMessage('powerSmartDataMessage',force?'Official data refreshed.':'','ok');}
  catch(error){if(error.status===401){powerSmartState={connected:false};powerSmartData=null;renderPowerSmartState();}else powerSmartMessage('powerSmartDataMessage',error.message);}
  finally{powerSmartSetBusy(false);}
}
async function connectPowerSmart(event){
  event?.preventDefault();if(powerSmartBusy)return;const email=$('powerSmartEmail')?.value.trim(),password=$('powerSmartPassword')?.value||'',cnic=$('powerSmartCnic')?.value.trim()||'';powerSmartMessage('powerSmartLoginMessage','');powerSmartSetBusy(true);
  try{const response=await fetch('/api/master/powersmart/connect',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,cnic})});const data=await response.json();if(!response.ok||!data.connected)throw new Error(data.error||'Power Smart sign-in failed.');powerSmartState=data;powerSmartData=data.data||null;if($('powerSmartPassword'))$('powerSmartPassword').value='';renderPowerSmartState();renderPowerSmartData();if(data.dataError)powerSmartMessage('powerSmartDataMessage',`Account connected. Consumption feed: ${data.dataError}`);else powerSmartMessage('powerSmartDataMessage','Power Smart account connected securely.','ok');}
  catch(error){if($('powerSmartPassword'))$('powerSmartPassword').value='';powerSmartMessage('powerSmartLoginMessage',error.message);}
  finally{powerSmartSetBusy(false);}
}
async function selectPowerSmartMeter(){
  if(powerSmartBusy)return;const meterId=$('powerSmartMeterSelect')?.value;if(!meterId)return;powerSmartSetBusy(true,'Switching…');powerSmartMessage('powerSmartDataMessage','');try{const response=await fetch('/api/master/powersmart/select-meter',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({meterId})});const data=await response.json();if(!response.ok||!data.connected)throw new Error(data.error||'Meter switch failed.');powerSmartState=data;powerSmartData=data.data||null;renderPowerSmartState();renderPowerSmartData();}catch(error){powerSmartMessage('powerSmartDataMessage',error.message);}finally{powerSmartSetBusy(false);}
}
async function disconnectPowerSmart(){
  if(powerSmartBusy)return;powerSmartSetBusy(true,'Disconnecting…');try{await fetch('/api/master/powersmart/disconnect',{method:'POST',credentials:'same-origin'});}catch(_error){}powerSmartState={connected:false};powerSmartData=null;renderPowerSmartState();renderPowerSmartData();powerSmartSetBusy(false);
}
function initPowerSmart(){
  $('powerSmartLoginForm')?.addEventListener('submit',connectPowerSmart);$('powerSmartRefresh')?.addEventListener('click',()=>loadPowerSmartData(true));$('powerSmartReload')?.addEventListener('click',()=>loadPowerSmartData(true));$('powerSmartDisconnect')?.addEventListener('click',disconnectPowerSmart);$('powerSmartMeterSelect')?.addEventListener('change',selectPowerSmartMeter);renderPowerSmartState();
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
  renderEnergyFlow(a,b,u,c,m);
  renderIntelligenceCenter();
  renderCommandView();
  renderOperatorTools();
  renderAiLiveContext();
  renderUltraDeck(a,b,u,c,m);
  renderControlRoom(a,b,u,c,m);
  renderPowerSmartComparison();
  drawAll();
}
function setState(id,online){set(id,online?'ONLINE':'OFFLINE');const el=$(id);el?.classList.toggle('online',Boolean(online));el?.classList.remove('pending');}
function setPendingState(id,label='LOGGER PENDING'){
  set(id,label);const el=$(id);if(!el)return;el.classList.remove('online');el.classList.add('pending');
}
function renderStatus(a,b,u,c,m){
  const target=monitoredSystemTarget();const count=[a,b,u].filter(Boolean).length;
  set('systemsOnline',`${count}/${target}`);
  if(a){setState('pv14000Online',true);setState('pv14000PageStatus',true);}else{setPendingState('pv14000Online');setPendingState('pv14000PageStatus');}
  setState('pv9000Online',b); setState('pv9000PageStatus',b);
  setState('matrixOnline',u); setState('matrixPageStatus',u);
  set('combinedPageStatus',count===target?'MONITORED SYSTEMS LIVE':`${count}/${target} LIVE`);
  $('combinedPageStatus')?.classList.toggle('online',count===target);
  set('pv14000Fresh',a?ageText(a.updatedAt):'WiFi logger moved to PV9000 • new logger pending');
  set('pv9000Fresh',b?`${ageText(b.updatedAt)} • reassigned WiFi logger`:'Reassigned WiFi logger unavailable');
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
  if(!a){
    set('pv14000SolarHero','NOT MONITORED');set('pv14000PvSplit','6.78 kWp physical array • telemetry excluded');
    set('pv14000LoadGaugeText','--');set('pv14000SolarGaugeText','--');set('pv14000GridGaugeText','--');set('pv14000GridMode','LOGGER PENDING');set('pv14000GridV','-- V');set('pv14000TodaySolar','NOT MONITORED');set('pv14000Temp','--');
    gauge('pv14000LoadGauge',0,10000);gauge('pv14000SolarGauge',0,6780);gauge('pv14000GridGauge',0,10000,'grid');return;
  }
  set('pv14000SolarHero',fmtPower(a.solarW)); set('pv14000PvSplit',`PV1 ${fmtPower(a.pv1W)} • PV2 ${fmtPower(a.pv2W)}`);
  set('pv14000LoadGaugeText',fmtPower(a.loadW)); set('pv14000SolarGaugeText',fmtPower(a.solarW)); set('pv14000GridGaugeText',fmtPower(a.gridW));
  set('pv14000GridMode',gridMode(a.gridW)); set('pv14000GridV',`${finite(a.gridV).toFixed(1)} V`); set('pv14000TodaySolar',fmtKwh(a.todaySolar)); set('pv14000Temp',`${Math.round(finite(a.temp))}°C`);
  gauge('pv14000LoadGauge',a.loadW,10000); gauge('pv14000SolarGauge',a.solarW,6780); gauge('pv14000GridGauge',a.gridW,10000,'grid');
}
function renderPv9000(b){
  if(!b){blank(['pv9000SolarHero','pv9000PvSplit','pv9000LoadGaugeText','pv9000SolarGaugeText','pv9000GridGaugeText','pv9000GridMode','pv9000GridV','pv9000SmartGaugeText','pv9000TodaySolar','pv9000Temp']);return;}
  set('pv9000SolarHero',fmtPower(b.solarW)); set('pv9000PvSplit',`STRING 1 ${fmtPower(b.pv1W)} • 8×545 W • STRING 2 NOT IN USE`);
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
  gauge('combinedSolarGauge',c.solarW,monitoredPvCapacityW()); gauge('combinedLoadGauge',c.siteDemandW,16000); gauge('combinedGridGauge',c.gridW,16000,'grid');
  const total=finite(c.solarW);
  set('pv14000Share',a&&total>0?`${Math.round(finite(a.solarW)/total*100)}%`:'UNMONITORED');
  set('pv9000Share',b&&total>0?`${Math.round(finite(b.solarW)/total*100)}% LIVE`:'--%');
  set('masterBattery',u?.batteryPct!=null?`${Math.round(u.batteryPct)}%`:'--');
  set('masterHealth',[a,b,u].filter(Boolean).length===monitoredSystemTarget()?'Excellent · monitored':'Partial');
}
function renderQuickTotals(c){
  set('todaySolar',fmtKwh(c.todaySolar)); set('todayLoad',fmtKwh(c.todayLoad)); set('todayImport',fmtKwh(c.todayImport)); set('todayExport',fmtKwh(c.todayExport));
  if(energy)renderEnergy();
}

function setFlowNodeState(id, online, active=false){
  const el=$(id); if(!el)return;
  el.classList.toggle('offline', !online);
  el.classList.remove('pending');
  el.classList.toggle('active', Boolean(active));
}
function setFlowLine(id, active, direction='forward', modeClass=''){
  const el=$(id); if(!el)return;
  el.classList.toggle('active', Boolean(active));
  el.classList.toggle('reverse', direction==='reverse');
  ['importing','exporting','charging','discharging'].forEach(c=>el.classList.remove(c));
  if(modeClass)el.classList.add(modeClass);
}
function setFlowLabel(id, className=''){
  const raw=$(id); if(!raw)return;
  const el=raw.classList.contains('flowLabel')?raw:(raw.closest('.flowLabel')||raw);
  el.classList.remove('off','gridImport','gridExport','solar','smart','ups','batteryCharge','batteryDischarge');
  if(className)className.split(' ').forEach(c=>c&&el.classList.add(c));
}
function flowGridFromMeterOrInverter(c,m){
  if(m?.online){
    const importW=finite(m.importW), exportW=finite(m.exportW);
    if(importW>30)return{mode:'IMPORTING',watts:importW,source:'Tuya physical meter'};
    if(exportW>30)return{mode:'EXPORTING',watts:exportW,source:'Tuya physical meter'};
    return{mode:'IDLE',watts:0,source:'Tuya physical meter'};
  }
  const w=finite(c?.gridW);
  if(Math.abs(w)<30)return{mode:'IDLE',watts:0,source:'Inverter estimate'};
  return{mode:w>=0?'IMPORTING':'EXPORTING',watts:Math.abs(w),source:'Inverter estimate'};
}
function renderEnergyFlow(a,b,u,c={},m=null){
  const pv14000Solar=finite(a?.solarW), pv9000Solar=finite(b?.solarW), totalSolar=finite(c?.solarW,pv14000Solar+pv9000Solar);
  const demand=finite(c?.siteDemandW,finite(a?.loadW)+finite(b?.loadW));
  const smart=finite(c?.smartLoadW,finite(b?.smartLoadW));
  const grid=flowGridFromMeterOrInverter(c,m);
  const matrixIn=finite(u?.acInputW);
  const matrixLoad=finite(u?.loadW);
  const batteryW=finite(u?.batteryW);
  const batteryMode=batteryFlowMode(batteryW,u?.batteryMode);
  const batteryActive=Math.abs(batteryW)>20;

  set('flowSolarBadge',fmtPower(totalSolar));
  set('flowDemandBadge',fmtPower(demand));
  set('flowGridBadge',`${grid.mode==='IDLE'?'IDLE':grid.mode} ${fmtPower(grid.watts)}`);
  set('flowBatteryBadge',u?`${fmtPct(u.batteryPct)} • ${batteryMode}`:'--');

  set('flowPv14000Value',a?fmtPower(pv14000Solar):'LOGGER PENDING');
  set('flowPv14000Sub',a?`Load ${fmtPower(a.loadW)} • ${fmtPower(a.gridW)} grid`:'WiFi logger moved • telemetry pending');
  set('flowPv9000Value',b?fmtPower(pv9000Solar):'--');
  set('flowPv9000Sub',b?`1 string • 8×545 W • Smart ${fmtPower(finite(b.smartLoadW))}`:'Reassigned WiFi logger unavailable');
  set('flowGridValue',grid.mode==='IDLE'?'0 W':fmtPower(grid.watts));
  set('flowGridSub',`${grid.mode} • ${grid.source}`);
  set('flowMeterValue',m?.online?String(m.mode||grid.mode).toUpperCase():'OFFLINE');
  set('flowMeterSub',m?.online?`${finite(m.voltage).toFixed(1)} V • ${finite(m.currentA).toFixed(2)} A`:'Tuya meter unavailable');
  set('flowBusValue',fmtPower(totalSolar));
  set('flowBusSub',`PV9000 monitored • Demand ${fmtPower(demand)} • Grid ${grid.mode}`);
  set('flowSiteLoadValue',fmtPower(demand));
  set('flowSmartValue',fmtPower(smart));
  set('flowMatrixValue',u?fmtPower(matrixIn):'--');
  set('flowMatrixSub',u?`UPS output ${fmtPower(matrixLoad)}`:'Matrix API offline');
  set('flowBackupValue',u?fmtPower(matrixLoad):'--');
  set('flowBatteryValue',u?fmtPct(u.batteryPct):'--');
  set('flowBatterySub',u?`${batteryMode} • ${fmtSignedPower(batteryW)}`:'Battery unavailable');

  set('flowPv14000LineText',a?fmtPower(pv14000Solar):'LOGGER PENDING');
  set('flowPv9000LineText',b?fmtPower(pv9000Solar):'--');
  set('flowGridLineTitle',grid.mode==='EXPORTING'?'Site → Grid':'Grid → Site');
  set('flowGridLineText',grid.mode==='IDLE'?'0 W':fmtPower(grid.watts));
  set('flowSmartLineText',fmtPower(smart));
  set('flowUpsInLineText',u?fmtPower(matrixIn):'--');
  set('flowUpsOutLineText',u?fmtPower(matrixLoad):'--');
  set('flowBatteryLineTitle',batteryMode==='DISCHARGING'?'Battery → Matrix':'Matrix → Battery');
  set('flowBatteryLineText',u?fmtSignedPower(batteryW):'--');

  const physicalSigned=meterSignedW(m);
  const balanceError=physicalSigned==null?null:totalSolar+physicalSigned-demand;
  set('flowBalanceSolar',fmtPower(totalSolar));
  set('flowBalanceGrid',physicalSigned==null?fmtGridSigned(c?.gridW):fmtGridSigned(physicalSigned));
  set('flowBalanceDemand',fmtPower(demand));
  set('flowBalanceError',balanceError==null?'--':fmtSignedPower(balanceError));
  const balanceAbs=balanceError==null?Infinity:Math.abs(balanceError);
  const balanceClass=balanceAbs<250?'good':balanceAbs<750?'warn':'danger';
  const balanceBox=$('flowBalanceError')?.closest('.balanceCheck');
  if(balanceBox){balanceBox.classList.remove('good','warn','danger');balanceBox.classList.add(balanceClass);}
  set('flowBalanceStatus',balanceError==null?'Tuya direction unavailable':balanceAbs<250?'Excellent accounting match':balanceAbs<750?'Small measurement difference':'Check CT / meter reconciliation');

  setFlowNodeState('flowNodePv14000',Boolean(a),pv14000Solar>30);
  $('flowNodePv14000')?.classList.toggle('pending',!a);
  setFlowNodeState('flowNodePv9000',Boolean(b),pv9000Solar>30 || smart>30 || matrixIn>30);
  setFlowNodeState('flowNodeGrid',Boolean(m?.online)||Math.abs(finite(c?.gridW))>0,grid.watts>30);
  setFlowNodeState('flowNodeMeter',Boolean(m?.online),grid.watts>30);
  setFlowNodeState('flowNodeBus',true,totalSolar>30 || demand>30 || grid.watts>30);
  setFlowNodeState('flowNodeSiteLoad',true,demand>30);
  setFlowNodeState('flowNodeSmartLoad',Boolean(b)||smart>0,smart>30);
  setFlowNodeState('flowNodeMatrix',Boolean(u),matrixIn>30 || matrixLoad>30 || batteryActive);
  setFlowNodeState('flowNodeBackup',Boolean(u),matrixLoad>30);
  setFlowNodeState('flowNodeBattery',Boolean(u),batteryActive);

  setFlowLine('flowPv14000Line',pv14000Solar>30,'forward','');
  setFlowLine('flowPv9000Line',pv9000Solar>30,'forward','');
  const gridActive=grid.watts>30, gridExport=grid.mode==='EXPORTING';
  setFlowLine('flowGridMeterLine',gridActive,gridExport?'reverse':'forward',gridExport?'exporting':'importing');
  setFlowLine('flowMeterBusLine',gridActive,gridExport?'reverse':'forward',gridExport?'exporting':'importing');
  setFlowLine('flowSiteLoadLine',demand>30,'forward','');
  setFlowLine('flowPv9000SmartLine',smart>30,'forward','');
  setFlowLine('flowPv9000MatrixLine',matrixIn>30,'forward','');
  setFlowLine('flowMatrixBackupLine',matrixLoad>30,'forward','');
  setFlowLine('flowBatteryLine',batteryActive,batteryMode==='CHARGING'?'reverse':'forward',batteryMode==='DISCHARGING'?'discharging':'charging');

  setFlowLabel('flowPv14000LineText',pv14000Solar>30?'solar':'off');
  setFlowLabel('flowPv9000LineText',pv9000Solar>30?'solar':'off');
  setFlowLabel('flowGridLineText',gridActive?(gridExport?'gridExport':'gridImport'):'off');
  setFlowLabel('flowSmartLineText',smart>30?'smart':'off');
  setFlowLabel('flowUpsInLineText',matrixIn>30?'smart':'off');
  setFlowLabel('flowUpsOutLineText',matrixLoad>30?'ups':'off');
  setFlowLabel('flowBatteryLineText',batteryActive?(batteryMode==='DISCHARGING'?'batteryDischarge':'batteryCharge'):'off');

  const seqSolar = totalSolar>30 ? `${fmtPower(totalSolar)} PV9000 solar • PV14000 unmonitored` : 'PV9000 waiting for solar • PV14000 logger pending';
  const seqGrid = grid.mode==='IDLE' ? 'Grid exchange is idle' : `${grid.mode} ${fmtPower(grid.watts)} via Tuya meter`;
  const seqPv9000 = `${fmtPower(smart)} smart load • ${u?fmtPower(matrixIn):'--'} UPS AC input`;
  const seqUps = u ? `${fmtPower(matrixLoad)} backup load • battery ${fmtPct(u.batteryPct)} ${batteryMode.toLowerCase()}` : 'Matrix UPS offline';
  set('flowSeqSolar',seqSolar); set('flowSeqGrid',seqGrid); set('flowSeqPv9000',seqPv9000); set('flowSeqUps',seqUps);
  $$('.flowSequenceStep').forEach((el,i)=>{
    const active=[totalSolar>30,gridActive,smart>30||matrixIn>30,matrixLoad>30||batteryActive][i];
    el.classList.toggle('live',Boolean(active));
    el.classList.toggle('active',Boolean(active));
  });
}


function setProgress(id,pctValue){
  const el=$(id); if(!el)return;
  const p=finite(pctValue); el.style.width=`${clamp(p,0,100)}%`;
  el.classList.remove('warn','danger'); if(p>=100)el.classList.add('danger'); else if(p>=80)el.classList.add('warn');
}
function setStateClass(el,level){if(!el)return;el.classList.remove('good','warn','danger');if(level)el.classList.add(level);}
function renderIntelligenceCenter(){
  if(!live)return;
  const s=live.systems||{},a=s.pv14000||null,b=s.pv9000||null,u=s.matrix||null,c=s.combined||{};const m=live.meter||null;
  const cfg=analytics?.config||live.guardrails||{};const peaks=analytics?.peaks||{};const current=analytics?.current||{};
  const importLimit=finite(cfg.nightImportLimitW,5000),exportLimit=finite(cfg.dayExportLimitW,6000);
  const importW=finite(m?.importW),exportW=finite(m?.exportW);const importPct=importLimit?importW/importLimit*100:0,exportPct=exportLimit?exportW/exportLimit*100:0;
  const dayMode=analytics?.mode?.dayMode ?? false;const modeLabel=analytics?.mode?.label||(dayMode?'DAY EXPORT WATCH':'NIGHT IMPORT WATCH');
  const activeW=dayMode?exportW:importW,activeLimit=dayMode?exportLimit:importLimit,headroom=activeLimit-activeW;
  const physicalSigned=analytics?.current?.physicalGridW ?? meterSignedW(m);const inverterSigned=finite(c.gridW);
  const reconAbs=analytics?.current?.reconciliationAbsW ?? (physicalSigned==null?null:Math.abs(physicalSigned-inverterSigned));
  const reconPct=analytics?.current?.reconciliationPct ?? (reconAbs==null?null:reconAbs/Math.max(100,Math.abs(finite(physicalSigned)),Math.abs(inverterSigned))*100);
  const balanceError=analytics?.current?.balanceErrorW ?? (physicalSigned==null?null:finite(c.solarW)+finite(physicalSigned)-finite(c.siteDemandW));
  const balanceAbs=balanceError==null?null:Math.abs(balanceError);

  set('guardMode',modeLabel); set('guardWindow',`${cfg.dayModeStart||'07:30'}–${cfg.dayModeEnd||'17:00'} day • otherwise night`);
  set('guardPower',`${dayMode?'EXPORT':'IMPORT'} ${fmtPower(activeW)}`);set('guardPowerSub',`Target ${fmtPower(activeLimit)} • Tuya physical meter`);
  set('guardHeadroom',headroom>=0?fmtPower(headroom):`OVER ${fmtPower(-headroom)}`);set('guardHeadroomSub',headroom>=0?'Available margin':'Target exceeded');
  set('guardRecon',reconAbs==null?'UNKNOWN':fmtPower(reconAbs));set('guardReconSub',reconAbs==null?'Need confirmed Tuya direction':`${finite(reconPct).toFixed(1)}% difference`);
  const guardCards=$$('.smartGuardCard'); if(guardCards[1])setStateClass(guardCards[1],classFromPct(dayMode?exportPct:importPct));if(guardCards[2])setStateClass(guardCards[2],headroom<0?'danger':headroom<activeLimit*.1?'warn':'good');if(guardCards[3])setStateClass(guardCards[3],reconAbs==null?'warn':reconAbs>finite(cfg.reconciliationAlertW,500)?'warn':'good');

  set('intelStatus',analytics?.ok===false?'PARTIAL':'MONITORING');
  set('intelBalance',balanceError==null?'--':fmtSignedPower(balanceError));
  set('intelBalanceSub',balanceError==null?'Physical Tuya direction required':balanceAbs<250?'Excellent power accounting':balanceAbs<750?'Small measurement difference':'Large balance difference');
  set('intelBalanceEquation',physicalSigned==null?'Solar + physical grid − demand':`${fmtPower(c.solarW)} + ${fmtGridSigned(physicalSigned)} − ${fmtPower(c.siteDemandW)}`);
  set('intelImportGuard',fmtPower(importW));set('intelImportGuardSub',`${importPct.toFixed(1)}% of ${fmtPower(importLimit)} • ${dayMode?'standby in day':'active night guard'}`);setProgress('intelImportProgress',importPct);
  set('intelExportGuard',fmtPower(exportW));set('intelExportGuardSub',`${exportPct.toFixed(1)}% of ${fmtPower(exportLimit)} • ${dayMode?'active day guard':'standby at night'}`);setProgress('intelExportProgress',exportPct);
  set('intelRecon',reconAbs==null?'--':fmtPower(reconAbs));set('intelReconSub',reconAbs==null?'Direction not confirmed':`${finite(reconPct).toFixed(1)}% difference`);set('intelReconEquation',`${physicalSigned==null?'Tuya --':`Tuya ${fmtGridSigned(physicalSigned)}`} • Inv ${fmtGridSigned(inverterSigned)}`);

  const todayImportPeak=Math.max(importW,finite(peaks.todayImportPeakW));const monthImportPeak=Math.max(todayImportPeak,finite(peaks.monthImportPeakW));
  const todayExportPeak=Math.max(exportW,finite(peaks.todayExportPeakW));const monthExportPeak=Math.max(todayExportPeak,finite(peaks.monthExportPeakW));
  set('mdiCurrent',fmtPower(importW));set('mdiPct',`${importPct.toFixed(1)}%`);setProgress('mdiTrack',importPct);
  set('mdiTodayPeak',fmtPower(todayImportPeak));set('mdiTodayTime',peaks.todayImportPeakAt?fmtTimePk(peaks.todayImportPeakAt):'Collecting');set('mdiMonthPeak',fmtPower(monthImportPeak));set('mdiMonthTime',peaks.monthImportPeakAt?fmtTimePk(peaks.monthImportPeakAt):'Collecting');
  set('mdiHeadroom',importLimit-importW>=0?fmtPower(importLimit-importW):`OVER ${fmtPower(importW-importLimit)}`);set('mdiStatus',statusFromPct(importPct));const mdiStatus=$('mdiStatus');if(mdiStatus){mdiStatus.className=`${importPct>=100?'dangerText':importPct>=80?'warnText':'goodText'}`;}
  set('dgCurrent',fmtPower(exportW));set('dgPct',`${exportPct.toFixed(1)}%`);setProgress('dgTrack',exportPct);
  set('dgTodayPeak',fmtPower(todayExportPeak));set('dgTodayTime',peaks.todayExportPeakAt?fmtTimePk(peaks.todayExportPeakAt):'Collecting');set('dgMonthPeak',fmtPower(monthExportPeak));set('dgMonthTime',peaks.monthExportPeakAt?fmtTimePk(peaks.monthExportPeakAt):'Collecting');
  set('dgHeadroom',exportLimit-exportW>=0?fmtPower(exportLimit-exportW):`OVER ${fmtPower(exportW-exportLimit)}`);set('dgStatus',statusFromPct(exportPct));const dgStatus=$('dgStatus');if(dgStatus){dgStatus.className=`${exportPct>=100?'dangerText':exportPct>=80?'warnText':'goodText'}`;}

  set('batteryIntelSoc',u?.batteryPct==null?'--':`${Math.round(finite(u.batteryPct))}%`);set('batteryIntelPower',u?`${batteryFlowMode(u.batteryW,u.batteryMode)} • ${fmtPower(u.batteryW)}`:'--');set('batteryIntelLoad',u?fmtPower(u.loadW):'--');
  const cap=analytics?.config?.batteryCapacityKwh||live.capacities?.batteryKwh||null;set('batteryIntelCapacity',cap?`${finite(cap).toFixed(2)} kWh`:'Not configured');set('batteryIntelRuntime',analytics?.current?.backupRuntimeHours?fmtDuration(analytics.current.backupRuntimeHours):'--');
  set('batteryIntelNote',cap?'Ideal runtime estimate from configured capacity, SOC and current UPS load.':'Set BATTERY_CAPACITY_KWH in Render to enable runtime estimation.');

  const te=todayEnergy||(energy?.period==='T'?energy:null);const ec=te?.combined||{},ea=te?.pv14000||{},eb=te?.pv9000||{};const rate=finite(te?.rate??cfg.electricityRatePkr,60),exportRate=finite(cfg.exportRatePkr,0);
  const solarKwh=finite(ec.solarKwh),loadKwh=finite(ec.loadKwh),importKwh=finite(ec.importKwh),exportKwh=finite(ec.exportKwh);const solarValue=solarKwh*rate,importCost=importKwh*rate,exportCredit=exportKwh*exportRate,netGridCost=importCost-exportCredit;
  const gridDependency=loadKwh>0?clamp(importKwh/loadKwh*100):0;const selfConsumption=solarKwh>0?clamp((solarKwh-exportKwh)/solarKwh*100):0;const selfConsumedKwh=Math.max(0,Math.min(solarKwh,solarKwh-exportKwh));const estimatedBenefit=selfConsumedKwh*rate+exportCredit;
  set('financeSolarValue',te?fmtPkr(solarValue):'--');set('financeImportCost',te?fmtPkr(importCost):'--');set('financeExportCredit',te?fmtPkr(exportCredit):'--');set('financeBenefit',te?fmtPkr(estimatedBenefit):'--');set('financeNetGrid',te?fmtPkr(netGridCost):'--');set('financeGridDependency',te?`${gridDependency.toFixed(1)}%`:'--');set('financeSelfConsumption',te?`${selfConsumption.toFixed(1)}%`:'--');

  const yieldCombined=solarKwh/monitoredSolarKwp(),yieldB=finite(eb.solarKwh)/MONITORED_SOLAR_KWP;set('perfYield',te?yieldCombined.toFixed(2):'--');set('perfPv14000Yield',a&&te?`${(finite(ea.solarKwh)/6.78).toFixed(2)} kWh/kWp`:'LOGGER PENDING');set('perfPv9000Yield',te?`${yieldB.toFixed(2)} kWh/kWp`:'--');set('perfLiveUtil',`${clamp(finite(c.solarW)/monitoredPvCapacityW()*100,0,999).toFixed(1)}%`);set('perfSolarPeak',peaks.todaySolarPeakW?`${fmtPower(peaks.todaySolarPeakW)} @ ${fmtTimePk(peaks.todaySolarPeakAt)}`:'Collecting');set('perfSmartEnergy',te?fmtKwh(ec.smartLoadKwh):'--');const clipA=a&&finite(a.solarW)>=6780*.97,clipB=finite(b?.solarW)>=MONITORED_PV_CAPACITY_W*.97;set('perfClipping',clipA||clipB?`WATCH • ${clipA?'PV14000 ':''}${clipB?'PV9000':''}`.trim():'No live clipping sign');
  const targetYield=finite(cfg.targetDailyYieldKwhPerKwp);if(targetYield>0&&te){const target=targetYield*monitoredSolarKwp();set('perfTarget',`${(solarKwh/Math.max(.01,target)*100).toFixed(0)}% • ${target.toFixed(1)} kWh monitored target`);}else set('perfTarget','Not configured');
  const best=peaks.bestDay,worst=peaks.worstDay;set('perfBestWorst',best&&worst?`History estimate • Best ${String(best.date).slice(0,10)} ${finite(best.solarKwh).toFixed(1)} kWh • Worst ${String(worst.date).slice(0,10)} ${finite(worst.solarKwh).toFixed(1)} kWh`:'Best/worst complete-day estimates appear as PostgreSQL history grows.');

  set('timelineSolarStart',fmtTimePk(peaks.solarStartAt));set('timelineSolarPeak',peaks.todaySolarPeakW?`${fmtPower(peaks.todaySolarPeakW)} • ${fmtTimePk(peaks.todaySolarPeakAt)}`:'--');set('timelineDemandPeak',peaks.todayDemandPeakW?`${fmtPower(peaks.todayDemandPeakW)} • ${fmtTimePk(peaks.todayDemandPeakAt)}`:'--');set('timelineSolarEnd',fmtTimePk(peaks.solarEndAt));
  renderSmartAlerts({a,b,u,c,m,cfg,dayMode,importW,exportW,importPct,exportPct,reconAbs,balanceAbs});
  renderSmartInsights({a,b,u,c,m,cfg,dayMode,headroom,activeLimit,reconAbs,balanceError,te,solarKwh,selfConsumption,peaks,todayImportPeak,todayExportPeak});
}

function renderSmartAlerts(ctx){
  const alerts=[];const counted=[];const add=(level,text,count=true)=>{alerts.push({level,text});if(count&&level!=='ok'&&level!=='info')counted.push(1);};
  const {a,b,u,c,m,cfg,dayMode,importW,exportW,importPct,exportPct,reconAbs,balanceAbs}=ctx;
  if(!m?.online)add('danger','Tuya physical utility meter is offline. Guardrail monitoring is unavailable.',false);
  else if(String(m.mode||'').toUpperCase()==='UNKNOWN')add('warn','Tuya live direction is UNKNOWN. Wait for a confirmed Import/Export direction.',true);
  if(!dayMode){if(importPct>=100)add('danger',`Night import is ${fmtPower(importW)}, above the ${fmtPower(cfg.nightImportLimitW||5000)} target.`);else if(importPct>=90)add('warn',`Night import is at ${importPct.toFixed(1)}% of the 5 kW target.`);else if(importPct>=80)add('warn',`Night import has entered the 80% watch zone (${fmtPower(importW)}).`);}
  if(dayMode){if(exportPct>=100)add('danger',`Day export is ${fmtPower(exportW)}, above the ${fmtPower(cfg.dayExportLimitW||6000)} DG target.`);else if(exportPct>=90)add('warn',`Day export is at ${exportPct.toFixed(1)}% of the 6 kW target.`);else if(exportPct>=80)add('warn',`Day export has entered the 80% watch zone (${fmtPower(exportW)}).`);}
  const reconLimit=finite(cfg.reconciliationAlertW,500);if(reconAbs!=null&&reconAbs>reconLimit*2)add('danger',`Tuya and inverter grid readings differ by ${fmtPower(reconAbs)}.`);else if(reconAbs!=null&&reconAbs>reconLimit)add('warn',`Grid reconciliation difference is ${fmtPower(reconAbs)}.`);
  if(balanceAbs!=null&&balanceAbs>1000)add('warn',`Whole-site power accounting difference is ${fmtPower(balanceAbs)}.`);
  const tempLimit=finite(cfg.alertTempC,65);for(const [name,temp] of [['PV14000',a?.temp],['PV9000',b?.temp],['Matrix',u?.transformer||u?.temp],['Tuya meter',m?.temperatureC]])if(temp!=null&&finite(temp)>tempLimit)add('warn',`${name} temperature is ${Math.round(finite(temp))}°C (watch > ${tempLimit}°C).`);
  if(finite(a?.solarW)>=6780*.97)add('info','PV14000 is operating near installed PV capacity; clipping watch is active.',false);if(finite(b?.solarW)>=4360*.97)add('info','PV9000 is operating near installed PV capacity; clipping watch is active.',false);
  if(u?.batteryPct!=null&&finite(u.batteryPct)<20)add('warn',`UPS battery SOC is low at ${Math.round(finite(u.batteryPct))}%.`);
  const staleLimit=180000;for(const [name,obj] of [['PV14000',a],['PV9000',b],['Matrix',u],['Tuya',m]])if(obj?.updatedAt&&Date.now()-finite(obj.updatedAt)>staleLimit)add('warn',`${name} telemetry is stale (${ageText(obj.updatedAt)}).`);
  if(!alerts.length)add('ok','All smart guardrails are normal. No threshold, temperature or reconciliation alert is active.',false);
  const box=$('smartAlerts');if(box)box.innerHTML=alerts.map(x=>`<div class="smartAlert ${x.level}">${x.text}</div>`).join('');smartAlertCount=counted.length;updateAlertBadge();maybeLocalBrowserAlerts(alerts);
}

function renderSmartInsights(ctx){
  const cards=[];const add=(title,text,level='good')=>cards.push(`<div class="insightCard ${level}"><strong>${title}</strong>${text}</div>`);
  const {a,b,u,c,dayMode,headroom,activeLimit,reconAbs,balanceError,te,solarKwh,selfConsumption,peaks,todayImportPeak,todayExportPeak}=ctx;
  add(dayMode?'Day export watch':'Night import watch',headroom>=0?`${fmtPower(headroom)} headroom remains before the ${fmtPower(activeLimit)} target.`:`Target is exceeded by ${fmtPower(-headroom)}.`,headroom>=0?'good':'danger');
  const solar=finite(c.solarW);if(solar>50)add('Solar contribution','PV9000 supplies 100% of monitored live solar. PV14000 is excluded until its new WiFi logger is installed.');
  if(te)add('Today energy',`${solarKwh.toFixed(2)} kWh solar produced with ${selfConsumption.toFixed(1)}% estimated self-consumption.`);
  if(reconAbs!=null)add('Grid reconciliation',`Physical Tuya meter and inverter calculation differ by ${fmtPower(reconAbs)}.`,reconAbs>500?'warn':'good');
  if(balanceError!=null)add('Power accounting',`${fmtSignedPower(balanceError)} balance error on the upstream bus.`,Math.abs(balanceError)>750?'warn':'good');
  if(peaks?.todaySolarPeakW)add('Solar peak',`Today peak is ${fmtPower(peaks.todaySolarPeakW)} at ${fmtTimePk(peaks.todaySolarPeakAt)}.`);
  add('Peak guardrails',`Today import peak ${fmtPower(todayImportPeak)} • export peak ${fmtPower(todayExportPeak)}.`,(todayImportPeak>5000||todayExportPeak>6000)?'warn':'good');
  if(analytics?.current?.backupRuntimeHours)add('UPS backup estimate',`At the current UPS load, ideal remaining runtime is about ${fmtDuration(analytics.current.backupRuntimeHours)}.`);
  const box=$('smartInsights');if(box)box.innerHTML=cards.slice(0,8).join('')||'<div class="insightCard">Collecting live data…</div>';
}

function renderCommandView(){
  if(!live)return;const s=live.systems||{},a=s.pv14000,b=s.pv9000,u=s.matrix,c=s.combined||{},m=live.meter||null;const cfg=analytics?.config||live.guardrails||{};
  const importLimit=finite(cfg.nightImportLimitW,5000),exportLimit=finite(cfg.dayExportLimitW,6000);const importW=finite(m?.importW),exportW=finite(m?.exportW);const physical=meterSignedW(m);
  set('cmdSolar',fmtPower(c.solarW));set('cmdSolarSub',`PV9000 ${fmtPower(b?.solarW)} • PV14000 logger pending`);set('cmdDemand',fmtPower(c.siteDemandW));set('cmdGrid',physical==null?'UNKNOWN':fmtPower(Math.abs(physical)));set('cmdGridMode',physical==null?'Tuya direction unavailable':fmtGridSigned(physical));set('cmdBattery',u?.batteryPct==null?'--':`${Math.round(finite(u.batteryPct))}%`);set('cmdBatterySub',u?`${batteryFlowMode(u.batteryW,u.batteryMode)} • ${fmtPower(u.batteryW)}`:'Matrix offline');
  set('cmdImport',fmtPower(importW));setProgress('cmdImportTrack',importW/importLimit*100);set('cmdImportHeadroom',`${importLimit-importW>=0?fmtPower(importLimit-importW)+' headroom':'OVER '+fmtPower(importW-importLimit)} • target ${fmtPower(importLimit)}`);
  set('cmdExport',fmtPower(exportW));setProgress('cmdExportTrack',exportW/exportLimit*100);set('cmdExportHeadroom',`${exportLimit-exportW>=0?fmtPower(exportLimit-exportW)+' headroom':'OVER '+fmtPower(exportW-exportLimit)} • target ${fmtPower(exportLimit)}`);
  set('cmdPv14000',a?fmtPower(a.solarW):'LOGGER PENDING');set('cmdPv14000State',a?`${ageText(a.updatedAt)} • ${gridMode(a.gridW)}`:'Physical system installed • not in live totals');set('cmdPv9000',b?fmtPower(b.solarW):'OFFLINE');set('cmdPv9000State',b?`${ageText(b.updatedAt)} • 1 string • Smart ${fmtPower(b.smartLoadW)}`:'Reassigned logger unavailable');set('cmdMatrix',u?fmtPower(u.loadW):'OFFLINE');set('cmdMatrixState',u?`UPS load • Battery ${fmtPct(u.batteryPct)}`:'API unavailable');set('cmdTuya',m?.online?fmtPower(m.powerW):'OFFLINE');set('cmdTuyaState',m?.online?`${String(m.mode||'').toUpperCase()} • ${finite(m.voltage).toFixed(1)} V`:'Meter unavailable');
  const dayMode=analytics?.mode?.dayMode??false;const pctNow=dayMode?exportW/exportLimit*100:importW/importLimit*100;const alertEl=$('cmdAlert')?.closest('.commandAlert');if(alertEl){alertEl.classList.remove('warn','danger');if(pctNow>=100)alertEl.classList.add('danger');else if(pctNow>=80)alertEl.classList.add('warn');}set('cmdAlert',pctNow>=100?`${dayMode?'DAY EXPORT':'NIGHT IMPORT'} target exceeded.`:pctNow>=80?`${dayMode?'Day export':'Night import'} is in the watch zone.`:`${dayMode?'Day export':'Night import'} guard is normal.`);set('commandMode',dayMode?'DAY WATCH':'NIGHT WATCH');
}

function drawDailyTimeline(){
  const canvas=$('dailyTimelineChart');if(!canvas)return;const source=Array.isArray(timelineHistory?.combined)&&timelineHistory.combined.length?timelineHistory.combined:(Array.isArray(history?.combined)?history.combined:[]);const today=pkToday();const data=source.filter(p=>pkDateKey(p.timestamp)===today);const{ctx,w,h}=canvasSize(canvas);ctx.clearRect(0,0,w,h);const pad={l:42,r:14,t:18,b:30};if(!data.length){ctx.fillStyle='#7893a5';ctx.font='12px Segoe UI';ctx.fillText('Today timeline will appear as PostgreSQL samples are collected.',pad.l,h/2);return;}
  const tf=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Karachi',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});const minuteOfDay=(ts)=>{const parts=tf.formatToParts(new Date(ts));let hh=0,mm=0;for(const x of parts){if(x.type==='hour')hh=Number(x.value);if(x.type==='minute')mm=Number(x.value);}return hh*60+mm;};
  const vals=data.flatMap(p=>[finite(p.solarW),finite(p.loadW),Math.abs(finite(p.meterImportW)-finite(p.meterExportW)||finite(p.gridW))]);const max=Math.max(1000,...vals)*1.12;const y=(v)=>pad.t+(max-finite(v))/max*(h-pad.t-pad.b);const x=(ts)=>pad.l+minuteOfDay(ts)/1440*(w-pad.l-pad.r);
  ctx.strokeStyle='#dce9ef';ctx.lineWidth=1;for(let i=0;i<5;i++){const yy=pad.t+i*(h-pad.t-pad.b)/4;ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(w-pad.r,yy);ctx.stroke();}for(const hour of [0,6,12,18,24]){const xx=pad.l+hour/24*(w-pad.l-pad.r);ctx.strokeStyle='#e6eff3';ctx.beginPath();ctx.moveTo(xx,pad.t);ctx.lineTo(xx,h-pad.b);ctx.stroke();ctx.fillStyle='#7893a5';ctx.font='9px Segoe UI';ctx.textAlign=hour===0?'left':hour===24?'right':'center';ctx.fillText(String(hour).padStart(2,'0'),xx,h-10);}
  const series=[{color:COLORS.solar,key:'solarW'},{color:COLORS.load,key:'loadW'},{color:COLORS.grid,key:'physical'}];for(const ser of series){ctx.strokeStyle=ser.color;ctx.lineWidth=2;ctx.beginPath();let started=false;for(const p of data){let v;if(ser.key==='physical'){const imp=finite(p.meterImportW),exp=finite(p.meterExportW);v=imp||exp?Math.max(imp,exp):Math.abs(finite(p.gridW));}else v=finite(p[ser.key]);const xx=x(p.timestamp),yy=y(v);if(!started){ctx.moveTo(xx,yy);started=true;}else ctx.lineTo(xx,yy);}ctx.stroke();}ctx.textAlign='start';
}

function metricCards(rows){return rows.map(([label,value,small,cls=''])=>`<div class="detailCard ${cls}">${iconLabelHtml(label)}<b>${value}</b><small>${small||''}</small></div>`).join('');}
function renderDetailPages(a,b,u,c){
  $('pv14000Page').innerHTML=metricCards(a?[
    ['Solar PV',fmtPower(a.solarW),'6.78 kWp installed'],['AC output / load',fmtPower(a.loadW),'10 kW capacity'],['Utility grid',fmtPower(a.gridW),gridMode(a.gridW)],['Grid voltage',`${finite(a.gridV).toFixed(1)} V`,`${finite(a.gridHz).toFixed(2)} Hz`],
    ['PV1',fmtPower(a.pv1W),`${finite(a.pv1V).toFixed(1)} V • ${finite(a.pv1A).toFixed(1)} A`],['PV2',fmtPower(a.pv2W),`${finite(a.pv2V).toFixed(1)} V • ${finite(a.pv2A).toFixed(1)} A`],['Today solar',fmtKwh(a.todaySolar),'Production'],['Temperature',`${Math.round(finite(a.temp))}°C`,'Inverter']
  ]:[['Monitoring','LOGGER PENDING','WiFi logger moved to PV9000','pendingDetail'],['Physical array','6.78 kWp','Still installed • excluded from live totals'],['AC inverter','10 kW','Fronus Meta physical asset'],['Next step','NEW WIFI LOGGER','Add PV14000_NEW_API_BASE after installation']]);

  $('pv9000Page').innerHTML=metricCards(b?[
    ['Solar PV',fmtPower(b.solarW),'4.36 kWp • 8 × 545 W'],['AC output / load',fmtPower(b.loadW),'Feeds UPS path'],['Utility grid',fmtPower(b.gridW),gridMode(b.gridW)],['Smart Load',fmtPower(b.smartLoadW),'Direct from PV9000'],
    ['String 1',fmtPower(b.pv1W),`ACTIVE • ${finite(b.pv1V).toFixed(1)} V • ${finite(b.pv1A).toFixed(1)} A`],['String 2','NOT IN USE','Single-string configuration'],['Today solar',fmtKwh(b.todaySolar),'Monitored production'],['WiFi logger','LIVE','Reassigned from PV14000']
  ]:[['Connection','OFFLINE','Check reassigned PV9000 WiFi logger / API','alertDetail']]);

  $('matrixPage').innerHTML=metricCards(u?[
    ['Role','UPS / BACKUP','PV disabled'],['PV installed','0 W','No solar contribution'],['AC input',fmtPower(u.acInputW),'From PV9000 • internal transfer'],['AC input voltage',`${finite(u.acInputV).toFixed(1)} V`,`${finite(u.acInputHz).toFixed(2)} Hz`],
    ['UPS output load',fmtPower(u.loadW),'6 kW capacity'],['Battery SOC',fmtPct(u.batteryPct),u.batteryMode||'Battery'],['Battery power',fmtSignedPower(u.batteryW),`${finite(u.batteryV).toFixed(1)} V`],['Transformer',`${Math.round(finite(u.transformer||u.temp))}°C`,'Temperature']
  ]:[['Connection','OFFLINE','Matrix API unavailable','alertDetail']]);

  $('combinedPage').innerHTML=metricCards([
    ['Monitored solar',fmtPower(c.solarW),'PV9000 only'],['Physical PV','11.14 kWp','6.78 + 4.36 kWp installed'],['Monitored PV','4.36 kWp','1 × 8 panels × 545 W'],['Site demand',fmtPower(c.siteDemandW),'Topology-corrected'],
    ['Utility grid',fmtPower(c.gridW),gridMode(c.gridW)],['Smart Load',fmtPower(c.smartLoadW),'Direct from PV9000'],['UPS AC input',fmtPower(c.upsAcInputW),'Internal PV9000 → Matrix transfer'],['Live systems',`${finite(c.connectedSystems)}/${monitoredSystemTarget()}`,c.health]
  ]);
}
function healthRows(rows){return rows.map(([k,v,ok])=>{const [name,cls]=iconMetaForLabel(k);return `<div class="healthRow"><span class="healthLabel iconLabel ${cls}">${uiIcon(name,cls)}<span>${k}</span></span><b class="${ok==='pending'?'pendingText':ok===false?'badText':'okText'}">${v}</b></div>`}).join('');}
function renderHealth(a,b,u,c,m,errors){
  $('pv14000Health').innerHTML=healthRows([['API connection',a?'ONLINE':'LOGGER PENDING',a?true:'pending'],['Monitoring',a?ageText(a.updatedAt):'INTENTIONALLY UNMONITORED',a?true:'pending'],['Physical PV','6.78 kWp',true],['AC capacity','10 kW',true]]);
  $('pv9000Health').innerHTML=healthRows([['API connection',b?'ONLINE':'OFFLINE',Boolean(b)],['Last update',b?ageText(b.updatedAt):'--',Boolean(b)],['Active string','1 • 8×545 W',true],['Feeds','UPS + Smart Load',Boolean(b)]]);
  $('matrixHealth').innerHTML=healthRows([['API connection',u?'ONLINE':'OFFLINE',Boolean(u)],['Role','UPS / BACKUP',true],['PV installed','0 W',true],['Battery',u?fmtPct(u.batteryPct):'--',Boolean(u)]]);
  const historyOnline=Boolean(live?.history?.online); const target=monitoredSystemTarget();const count=[a,b,u].filter(Boolean).length;
  $('combinedHealth').innerHTML=healthRows([['Live systems',`${count}/${target}`,count===target],['Tuya physical meter',m?.online?'ONLINE':'OFFLINE',Boolean(m?.online)],['Tuya direction',m?.mode||'--',Boolean(m?.online)],['Physical PV','11.14 kWp',true],['Monitored PV',`${monitoredSolarKwp().toFixed(2)} kWp`,true],['Grid estimate source',a?'PV14000 + PV9000':'PV9000 only',Boolean(b)],['Online history',historyOnline?'PostgreSQL ACTIVE':'Fallback',historyOnline],['Overall',count===target?'Excellent':'Partial',count===target]]);
  set('healthPill',count===target?'MONITORED SYSTEMS NORMAL':'ATTENTION'); $('healthPill')?.classList.toggle('good',count===target);
  const messages=[]; if(errors.pv14000)messages.push(`PV14000: ${errors.pv14000}`); if(errors.pv9000)messages.push(`PV9000: ${errors.pv9000}`); if(errors.matrix)messages.push(`Matrix: ${errors.matrix}`); if(errors.tuya)messages.push(`Tuya meter: ${errors.tuya}`);
  set('diagnosticNotice',messages.length?messages.join(' • '):'✓ PV14000 is intentionally unmonitored until its new WiFi logger arrives. PV9000 + Matrix telemetry is normal; Matrix internal AC transfer is excluded from utility-grid totals.');
  connectionAlertCount=messages.length; updateAlertBadge();
}

function renderEnergy(){
  if(!energy)return;
  const a=energy.pv14000||{}, b=energy.pv9000||{}, u=energy.matrix||{}, c=energy.combined||{};
  const labels={T:'Today',Y:'Yesterday',TM:'This month',LM:'Last month'}; const label=labels[energy.period]||'Selected period';
  set('totSolar',fmtKwh(c.solarKwh)); set('totLoad',fmtKwh(c.loadKwh)); set('totImport',fmtKwh(c.importKwh)); set('totExport',fmtKwh(c.exportKwh));
  ['totPeriodSolar','totPeriodLoad','totPeriodImport','totPeriodExport'].forEach(id=>set(id,`${label} • topology corrected`));
  set('energyPeriodLabel',`${label} · PV9000 monitored + Combined`);
  set('solarValueBig',Math.round(finite(c.solarKwh)*finite(energy.rate,60)).toLocaleString('en-PK'));
  set('rateValue',`PKR ${finite(energy.rate,60).toFixed(2)}/kWh`);
  set('totPv14000Solar',a.solarKwh==null?'NOT MONITORED':fmtKwh(a.solarKwh)); set('totPv9000Solar',fmtKwh(b.solarKwh)); set('totCombinedSolar',fmtKwh(c.solarKwh));
  set('totPv14000Load',a.loadKwh==null?'NOT MONITORED':fmtKwh(a.loadKwh)); set('totPv9000Load',fmtKwh(b.loadKwh)); set('totMatrixLoad',fmtKwh(u.loadKwh));
  set('totCombinedImport',fmtKwh(c.importKwh)); set('totCombinedExport',fmtKwh(c.exportKwh));
  const notice=$('energyNotice'); const errs=energy.errors||{}; const messages=[]; if(errs.pv14000)messages.push(`PV14000: ${errs.pv14000}`); if(errs.pv9000)messages.push(`PV9000: ${errs.pv9000}`); if(errs.matrix)messages.push(`Matrix: ${errs.matrix}`); if(notice){notice.hidden=!messages.length;notice.textContent=messages.join(' • ');}
  drawEnergyBars();
  renderIntelligenceCenter();
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


/* =========================================================
   V32 ULTRA PRO MAX - Mission Control intelligence
   ========================================================= */
function ultraRing(id,value){const el=$(id);if(el)el.style.setProperty('--p',String(clamp(value,0,100)));}
function ultraTrend(values,key){if(!Array.isArray(values)||values.length<2)return null;const usable=values.filter(x=>Number.isFinite(Number(x?.[key])));if(usable.length<2)return null;const recent=usable.slice(-12);return finite(recent.at(-1)?.[key])-finite(recent[0]?.[key]);}
function ultraTrendText(v){if(v==null)return'trend --';const a=Math.abs(v);if(a<40)return'→ steady';return `${v>0?'↗':'↘'} ${fmtPower(a)} vs recent`;}
function ultraFresh(ts,maxSec=180){if(!ts)return false;return(Date.now()-finite(ts,0))<=maxSec*1000;}
function addUltraEvent(title,detail='',level='good'){
  const last=ultraEvents[0]; if(last&&last.title===title&&last.detail===detail&&(Date.now()-last.ts)<15000)return;
  ultraEvents.unshift({title,detail,level,ts:Date.now()}); ultraEvents=ultraEvents.slice(0,18); renderUltraEvents();
}
function renderUltraEvents(){const box=$('ultraEventStream');if(!box)return;if(!ultraEvents.length){box.innerHTML='<div class="ultraEmpty">Events will appear when site state changes.</div>';return;}box.innerHTML=ultraEvents.map(e=>`<div class="ultraEvent ${escapeHtml(e.level)}"><b>${escapeHtml(e.title)}</b><span>${escapeHtml(fmtTimePk(e.ts))} PKT • ${escapeHtml(e.detail)}</span></div>`).join('');}
function detectUltraEvents(a,b,u,c,m,guardMode,guardPct){
  const state={b:Boolean(b),u:Boolean(u),m:Boolean(m?.online),grid:m?.online?String(m.mode||'IDLE').toUpperCase():gridMode(c?.gridW),bat:u?batteryFlowMode(u.batteryW,u.batteryMode):'OFFLINE',guard:statusFromPct(guardPct)};
  if(!ultraLastState){ultraLastState=state;addUltraEvent('Mission Control linked','Live estate telemetry attached','good');return;}
  for(const [k,label] of [['b','PV9000'],['u','Matrix UPS'],['m','Tuya Meter']]) if(state[k]!==ultraLastState[k]) addUltraEvent(`${label} ${state[k]?'ONLINE':'OFFLINE'}`,state[k]?'Telemetry restored':'Telemetry feed unavailable',state[k]?'good':'danger');
  if(state.grid!==ultraLastState.grid)addUltraEvent(`Grid ${state.grid}`,m?.online?`${fmtPower(Math.max(finite(m.importW),finite(m.exportW)))} on physical meter`:'Using inverter estimate',state.grid==='IMPORTING'?'warn':'good');
  if(state.bat!==ultraLastState.bat)addUltraEvent(`Battery ${state.bat}`,u?`${fmtPct(u.batteryPct)} • ${fmtSignedPower(u.batteryW)}`:'Matrix unavailable',state.bat==='DISCHARGING'?'warn':'good');
  if(state.guard!==ultraLastState.guard)addUltraEvent(`${guardMode} guard ${state.guard}`,`${Math.round(guardPct)}% of active limit`,guardPct>=100?'danger':guardPct>=80?'warn':'good');
  ultraLastState=state;
}
function ultraQualityScore(m,a,b){
  let score=100,notes=[];const v=m?.voltage;const pf=m?.powerFactor;const hz=finite(a?.gridHz||b?.gridHz,0);
  if(Number.isFinite(Number(v))){const d=Math.abs(finite(v)-230);if(d>20){score-=30;notes.push('voltage outside preferred band');}else if(d>10){score-=12;notes.push('voltage slightly off nominal');}}else{score-=25;notes.push('meter voltage unavailable');}
  if(Number.isFinite(Number(pf))){if(finite(pf)<.8){score-=25;notes.push('low power factor');}else if(finite(pf)<.9){score-=10;notes.push('power factor watch');}}else score-=10;
  if(hz){const d=Math.abs(hz-50);if(d>.8){score-=25;notes.push('frequency deviation');}else if(d>.3){score-=8;notes.push('frequency slightly off');}}else score-=8;
  return{score:clamp(score),notes};
}
function renderUltraDeck(a,b,u,c,m){
  const solar=finite(c?.solarW), demand=finite(c?.siteDemandW);const importW=m?.online?finite(m.importW):Math.max(0,finite(c?.gridW));const exportW=m?.online?finite(m.exportW):Math.max(0,-finite(c?.gridW));
  const dayMode=analytics?.mode?.dayMode??false;const guardMode=dayMode?'DAY EXPORT':'NIGHT IMPORT';const guardW=dayMode?exportW:importW;const guardLimit=dayMode?6000:5000;const guardPct=guardW/guardLimit*100;
  const sourceTarget=monitoredSourceTarget();const sources=[...(a?[[a,a.updatedAt]]:[]),[b,b?.updatedAt],[u,u?.updatedAt],[m?.online?m:null,m?.updatedAt]];const fresh=sources.filter(([x,ts])=>Boolean(x)&&ultraFresh(ts)).length;const confidence=fresh/sourceTarget*100;
  const coverage=demand>20?solar/demand*100:(solar>20?100:0);const independence=demand>20?100-(importW/demand*100):100;
  const temps=[finite(a?.temp,-999),finite(b?.temp,-999),finite(u?.transformer||u?.temp,-999),finite(m?.temperatureC,-999)].filter(x=>x>-100);const hottest=temps.length?Math.max(...temps):0;
  let score=100;score-=(sourceTarget-fresh)*12;if(guardPct>=100)score-=18;else if(guardPct>=90)score-=8;else if(guardPct>=80)score-=4;if(hottest>=70)score-=12;else if(hottest>=60)score-=5;if(u?.batteryPct!=null&&finite(u.batteryPct)<20)score-=8;score=clamp(score);
  const scoreLevel=score>=90?'ELITE':score>=75?'GOOD':score>=55?'WATCH':'ATTENTION';
  set('ultraScore',Math.round(score));set('ultraScoreLabel',scoreLevel);set('ultraScoreSub',`${fresh}/${sourceTarget} fresh sources • ${a?'PV14000 live':'PV14000 logger pending'} • hottest ${hottest?Math.round(hottest)+'°C':'--'}`);ultraRing('ultraScoreRing',score);
  set('ribbonScore',`${Math.round(score)}/100`);set('ribbonCoverage',`${Math.round(clamp(coverage))}%`);set('ribbonIndependence',`${Math.round(clamp(independence))}%`);set('ribbonConfidence',`${Math.round(confidence)}%`);
  set('ultraSolar',fmtPower(solar));set('ultraDemand',fmtPower(demand));set('ultraGrid',m?.online?fmtGridSigned(meterSignedW(m)):fmtGridSigned(c?.gridW));set('ultraGridSub',m?.online?`${finite(m.voltage).toFixed(1)} V • Tuya physical`:'Inverter estimate');
  set('ultraBattery',u?fmtPct(u.batteryPct):'--');set('ultraBatterySub',u?`${batteryFlowMode(u.batteryW,u.batteryMode)} • ${fmtSignedPower(u.batteryW)}`:'Matrix offline');
  set('ultraCoverage',`${Math.round(clamp(coverage))}%`);set('ultraIndependence',`${Math.round(clamp(independence))}%`);set('ultraConfidence',`${Math.round(confidence)}%`);ultraRing('ultraCoverageRing',coverage);ultraRing('ultraIndependenceRing',independence);ultraRing('ultraConfidenceRing',confidence);
  set('ultraGuard',`${guardMode} • ${Math.round(guardPct)}%`);set('ultraGuardSub',`${fmtPower(guardW)} / ${fmtPower(guardLimit)} • ${fmtPower(Math.max(0,guardLimit-guardW))} headroom`);
  const mission=$('ultraMissionState');if(mission){mission.classList.remove('good','warn','danger');const lev=score<55||guardPct>=100?'danger':score<75||guardPct>=80?'warn':'good';mission.classList.add(lev);mission.textContent=lev==='danger'?'ACTION REQUIRED':lev==='warn'?'WATCH ACTIVE':'SYSTEM NOMINAL';}
  const hist=mergeHistory();const solarD=ultraTrend(hist,'solarW'),loadD=ultraTrend(hist,'loadW'),gridD=ultraTrend(hist,'gridW');set('ultraSolarTrend',ultraTrendText(solarD));set('ultraLoadTrend',ultraTrendText(loadD));set('ultraSolarDelta',solarD==null?'--':`${solarD>=0?'+':'−'}${fmtPower(Math.abs(solarD))}`);set('ultraDemandDelta',loadD==null?'--':`${loadD>=0?'+':'−'}${fmtPower(Math.abs(loadD))}`);set('ultraGridDelta',gridD==null?'--':`${gridD>=0?'+':'−'}${fmtPower(Math.abs(gridD))}`);set('ultraSamples',String(hist.length));
  const q=ultraQualityScore(m,a,b);const hz=finite(a?.gridHz||b?.gridHz,0);set('ultraQualityGrade',q.score>=92?'A+':q.score>=84?'A':q.score>=72?'B':'C');set('ultraVoltage',m?.voltage!=null?`${finite(m.voltage).toFixed(1)} V`:'--');set('ultraVoltageState',m?.voltage!=null?(Math.abs(finite(m.voltage)-230)<=10?'Near nominal':'Check voltage'):'Unavailable');set('ultraCurrent',m?.currentA!=null?`${finite(m.currentA).toFixed(2)} A`:'--');set('ultraPf',m?.powerFactor!=null?finite(m.powerFactor).toFixed(3):'--');set('ultraPfState',m?.powerFactor!=null?(finite(m.powerFactor)>=.9?'Healthy':'Watch PF'):'Unavailable');set('ultraHz',hz?`${hz.toFixed(2)} Hz`:'--');set('ultraQualityNote',q.notes.length?q.notes.join(' • '):'Voltage, frequency and power factor look healthy.');const qb=$('ultraQualityBar');if(qb)qb.style.width=`${q.score}%`;
  const assets=[
    {icon:'☀',name:'FRONUS META 10KW',sub:'PV14000 • 6.78 kWp physical',on:Boolean(a),pending:!a,m:[['Solar',a?fmtPower(a.solarW):'UNMONITORED'],['WiFi',a?'CONNECTED':'NEW LOGGER'],['State',a?'LIVE':'PENDING']]},
    {icon:'☀',name:'FRONUS META 6KW',sub:'PV9000 • 1 string • 8×545 W',on:Boolean(b),m:[['Solar',b?fmtPower(b.solarW):'--'],['Smart',b?fmtPower(b.smartLoadW):'--'],['Temp',b?`${Math.round(finite(b.temp))}°C`:'--']]},
    {icon:'⚡',name:'FRONUS MATRIX 6KW',sub:'UPS / BACKUP',on:Boolean(u),m:[['UPS load',u?fmtPower(u.loadW):'--'],['Battery',u?fmtPct(u.batteryPct):'--'],['Temp',u?`${Math.round(finite(u.transformer||u.temp))}°C`:'--']]},
    {icon:'↕',name:'TUYA PHYSICAL METER',sub:'GRID REFERENCE',on:Boolean(m?.online),m:[['Grid',m?.online?fmtGridSigned(meterSignedW(m)):'--'],['Voltage',m?.online?`${finite(m.voltage).toFixed(1)}V`:'--'],['PF',m?.online&&m.powerFactor!=null?finite(m.powerFactor).toFixed(3):'--']]}
  ];
  const ag=$('ultraAssetGrid');if(ag)ag.innerHTML=assets.map(x=>`<div class="ultraAsset"><div class="ultraAssetIcon">${x.icon}</div><div class="ultraAssetName"><b>${escapeHtml(x.name)}</b><span>${escapeHtml(x.sub)}</span></div><div class="ultraAssetState ${x.pending?'pending':x.on?'':'off'}">${x.pending?'LOGGER PENDING':x.on?'ONLINE':'OFFLINE'}</div><div class="ultraAssetMetrics">${x.m.map(([k,v])=>`<div><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('')}</div></div>`).join('');set('ultraAssetsOnline',`${sources.filter(([x])=>Boolean(x)).length}/${sourceTarget} LIVE${a?'':' • 1 LOGGER PENDING'}`);
  const ops=[];let priority='NORMAL',priorityClass='';if(!b){ops.push(['📡','Restore PV9000 telemetry','PV9000 is not currently contributing to the master data picture. Check its reassigned WiFi logger / API path.']);priority='WATCH';priorityClass='warn';}if(guardPct>=80){ops.push(['🎯',`${guardMode} guard is ${Math.round(guardPct)}%`,`Only ${fmtPower(Math.max(0,guardLimit-guardW))} headroom remains before the configured watch limit.`]);priority=guardPct>=100?'CRITICAL':'WATCH';priorityClass=guardPct>=100?'danger':'warn';}if(q.score<80)ops.push(['〽','Power quality needs attention',q.notes.join(' • ')||'Review voltage / PF / frequency.']);if(u&&finite(u.batteryPct)<30)ops.push(['🔋','UPS battery reserve is low',`${fmtPct(u.batteryPct)} SOC with ${fmtPower(u.loadW)} downstream load.`]);if(confidence<75)ops.push(['🛰','Data confidence reduced',`${fresh}/${sourceTarget} monitored sources are fresh inside the 180 second supervision window.`]);if(!ops.length)ops.push(['✅','No urgent operator action','PV9000, Matrix and Tuya telemetry, grid guardrails and power quality are inside the normal watch zone.']);const ol=$('ultraOpsList');if(ol)ol.innerHTML=ops.slice(0,5).map(([ic,t,d])=>`<div class="ultraOp"><i>${ic}</i><div><b>${escapeHtml(t)}</b><span>${escapeHtml(d)}</span></div></div>`).join('');set('ultraPriority',priority);const pb=$('ultraPriority');if(pb){pb.classList.remove('warn','danger');if(priorityClass)pb.classList.add(priorityClass);}
  const tSolar=finite(todayEnergy?.combined?.solarKwh,finite(c?.todaySolar));const tImport=finite(todayEnergy?.combined?.importKwh,finite(c?.todayImport));const tExport=finite(todayEnergy?.combined?.exportKwh,finite(c?.todayExport));set('ultraTodaySolar',fmtKwh(tSolar));set('ultraTodayYield',`${(tSolar/monitoredSolarKwp()).toFixed(2)} kWh/kWp`);set('ultraTodayImport',fmtKwh(tImport));set('ultraTodayExport',fmtKwh(tExport));set('ultraPvUtil',`${Math.round(clamp(solar/monitoredPvCapacityW()*100))}%`);set('ultraUpsLoad',u?fmtPower(u.loadW):'--');set('ultraUpsMode',u?`${batteryFlowMode(u.batteryW,u.batteryMode)} • ${fmtPct(u.batteryPct)}`:'Matrix offline');const ages=[...(a?[a.updatedAt]:[]),b?.updatedAt,u?.updatedAt,m?.updatedAt].filter(Boolean).map(ts=>Date.now()-finite(ts));set('ultraSyncAge',ages.length?`${Math.round(Math.min(...ages)/1000)}s`:'--');
  detectUltraEvents(a,b,u,c,m,guardMode,guardPct);drawUltraPulse();
}
function drawUltraPulse(){
  const canvas=$('ultraPulseChart');if(!canvas)return;const all=mergeHistory().slice(-180);const {ctx,w,h}=canvasSize(canvas);ctx.clearRect(0,0,w,h);const pad={l:6,r:6,t:10,b:12};ctx.strokeStyle='rgba(120,190,215,.10)';ctx.lineWidth=1;for(let i=0;i<4;i++){const yy=pad.t+i*(h-pad.t-pad.b)/3;ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(w-pad.r,yy);ctx.stroke();}if(!all.length){ctx.fillStyle='#6f9eb3';ctx.font='11px Segoe UI';ctx.fillText('Collecting live history…',18,h/2);return;}const max=Math.max(1000,...all.flatMap(p=>[finite(p.solarW),finite(p.loadW),Math.abs(finite(p.gridW))]))*1.12;const x=i=>pad.l+(all.length<=1?0:i/(all.length-1))*(w-pad.l-pad.r);const y=v=>pad.t+(max-Math.abs(finite(v)))/max*(h-pad.t-pad.b);const series=[[COLORS.solar,'solarW'],[COLORS.load,'loadW'],['#3ce09b','gridW']];for(const [color,key] of series){ctx.beginPath();all.forEach((p,i)=>{const xx=x(i),yy=y(p[key]);i?ctx.lineTo(xx,yy):ctx.moveTo(xx,yy)});ctx.strokeStyle=color;ctx.lineWidth=2;ctx.shadowColor=color;ctx.shadowBlur=6;ctx.stroke();ctx.shadowBlur=0;}}

/* =========================================================
   V37 DESKTOP CONTROL ROOM - PV9000 logger reassignment
   ========================================================= */
function openControlView(name){$q('.navtab[data-view="'+name+'"]')?.click();window.scrollTo({top:0,behavior:'smooth'});}
function setControlFocus(enabled){document.body.classList.toggle('controlFocusMode',Boolean(enabled));set('controlFocus',enabled?'◉ EXIT FOCUS':'◉ FOCUS');requestAnimationFrame(()=>{drawAll();drawUltraPulse();});}
function setControlDensity(enabled){document.body.classList.toggle('controlDense',Boolean(enabled));set('controlDensity',enabled?'▦ COMFORT':'▦ DENSE');try{localStorage.setItem('rajaFrazControlDense',enabled?'1':'0');}catch(_error){}requestAnimationFrame(()=>{drawAll();drawUltraPulse();});}
function initControlRoom(){
  let dense=false;try{dense=localStorage.getItem('rajaFrazControlDense')==='1';}catch(_error){}setControlDensity(dense);
  $('controlFocus')?.addEventListener('click',()=>setControlFocus(!document.body.classList.contains('controlFocusMode')));
  $('controlDensity')?.addEventListener('click',()=>setControlDensity(!document.body.classList.contains('controlDense')));
  $('controlOpenFlow')?.addEventListener('click',()=>openControlView('flow'));
  $('controlOpenTools')?.addEventListener('click',()=>openControlView('tools'));
  document.addEventListener('fullscreenchange',()=>set('ultraFullscreen',document.fullscreenElement?'⛶ EXIT FULL SCREEN':'⛶ FULL SCREEN'));
  document.addEventListener('keydown',(event)=>{
    if(event.ctrlKey||event.metaKey||event.altKey)return;const tag=String(event.target?.tagName||'').toLowerCase();if(['input','textarea','select'].includes(tag))return;
    const key=event.key.toLowerCase();const views={1:'mission',2:'dashboard',3:'flow',4:'tools'};
    if(views[key]){event.preventDefault();openControlView(views[key]);return;}
    if(key==='f'){event.preventDefault();setControlFocus(!document.body.classList.contains('controlFocusMode'));}
    if(key==='d'){event.preventDefault();setControlDensity(!document.body.classList.contains('controlDense'));}
    if(key==='escape'&&document.body.classList.contains('controlFocusMode'))setControlFocus(false);
  });
}
function setControlAsset(id,online,power,stateLabel=''){const el=$(id);if(!el)return;const pending=stateLabel==='LOGGER PENDING';el.classList.toggle('online',Boolean(online));el.classList.toggle('offline',!online&&!pending);el.classList.toggle('pending',pending);const state=el.querySelector('b');if(state)state.textContent=stateLabel||(online?'ONLINE':'OFFLINE');const value=el.querySelector('small');if(value)value.textContent=power;}
function renderControlRoom(a,b,u,c={},m=null){
  if(!$('mission'))return;
  const physical=meterSignedW(m),grid=physical==null?finite(c.gridW):physical,solar=finite(c.solarW),demand=finite(c.siteDemandW);const dayMode=analytics?.mode?.dayMode??false;const guardLimit=dayMode?finite(analytics?.config?.dayExportLimitW,6000):finite(analytics?.config?.nightImportLimitW,5000);const guardW=dayMode?Math.max(0,-grid):Math.max(0,grid);const guardPct=guardW/Math.max(1,guardLimit)*100;const balance=physical==null?null:solar+physical-demand;const recon=physical==null?null:Math.abs(physical-finite(c.gridW));
  set('controlRailSolar',fmtPower(solar));set('controlRailSolarSub',`${Math.round(clamp(solar/monitoredPvCapacityW()*100))}% of ${monitoredSolarKwp().toFixed(2)} kWp monitored • 11.14 kWp installed`);
  set('controlRailDemand',fmtPower(demand));set('controlRailDemandSub',demand>0?`${Math.round(clamp(solar/demand*100))}% solar coverage`:'Demand idle');
  set('controlRailGrid',fmtGridSigned(grid));set('controlRailGridSub',m?.online?'Tuya physical meter':'Inverter estimate');
  set('controlRailGuard',`${Math.round(guardPct)}%`);set('controlRailGuardSub',`${dayMode?'EXPORT':'IMPORT'} ${fmtPower(guardW)} / ${fmtPower(guardLimit)}`);
  set('controlRailBattery',u?fmtPct(u.batteryPct):'--');set('controlRailBatterySub',u?`${batteryFlowMode(u.batteryW,u.batteryMode)} • ${fmtPower(u.loadW)} load`:'Matrix unavailable');
  set('controlRailBalance',balance==null?'UNKNOWN':fmtSignedPower(balance));set('controlRailBalanceSub',balance==null?'Physical direction required':`${Math.abs(balance)<250?'Excellent':Math.abs(balance)<750?'Review':'Large'} accounting difference`);
  setControlAsset('controlAsset14000',Boolean(a),a?`${fmtPower(a.solarW)} solar`:'6.78 kWp physical • telemetry excluded',a?'':'LOGGER PENDING');setControlAsset('controlAsset9000',Boolean(b),b?`${fmtPower(b.solarW)} • 1 string`:'Telemetry unavailable');setControlAsset('controlAssetMatrix',Boolean(u),u?`${fmtPower(u.loadW)} protected load`:'Telemetry unavailable');setControlAsset('controlAssetTuya',Boolean(m?.online),m?.online?fmtGridSigned(physical):'Physical reference unavailable');
  const sourceTarget=monitoredSourceTarget();const sources=[...(a?[a]:[]),b,u,m?.online?m:null],sourceCount=sources.filter(Boolean).length;const ages=[...(a?[a.updatedAt]:[]),b?.updatedAt,u?.updatedAt,m?.updatedAt].filter(Boolean).map(ts=>Math.max(0,Date.now()-finite(ts)));set('controlLastSync',ages.length?`Oldest monitored sync ${Math.round(Math.max(...ages)/1000)}s`:'Sync unavailable');
  let level='normal',label='SYSTEM NORMAL',message='All monitored assets, grid guardrails and power accounting are inside the normal watch zone.';
  if(guardPct>=100){level='danger';label='ACTION REQUIRED';message=`${dayMode?'Export':'Import'} is above the ${fmtPower(guardLimit)} operating guard by ${fmtPower(guardW-guardLimit)}.`;}
  else if(u&&u.batteryPct!=null&&finite(u.batteryPct)<20){level='danger';label='LOW UPS RESERVE';message=`Matrix battery is ${fmtPct(u.batteryPct)} with ${fmtPower(u.loadW)} protected load. Review backup runtime.`;}
  else if(sourceCount<sourceTarget-1){level='danger';label='DATA DEGRADED';message=`Only ${sourceCount}/${sourceTarget} monitored sources are available. Restore missing telemetry before relying on site totals.`;}
  else if(sourceCount<sourceTarget){level='warn';label='SOURCE WATCH';message=`${sourceCount}/${sourceTarget} monitored sources are available. PV14000 logger pending is planned and not counted as a fault.`;}
  else if(guardPct>=80){level='warn';label='GUARD WATCH';message=`${dayMode?'Export':'Import'} has reached ${Math.round(guardPct)}% of the active ${fmtPower(guardLimit)} guard.`;}
  else if(recon!=null&&recon>500){level='warn';label='METER REVIEW';message=`Tuya physical grid and inverter estimate differ by ${fmtPower(recon)}. Check CT direction and meter timing.`;}
  else if(balance!=null&&Math.abs(balance)>750){level='warn';label='BALANCE REVIEW';message=`Power balance error is ${fmtSignedPower(balance)}. Check telemetry timing and topology reconciliation.`;}
  set('controlAlertLevel',label);set('controlAlertText',message);const ticker=$('controlTicker');if(ticker){ticker.classList.remove('normal','warn','danger');ticker.classList.add(level);}
}

/* =========================================================
   V35 OPERATOR TOOLKIT - planning, conversion and exports
   ========================================================= */
function toolValue(id,fallback=0){const el=$(id);return el?finite(el.value,fallback):fallback;}
function toolSetInput(id,value){const el=$(id);if(el&&Number.isFinite(Number(value)))el.value=String(Number(value));}
function toolProgress(id,value){const el=$(id);if(!el)return;const p=Math.max(0,finite(value));el.style.width=`${Math.min(100,p)}%`;el.classList.toggle('warn',p>=80&&p<100);el.classList.toggle('danger',p>=100);}
function saveToolPrefs(){
  try{
    const values=$$('[data-tools-persist]').map((el)=>el.type==='checkbox'?el.checked:el.value);
    localStorage.setItem('rajaFrazOperatorToolsV35',JSON.stringify({values}));
  }catch(_error){}
}
function restoreToolPrefs(){
  try{
    const raw=localStorage.getItem('rajaFrazOperatorToolsV35');if(!raw)return;
    const data=JSON.parse(raw);if(!Array.isArray(data.values))return;toolHasSavedPrefs=true;
    $$('[data-tools-persist]').forEach((el,index)=>{const value=data.values[index];if(value==null)return;if(el.type==='checkbox')el.checked=Boolean(value);else el.value=String(value);});
  }catch(_error){}
}
function toolToast(message){const el=$('toolToast');if(!el)return;el.textContent=message;el.classList.add('show');clearTimeout(toolToast.timer);toolToast.timer=setTimeout(()=>el.classList.remove('show'),2600);}
function liveToolContext(){
  const systems=live?.systems||{},a=systems.pv14000||null,b=systems.pv9000||null,u=systems.matrix||null,c=systems.combined||{};const m=live?.meter||null;
  const physical=meterSignedW(m);const grid=physical==null?finite(c.gridW):physical;
  const solar=finite(c.solarW,finite(a?.solarW)+finite(b?.solarW));const demand=finite(c.siteDemandW,finite(a?.loadW)+finite(b?.loadW));
  return{systems,a,b,u,c,m,grid,physical,solar,demand};
}
function renderOperatorTools(){
  if(!$('tools'))return;
  const x=liveToolContext();
  if(live&&!toolHasSavedPrefs&&!toolsSeededFromLive){
    if(x.u?.batteryPct!=null)toolSetInput('toolBatterySoc',Math.round(finite(x.u.batteryPct)));
    if(finite(x.u?.loadW)>0)toolSetInput('toolBatteryLoad',Math.round(finite(x.u.loadW)));
    const todaySolar=finite(todayEnergy?.combined?.solarKwh,finite(x.c?.todaySolar));if(todaySolar>0)toolSetInput('toolDailySolar',todaySolar.toFixed(1));
    toolsSeededFromLive=true;
  }

  set('toolLiveSolar',live?fmtPower(x.solar):'--');set('toolLiveSolarSub',`${Math.round(clamp(x.solar/monitoredPvCapacityW()*100))}% of ${monitoredSolarKwp().toFixed(2)} kWp monitored • 11.14 installed`);
  set('toolLiveDemand',live?fmtPower(x.demand):'--');
  set('toolLiveGrid',live?fmtGridSigned(x.grid):'--');set('toolLiveGridSub',x.m?.online?'Tuya physical meter':'Inverter estimate');
  set('toolLiveBattery',x.u?fmtPct(x.u.batteryPct):'--');set('toolLiveBatterySub',x.u?`${batteryFlowMode(x.u.batteryW,x.u.batteryMode)} • ${fmtPower(x.u.loadW)} load`:'Matrix unavailable');

  const extraLoad=toolValue('toolExtraLoad'),extraSolar=toolValue('toolExtraSolar');const projectedGrid=x.grid+extraLoad-extraSolar;const projectedDemand=x.demand+extraLoad;const projectedSolar=x.solar+extraSolar;
  const isImport=projectedGrid>=0,limit=isImport?5000:6000,used=Math.abs(projectedGrid),headroom=limit-used;
  set('toolProjectedGrid',live?fmtGridSigned(projectedGrid):'WAITING FOR LIVE');set('toolScenarioEquation',`${fmtGridSigned(x.grid)} + ${fmtPower(extraLoad)} load − ${fmtPower(extraSolar)} solar`);
  set('toolProjectedDemand',fmtPower(projectedDemand));set('toolProjectedSolar',fmtPower(projectedSolar));set('toolProjectedHeadroom',headroom>=0?fmtPower(headroom):`OVER ${fmtPower(-headroom)}`);
  set('toolScenarioGuard',`${isImport?'Night import':'Day export'} guard • ${Math.round(used/limit*100)}% of ${fmtPower(limit)}`);toolProgress('toolScenarioBar',used/limit*100);
  const projected=$('toolProjectedGrid');if(projected){projected.classList.toggle('importing',isImport&&used>=30);projected.classList.toggle('exporting',!isImport&&used>=30);projected.classList.toggle('over',used>limit);}

  let plannedLoad=0;$$('[data-tool-load]').forEach((row)=>{const on=row.querySelector('[data-load-on]')?.checked;const qty=finite(row.querySelector('[data-load-qty]')?.value,1);const watts=finite(row.querySelector('[data-load-watts]')?.value);const subtotal=on?qty*watts:0;plannedLoad+=subtotal;row.classList.toggle('selected',Boolean(on));row.dataset.subtotal=String(subtotal);});
  set('toolLoadTotal',fmtPower(plannedLoad));
  [['toolCap14000','toolCap14000Text',10000],['toolCap9000','toolCap9000Text',6000],['toolCapMatrix','toolCapMatrixText',6000]].forEach(([bar,textId,capacity])=>{const p=plannedLoad/capacity*100;toolProgress(bar,p);set(textId,`${Math.round(p)}%`);});
  const loadAdvice=plannedLoad>10000?'Stack exceeds every inverter rating — split or sequence these loads.':plannedLoad>6000?'Fits PV14000 rating only; above PV9000 and Matrix 6 kW ratings.':plannedLoad>4800?'High on both 6 kW systems; allow motor/compressor surge margin.':plannedLoad>0?'Comfortable planning range; confirm starting surge before switching.':'Select loads to build a switching plan.';set('toolLoadAdvice',loadAdvice);

  const capacity=toolValue('toolBatteryKwh',5),soc=clamp(toolValue('toolBatterySoc',80)),eff=clamp(toolValue('toolBatteryEff',90),1,100),backupLoad=toolValue('toolBatteryLoad',1000);const usable=capacity*(soc/100)*(eff/100);const runtime=backupLoad>0?usable/(backupLoad/1000):0;
  set('toolBatteryRuntime',runtime>0?fmtDuration(runtime):'--');set('toolBatteryEnergy',`${usable.toFixed(2)} kWh usable • ${fmtPower(backupLoad)} load`);

  const dailySolar=toolValue('toolDailySolar',30),selfUse=clamp(toolValue('toolSelfUse',70)),importTariff=toolValue('toolImportTariff',65),exportTariff=toolValue('toolExportTariff',27),days=Math.max(1,toolValue('toolSavingsDays',30));const selfKwh=dailySolar*selfUse/100*days,exportKwh=dailySolar*(1-selfUse/100)*days;const selfValue=selfKwh*importTariff,exportValue=exportKwh*exportTariff;
  set('toolSavingsValue',fmtPkr(selfValue+exportValue));set('toolSavingsSplit',`${selfKwh.toFixed(1)} kWh self-use + ${exportKwh.toFixed(1)} kWh export over ${Math.round(days)} days`);

  const watts=toolValue('toolConvertWatts',5000),volts=Math.max(1,toolValue('toolConvertVolts',230)),phase=toolValue('toolConvertPhase',1),pf=clamp(toolValue('toolConvertPf',1),.1,1);const amps=phase===3?watts/(Math.sqrt(3)*volts*pf):watts/(volts*pf);const energyKwh=toolValue('toolConvertKwh',10),tariff=toolValue('toolConvertTariff',65);
  set('toolConvertAmps',`${amps.toFixed(2)} A`);set('toolConvertCost',fmtPkr(energyKwh*tariff));

  const sourceTarget=monitoredSourceTarget();const sourceCount=[...(x.a?[x.a]:[]),x.b,x.u,x.m?.online?x.m:null].filter(Boolean).length;const recon=x.physical==null?null:Math.abs(x.physical-finite(x.c.gridW));const balance=x.physical==null?null:x.solar+x.physical-x.demand;const attention=sourceCount<sourceTarget||(recon!=null&&recon>500)||(balance!=null&&Math.abs(balance)>750);
  set('toolDiagSources',`${sourceCount}/${sourceTarget} monitored available`);set('toolDiagGrid',x.m?.online?'TUYA PHYSICAL':'INVERTER ESTIMATE');set('toolDiagRecon',recon==null?'Unknown':fmtPower(recon));set('toolDiagBalance',balance==null?'Unknown':fmtSignedPower(balance));set('toolDiagState',attention?'REVIEW':'NOMINAL');
  const state=$('toolDiagState');if(state){state.classList.toggle('warn',attention);state.classList.toggle('good',!attention);}
}
function operatorSnapshot(){
  const x=liveToolContext();const recon=x.physical==null?null:Math.abs(x.physical-finite(x.c.gridW));const balance=x.physical==null?null:x.solar+x.physical-x.demand;
  return{generatedAt:new Date().toISOString(),timezone:'Asia/Karachi',monitoringOnly:true,site:{physicalPvCapacityW:PHYSICAL_PV_CAPACITY_W,monitoredPvCapacityW:MONITORED_PV_CAPACITY_W,solarW:x.solar,demandW:x.demand,physicalGridW:x.physical,gridEstimateW:finite(x.c.gridW),gridMode:x.m?.online?x.m.mode:gridMode(x.c.gridW),todaySolarKwh:finite(todayEnergy?.combined?.solarKwh,finite(x.c.todaySolar))},systems:{pv14000:{online:Boolean(x.a),loggerState:x.a?'online':'waiting-for-new-wifi-logger',solarW:x.a?finite(x.a.solarW):null,loadW:x.a?finite(x.a.loadW):null,updatedAt:x.a?.updatedAt||null},pv9000:{online:Boolean(x.b),loggerSource:'reassigned-from-pv14000',activeStrings:1,panels:8,panelW:545,solarW:finite(x.b?.solarW),loadW:finite(x.b?.loadW),smartLoadW:finite(x.b?.smartLoadW),updatedAt:x.b?.updatedAt||null},matrix:{online:Boolean(x.u),loadW:finite(x.u?.loadW),acInputW:finite(x.u?.acInputW),batteryPct:x.u?.batteryPct??null,batteryW:finite(x.u?.batteryW),updatedAt:x.u?.updatedAt||null},tuya:{online:Boolean(x.m?.online),mode:x.m?.mode||null,importW:finite(x.m?.importW),exportW:finite(x.m?.exportW),voltage:x.m?.voltage??null,currentA:x.m?.currentA??null,powerFactor:x.m?.powerFactor??null,updatedAt:x.m?.updatedAt||null}},diagnostics:{meterInverterDifferenceW:recon,powerBalanceErrorW:balance}};
}
function operatorSummary(snapshot=operatorSnapshot()){
  const s=snapshot.site,u=snapshot.systems.matrix,t=snapshot.systems.tuya,d=snapshot.diagnostics;
  return[`RAJA FRAZ MASTER • LIVE OPERATOR SNAPSHOT`,`Time: ${new Date(snapshot.generatedAt).toLocaleString('en-PK',{timeZone:'Asia/Karachi'})} PKT`,`Solar: ${fmtPower(s.solarW)}`,`Site demand: ${fmtPower(s.demandW)}`,`Grid: ${s.physicalGridW==null?'Tuya unavailable':fmtGridSigned(s.physicalGridW)}`,`UPS battery: ${u.batteryPct==null?'--':fmtPct(u.batteryPct)} • load ${fmtPower(u.loadW)}`,`Tuya: ${t.online?'ONLINE':'OFFLINE'}${t.voltage!=null?` • ${finite(t.voltage).toFixed(1)} V`:''}`,`Reconciliation: ${d.meterInverterDifferenceW==null?'--':fmtPower(d.meterInverterDifferenceW)}`,`Power balance error: ${d.powerBalanceErrorW==null?'--':fmtSignedPower(d.powerBalanceErrorW)}`,'Monitoring only • No control command issued'].join('\n');
}
function downloadToolFile(name,content,type){const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function snapshotCsv(s=operatorSnapshot()){
  const rows=[['generatedAt','solarW','demandW','physicalGridW','gridEstimateW','gridMode','pv14000Online','pv14000SolarW','pv9000Online','pv9000SolarW','matrixOnline','matrixLoadW','batteryPct','tuyaOnline','voltage','powerFactor','reconciliationW','balanceErrorW'],[s.generatedAt,s.site.solarW,s.site.demandW,s.site.physicalGridW??'',s.site.gridEstimateW,s.site.gridMode,s.systems.pv14000.online,s.systems.pv14000.solarW,s.systems.pv9000.online,s.systems.pv9000.solarW,s.systems.matrix.online,s.systems.matrix.loadW,s.systems.matrix.batteryPct??'',s.systems.tuya.online,s.systems.tuya.voltage??'',s.systems.tuya.powerFactor??'',s.diagnostics.meterInverterDifferenceW??'',s.diagnostics.powerBalanceErrorW??'']];return rows.map(row=>row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
}
async function copyOperatorSummary(){const text=operatorSummary();try{await navigator.clipboard.writeText(text);}catch(_error){const area=document.createElement('textarea');area.value=text;document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();}toolToast('Live summary copied');}
function initOperatorTools(){
  if(toolsInitialized)return;toolsInitialized=true;restoreToolPrefs();
  $$('[data-tools-persist]').forEach((el)=>el.addEventListener('input',()=>{saveToolPrefs();renderOperatorTools();}));
  $('toolScenarioReset')?.addEventListener('click',()=>{toolSetInput('toolExtraLoad',0);toolSetInput('toolExtraSolar',0);saveToolPrefs();renderOperatorTools();});
  $('toolCopySnapshot')?.addEventListener('click',copyOperatorSummary);
  $('toolDownloadJson')?.addEventListener('click',()=>{downloadToolFile(`raja-fraz-snapshot-${pkToday()}.json`,JSON.stringify(operatorSnapshot(),null,2),'application/json');toolToast('JSON snapshot downloaded');});
  $('toolDownloadCsv')?.addEventListener('click',()=>{downloadToolFile(`raja-fraz-snapshot-${pkToday()}.csv`,snapshotCsv(),'text/csv');toolToast('CSV snapshot downloaded');});
  $('toolPrintReport')?.addEventListener('click',()=>window.print());
  renderOperatorTools();
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
  drawDailyTimeline();
  drawUltraPulse();
}

async function start(){
  initTuyaPickers();
  initControlRoom();
  initOperatorTools();
  initPowerSmart();
  await wakeMasterSources();
  await Promise.allSettled([loadLive(),loadHistory(activeHours),loadEnergy(activeEnergyPeriod),loadAnalytics(),loadTimelineHistory(),loadWeather(),loadTuyaQuickTotals(),loadAiStatus(),loadNotificationStatus(),loadPowerSmartStatus()]);
  if(!todayEnergy)todayEnergy=energy?.period==='T'?energy:null;
  await loadSelectedTuyaEnergy();
  renderIntelligenceCenter(); renderCommandView(); renderAiLiveContext(); drawDailyTimeline(); drawUltraPulse();
  setInterval(loadLive,10000);
  setInterval(()=>loadHistory(activeHours),60000);
  setInterval(()=>loadEnergy(activeEnergyPeriod),60000);
  setInterval(loadAnalytics,30000);
  setInterval(loadTimelineHistory,60000);
  setInterval(loadTodayEnergy,300000);
  setInterval(loadTuyaQuickTotals,300000);
  setInterval(()=>{if(powerSmartState.connected)loadPowerSmartData(false);},300000);
  setInterval(renderPowerSmartState,60000);
  setInterval(loadWeather,600000);
}
setInterval(()=>{loadNotificationStatus().catch(()=>{});},60000);
window.addEventListener('resize',()=>requestAnimationFrame(()=>{drawAll();drawDailyTimeline();drawUltraPulse();}));
start();
