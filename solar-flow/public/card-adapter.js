import {finite, select, energy, IDS, names} from './model.js';

export function cardModel(data,system,now=Date.now(),connected=true,{wide=false,animate=true}={}){
  const s=select(data,system,now,connected),e=energy(data,system,now,connected);
  if(!s.complete||!['solarW','loadW','gridW'].every(k=>finite(s[k])))return null;
  const ids=system==='combined'?IDS:[system], rows=ids.map(id=>data.solar[id]);
  const states={},entities={};
  const add=(key,value,unit,label)=>{
    if(!finite(value))return;
    const id='sensor.raja_'+key;
    entities[key]=id;
    states[id]={entity_id:id,state:String(value),attributes:{unit_of_measurement:unit,friendly_name:label},last_changed:new Date(s.timestamp).toISOString(),last_updated:new Date(s.timestamp).toISOString()};
  };
  add('pv_total',s.solarW,'W','Solar production');
  add('essential_power',s.loadW,'W','Inverter output load');
  add('grid_ct_power_172',s.gridW,'W','Grid exchange: positive import, negative export');
  add('grid_power_169',s.gridW,'W','Reported inverter grid exchange');
  add('day_pv_energy_108',e.solar,'kWh','Today’s generation');
  add('day_load_energy_84',e.load,'kWh','Today’s inverter load');
  add('day_grid_import_76',e.import,'kWh','Today’s grid import');
  add('day_grid_export_77',e.export,'kWh','Today’s grid export');
  // Inverter totals are independent feeds, not MPPT strings of one physical unit.
  // Their names remain visible when shown together on the overview card.
  const pv=system==='combined'?rows.map((r,i)=>({watts:r.solarW,name:names[ids[i]]})):((rows[0].strings?.length&&rows[0].strings.every(p=>finite(p.watts)))?rows[0].strings.slice(0,6).map(p=>({...p,name:'PV '+p.id})):[{watts:s.solarW,name:names[system]}]);
  const solar={mppts:pv.length,show_daily:finite(e.solar),colour:'#f4c755',dynamic_colour:true,max_power:s.installedW,auto_scale:true,animation_speed:7,display_mode:1,efficiency:0};
  pv.forEach((p,i)=>{
    const n=i+1;
    add('pv'+n+'_power_'+(186+i),p.watts,'W',p.name);
    // The upstream card uses 186..189 for MPPT 1..4; MPPT5/6 have no suffix.
    if(n>4){entities['pv'+n+'_power']=entities['pv'+n+'_power_'+(186+i)];}
    solar['pv'+n+'_name']=p.name;
  });
  if(system!=='combined'){
    add('inverter_voltage_154',rows[0].outputV,'V','Inverter output voltage');
  }
  // A supported Sunsynk status is deliberately not inferred from a Fronus fault code.
  // Battery flow is omitted: Matrix is an independent battery-only feed.
  const config={type:'custom:sunsynk-power-flow-card',cardstyle:'full',wide,large_font:false,show_solar:true,show_grid:true,show_battery:false,card_height:'100%',card_width:'100%',decimal_places:2,decimal_places_energy:2,disable_animations:!animate,inverter:{modern:true,colour:'#d5d8e1',autarky:'no',model:'sunsynk',auto_scale:true},solar,load:{colour:'#64d7ad',essential_name:'Inverter load',show_aux:false,show_daily:finite(e.load),max_power:s.ratingW||16000,auto_scale:true},grid:{colour:'#6eaff5',export_colour:'#64d7ad',grid_name:'Grid exchange',show_nonessential:false,show_daily_buy:finite(e.import),show_daily_sell:finite(e.export),max_power:16000,auto_scale:true,off_threshold:0},entities};
  return {config,hass:{states,language:'en',selectedLanguage:'en',locale:{language:'en',number_format:'language',time_format:'24',date_format:'language',first_weekday:'monday'},themes:{darkMode:true,default_theme:'default',themes:{}},localize:key=>key,callService:()=>Promise.reject(new Error('Read-only monitoring'))},snapshot:s};
}
