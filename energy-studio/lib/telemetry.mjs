export const SOLAR_IDS = ['pv14000', 'pv9000'];
export const num = v => v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v);
export const pkDay = t => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).format(t);
export function sourceTime(d) {
  const t=d?.timeDate?.dateTime, offset=num(d?.timeDate?.offset?.totalSeconds);
  if(t?.date&&t?.time&&offset!==null){const {year,month,day}=t.date,{hour,minute,second}=t.time;if([year,month,day,hour,minute,second].every(Number.isFinite))return Date.UTC(year,month-1,day,hour,minute,second)-offset*1000;}
  const s=d?.realTime;
  const match=typeof s==='string'&&s.match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2}:\d{2}(?::\d{2})?)$/);
  const time=match?Date.parse(`${match[3]}-${match[2]}-${match[1]}T${match[4]}+05:00`):Date.parse(s);
  return Number.isFinite(time)?time:null;
}
export const isFresh=(t,now,maxAge)=>Number.isFinite(t)&&now-t<=maxAge&&t-now<=30000;
export function solarReading(raw,id,now=Date.now()) {
  if(raw?.ok!==true)throw new Error('Source unavailable');
  const d=raw.data?.dataDTO||raw.data;
  if(!d||num(d.solarW)===null)throw new Error('Incomplete solar data');
  const timestamp=sourceTime(d), offline=[false,0,'0','false','offline'].includes(d.online??d.isOnline??d.status);
  return {id,status:!offline&&isFresh(timestamp,now,180000)?'live':'stale',timestamp,receivedAt:now,
    solarW:num(d.solarW),loadW:num(d.acOutW),gridW:num(d.gridW),gridV:num(d.gridV),gridHz:num(d.gridHz),temperature:num(d.heatSinkDegC),
    ratingW:num(d.acOutRatingW),installedW:num(d.pvInstalled),fault:typeof d.fault==='string'?d.fault:null,
    strings:[1,2,3].map(i=>({id:i,watts:num(d[`solarW${i}`]),volts:num(d[`solarV${i}`]),amps:num(d[`solarA${i}`])})).filter(s=>s.watts>0||s.volts>0),
    inputMode:d.inputVoltType??null,outputV:num(d.acOutRatingV)};
}
export function batteryReading(raw,expected,now=Date.now()) {
  if(raw?.ok!==true)throw new Error('Battery connection pending');
  const d=raw.data;
  if(!d||d.scope!=='battery_only')throw new Error('Battery feed unavailable');
  const timestamp=num(d.timestamp),matched=String(d.deviceId)===String(expected);
  const fresh=matched&&d.status==='live'&&isFresh(timestamp,now,900000);
  const soc=num(d.batterySoc),power=num(d.batteryPower);
  return {id:'matrix',scope:'battery_only',status:!matched?'device_mismatch':fresh?'live':'stale',timestamp,receivedAt:now,
    soc:fresh&&soc!==null&&soc>=0&&soc<=100?soc:null,voltage:fresh?num(d.batteryVoltage):null,current:fresh?num(d.batteryCurrent):null,
    power:fresh?power:null,temperature:fresh?num(d.batteryTemperature):null,
    mode:!fresh||power===null?'unknown':Math.abs(power)<20?'idle':power<0?'charging':'discharging',
    chargedKwh:fresh?num(d.todayBatteryCharge):null,dischargedKwh:fresh?num(d.todayBatteryDischarge):null};
}
export function energyReading(raw,now=Date.now()) {
  if(raw?.ok!==true||!raw.data)throw new Error('Energy totals unavailable');
  const d=raw.data.dataDTO||raw.data;
  return {date:pkDay(now),receivedAt:now,solar:num(d.todaySolar),load:num(d.todayLoad),import:num(d.todayGrid),export:num(d.todayNetGrid)};
}
export function totals(solar,energy={},now=Date.now()) {
  const all=SOLAR_IDS.every(id=>solar[id]?.status==='live'&&isFresh(solar[id].timestamp,now,180000));
  const sum=k=>all&&SOLAR_IDS.every(id=>num(solar[id][k])!==null)?SOLAR_IDS.reduce((s,id)=>s+solar[id][k],0):null;
  const daily=k=>all&&SOLAR_IDS.every(id=>energy[id]?.date===pkDay(now)&&now-energy[id].receivedAt<180000&&num(energy[id][k])!==null)?SOLAR_IDS.reduce((s,id)=>s+energy[id][k],0):null;
  return {complete:all,solarW:sum('solarW'),loadW:sum('loadW'),gridW:sum('gridW'),todaySolar:daily('solar'),todayExport:daily('export'),todayImport:daily('import'),todayLoad:daily('load')};
}
export function cleanHistory(raw,now=Date.now()) {
  const rows=raw?.ok===true&&Array.isArray(raw.data)?raw.data:[];
  return rows.filter(p=>num(p.timestamp)!==null&&p.timestamp<=now+30000&&p.timestamp>=now-86400000)
    .map(p=>({timestamp:Number(p.timestamp),solarW:num(p.solarW),gridV:num(p.gridV),loadW:num(p.loadW),gridW:num(p.gridW)})).sort((a,b)=>a.timestamp-b.timestamp);
}
