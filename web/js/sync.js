/* ---------- server sync ----------
   Cada viagem é um ficheiro no servidor com um número de revisão (rev).
   A página guarda só as viagens que mudaram e envia a revisão em que se baseou;
   se outro dispositivo gravou entretanto, o servidor responde 409 e fica a versão dele. */
import { tr } from './i18n.js';
import { $, toast, announce } from './util.js';
import { S, ensureActive, clearHistory } from './state.js';
import { normTrip } from './trip.js';
import { setServerHomeTz } from './tz.js';
import { render } from './ui/board.js';
import { closeSheets } from './ui/sheets.js';

let saveTimer=null;
const revs = {}, synced = {};

async function api(method, path, body){
  const headers={'X-Requested-With':'planner'}; if(body!==undefined) headers['Content-Type']='application/json';
  const r = await fetch(path,{method, headers, body, credentials:'same-origin', cache:'no-store'});
  if(r.status===401){ showLogin(); throw {code:'auth'}; }
  return r;
}
export function computeDirty(){ const ids=new Set(S.store.trips.map(t=>t.id)); return S.store.trips.some(t=>synced[t.id]!==JSON.stringify(t)) || Object.keys(synced).some(id=>!ids.has(id)); }
function setSave(s,txt){ $('#save').dataset.s=s; $('#save-txt').textContent=txt; }
export function refreshSaveLabel(){
  if(S.saving) return setSave('saving',tr('saving'));
  if(!S.online) return setSave('error',tr('saveError'));
  if(S.dirty) return setSave('dirty',tr('unsaved'));
  setSave('saved',tr('allSaved'));
}
export function scheduleSave(delay){ clearTimeout(saveTimer); saveTimer=setTimeout(doSave, delay||1200); refreshSaveLabel(); }
async function doSave(){
  if(S.saving || !S.authed) return;
  if(!computeDirty()){ S.dirty=false; refreshSaveLabel(); return; }
  S.saving=true; refreshSaveLabel(); let conflict=false, tooBig=false;
  try{
    const ids=new Set(S.store.trips.map(t=>t.id));
    for(const id of Object.keys(synced)){
      if(ids.has(id)) continue;
      const r=await api('DELETE','/api/trips/'+encodeURIComponent(id));
      if(!r.ok) throw {code:'http'};
      delete synced[id]; delete revs[id];
    }
    for(const t of S.store.trips.slice()){
      const js=JSON.stringify(t); if(synced[t.id]===js) continue;
      const r=await api('PUT','/api/trips/'+encodeURIComponent(t.id), '{"baseRev":'+(revs[t.id]||0)+',"trip":'+js+'}');
      if(r.ok){ const d=await r.json(); revs[t.id]=d.rev; synced[t.id]=js; }
      else if(r.status===409){
        const d=await r.json(); conflict=true; const i=S.store.trips.indexOf(t);
        if(d.deleted){ if(i>=0) S.store.trips.splice(i,1); delete synced[t.id]; delete revs[t.id]; }
        else { const nt=normTrip(d.trip); if(i>=0) S.store.trips[i]=nt; revs[nt.id]=d.rev; synced[nt.id]=JSON.stringify(nt); }
      }
      else if(r.status===413){ tooBig=true; synced[t.id]=js; }
      else throw {code:'http'};
    }
    S.online=true;
  }catch(e){ if(!e || e.code!=='auth') S.online=false; }
  S.saving=false; S.dirty=computeDirty(); refreshSaveLabel();
  if(conflict){ clearHistory(); closeSheets(); ensureActive(); render(); toast(tr('tConflict')); }
  if(tooBig) toast(tr('tTooBig'));
  if(S.dirty && S.authed) scheduleSave(S.online?1200:8000);
}
/* Depois de qualquer alteração: marca por gravar, agenda a gravação e redesenha. */
export function commit(){ S.dirty=true; scheduleSave(); render(); }
export function undo(){ if(!S.history.length) return; S.store=JSON.parse(S.history.pop()); ensureActive(); $('#undo').disabled=!S.history.length; closeSheets(); commit(); announce(tr('undone')); }

function applyServer(d){
  for(const k of Object.keys(revs)) delete revs[k];
  for(const k of Object.keys(synced)) delete synced[k];
  setServerHomeTz(d.homeTz);
  const trips=d.trips.map(x=>{ const t=normTrip(x.trip); revs[t.id]=x.rev; synced[t.id]=JSON.stringify(t); return t; });
  trips.sort((a,b)=>String(a.start).localeCompare(String(b.start)));
  S.store={version:2, trips};
}
function showApp(){ S.authed=true; $('#login').hidden=true; $('#offline').hidden=true; $('.app').hidden=false; }
async function loadAll(){
  const r=await api('GET','/api/trips'); if(!r.ok) throw {code:'http'};
  applyServer(await r.json()); clearHistory(); S.dirty=false; S.online=true;
  showApp(); ensureActive(); render(); refreshSaveLabel();
}
export async function boot(){
  try{ await loadAll(); }
  catch(e){ if(e && e.code==='auth') return; $('#offline').hidden=false; setTimeout(boot,5000); }
}
/* Ao voltar ao separador, vai buscar o que mudou noutros dispositivos. */
async function refresh(){
  try{
    const r=await api('GET','/api/trips'); if(!r.ok) return; const d=await r.json();
    if(S.saving || computeDirty()) return;
    const sig=a=>JSON.stringify(a.sort());
    if(sig(S.store.trips.map(t=>t.id+':'+revs[t.id]))===sig(d.trips.map(x=>x.trip.id+':'+x.rev))) return;
    applyServer(d); clearHistory(); closeSheets(); ensureActive(); render();
    toast(tr('tRefreshed'));
  }catch(e){}
}
document.addEventListener('visibilitychange',()=>{
  if(!S.authed) return;
  if(document.hidden){ if(computeDirty()){ clearTimeout(saveTimer); doSave(); } return; }
  if(!S.saving && !S.drag && !computeDirty()) refresh();
});
window.addEventListener('beforeunload',e=>{ if(S.authed && computeDirty()){ e.preventDefault(); e.returnValue=''; } });

/* login */
function showLogin(){
  S.authed=false; clearTimeout(saveTimer);
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
  applyServer({trips:[]}); clearHistory(); closeSheets(); showLogin();
});
