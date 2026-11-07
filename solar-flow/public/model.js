export const IDS=['pv14000','pv9000'];
export const names={pv14000:'PV14000',pv9000:'PV9000',matrix:'Matrix'};
export const finite=v=>typeof v==='number'&&Number.isFinite(v);
export const dayPK=t=>{const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(t));return ['year','month','day'].map(k=>p.find(x=>x.type===k).value).join('-');};
export function fresh(r,now=Date.now(),battery=false){return !!r&&r.status==='live'&&finite(r.timestamp)&&now-r.timestamp<=(battery?900000:180000)&&r.timestamp<=now+30000&&finite(r.receivedAt)&&now-r.receivedAt<=90000&&r.receivedAt<=now+30000;}
export function select(data,id='combined',now=Date.now(),connected=true){
 const rows=(id==='combined'?IDS:[id]).map(x=>data?.solar?.[x]);
 const good=rows.map(r=>connected&&fresh(r,now));
 const sum=k=>good.every(Boolean)&&rows.every(r=>finite(r?.[k]))?rows.reduce((s,r)=>s+r[k],0):null;
 return {solarW:sum('solarW'),loadW:sum('loadW'),gridW:sum('gridW'),installedW:rows.reduce((s,r,i)=>s+(r?.installedW||(id==='pv9000'||(id==='combined'&&i===1)?4360:6780)),0),ratingW:rows.every(r=>finite(r?.ratingW))?rows.reduce((s,r)=>s+r.ratingW,0):null,live:good.filter(Boolean).length,count:rows.length,complete:good.every(Boolean),timestamp:rows.every(r=>finite(r?.timestamp))?Math.min(...rows.map(r=>r.timestamp)):null};
}
export function energy(data,id='combined',now=Date.now(),connected=true){
 const ids=id==='combined'?IDS:[id];const rows=ids.map(k=>data?.energy?.[k]);
 const ok=connected&&ids.every((k,i)=>fresh(data?.solar?.[k],now)&&rows[i]?.date===dayPK(now)&&finite(rows[i]?.receivedAt)&&now-rows[i].receivedAt<180000&&rows[i].receivedAt<=now+30000);
 return Object.fromEntries(['solar','load','import','export'].map(k=>[k,ok&&rows.every(r=>finite(r?.[k])&&r[k]>=0)?rows.reduce((s,r)=>s+r[k],0):null]));
}
export function valueEstimate(e,rates){
 if(!finite(e.solar)||!finite(e.export)||e.export>e.solar+0.2)return {selfUsed:null,avoided:null,credit:null,total:null};
 const selfUsed=Math.max(0,e.solar-e.export),avoided=selfUsed*rates.importRate,credit=e.export*rates.exportRate;
 return {selfUsed,avoided,credit,total:avoided+credit};
}
export function mergeSamples(old,incoming,now=Date.now()){
 const m=new Map();for(const r of [...(old||[]),...(incoming||[])]){
  if(!r||!IDS.includes(r.id)||!finite(r.timestamp)||r.timestamp<now-7*86400000||r.timestamp>now+30000)continue;
  const key=r.id+':'+Math.floor(r.timestamp/60000);if(!m.has(key)||m.get(key).timestamp<r.timestamp)m.set(key,r);
 }return [...m.values()].sort((a,b)=>a.timestamp-b.timestamp).slice(-21000);
}
export function historyRows(samples,id,from,to=Date.now()){
 const rows=samples.filter(r=>r.timestamp>=from&&r.timestamp<=to);
 if(id!=='combined')return rows.filter(r=>r.id===id);
 const m=new Map();for(const r of rows){let t=Math.floor(r.timestamp/60000)*60000;if(!m.has(t))m.set(t,{});m.get(t)[r.id]=r;}
 return [...m].filter(([,b])=>IDS.every(id=>b[id])).map(([timestamp,b])=>({timestamp,...Object.fromEntries(['solarW','loadW','gridW'].map(k=>[k,IDS.every(id=>finite(b[id][k]))?IDS.reduce((s,id)=>s+b[id][k],0):null]))})).sort((a,b)=>a.timestamp-b.timestamp);
}
