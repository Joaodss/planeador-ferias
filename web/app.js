(function(){
"use strict";
const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2,'0');
const esc = s => String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const cssSlot = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--slot')) || 24;
let SLOT = cssSlot(); const PXM = () => SLOT/30; const SNAP = 15;
/* Textos: ver i18n.js. tr(chave, {marcadores}) devolve o texto na língua escolhida. */
const tr = I18N.tr;
const WD = () => tr('wd'), MON = () => tr('mon'), CATS = () => tr('cats'), STATUS = () => tr('status');
const artDay = w => tr('onDay',{w});
const daysPhrase = ws => ws.slice().sort((x,y)=>((x||7)-(y||7))).map(artDay).join(', ').replace(/, ([^,]*)$/,' '+tr('and')+' $1');

/* ---------- dates & times ---------- */
const parseISO = s => { const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); };
const iso = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const addDays = (d,n) => { const x=new Date(d); x.setDate(x.getDate()+n); return x; };
const mlabel = m => { const x=((m%1440)+1440)%1440; return pad(Math.floor(x/60))+':'+pad(x%60); };
const durLabel = n => { const h=Math.floor(n/60), m=n%60; return h ? (m? `${h}h${pad(m)}` : `${h}h`) : `${m} min`; };
function dayLabel(date, withMonth){ const d=parseISO(date); return `${WD()[d.getDay()]} ${d.getDate()}${withMonth?' '+MON()[d.getMonth()]:''}`; }

/* ---------- store ---------- */
let store = {version:2, trips:[]};
let activeId = null;
const ACTIVE_KEY='ferias-active-trip', SLEEP_KEY='ferias-hide-sleep';
try{ activeId = localStorage.getItem(ACTIVE_KEY); }catch(e){}
function T(){ return store.trips.find(t=>t.id===activeId) || null; }
function ensureActive(){ if(!T()) activeId = store.trips.length ? store.trips[0].id : null; }
function days(t){ const out=[]; if(!t) return out; let d=parseISO(t.start); const e=parseISO(t.end); while(d<=e && out.length<120){ out.push(iso(d)); d=addDays(d,1);} return out; }
function view(t){ const T0=t.dayStart*60; const span=(((t.dayEnd - t.dayStart)+24)%24 || 24)*60; return {T0, span, T1:T0+span}; }
function fmt(v){ const t=T(); const cur=(t&&t.currency)||'€'; const n=(Math.round(v*100)/100).toLocaleString(I18N.locale,{maximumFractionDigits:2}); return cur==='€' && I18N.lang==='pt' ? n+' €' : cur+n; }
function blockCostPP(b){ const t=T(); return (b.pp||0) + (b.total ? b.total/Math.max(1,t.people||1) : 0); }
function placeById(id){ const t=T(); return t && t.places.find(p=>p.id===id); }
function placeName(id){ const p=placeById(id); return p ? p.name : ''; }
function short(n){ return n.split(' ·')[0]; }
function newId(p){ return (p||'n')+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }

/* ---------- fusos ----------
   As horas da grelha são a hora local da viagem (t.tz). O segundo fuso aparece numa
   coluna de horas ao lado: o escolhido neste dispositivo, senão PLANNER_HOME_TZ, senão o do browser. */
const HOME_KEY='ferias-home-tz';
let serverHomeTz='';
function defaultHomeTz(){ return TZ.valid(serverHomeTz) ? serverHomeTz : TZ.local(); }
function ownHomeTz(){ try{ const v=localStorage.getItem(HOME_KEY)||''; return TZ.valid(v)?v:''; }catch(e){ return ''; } }
function homeTz(){ return ownHomeTz() || defaultHomeTz(); }
/* Segundo fuso da viagem t, ou null se não houver fuso da viagem ou se forem iguais. */
function secondTz(t){
  const h=homeTz(); if(!t || !TZ.valid(t.tz) || !TZ.valid(h)) return null;
  const diff=TZ.diff(t.tz,h,t.start); return diff ? {tz:h, diff} : null;
}
/* Aceita "Asia/Tokyo", "asia/tokyo" ou só "Tokyo". Devolve '' se vazio e null se não reconhecer. */
function resolveTz(v){
  v=v.trim(); if(!v) return '';
  const n=v.toLowerCase().replace(/\s+/g,'_');
  const hit=TZ.all.find(z=>z.toLowerCase()===n) || TZ.all.find(z=>z.toLowerCase().endsWith('/'+n));
  return hit || (TZ.valid(v) ? v : null);
}

/* ---------- server sync ----------
   Cada viagem é um ficheiro no servidor com um número de revisão (rev).
   A página guarda só as viagens que mudaram e envia a revisão em que se baseou;
   se outro dispositivo gravou entretanto, o servidor responde 409 e fica a versão dele. */
let history = [], dirty=false, saving=false, saveTimer=null, online=true, authed=false;
const revs = {}, synced = {};
function normTrip(t){ t.places=t.places||[]; t.dayPlaces=t.dayPlaces||{}; t.blocks=t.blocks||[]; t.tray=t.tray||[]; t.people=t.people||1; t.currency=t.currency||'€'; if(t.dayStart==null) t.dayStart=7; if(t.dayEnd==null) t.dayEnd=1; return t; }
async function api(method, path, body){
  const headers={'X-Requested-With':'planner'}; if(body!==undefined) headers['Content-Type']='application/json';
  const r = await fetch(path,{method, headers, body, credentials:'same-origin', cache:'no-store'});
  if(r.status===401){ showLogin(); throw {code:'auth'}; }
  return r;
}
function computeDirty(){ const ids=new Set(store.trips.map(t=>t.id)); return store.trips.some(t=>synced[t.id]!==JSON.stringify(t)) || Object.keys(synced).some(id=>!ids.has(id)); }
function setSave(s,txt){ $('#save').dataset.s=s; $('#save-txt').textContent=txt; }
function refreshSaveLabel(){
  if(saving) return setSave('saving',tr('saving'));
  if(!online) return setSave('error',tr('saveError'));
  if(dirty) return setSave('dirty',tr('unsaved'));
  setSave('saved',tr('allSaved'));
}
function scheduleSave(delay){ clearTimeout(saveTimer); saveTimer=setTimeout(doSave, delay||1200); refreshSaveLabel(); }
function clearHistory(){ history=[]; $('#undo').disabled=true; }
async function doSave(){
  if(saving || !authed) return;
  if(!computeDirty()){ dirty=false; refreshSaveLabel(); return; }
  saving=true; refreshSaveLabel(); let conflict=false, tooBig=false;
  try{
    const ids=new Set(store.trips.map(t=>t.id));
    for(const id of Object.keys(synced)){
      if(ids.has(id)) continue;
      const r=await api('DELETE','/api/trips/'+encodeURIComponent(id));
      if(!r.ok) throw {code:'http'};
      delete synced[id]; delete revs[id];
    }
    for(const t of store.trips.slice()){
      const js=JSON.stringify(t); if(synced[t.id]===js) continue;
      const r=await api('PUT','/api/trips/'+encodeURIComponent(t.id), '{"baseRev":'+(revs[t.id]||0)+',"trip":'+js+'}');
      if(r.ok){ const d=await r.json(); revs[t.id]=d.rev; synced[t.id]=js; }
      else if(r.status===409){
        const d=await r.json(); conflict=true; const i=store.trips.indexOf(t);
        if(d.deleted){ if(i>=0) store.trips.splice(i,1); delete synced[t.id]; delete revs[t.id]; }
        else { const nt=normTrip(d.trip); if(i>=0) store.trips[i]=nt; revs[nt.id]=d.rev; synced[nt.id]=JSON.stringify(nt); }
      }
      else if(r.status===413){ tooBig=true; synced[t.id]=js; }
      else throw {code:'http'};
    }
    online=true;
  }catch(e){ if(!e || e.code!=='auth') online=false; }
  saving=false; dirty=computeDirty(); refreshSaveLabel();
  if(conflict){ clearHistory(); closeSheets(); ensureActive(); render(); toast(tr('tConflict')); }
  if(tooBig) toast(tr('tTooBig'));
  if(dirty && authed) scheduleSave(online?1200:8000);
}
function commit(){ dirty=true; scheduleSave(); render(); }
function pushHistory(){ history.push(JSON.stringify(store)); if(history.length>60) history.shift(); $('#undo').disabled=false; }
function undo(){ if(!history.length) return; store=JSON.parse(history.pop()); ensureActive(); $('#undo').disabled=!history.length; closeSheets(); commit(); announce(tr('undone')); }

function applyServer(d){
  for(const k of Object.keys(revs)) delete revs[k];
  for(const k of Object.keys(synced)) delete synced[k];
  serverHomeTz=d.homeTz||'';
  const trips=d.trips.map(x=>{ const t=normTrip(x.trip); revs[t.id]=x.rev; synced[t.id]=JSON.stringify(t); return t; });
  trips.sort((a,b)=>String(a.start).localeCompare(String(b.start)));
  store={version:2, trips};
}
function showApp(){ authed=true; $('#login').hidden=true; $('#offline').hidden=true; $('.app').hidden=false; }
async function loadAll(){
  const r=await api('GET','/api/trips'); if(!r.ok) throw {code:'http'};
  applyServer(await r.json()); clearHistory(); dirty=false; online=true;
  showApp(); ensureActive(); render(); refreshSaveLabel();
}
async function boot(){
  try{ await loadAll(); }
  catch(e){ if(e && e.code==='auth') return; $('#offline').hidden=false; setTimeout(boot,5000); }
}
/* Ao voltar ao separador, vai buscar o que mudou noutros dispositivos. */
async function refresh(){
  try{
    const r=await api('GET','/api/trips'); if(!r.ok) return; const d=await r.json();
    if(saving || computeDirty()) return;
    const sig=a=>JSON.stringify(a.sort());
    if(sig(store.trips.map(t=>t.id+':'+revs[t.id]))===sig(d.trips.map(x=>x.trip.id+':'+x.rev))) return;
    applyServer(d); clearHistory(); closeSheets(); ensureActive(); render();
    toast(tr('tRefreshed'));
  }catch(e){}
}
document.addEventListener('visibilitychange',()=>{
  if(!authed) return;
  if(document.hidden){ if(computeDirty()){ clearTimeout(saveTimer); doSave(); } return; }
  if(!saving && !drag && !computeDirty()) refresh();
});
window.addEventListener('beforeunload',e=>{ if(authed && computeDirty()){ e.preventDefault(); e.returnValue=''; } });

/* login */
function showLogin(){
  authed=false; clearTimeout(saveTimer);
  $('.app').hidden=true; $('#offline').hidden=true; $('#login').hidden=false; $('#l-err').hidden=true;
  ($('#l-user').value ? $('#l-pass') : $('#l-user')).focus();
}
$('#login-form').addEventListener('submit', async e=>{
  e.preventDefault(); const err=$('#l-err'), btn=$('#l-submit'); err.hidden=true;
  const fail=m=>{ err.textContent=m; err.hidden=false; };
  if(!$('#l-user').value.trim() || !$('#l-pass').value) return fail(tr('errFill'));
  btn.disabled=true; btn.textContent=tr('signingIn');
  try{
    const r=await fetch('/api/login',{method:'POST', headers:{'Content-Type':'application/json','X-Requested-With':'planner'}, credentials:'same-origin', body:JSON.stringify({user:$('#l-user').value, password:$('#l-pass').value})});
    if(r.ok){ $('#l-pass').value=''; if(computeDirty()){ showApp(); render(); doSave(); } else await loadAll(); }
    else if(r.status===429) fail(tr('errTooMany'));
    else fail(tr('errWrong'));
  }catch(ex){ if(!ex || ex.code!=='auth') fail(tr('errServer')); }
  finally{ btn.disabled=false; btn.textContent=tr('signIn'); }
});
$('#logout').addEventListener('click', async ()=>{
  if(computeDirty()){ clearTimeout(saveTimer); await doSave(); if(computeDirty()){ toast(tr('tLogoutPending')); return; } }
  try{ await fetch('/api/logout',{method:'POST', headers:{'X-Requested-With':'planner'}, credentials:'same-origin'}); }catch(e){}
  store={version:2, trips:[]}; applyServer({trips:[]}); clearHistory(); closeSheets(); showLogin();
});

/* ficheiros */
function saveFile(name, blob){
  const u=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=u; a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(u),2000);
}
let xlsxP=null;
function loadXLSX(){
  if(window.XLSX) return Promise.resolve(true);
  if(!xlsxP) xlsxP=new Promise(res=>{ const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload=()=>res(true); s.onerror=()=>{ xlsxP=null; s.remove(); res(false); }; document.head.appendChild(s); });
  return xlsxP;
}

/* ---------- lookup / mutate ---------- */
function findBlock(id){ const t=T(); if(!t) return null; let b=t.blocks.find(x=>x.id===id); if(b) return {b,where:'grid'}; b=t.tray.find(x=>x.id===id); return b?{b,where:'tray'}:null; }
function blocksOf(date){ return T().blocks.filter(b=>b.date===date).sort((a,b)=>a.start-b.start||b.len-a.len); }
function moveTo(id,date,start){ const t=T(), f=findBlock(id); if(!f) return; const b=f.b; const v=view(t);
  if(f.where==='tray'){ t.tray=t.tray.filter(x=>x!==b); t.blocks.push(b); }
  b.date=date; b.start=Math.max(v.T0, Math.min(v.T1-b.len, start)); }
function toTray(id){ const t=T(), f=findBlock(id); if(!f||f.where==='tray') return; t.blocks=t.blocks.filter(x=>x!==f.b); delete f.b.date; delete f.b.start; t.tray.push(f.b); }

/* ---------- warnings ---------- */
function computeWarnings(){
  const t=T(); if(!t) return []; const W=[]; const v=view(t); const ds=days(t);
  ds.forEach((date,i)=>{
    const list=blocksOf(date); const wd=parseISO(date).getDay(); const dp=t.dayPlaces[date]||[];
    for(let a=0;a<list.length;a++) for(let c=a+1;c<list.length;c++){
      const x=list[a], y=list[c];
      if(y.start < x.start+x.len && x.start < y.start+y.len){
        const sl = x.cat==='sleep'||y.cat==='sleep'; const o = x.cat==='sleep'?y:x;
        W.push({sev:sl?'warn':'bad', ids:[x.id,y.id], date, t: sl?tr('wSleep',{a:o.title}):tr('wOverlap',{a:x.title,b:y.title}), d:`${dayLabel(date,true)} · ${mlabel(Math.max(x.start,y.start))}–${mlabel(Math.min(x.start+x.len,y.start+y.len))}`});
      }
    }
    for(const b of list){
      if(b.weekdays && b.weekdays.length && !b.weekdays.includes(wd)){
        const ok = ds.filter(dd=>b.weekdays.includes(parseISO(dd).getDay()) && (!b.place || !(t.dayPlaces[dd]||[]).length || (t.dayPlaces[dd]||[]).includes(b.place)));
        W.push({sev:'bad', ids:[b.id], date, t:tr('wWeekday',{a:b.title,day:artDay(wd)}), d:tr('wWeekdayD',{days:daysPhrase(b.weekdays), ok:ok.map(dd=>dayLabel(dd)).join(', ')||tr('none')})});
      }
      if(b.place && dp.length && !dp.includes(b.place)){
        W.push({sev:'bad', ids:[b.id], date, t:tr('wPlace',{a:b.title,place:placeName(b.place)}), d:tr('wPlaceD',{day:dayLabel(date,true), places:dp.map(placeName).join(' → ')})});
      }
      if(b.start < v.T0 || b.start+b.len > v.T1){
        W.push({sev:'warn', ids:[b.id], date, t:tr('wHours',{a:b.title}), d:tr('wHoursD',{time:mlabel(b.start)})});
      }
      if(b.cat==='party' && b.start+b.len>=1380 && i<ds.length-1){
        for(const n of blocksOf(ds[i+1]).filter(n=>['tour','transport','party'].includes(n.cat) && n.start<600))
          W.push({sev:'warn', ids:[b.id,n.id], date:ds[i+1], t:tr('wNight',{b:n.title}), d:tr('wNightD',{a:b.title, t1:mlabel(b.start+b.len), b:n.title, t2:mlabel(n.start), day:dayLabel(ds[i+1])})});
      }
    }
  });
  const outside = t.blocks.filter(b=>!ds.includes(b.date));
  for(const b of outside) W.push({sev:'bad', ids:[b.id], date:b.date, t:tr('wDates',{a:b.title}), d:tr('wDatesD',{date:b.date})});
  return W;
}

/* ---------- render ---------- */
function laneLayout(list){
  const res=new Map(); let cl=[], end=-1;
  const flush=()=>{ const lanes=[]; for(const b of cl){ let li=lanes.findIndex(e=>e<=b.start); if(li<0){ li=lanes.length; lanes.push(0);} lanes[li]=b.start+b.len; res.set(b.id,{lane:li}); } for(const b of cl) res.get(b.id).n=lanes.length; cl=[]; end=-1; };
  for(const b of list){ if(cl.length && b.start>=end) flush(); cl.push(b); end=Math.max(end,b.start+b.len); }
  if(cl.length) flush(); return res;
}
function blockEl(b, warnMap, inTray){
  const el=document.createElement('div');
  el.className='blk cat-'+b.cat+(b.locked?' locked':'')+(b.status==='ideia'?' status-ideia':'');
  el.dataset.id=b.id; el.tabIndex=0; el.setAttribute('role','button');
  const w=warnMap.get(b.id);
  const cost = b.pp ? `<span class="eur">${fmt(b.pp)} pp</span>` : (b.total ? `<span class="eur">${fmt(b.total)}</span>` : '');
  const st = b.status ? `<span class="st st-${b.status}">${(b.status==='reservado'||b.status==='pago')?'✓ ':''}${STATUS()[b.status]}</span>` : '';
  const time = inTray ? durLabel(b.len) : `${mlabel(b.start)}–${mlabel(b.start+b.len)}`;
  el.innerHTML = `<div class="t">${esc(b.title)}</div><div class="m"><span>${time}</span>${cost}${st}</div>`
    + (w?`<span class="badge" title="${esc(w.map(x=>x.t).join('\n'))}">!</span>`:'')
    + (b.locked?`<svg class="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`:'')
    + (inTray?'':'<div class="grip" aria-hidden="true"></div>');
  if(w){ el.classList.add('has-badge'); if(w.some(x=>x.sev==='bad')) el.classList.add('bad'); }
  el.setAttribute('aria-label', `${b.title}, ${inTray?tr('unscheduledLower'):dayLabel(b.date,true)+' '+time}${b.status?', '+STATUS()[b.status]:''}${w?', '+tr('nWarnings',{n:w.length}):''}`);
  return el;
}
let hideSleep=false, lastWarnings=[];
function render(){
  SLOT=cssSlot(); ensureActive();
  const t=T();
  // trip switcher
  const sel=$('#trip-sel'); sel.innerHTML = `<option value="">${store.trips.length>1?tr('switchTrip'):tr('trips')}</option>` + store.trips.map(x=>`<option value="${esc(x.id)}"${t&&x.id===t.id?' disabled':''}>${esc(x.name)}${t&&x.id===t.id?tr('openMark'):''}</option>`).join('') + `<option value="__new">${tr('newTripOpt')}</option>`;
  sel.value='';
  const board=$('#board'); const sc=$('#scroller'); const sl=sc.scrollLeft, st=sc.scrollTop;
  board.innerHTML='';
  if(!t){
    $('#trip-name').textContent=tr('appName'); $('#route').textContent=''; board.classList.remove('two-tz');
    board.style.gridTemplateColumns='1fr';
    board.innerHTML = `<div class="empty-board"><div class="card"><h2>${tr('emptyH')}</h2><p>${tr('emptyP')}</p><div class="actions"><button class="btn primary" type="button" id="empty-new">${tr('newTrip')}</button><button class="btn" type="button" id="empty-import">${tr('importBackup')}</button></div></div></div>`;
    $('#empty-new').addEventListener('click',()=>openTripSheet(true));
    $('#empty-import').addEventListener('click',()=>$('#import-file').click());
    document.title=tr('appName');
    $('#tray-list').innerHTML=''; ['#tot-pp','#tot-n','#tot-res'].forEach(s=>$(s).textContent='—'); $('#warn-txt').textContent='—'; return;
  }
  document.title = t.name ? `${t.name} · ${tr('appName')}` : tr('appName');
  $('#trip-name').textContent=t.name;
  const ds=days(t), v=view(t), H=v.span*PXM();
  // route summary
  const seq=[]; ds.forEach(d=>(t.dayPlaces[d]||[]).forEach(p=>{ if(seq[seq.length-1]!==p) seq.push(p); }));
  const s0=parseISO(t.start), s1=parseISO(t.end);
  const range = s0.getMonth()===s1.getMonth() ? `${s0.getDate()}–${s1.getDate()} ${MON()[s1.getMonth()]} ${s1.getFullYear()}` : `${s0.getDate()} ${MON()[s0.getMonth()]} – ${s1.getDate()} ${MON()[s1.getMonth()]} ${s1.getFullYear()}`;
  const sec=secondTz(t);
  $('#route').innerHTML = `<span>${range} · ${tr('nDays',{n:ds.length})}</span>` + (seq.length ? '<span class="arrow">·</span>'+seq.map(p=>`<b>${esc(short(placeName(p)))}</b>`).join('<span class="arrow">→</span>') : `<span class="arrow">·</span><span>${tr('clickDay')}</span>`)
    + (TZ.valid(t.tz) ? `<span class="arrow">·</span><span title="${esc(t.tz)}">${tr('tzRoute',{city:esc(TZ.city(t.tz))})}${sec?` (${esc(TZ.city(sec.tz))} ${TZ.diffLabel(sec.diff)})`:''}</span>` : '');
  const narrow=matchMedia('(max-width:640px)').matches;
  board.classList.toggle('two-tz', !!sec);
  board.style.gridTemplateColumns = `${sec?(narrow?84:98):(narrow?48:58)}px repeat(${ds.length}, minmax(${matchMedia('(max-width:640px)').matches?124:138}px,1fr))`;
  // warnings
  const warns=computeWarnings(); const warnMap=new Map();
  for(const w of warns) for(const id of w.ids){ if(!warnMap.has(id)) warnMap.set(id,[]); warnMap.get(id).push(w); }
  const corner=Object.assign(document.createElement('div'),{className:'corner'});
  if(sec) corner.innerHTML=`<span class="sec" title="${esc(sec.tz)}">${esc(TZ.city(sec.tz))}</span><span title="${esc(t.tz)}">${esc(TZ.city(t.tz))}</span>`;
  board.appendChild(corner);
  ds.forEach((date,i)=>{
    const d=parseISO(date), wd=d.getDay();
    const h=document.createElement('button'); h.type='button'; h.className='dh'+((wd===0||wd===6)?' weekend':''); h.dataset.date=date;
    const locs=t.dayPlaces[date]||[];
    const cost=blocksOf(date).reduce((s,b)=>s+blockCostPP(b),0)+dayCostPP(date);
    if(locs.length) h.style.setProperty('--loc-c', `linear-gradient(90deg, ${locs.map((l,k)=>`var(--p${((placeById(l)||{c:1}).c-1)%8+1}) ${k*100/locs.length}% ${(k+1)*100/locs.length}%`).join(',')})`);
    const showMonth = i===0 || d.getDate()===1;
    h.innerHTML = `<div class="strip"></div><div class="date"><span class="num">${d.getDate()}</span><span class="wd">${WD()[wd]}${showMonth?' · '+MON()[d.getMonth()]:''}</span><span class="cost">${cost?fmt(cost)+' pp':''}</span></div>`
      + (locs.length ? `<div class="loc" title="${esc(locs.map(placeName).join(' → '))}">${locs.map(l=>esc(short(placeName(l)))).join(' <span class="ferry">→</span> ')}</div>` : `<div class="loc none">${tr('whereClick')}</div>`);
    h.setAttribute('aria-label', `${dayLabel(date,true)}${locs.length?', '+locs.map(placeName).join(tr('placesJoin')):''}. ${tr('openDay')}`);
    board.appendChild(h);
  });
  const times=document.createElement('div'); times.className='times'; times.style.height=H+'px'; times.style.position='sticky';
  for(let m=Math.ceil((v.T0+1)/60)*60; m<v.T1; m+=60){ const sp=document.createElement('span'); sp.style.top=((m-v.T0)*PXM())+'px'; sp.textContent=mlabel(m); if(m%1440===0) sp.className='mid'; times.appendChild(sp);
    if(sec){ const m2=m+sec.diff, s2=document.createElement('span'); s2.className='sec'+(((m2%1440)+1440)%1440===0?' mid':''); s2.style.top=sp.style.top; s2.textContent=mlabel(m2); times.appendChild(s2); } }
  board.appendChild(times);
  ds.forEach(date=>{
    const col=document.createElement('div'); col.className='day-col'; col.dataset.date=date; col.style.height=H+'px';
    if(v.T1>1440 && v.T0<1440){ col.style.setProperty('--night-top', ((1440-v.T0)*PXM())+'px'); col.insertAdjacentHTML('beforeend', `<div class="midnight" style="top:${(1440-v.T0)*PXM()}px" aria-hidden="true"></div>`); }
    const list=blocksOf(date).filter(b=>b.start+b.len>v.T0 && b.start<v.T1);
    const layout=laneLayout(hideSleep?list.filter(b=>b.cat!=='sleep'):list);
    for(const b of list){
      const el=blockEl(b,warnMap,false); const L=layout.get(b.id)||{lane:0,n:1}; const wp=100/L.n;
      const top=Math.max(0,(b.start-v.T0))*PXM(); const bottom=Math.min(v.span,(b.start+b.len-v.T0))*PXM(); const hp=bottom-top-2;
      el.style.top=(top+1)+'px'; el.style.height=hp+'px'; el.style.left=`calc(${L.lane*wp}% + 3px)`; el.style.width=`calc(${wp}% - 6px)`;
      if(hp<40) el.classList.add('short');
      el.style.setProperty('--lines', Math.max(1, Math.floor((hp-22)/15)));
      col.appendChild(el);
    }
    board.appendChild(col);
  });
  sc.scrollLeft=sl; sc.scrollTop=st;
  // tray
  const tl=$('#tray-list'); tl.innerHTML='';
  if(!t.tray.length) tl.innerHTML=`<span class="tray-empty">${tr('trayEmpty')}</span>`;
  for(const b of t.tray) tl.appendChild(blockEl(b,warnMap,true));
  // stats
  const pp=tripTotal(t)/nPeople(t);
  $('#tot-pp').textContent=fmt(pp); $('#tot-n-k').textContent = t.people>1 ? tr('totalFor',{n:t.people}) : tr('total'); $('#tot-n').textContent=fmt(pp*(t.people||1));
  const res=t.blocks.concat(t.tray).filter(b=>b.status==='reservar').length; $('#tot-res').textContent=String(res);
  const btn=$('#warn-btn'); const bad=warns.filter(w=>w.sev==='bad').length;
  btn.classList.toggle('has-warn', warns.length>0 && !bad); btn.classList.toggle('has-bad', bad>0);
  $('#warn-txt').textContent = warns.length ? tr('nToReview',{n:warns.length}) : tr('noConflicts');
  lastWarnings=warns;
  if(!$('#warnings').hidden) renderWarnings();
  if(editingId && !$('#editor').hidden) fillEditor(false);
  if(dayOpen && !$('#daysheet').hidden) fillDay();
  if(!$('#costsheet').hidden) renderDash();
}
function renderWarnings(){
  const box=$('#w-list'); box.innerHTML='';
  if(!lastWarnings.length){ box.innerHTML=`<div class="empty-ok">${tr('warnOk')}</div>`; return; }
  box.insertAdjacentHTML('beforeend',`<p class="hint">${tr('warnHint')}</p>`);
  lastWarnings.slice().sort((a,b)=>String(a.date).localeCompare(String(b.date))||(a.sev==='bad'?-1:1)).forEach(w=>{
    const it=document.createElement('button'); it.type='button'; it.className='warn-item'+(w.sev==='bad'?' bad':'');
    it.innerHTML=`<span class="sev"></span><span><div class="wt">${esc(w.t)}</div><div class="wd">${esc(w.d)}</div></span>`;
    it.addEventListener('click',()=>{ if(matchMedia('(max-width:640px)').matches) $('#warnings').hidden=true; focusBlock(w.ids[0]); });
    box.appendChild(it);
  });
}
function focusBlock(id){
  const el=document.querySelector(`.blk[data-id="${id}"]`); if(!el){ openEditor(id); return; }
  if(el.closest('.day-col')){ const r=el.getBoundingClientRect(), sr=scroller.getBoundingClientRect(); scroller.scrollBy({left:r.left-sr.left-90, top:r.top-sr.top-90, behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'}); }
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); el.focus({preventScroll:true});
}

/* ---------- drag & drop ---------- */
let drag=null, suppressClick=false; const scroller=$('#scroller');
document.addEventListener('pointerdown', e=>{
  const el=e.target.closest('.blk'); if(!el || e.button>0 || !T()) return;
  const f=findBlock(el.dataset.id); if(!f) return;
  const isGrip=!!e.target.closest('.grip'); const r=el.getBoundingClientRect();
  drag={id:el.dataset.id, el, pointerId:e.pointerId, type:e.pointerType, x0:e.clientX, y0:e.clientY, x:e.clientX, y:e.clientY, mode:isGrip?'resize':'move', active:false, offY:e.clientY-r.top, offX:e.clientX-r.left, w:r.width, locked:!!f.b.locked, timer:null};
  if(isGrip && e.pointerType!=='mouse'){ e.preventDefault(); startDrag(); }
  else if(e.pointerType!=='mouse' && !isGrip){ drag.timer=setTimeout(()=>{ if(drag && !drag.active && !drag.cancelled) startDrag(); },300); }
});
function startDrag(){
  if(!drag) return;
  if(drag.locked){ toast(tr('tLocked')); drag.cancelled=true; return; }
  drag.active=true; pushHistory(); document.body.classList.add('is-dragging');
  const f=findBlock(drag.id);
  if(drag.mode==='move'){
    const g=drag.el.cloneNode(true); g.classList.add('ghost'); g.classList.remove('flash');
    const hp=f.b.len*PXM()-2; g.style.width=Math.max(drag.w,130)+'px'; g.style.height=hp+'px'; g.style.left='0'; g.style.top='0';
    document.body.appendChild(g); drag.ghost=g; drag.offY=Math.min(drag.offY,hp-4); drag.el.classList.add('dragging');
  }
  if(navigator.vibrate && drag.type==='touch'){ try{ navigator.vibrate(12); }catch(e){} }
  updateDrag(); autoScroll();
}
document.addEventListener('pointermove', e=>{
  if(!drag || e.pointerId!==drag.pointerId) return;
  drag.x=e.clientX; drag.y=e.clientY;
  if(!drag.active){ const dist=Math.hypot(e.clientX-drag.x0,e.clientY-drag.y0);
    if(drag.type==='mouse' && dist>4 && !drag.cancelled) startDrag();
    else if(drag.type!=='mouse' && dist>8){ clearTimeout(drag.timer); drag.cancelled=true; }
    return; }
  e.preventDefault(); updateDrag();
},{passive:false});
function clearTargets(){ document.querySelectorAll('.drop-target').forEach(x=>x.classList.remove('drop-target')); const p=document.querySelector('.preview'); if(p) p.remove(); }
function updateDrag(){
  if(!drag||!drag.active) return;
  const t=T(), f=findBlock(drag.id); if(!f) return; const b=f.b, v=view(t);
  clearTargets(); drag.target=null;
  if(drag.mode==='resize'){
    const col=drag.el.closest('.day-col'); if(!col) return; const r=col.getBoundingClientRect();
    let end=v.T0+Math.round((drag.y-r.top)/PXM()/SNAP)*SNAP; end=Math.max(b.start+SNAP, Math.min(v.T1,end));
    drag.target={len:end-b.start};
    const p=document.createElement('div'); p.className='preview'; p.style.top=((b.start-v.T0)*PXM())+'px'; p.style.height=((end-b.start)*PXM())+'px';
    p.innerHTML=`<span>${mlabel(b.start)}–${mlabel(end)} · ${durLabel(end-b.start)}</span>`; col.appendChild(p); return;
  }
  drag.ghost.style.transform=`translate(${drag.x-Math.min(drag.offX,120)}px, ${drag.y-drag.offY}px) rotate(-1.2deg)`;
  const hit=document.elementFromPoint(drag.x,drag.y); const col=hit&&hit.closest('.day-col'); const tray=hit&&hit.closest('#tray');
  if(col){
    const date=col.dataset.date, r=col.getBoundingClientRect();
    let s=v.T0+Math.round((drag.y-drag.offY-r.top)/PXM()/SNAP)*SNAP; s=Math.max(v.T0, Math.min(v.T1-b.len, s));
    drag.target={date,start:s}; col.classList.add('drop-target');
    const wd=parseISO(date).getDay(); const dp=t.dayPlaces[date]||[];
    const clash=(b.weekdays&&b.weekdays.length&&!b.weekdays.includes(wd)) || (b.place&&dp.length&&!dp.includes(b.place));
    const p=document.createElement('div'); p.className='preview'+(clash?' bad':''); p.style.top=((s-v.T0)*PXM())+'px'; p.style.height=(b.len*PXM())+'px';
    p.innerHTML=`<span>${dayLabel(date)} · ${mlabel(s)}–${mlabel(s+b.len)}${clash?tr('seeWarnings'):''}</span>`; col.appendChild(p);
  } else if(tray){ drag.target={tray:true}; tray.classList.add('drop-target'); }
}
function autoScroll(){
  if(!drag||!drag.active) return;
  const r=scroller.getBoundingClientRect(), edge=56; let dx=0, dy=0;
  if(drag.y<r.top+edge+50 && drag.y>r.top-20) dy=-Math.ceil((r.top+edge+50-drag.y)/6);
  else if(drag.y>r.bottom-edge && drag.y<r.bottom+10) dy=Math.ceil((drag.y-(r.bottom-edge))/6);
  if(drag.x<r.left+edge+40) dx=-Math.ceil((r.left+edge+40-drag.x)/5);
  else if(drag.x>r.right-edge) dx=Math.ceil((drag.x-(r.right-edge))/5);
  if(dx||dy){ scroller.scrollBy(dx,dy); updateDrag(); }
  requestAnimationFrame(autoScroll);
}
function endDrag(e){
  if(!drag || e.pointerId!==drag.pointerId) return;
  clearTimeout(drag.timer); const d=drag; drag=null;
  document.body.classList.remove('is-dragging'); if(d.ghost) d.ghost.remove(); clearTargets();
  if(!d.active){ if(!d.cancelled && e.type==='pointerup' && Math.hypot(e.clientX-d.x0,e.clientY-d.y0)<8 && !(e.target.closest&&e.target.closest('.grip'))) openEditor(d.id); return; }
  if(e.type==='pointercancel' || !d.target){ history.pop(); $('#undo').disabled=!history.length; render(); return; }
  const f=findBlock(d.id);
  if(d.mode==='resize'){ f.b.len=d.target.len; announce(`${f.b.title}: ${durLabel(f.b.len)}`); }
  else if(d.target.tray){ toTray(d.id); announce(tr('movedToTray',{a:f.b.title})); }
  else { moveTo(d.id,d.target.date,d.target.start); announce(`${f.b.title} → ${dayLabel(d.target.date,true)}, ${mlabel(d.target.start)}`); }
  commit(); suppressClick=true; setTimeout(()=>suppressClick=false,50);
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', e=>{ if(drag && drag.active && drag.type!=='mouse') return; endDrag(e); });
document.addEventListener('touchmove', e=>{ if(drag&&drag.active){ e.preventDefault(); const tt=e.touches[0]; if(tt){ drag.x=tt.clientX; drag.y=tt.clientY; updateDrag(); } } },{passive:false});
document.addEventListener('touchend', ()=>{ if(drag&&drag.active&&drag.type!=='mouse') endDrag({pointerId:drag.pointerId,type:'pointerup',clientX:drag.x,clientY:drag.y,target:document.body}); });
document.addEventListener('contextmenu', e=>{ if(e.target.closest('.blk')) e.preventDefault(); });

$('#board').addEventListener('dblclick', e=>{
  if(e.target.closest('.blk')) return; const col=e.target.closest('.day-col'); if(!col) return;
  const t=T(), v=view(t), r=col.getBoundingClientRect();
  const s=Math.max(v.T0, Math.min(v.T1-60, v.T0+Math.floor((e.clientY-r.top)/PXM()/30)*30));
  pushHistory(); const b={id:newId('a'), date:col.dataset.date, start:s, len:60, title:tr('newActivity'), cat:'tour', status:'ideia'};
  t.blocks.push(b); commit(); openEditor(b.id,true);
});
$('#board').addEventListener('click', e=>{ const h=e.target.closest('.dh'); if(h) openDay(h.dataset.date); });

document.addEventListener('keydown', e=>{
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z' && !e.target.closest('input,textarea,select')){ e.preventDefault(); undo(); return; }
  if(e.key==='Escape'){ closeSheets(); return; }
  const el=e.target.closest&&e.target.closest('.blk'); if(!el) return;
  const f=findBlock(el.dataset.id); if(!f) return; const b=f.b;
  if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openEditor(b.id); return; }
  if(f.where==='tray'||b.locked) return;
  const k=e.key; if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(k)) return;
  e.preventDefault(); const t=T(), v=view(t), ds=days(t); const di=ds.indexOf(b.date); let ch=false; pushHistory();
  if(e.shiftKey){ if(k==='ArrowDown'&&b.start+b.len<v.T1){ b.len+=SNAP; ch=true; } if(k==='ArrowUp'&&b.len>SNAP){ b.len-=SNAP; ch=true; } }
  else { if(k==='ArrowUp'&&b.start>v.T0){ b.start-=SNAP; ch=true; } if(k==='ArrowDown'&&b.start+b.len<v.T1){ b.start+=SNAP; ch=true; }
    if(k==='ArrowLeft'&&di>0){ b.date=ds[di-1]; ch=true; } if(k==='ArrowRight'&&di>=0&&di<ds.length-1){ b.date=ds[di+1]; ch=true; } }
  if(!ch){ history.pop(); $('#undo').disabled=!history.length; return; }
  commit(); announce(`${b.title}: ${dayLabel(b.date,true)} ${mlabel(b.start)}–${mlabel(b.start+b.len)}`);
  const again=document.querySelector(`.blk[data-id="${b.id}"]`); if(again) again.focus();
});

/* ---------- sheets ---------- */
function closeSheets(){ ['editor','daysheet','tripsheet','warnings','costsheet'].forEach(id=>$('#'+id).hidden=true); editingId=null; dayOpen=null; }
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>{ const id=b.dataset.close; $('#'+id).hidden=true; if(id==='editor') editingId=null; if(id==='daysheet') dayOpen=null; }));

/* activity editor */
let editingId=null, editorSnap=false;
function buildWdays(){ $('#f-wdays').innerHTML=[1,2,3,4,5,6,0].map(w=>`<label><input type="checkbox" value="${w}" id="f-wd-${w}">${WD()[w]}</label>`).join(''); }
buildWdays();
function fillSelects(){
  const t=T(); if(!t) return; const v=view(t); const ds=days(t);
  $('#f-day').innerHTML=`<option value="tray">${tr('unscheduled')}</option>`+ds.map(d=>`<option value="${d}">${dayLabel(d,true)}${(t.dayPlaces[d]||[]).length?' · '+(t.dayPlaces[d]).map(p=>short(placeName(p))).join(' → '):''}</option>`).join('');
  let so=''; for(let m=v.T0; m<v.T1; m+=SNAP) so+=`<option value="${m}">${mlabel(m)}${m>=1440?tr('afterMidnight'):''}</option>`; $('#f-start').innerHTML=so;
  let lo=''; for(let m=SNAP; m<=v.span; m+=SNAP) lo+=`<option value="${m}">${durLabel(m)}</option>`; $('#f-len').innerHTML=lo;
  $('#f-place').innerHTML=`<option value="">${tr('anywhere')}</option>`+t.places.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
}
function openEditor(id,isNew){
  if(suppressClick) return; closeSheets(); editingId=id; editorSnap=!!isNew;
  fillSelects(); $('#editor').hidden=false; $('#f-del-confirm').hidden=true; fillEditor(true);
  if(isNew){ const i=$('#f-title'); i.focus(); i.select(); } else $('#editor [data-close]').focus();
}
function fillEditor(full){
  const f=findBlock(editingId); if(!f){ $('#editor').hidden=true; editingId=null; return; }
  const b=f.b, act=document.activeElement, t=T();
  const set=(sel,val)=>{ const el=$(sel); if(full||el!==act){ if(el.type==='checkbox') el.checked=!!val; else el.value=val; } };
  set('#f-title',b.title); set('#f-day', f.where==='tray'?'tray':b.date); $('#f-start').disabled=f.where==='tray';
  if(f.where!=='tray'){ if(![...$('#f-start').options].some(o=>+o.value===b.start)) $('#f-start').insertAdjacentHTML('beforeend',`<option value="${b.start}">${mlabel(b.start)}${tr('outsideBoard')}</option>`); set('#f-start',String(b.start)); }
  if(![...$('#f-len').options].some(o=>+o.value===b.len)) $('#f-len').insertAdjacentHTML('beforeend',`<option value="${b.len}">${durLabel(b.len)}</option>`);
  set('#f-len',String(b.len)); set('#f-cat',b.cat); set('#f-status',b.status||''); set('#f-place',b.place||'');
  if(full||$('#f-ccat')!==act){ $('#f-ccat').innerHTML=catOptions(t, (b.ccat&&hasCat(t,b.ccat))?b.ccat:'', `<option value="">${tr('autoCat',{name:esc(catName(t,autoCat(t,b)))})}</option>`); }
  set('#f-pp',b.pp??''); set('#f-total',b.total??''); set('#f-address',b.address||''); set('#f-link',b.link||''); set('#f-ref',b.ref||''); set('#f-note',b.note||''); set('#f-lock',b.locked);
  [0,1,2,3,4,5,6].forEach(w=>{ const c=$('#f-wd-'+w); if(full||c!==act) c.checked=!!(b.weekdays&&b.weekdays.includes(w)); });
  const cur=t.currency||'€'; $('#f-pp-l').textContent=tr('costPPCur',{cur}); $('#f-total-l').textContent=tr('costTotalCur',{cur});
  const lo=$('#f-link-open'); if(/^https?:\/\//i.test(b.link||'')){ lo.hidden=false; lo.href=b.link; lo.textContent=tr('openLink'); } else lo.hidden=true;
  $('#f-tray').hidden=f.where==='tray'; $('#ed-h').textContent=CATS()[b.cat]||tr('activity');
  const sec=secondTz(t), fs=$('#f-sec');
  if(sec && f.where!=='tray'){ const a=b.start+sec.diff, sh=Math.floor(a/1440)-Math.floor(b.start/1440);
    fs.textContent=tr('secAt',{city:TZ.city(sec.tz), range:`${mlabel(a)}–${mlabel(a+b.len)}`})+(sh<0?tr('prevDay'):sh>0?tr('nextDay'):''); fs.hidden=false; }
  else fs.hidden=true;
}
function edit(fn){ const f=findBlock(editingId); if(!f) return; if(!editorSnap){ pushHistory(); editorSnap=true; } fn(f.b,f); commit(); }
const optStr=(k)=>e=>edit(b=>{ const v=e.target.value.trim(); if(v) b[k]=e.target.value; else delete b[k]; });
$('#f-title').addEventListener('input',e=>edit(b=>{ b.title=e.target.value||tr('untitled'); }));
['note','address','link','ref'].forEach(k=>$('#f-'+k).addEventListener('input',optStr(k)));
$('#f-cat').addEventListener('change',e=>edit(b=>{ b.cat=e.target.value; }));
$('#f-status').addEventListener('change',e=>edit(b=>{ if(e.target.value) b.status=e.target.value; else delete b.status; }));
$('#f-place').addEventListener('change',e=>edit(b=>{ if(e.target.value) b.place=e.target.value; else delete b.place; }));
$('#f-ccat').addEventListener('change',e=>edit(b=>{ if(e.target.value) b.ccat=e.target.value; else delete b.ccat; }));
$('#f-lock').addEventListener('change',e=>edit(b=>{ if(e.target.checked) b.locked=true; else delete b.locked; }));
$('#f-pp').addEventListener('input',e=>edit(b=>{ const v=parseFloat(e.target.value); if(v>0) b.pp=v; else delete b.pp; }));
$('#f-total').addEventListener('input',e=>edit(b=>{ const v=parseFloat(e.target.value); if(v>0) b.total=v; else delete b.total; }));
$('#f-wdays').addEventListener('change',()=>edit(b=>{ const ws=[0,1,2,3,4,5,6].filter(w=>$('#f-wd-'+w).checked); if(ws.length&&ws.length<7) b.weekdays=ws; else delete b.weekdays; }));
$('#f-len').addEventListener('change',e=>edit(b=>{ b.len=+e.target.value; const v=view(T()); if(b.start!=null && b.start+b.len>v.T1) b.start=Math.max(v.T0,v.T1-b.len); }));
$('#f-start').addEventListener('change',e=>edit(b=>{ const v=view(T()); b.start=Math.min(+e.target.value, v.T1-b.len); }));
$('#f-day').addEventListener('change',e=>edit((b,f)=>{ if(e.target.value==='tray') toTray(b.id); else moveTo(b.id,e.target.value, f.where==='tray'?Math.max(view(T()).T0,600):b.start); }));
$('#f-dup').addEventListener('click',()=>{ const f=findBlock(editingId); if(!f) return; pushHistory(); const c=clone(f.b); c.id=newId('a'); delete c.locked; const t=T();
  if(f.where==='tray') t.tray.push(c); else { c.start=Math.min(view(t).T1-c.len, f.b.start+f.b.len); t.blocks.push(c); } commit(); openEditor(c.id); toast(tr('tDupActivity')); });
$('#f-tray').addEventListener('click',()=>{ edit(b=>toTray(b.id)); $('#editor').hidden=true; editingId=null; });
$('#f-del').addEventListener('click',()=>{ $('#f-del-confirm').hidden=false; $('#f-del-yes').focus(); });
$('#f-del-no').addEventListener('click',()=>{ $('#f-del-confirm').hidden=true; });
$('#f-del-yes').addEventListener('click',()=>{ const id=editingId, t=T(); pushHistory(); t.blocks=t.blocks.filter(b=>b.id!==id); t.tray=t.tray.filter(b=>b.id!==id); $('#editor').hidden=true; editingId=null; commit(); toast(tr('tDelActivity')); });

/* day sheet */
let dayOpen=null;
function openDay(date){ closeSheets(); dayOpen=date; $('#daysheet').hidden=false; fillDay(true); $('#d-place').focus(); }
function fillDay(full){
  const t=T(); if(!t||!dayOpen) return; const ds=days(t); const cur=t.dayPlaces[dayOpen]||[];
  $('#d-h').textContent=dayLabel(dayOpen,true);
  const popts=t.places.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  if(full!==false || document.activeElement!==$('#d-place')){ $('#d-place').innerHTML=`<option value="">${tr('noPlace')}</option>`+popts; $('#d-place').value=cur[0]||''; }
  if(full!==false || document.activeElement!==$('#d-place2')){ $('#d-place2').innerHTML=`<option value="">${tr('noChange')}</option>`+popts; $('#d-place2').value=cur[1]||''; }
  if(full!==false){ const i=ds.indexOf(dayOpen); $('#d-until').innerHTML=`<option value="">${tr('justThisDay')}</option>`+ds.slice(i+1).map(d=>`<option value="${d}">${dayLabel(d,true)}</option>`).join(''); }
  const list=blocksOf(dayOpen); const box=$('#d-list'); box.innerHTML='';
  const cost=list.reduce((s,b)=>s+blockCostPP(b),0);
  $('#d-list-h').textContent = tr('dayActivities')+(cost?' · '+fmt(cost)+' '+tr('perPersonLower'):'');
  const dc=dayCostPP(dayOpen); $('#d-costs-h').textContent = tr('dayCosts')+(dc?' · '+fmt(dc)+' '+tr('perPersonLower'):'');
  renderCostRows($('#d-costs'), dayOpen, full===true);
  if(!list.length) box.innerHTML=`<p class="hint">${tr('dayEmpty')}</p>`;
  list.filter(b=>b.cat!=='sleep').forEach(b=>{ const it=document.createElement('button'); it.type='button'; it.className='day-item cat-'+b.cat;
    it.innerHTML=`<span class="tm">${mlabel(b.start)}–${mlabel(b.start+b.len)}</span><span class="nm">${esc(b.title)}</span>${b.status?`<span class="st st-${b.status}" style="margin-left:auto;font-size:10px;font-weight:700;padding:0 5px;border-radius:4px">${STATUS()[b.status]}</span>`:''}`;
    it.addEventListener('click',()=>openEditor(b.id)); box.appendChild(it); });
}
$('#d-apply').addEventListener('click',()=>{
  const t=T(); const p1=$('#d-place').value, p2=$('#d-place2').value, until=$('#d-until').value; const ds=days(t);
  const i=ds.indexOf(dayOpen), j=until?ds.indexOf(until):i; pushHistory();
  for(let k=i;k<=j;k++){ const d=ds[k]; const arr=[]; if(p1) arr.push(p1); if(p2 && p2!==p1 && k===j) arr.push(p2); if(arr.length) t.dayPlaces[d]=arr; else delete t.dayPlaces[d]; }
  if(p2 && j>i && p2!==p1) toast(tr('tPlaceLastDay'));
  commit(); fillDay(true); announce(tr('placeSaved'));
});
function addPlace(name){ const t=T(); name=name.trim(); if(!name) return null; const ex=t.places.find(p=>p.name.toLowerCase()===name.toLowerCase()); if(ex) return ex;
  const used=t.places.map(p=>p.c); let c=1; while(used.includes(c) && c<8) c++; if(used.includes(c)) c=(t.places.length%8)+1;
  const p={id:newId('p'), name, c}; t.places.push(p); return p; }
$('#d-addplace').addEventListener('click',()=>{ const v=$('#d-newplace').value; if(!v.trim()) return; pushHistory(); const p=addPlace(v); $('#d-newplace').value=''; commit(); fillDay(true); $('#d-place').value=p.id; toast(tr('tPlaceAdded',{name:p.name})); });
$('#d-newplace').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#d-addplace').click(); } });
$('#d-add').addEventListener('click',()=>{ const t=T(), v=view(t); const list=blocksOf(dayOpen); let s=Math.max(v.T0,540);
  pushHistory(); const b={id:newId('a'), date:dayOpen, start:Math.min(s,v.T1-60), len:60, title:tr('newActivity'), cat:'tour', status:'ideia'}; t.blocks.push(b); commit(); openEditor(b.id,true); });

/* trip sheet */
let tripMode='edit';
(function(){ const h=Array.from({length:24},(_,i)=>`<option value="${i}">${pad(i)}:00</option>`).join(''); $('#t-ds').innerHTML=h; $('#t-de').innerHTML=h; })();
$('#tz-list').innerHTML=TZ.all.map(z=>`<option value="${z}">`).join('');
function openTripSheet(isNew){
  closeSheets(); tripMode=isNew?'new':'edit'; const t=T(); $('#tripsheet').hidden=false; $('#t-err').hidden=true; $('#t-del-confirm').hidden=true;
  $('#t-h').textContent=tr(isNew?'newTrip':'datesPlaces'); $('#t-submit').textContent=tr(isNew?'createTrip':'save');
  $('#t-places-wrap').hidden=isNew;
  if(isNew||!t){ const n=new Date(); const s=iso(addDays(n,30)), e=iso(addDays(n,36)); $('#t-name').value=''; $('#t-start').value=s; $('#t-end').value=e; $('#t-ds').value='7'; $('#t-de').value='1'; $('#t-people').value='2'; $('#t-cur').value='€'; $('#t-budget').value=''; $('#t-tz').value=homeTz(); }
  else { $('#t-name').value=t.name; $('#t-start').value=t.start; $('#t-end').value=t.end; $('#t-ds').value=String(t.dayStart); $('#t-de').value=String(t.dayEnd); $('#t-people').value=String(t.people||1); $('#t-cur').value=t.currency||'€'; $('#t-budget').value=t.budget||''; $('#t-tz').value=t.tz||''; renderPlaces(); renderCats(); }
  $('#t-hometz').value=ownHomeTz(); $('#t-hometz').placeholder=tr('homeTzDefault',{tz:defaultHomeTz()||'—'});
  $('#t-name').focus();
}
function renderPlaces(){
  const t=T(), box=$('#t-places'); box.innerHTML='';
  if(!t.places.length){ box.innerHTML=`<p class="hint">${tr('noPlaces')}</p>`; return; }
  t.places.forEach(p=>{ const row=document.createElement('div'); row.className='place-row'; row.style.setProperty('--pc',`var(--p${(p.c-1)%8+1})`);
    row.innerHTML=`<i aria-hidden="true"></i><input type="text" value="${esc(p.name)}" aria-label="${tr('placeNameAria')}" style="border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:6px 8px;min-width:0"><button class="btn danger" type="button">${tr('remove')}</button>`;
    const inp=row.querySelector('input'); let snap=false;
    inp.addEventListener('input',()=>{ if(!snap){ pushHistory(); snap=true; } p.name=inp.value||tr('untitled'); dirty=true; scheduleSave(); render(); });
    row.querySelector('button').addEventListener('click',()=>{ pushHistory(); t.places=t.places.filter(x=>x!==p); Object.keys(t.dayPlaces).forEach(d=>{ t.dayPlaces[d]=t.dayPlaces[d].filter(x=>x!==p.id); if(!t.dayPlaces[d].length) delete t.dayPlaces[d]; }); t.blocks.concat(t.tray).forEach(b=>{ if(b.place===p.id) delete b.place; }); commit(); renderPlaces(); });
    box.appendChild(row); });
}
$('#t-addplace').addEventListener('click',()=>{ const v=$('#t-newplace').value; if(!v.trim()) return; pushHistory(); addPlace(v); $('#t-newplace').value=''; commit(); renderPlaces(); });
$('#t-newplace').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#t-addplace').click(); } });
$('#t-form').addEventListener('submit',e=>{
  e.preventDefault(); const err=$('#t-err');
  const name=$('#t-name').value.trim(), s=$('#t-start').value, en=$('#t-end').value;
  const fail=m=>{ err.textContent=m; err.hidden=false; };
  if(!name) return fail(tr('errTripName'));
  if(!s||!en) return fail(tr('errTripDates'));
  if(en<s) return fail(tr('errTripOrder'));
  const n=Math.round((parseISO(en)-parseISO(s))/864e5)+1; if(n>60) return fail(tr('errTripLong',{n}));
  const ds=+$('#t-ds').value, de=+$('#t-de').value, people=Math.max(1,parseInt($('#t-people').value)||1), cur=$('#t-cur').value, budget=parseFloat($('#t-budget').value)>0?parseFloat($('#t-budget').value):0;
  const tz=resolveTz($('#t-tz').value), home=resolveTz($('#t-hometz').value);
  if(tz===null) return fail(tr('errTz',{v:$('#t-tz').value.trim()}));
  if(home===null) return fail(tr('errTz',{v:$('#t-hometz').value.trim()}));
  try{ if(home && home!==defaultHomeTz()) localStorage.setItem(HOME_KEY,home); else localStorage.removeItem(HOME_KEY); }catch(_){}
  pushHistory();
  if(tripMode==='new'){
    const t={id:newId('t'), name, start:s, end:en, dayStart:ds, dayEnd:de, people, currency:cur, places:[], dayPlaces:{}, blocks:[], tray:[], costs:[]}; if(budget) t.budget=budget; if(tz) t.tz=tz;
    store.trips.push(t); activeId=t.id; try{ localStorage.setItem(ACTIVE_KEY,activeId); }catch(_){}
    $('#tripsheet').hidden=true; commit(); scroller.scrollTo(0,0); toast(tr('tTripCreated'));
  } else {
    const t=T(); Object.assign(t,{name,start:s,end:en,dayStart:ds,dayEnd:de,people,currency:cur}); if(budget) t.budget=budget; else delete t.budget; if(tz) t.tz=tz; else delete t.tz;
    const dset=new Set(days(t)); const out=t.blocks.filter(b=>!dset.has(b.date));
    out.forEach(b=>toTray(b.id)); (t.costs||[]).forEach(c=>{ if(c.date && !dset.has(c.date)) delete c.date; }); Object.keys(t.dayPlaces).forEach(d=>{ if(!dset.has(d)) delete t.dayPlaces[d]; });
    $('#tripsheet').hidden=true; commit(); if(out.length) toast(tr('tOutOfDates',{n:out.length}));
  }
});
$('#t-cancel').addEventListener('click',()=>{ $('#tripsheet').hidden=true; render(); });
$('#t-dup').addEventListener('click',()=>{ const t=T(); pushHistory(); const c=clone(t); c.id=newId('t'); c.name=t.name+tr('copySuffix'); store.trips.push(c); activeId=c.id; try{ localStorage.setItem(ACTIVE_KEY,activeId); }catch(_){} $('#tripsheet').hidden=true; commit(); toast(tr('tTripDup')); });
$('#t-del').addEventListener('click',()=>{ $('#t-del-confirm').hidden=false; $('#t-del-yes').focus(); });
$('#t-del-no').addEventListener('click',()=>{ $('#t-del-confirm').hidden=true; });
$('#t-del-yes').addEventListener('click',()=>{ const t=T(); pushHistory(); store.trips=store.trips.filter(x=>x!==t); activeId=null; ensureActive(); $('#tripsheet').hidden=true; commit(); toast(tr('tTripDel',{name:t.name})); });

/* toolbar */
$('#trip-sel').addEventListener('change',e=>{ if(!e.target.value) return; if(e.target.value==='__new'){ e.target.value=''; openTripSheet(true); return; } activeId=e.target.value; try{ localStorage.setItem(ACTIVE_KEY,activeId); }catch(_){} closeSheets(); render(); scroller.scrollTo(0,0); });
$('#undo').addEventListener('click',undo);
$('#add').addEventListener('click',()=>{ const t=T(); if(!t){ openTripSheet(true); return; } pushHistory(); const b={id:newId('a'), len:60, title:tr('newActivity'), cat:'tour', status:'ideia'}; t.tray.push(b); commit(); openEditor(b.id,true); });
$('#trip-settings').addEventListener('click',()=>{ if(!T()) openTripSheet(true); else openTripSheet(false); });
$('#show-sleep').addEventListener('change',e=>{ hideSleep=!e.target.checked; document.body.classList.toggle('hide-sleep',hideSleep); try{ localStorage.setItem(SLEEP_KEY,hideSleep?'1':'0'); }catch(_){} render(); });
try{ if(localStorage.getItem(SLEEP_KEY)==='1'){ hideSleep=true; $('#show-sleep').checked=false; document.body.classList.add('hide-sleep'); } }catch(_){}
/* Trocar de língua: os textos fixos mudam logo; o resto volta a ser desenhado. */
document.querySelectorAll('[data-lang-toggle]').forEach(b=>b.addEventListener('click',()=>{
  I18N.set(I18N.other()); buildWdays(); closeSheets(); $('#l-err').hidden=true;
  if(authed){ render(); refreshSaveLabel(); } else document.title=tr('appName');
}));

/* ---------- custos ---------- */
const DEFAULT_CAT_IDS = ['alojamento','transporte','alimentacao','atividades','festas','compras','outros'];
const defaultCats = () => DEFAULT_CAT_IDS.map(id=>({id, name:tr('defaultCats')[id]}));
const AUTO_CAT = {tour:'atividades', party:'festas', transport:'transporte', food:'alimentacao', rest:'outros', sleep:'outros'};
const NO_CAT = 'sem';
function cats(t){ return (t && t.costCats) || defaultCats(); }
function ownCats(t){ if(!t.costCats) t.costCats=defaultCats(); return t.costCats; }
function catName(t,id){ const c=cats(t).find(c=>c.id===id); return c ? c.name : tr('noCat'); }
function hasCat(t,id){ return cats(t).some(c=>c.id===id); }
function autoCat(t,b){ const id=AUTO_CAT[b.cat]; return hasCat(t,id) ? id : NO_CAT; }
function blockCat(t,b){ return (b.ccat && hasCat(t,b.ccat)) ? b.ccat : autoCat(t,b); }
function lineCat(t,c){ return (c.cat && hasCat(t,c.cat)) ? c.cat : NO_CAT; }
function nPeople(t){ return Math.max(1, t.people||1); }
function blockTotal(t,b){ return (b.pp||0)*nPeople(t) + (b.total||0); }
function lineTotal(t,c){ return c.per==='pp' ? (c.amount||0)*nPeople(t) : (c.amount||0); }
function costLines(t,date){ return (t.costs||[]).filter(c=> date===null ? !c.date : c.date===date); }
function dayCostPP(date){ const t=T(); return costLines(t,date).reduce((s,c)=>s+lineTotal(t,c),0)/nPeople(t); }
function tripTotal(t){ return t.blocks.reduce((s,b)=>s+blockTotal(t,b),0) + (t.costs||[]).reduce((s,c)=>s+lineTotal(t,c),0); }
/* Todas as parcelas de custo da viagem, já em valor total para o grupo. */
function costItems(t){
  const out=[];
  for(const b of t.blocks){ const v=blockTotal(t,b); if(v>0) out.push({label:b.title, date:b.date, cat:blockCat(t,b), total:v, paid:b.status==='pago', blockId:b.id}); }
  for(const c of (t.costs||[])){ const v=lineTotal(t,c); if(v>0) out.push({label:c.label||tr('noDesc'), date:c.date||null, cat:lineCat(t,c), total:v, paid:!!c.paid}); }
  return out;
}
function catOptions(t, sel, first){ return (first||'') + cats(t).map(c=>`<option value="${esc(c.id)}"${c.id===sel?' selected':''}>${esc(c.name)}</option>`).join(''); }

/* Linhas de custo editáveis (do dia, ou gerais quando date === null). */
function renderCostRows(box, date, force){
  if(!force && box.contains(document.activeElement)) return;
  const t=T(); if(!t) return; const lines=costLines(t,date); box.innerHTML='';
  if(!lines.length){ box.innerHTML = `<p class="hint">${tr(date===null ? 'noGeneralCosts' : 'noDayCosts')}</p>`; return; }
  for(const c of lines){
    const row=document.createElement('div'); row.className='cost-row'; const k='c-'+c.id;
    row.innerHTML = `<input type="text" id="${k}-l" class="c-label" value="${esc(c.label||'')}" placeholder="${tr('costDescPh')}" aria-label="${tr('costDescAria')}">`
      + `<input type="number" id="${k}-a" class="c-amt" min="0" step="0.01" inputmode="decimal" value="${c.amount??''}" placeholder="0" aria-label="${tr('costAmountAria',{cur:esc(t.currency||'€')})}">`
      + `<select id="${k}-p" class="c-per" aria-label="${tr('costPerAria')}"><option value="total">${tr('perTotal')}</option><option value="pp"${c.per==='pp'?' selected':''}>${tr('perPersonLower')}</option></select>`
      + `<select id="${k}-c" class="c-cat" aria-label="${tr('costCat')}">${catOptions(t, lineCat(t,c), `<option value="">${tr('noCat')}</option>`)}</select>`
      + `<label class="toggle c-paid"><input type="checkbox" id="${k}-d"${c.paid?' checked':''}>${tr('paid')}</label>`
      + `<button class="x c-del" type="button" aria-label="${tr('removeCost')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
    let snap=false; const touch=()=>{ if(!snap){ pushHistory(); snap=true; } };
    row.querySelector('.c-label').addEventListener('input',e=>{ touch(); c.label=e.target.value; commit(); });
    row.querySelector('.c-amt').addEventListener('input',e=>{ touch(); const v=parseFloat(e.target.value); c.amount = v>0 ? v : 0; commit(); });
    row.querySelector('.c-per').addEventListener('change',e=>{ touch(); c.per=e.target.value; commit(); });
    row.querySelector('.c-cat').addEventListener('change',e=>{ touch(); if(e.target.value) c.cat=e.target.value; else delete c.cat; commit(); });
    row.querySelector('.c-paid input').addEventListener('change',e=>{ touch(); if(e.target.checked) c.paid=true; else delete c.paid; commit(); });
    row.querySelector('.c-del').addEventListener('click',()=>{ pushHistory(); t.costs=t.costs.filter(x=>x!==c); commit(); renderCostRows(box,date,true); if(!$('#costsheet').hidden) renderDash(true); });
    box.appendChild(row);
  }
}
function addCost(box, date, defCat){
  const t=T(); if(!t) return; pushHistory(); t.costs=t.costs||[];
  const c={id:newId('c'), label:'', amount:0, per:'total'}; if(date) c.date=date; if(defCat && hasCat(t,defCat)) c.cat=defCat;
  t.costs.push(c); commit(); renderCostRows(box,date,true);
  const inp=box.querySelector('#c-'+c.id+'-l'); if(inp) inp.focus();
}

/* Painel de resumo */
function barRow(label, value, max, total, extra){
  const pct = total>0 ? Math.round(value/total*100) : 0; const w = max>0 ? Math.max(value>0?2:0, value/max*100) : 0;
  return `<span class="bar-name">${label}</span><span class="bar-track" aria-hidden="true"><span class="bar-fill" style="width:${w}%"></span></span><span class="bar-val">${fmt(value)}</span>${extra===false?'':`<span class="bar-pct">${pct}%</span>`}`;
}
function renderDash(force){
  const t=T(); if(!t) return; const items=costItems(t); const n=nPeople(t);
  const total=items.reduce((s,i)=>s+i.total,0); const paid=items.filter(i=>i.paid).reduce((s,i)=>s+i.total,0);
  // resumo
  let h = `<div class="dash-figs"><div class="dash-fig"><span class="k">${n>1?tr('totalFor',{n}):tr('total')}</span><span class="v big">${fmt(total)}</span></div>`
    + (n>1?`<div class="dash-fig"><span class="k">${tr('perPerson')}</span><span class="v">${fmt(total/n)}</span></div>`:'')
    + `<div class="dash-fig"><span class="k">${tr('alreadyPaid')}</span><span class="v">${fmt(paid)}</span></div><div class="dash-fig"><span class="k">${tr('toPay')}</span><span class="v">${fmt(total-paid)}</span></div></div>`;
  if(t.budget>0){
    const left=t.budget-total, over=left<0, pct=Math.round(total/t.budget*100);
    h += `<div class="budget${over?' over':''}"><div class="budget-top"><span>${tr('budget')}: <b>${fmt(t.budget)}</b></span><span class="budget-state">${over?tr('overBudget',{x:fmt(-left)}):tr('left',{x:fmt(left)})}</span></div>`
      + `<div class="bar-track tall" role="img" aria-label="${tr('budgetUsedAria',{pct})}"><span class="bar-fill" style="width:${Math.min(100,pct)}%"></span></div><div class="budget-sub">${tr('budgetUsed',{pct})}${n>1?' · '+tr('budgetPP',{x:fmt(Math.abs(left)/n), over}):''}</div></div>`;
  } else h += `<p class="hint">${tr('budgetHint')}</p>`;
  $('#c-summary').innerHTML=h;
  // por categoria
  const open=new Set([...document.querySelectorAll('#c-bycat details[open]')].map(d=>d.dataset.cat));
  const groups=new Map(); for(const i of items){ if(!groups.has(i.cat)) groups.set(i.cat,[]); groups.get(i.cat).push(i); }
  const rows=[...groups.entries()].map(([id,list])=>({id, list, sum:list.reduce((s,i)=>s+i.total,0)})).sort((a,b)=>b.sum-a.sum);
  const max=rows.length?rows[0].sum:0; const box=$('#c-bycat');
  if(!rows.length) box.innerHTML=`<p class="hint">${tr('noCosts')}</p>`;
  else {
    box.innerHTML = rows.map(r=>`<details class="cat-row" data-cat="${esc(r.id)}"${open.has(r.id)?' open':''}><summary title="${esc(catName(t,r.id))}: ${fmt(r.sum)}${n>1?' · '+fmt(r.sum/n)+' '+tr('perPersonLower'):''}">${barRow(esc(catName(t,r.id)), r.sum, max, total)}</summary><ul class="cat-items">`
      + r.list.slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))||b.total-a.total).map(i=>`<li${i.blockId?` data-block="${esc(i.blockId)}" tabindex="0" role="button"`:''}><span class="ci-d">${i.date?dayLabel(i.date,true):tr('general')}</span><span class="ci-l">${esc(i.label)}</span>${i.paid?`<span class="st st-pago">${tr('paidMark')}</span>`:''}<span class="ci-v">${fmt(i.total)}</span></li>`).join('')
      + `</ul></details>`).join('');
    box.querySelectorAll('li[data-block]').forEach(li=>{ const go=()=>openEditor(li.dataset.block); li.addEventListener('click',go); li.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); go(); } }); });
  }
  // por dia
  const ds=days(t); const byDay=ds.map(d=>({d, sum:items.filter(i=>i.date===d).reduce((s,i)=>s+i.total,0)}));
  const gen=items.filter(i=>!i.date || !ds.includes(i.date)).reduce((s,i)=>s+i.total,0);
  const dmax=Math.max(gen, ...byDay.map(x=>x.sum), 0);
  $('#c-byday').innerHTML = (gen>0?`<div class="day-row static" title="${tr('generalCosts')}: ${fmt(gen)}">${barRow(tr('generalPl'), gen, dmax, total, false)}</div>`:'')
    + byDay.map(x=>`<button type="button" class="day-row" data-date="${x.d}" title="${dayLabel(x.d,true)}: ${fmt(x.sum)}${n>1?' · '+fmt(x.sum/n)+' '+tr('perPersonLower'):''}. ${tr('openDay')}">${barRow(dayLabel(x.d,true), x.sum, dmax, total, false)}</button>`).join('');
  $('#c-byday').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>openDay(b.dataset.date)));
  renderCostRows($('#c-general'), null, force);
}
function openCosts(){ closeSheets(); $('#costsheet').hidden=false; renderDash(true); $('#costsheet [data-close]').focus(); }
$('#costs-btn').addEventListener('click',()=>{ if(!T()) return; if(!$('#costsheet').hidden){ $('#costsheet').hidden=true; return; } openCosts(); });
$('#c-add-general').addEventListener('click',()=>addCost($('#c-general'), null));
$('#d-addcost').addEventListener('click',()=>addCost($('#d-costs'), dayOpen));

/* categorias (no painel da viagem) */
function renderCats(){
  const t=T(), box=$('#t-cats'); box.innerHTML='';
  cats(t).forEach(c=>{ const row=document.createElement('div'); row.className='place-row cat-edit';
    row.innerHTML=`<input type="text" id="cat-${esc(c.id)}" value="${esc(c.name)}" aria-label="${tr('catNameAria')}" style="border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:6px 8px;min-width:0"><button class="btn danger" type="button">${tr('remove')}</button>`;
    const inp=row.querySelector('input'); let snap=false;
    inp.addEventListener('input',()=>{ if(!snap){ pushHistory(); snap=true; } const own=ownCats(t).find(x=>x.id===c.id); if(own) own.name=inp.value||tr('untitled'); commit(); });
    row.querySelector('button').addEventListener('click',()=>{ pushHistory(); t.costCats=ownCats(t).filter(x=>x.id!==c.id); commit(); renderCats(); toast(tr('tCatRemoved',{name:c.name})); });
    box.appendChild(row); });
  if(!cats(t).length) box.innerHTML=`<p class="hint">${tr('noCats')}</p>`;
}
$('#t-addcat').addEventListener('click',()=>{ const t=T(), v=$('#t-newcat').value.trim(); if(!v) return;
  if(cats(t).some(c=>c.name.toLowerCase()===v.toLowerCase())){ toast(tr('tCatExists')); return; }
  pushHistory(); ownCats(t).push({id:newId('k'), name:v}); $('#t-newcat').value=''; commit(); renderCats(); });
$('#t-newcat').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#t-addcat').click(); } });

$('#warn-btn').addEventListener('click',()=>{ const w=$('#warnings'); if(!w.hidden){ w.hidden=true; return; } closeSheets(); renderWarnings(); w.hidden=false; w.querySelector('[data-close]').focus(); });

/* excel export */
$('#export').addEventListener('click', async ()=>{
  const t=T(); if(!t) return;
  if(!(await loadXLSX())){ toast(tr('tExcelFail')); return; }
  const v=view(t), ds=days(t);
  const MONL=tr('xMonths'), WDX=tr('xWeekdays');
  const aoa=[[''].concat(ds.map(d=>{ const x=parseISO(d); return tr('xDay',{d:x.getDate(), m:MONL[x.getMonth()], w:WDX[x.getDay()]}); }))];
  const rows=v.span/30; for(let r=0;r<rows;r++){ const row=[mlabel(v.T0+r*30)]; ds.forEach(()=>row.push('')); aoa.push(row); }
  const merges=[]; const cell=b=>b.title+(b.pp?`\n${b.pp} ${tr('xPP')}`:'')+(b.total?`\n${b.total}`:'');
  ds.forEach((d,ci)=>{ let g=null; const flush=()=>{ if(!g) return; aoa[g.r0+1][ci+1]=g.tx.join('\n'+tr('xAnd')+'\n'); if(g.r1-g.r0>1) merges.push({s:{r:g.r0+1,c:ci+1},e:{r:g.r1,c:ci+1}}); g=null; };
    for(const b of blocksOf(d)){ let r0=Math.floor((b.start-v.T0)/30), r1=Math.ceil((b.start+b.len-v.T0)/30); r0=Math.max(0,Math.min(rows-1,r0)); r1=Math.max(r0+1,Math.min(rows,r1));
      if(g && r0<g.r1){ g.tx.push(cell(b)); g.r1=Math.max(g.r1,r1); } else { flush(); g={r0,r1,tx:[cell(b)]}; } }
    flush(); });
  const ws=XLSX.utils.aoa_to_sheet(aoa); ws['!merges']=merges; ws['!cols']=[{wch:7}].concat(ds.map(()=>({wch:24})));
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,tr('xPlan'));
  const head=tr('xHead');
  const rowOf=b=>[b.date?dayLabel(b.date,true):tr('unscheduled'), b.date?mlabel(b.start):'', b.date?mlabel(b.start+b.len):durLabel(b.len), b.title, CATS()[b.cat]||'', placeName(b.place)||'', b.status?STATUS()[b.status]:'', (b.pp||b.total)?catName(t,blockCat(t,b)):'', b.pp||'', b.total||'', b.address||'', b.link||'', b.ref||'', b.note||''];
  const det=t.blocks.filter(b=>b.cat!=='sleep').slice().sort((a,b)=>a.date.localeCompare(b.date)||a.start-b.start).map(rowOf).concat(t.tray.map(rowOf));
  const ws2=XLSX.utils.aoa_to_sheet([head].concat(det)); ws2['!cols']=[14,7,7,34,11,16,12,18,9,10,24,30,14,40].map(w=>({wch:w}));
  XLSX.utils.book_append_sheet(wb,ws2,tr('xDetails'));
  const items=costItems(t), np=nPeople(t), sumAll=items.reduce((s,i)=>s+i.total,0);
  const byCat=new Map(); items.forEach(i=>byCat.set(i.cat,(byCat.get(i.cat)||0)+i.total));
  const r2=x=>Math.round(x*100)/100;
  const cs=[tr('xCatHead')].concat([...byCat.entries()].sort((a,b)=>b[1]-a[1]).map(([id,v])=>[catName(t,id), r2(v), r2(v/np), sumAll?Math.round(v/sumAll*100):0]));
  cs.push([tr('total'), r2(sumAll), r2(sumAll/np), sumAll?100:0]); if(t.budget>0){ cs.push([tr('budget'), t.budget, r2(t.budget/np), '']); cs.push([tr('xMargin'), r2(t.budget-sumAll), r2((t.budget-sumAll)/np), '']); }
  cs.push([]); cs.push(tr('xItemHead'));
  items.slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))).forEach(i=>cs.push([i.date?dayLabel(i.date,true):tr('general'), i.label, catName(t,i.cat), r2(i.total), r2(i.total/np), i.paid?tr('xYes'):'']));
  const ws3=XLSX.utils.aoa_to_sheet(cs); ws3['!cols']=[18,36,20,10,11,11].map(w=>({wch:w}));
  XLSX.utils.book_append_sheet(wb,ws3,tr('xCosts'));
  const out=XLSX.write(wb,{bookType:'xlsx',type:'array'});
  const fname=tr('xFile',{name:(t.name||tr('trip')).replace(/[\\/:*?"<>|]+/g,'').trim()});
  saveFile(fname, new Blob([out],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
});

/* backup / import */
$('#backup').addEventListener('click',()=>{
  const d=new Date(); const stamp=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  saveFile(`planeador-ferias-${stamp}.json`, new Blob([JSON.stringify({version:2, savedAt:Date.now(), trips:store.trips})],{type:'application/json'}));
  toast(tr('tBackup'));
});
$('#import').addEventListener('click',()=>$('#import-file').click());
$('#import-file').addEventListener('change', async e=>{
  const f=e.target.files[0]; e.target.value=''; if(!f) return;
  try{
    const data=JSON.parse(await f.text()); if(!data || !Array.isArray(data.trips)) throw new Error('formato');
    const ok=data.trips.filter(t=>t && typeof t==='object' && t.name && /^\d{4}-\d{2}-\d{2}$/.test(t.start||'') && /^\d{4}-\d{2}-\d{2}$/.test(t.end||''));
    if(!ok.length) throw new Error('vazio');
    pushHistory(); let added=0, replaced=0, first=null;
    for(const raw of ok){
      const t=normTrip(raw); if(!/^[A-Za-z0-9_-]{1,64}$/.test(t.id||'')) t.id=newId('t');
      const i=store.trips.findIndex(x=>x.id===t.id);
      if(i>=0){ store.trips[i]=t; replaced++; } else { store.trips.push(t); added++; }
      if(!first) first=t.id;
    }
    activeId=first;
    try{ localStorage.setItem(ACTIVE_KEY,activeId); }catch(_){}
    closeSheets(); commit(); scroller.scrollTo(0,0);
    toast(tr('tImported',{added, replaced}));
  }catch(err){ toast(tr('tImportBad')); }
});


/* misc */
let toastT=null;
function toast(m){ const t=$('#toast'); t.textContent=m; t.hidden=false; clearTimeout(toastT); toastT=setTimeout(()=>t.hidden=true, 4200); }
function announce(m){ $('#announce').textContent=m; }
let rz=null; window.addEventListener('resize',()=>{ clearTimeout(rz); rz=setTimeout(render,120); });

boot();
})();
