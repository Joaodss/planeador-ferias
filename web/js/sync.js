/* ---------- server sync ----------
   Cada viagem é um ficheiro no servidor com um número de revisão (rev).
   A página guarda só as viagens que mudaram e envia a revisão em que se baseou;
   se outro dispositivo gravou entretanto, o servidor responde 409 e fica a versão dele. */
import { tr } from './i18n.js';
import { $, toast, announce } from './util.js';
import { S, ensureActive, setActive, clearHistory } from './state.js';
import { normTrip } from './trip.js';
import { setServerHomeTz } from './tz.js';
import { render } from './ui/board.js';
import { closeSheets } from './ui/sheets.js';

let saveTimer=null, renderTimer=null;
let edits=0;      // conta os commit(): se não mudou durante uma gravação, o que foi serializado no início ainda é o estado atual
let listTag='';   // ETag da última lista de viagens aplicada: o refresh() pergunta com If-None-Match
const revs = {}, synced = {};

async function api(method, path, body, extra){
  const headers={'X-Requested-With':'planner', ...extra}; if(body!==undefined) headers['Content-Type']='application/json';
  const r = await fetch(path,{method, headers, body, credentials:'same-origin', cache:'no-store'});
  if(r.status===401){ showLogin(); throw {code:'auth'}; }
  return r;
}
/* O JSON de cada viagem, serializado uma só vez por gravação. */
const snapshot = () => new Map(S.store.trips.map(t=>[t.id, JSON.stringify(t)]));
function dirtyIn(snap){ for(const [id,js] of snap) if(synced[id]!==js) return true; return Object.keys(synced).some(id=>!snap.has(id)); }
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
  // snap serve para ver o que mudou, para o corpo dos PUT e, se nada mudar entretanto, para o estado no fim
  const snap=snapshot(), e0=edits;
  if(!dirtyIn(snap)){ S.dirty=false; refreshSaveLabel(); return; }
  S.saving=true; refreshSaveLabel(); let conflict=false, tooBig=false;
  try{
    for(const id of Object.keys(synced)){
      if(snap.has(id)) continue;
      const r=await api('DELETE','/api/trips/'+encodeURIComponent(id));
      if(!r.ok) throw {code:'http'};
      delete synced[id]; delete revs[id];
    }
    for(const t of S.store.trips.slice()){
      const js=snap.get(t.id); if(js===undefined || synced[t.id]===js) continue;
      const r=await api('PUT','/api/trips/'+encodeURIComponent(t.id), '{"baseRev":'+(revs[t.id]||0)+',"trip":'+js+'}');
      if(r.ok){ const d=await r.json(); revs[t.id]=d.rev; synced[t.id]=js; }
      else if(r.status===409){
        const d=await r.json(); conflict=true; const i=S.store.trips.indexOf(t); snap.delete(t.id);
        if(d.deleted){ if(i>=0) S.store.trips.splice(i,1); delete synced[t.id]; delete revs[t.id]; }
        else { const nt=normTrip(d.trip); if(i>=0) S.store.trips[i]=nt; revs[nt.id]=d.rev; synced[nt.id]=JSON.stringify(nt); snap.set(nt.id, synced[nt.id]); }
      }
      else if(r.status===413){ tooBig=true; synced[t.id]=js; }
      else throw {code:'http'};
    }
    S.online=true;
  }catch(e){ if(!e || e.code!=='auth') S.online=false; }
  S.saving=false; S.dirty = edits===e0 ? dirtyIn(snap) : computeDirty(); refreshSaveLabel();
  if(conflict){ clearHistory(); closeSheets(); ensureActive(); render(); toast(tr('tConflict')); }
  if(tooBig) toast(tr('tTooBig'));
  if(S.dirty && S.authed) scheduleSave(S.online?1200:8000);
}
/* Depois de qualquer alteração: marca por gravar, agenda a gravação e redesenha.
   lazy (campos de texto, a cada tecla): o quadro só é redesenhado numa pausa de 150 ms, não a cada letra. */
export function commit(lazy){ S.dirty=true; edits++; scheduleSave(); clearTimeout(renderTimer); if(lazy) renderTimer=setTimeout(render,150); else render(); }
/* Um ponto do Desfazer é a store inteira ou uma viagem (ver pushHistory); volta a mostrar a viagem que estava aberta. */
export function undo(){ if(!S.history.length) return; const h=S.history.pop();
  if(h.store) S.store=JSON.parse(h.store);
  else { const t=JSON.parse(h.trip), i=S.store.trips.findIndex(x=>x.id===h.id); if(i>=0) S.store.trips[i]=t; else S.store.trips.push(t); }
  if(h.id) setActive(h.id);
  ensureActive(); $('#undo').disabled=!S.history.length; closeSheets(); commit(); announce(tr('undone')); }

function applyServer(d, tag){
  listTag=tag||'';
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
  applyServer(await r.json(), r.headers.get('ETag')); clearHistory(); S.dirty=false; S.online=true;
  showApp(); ensureActive(); render(); refreshSaveLabel();
}
export async function boot(){
  try{ await loadAll(); }
  catch(e){ if(e && e.code==='auth') return; $('#offline').hidden=false; setTimeout(boot,5000); }
}
/* Ao voltar ao separador, vai buscar o que mudou noutros dispositivos. */
async function refresh(){
  try{
    // 304: nada mudou no servidor desde a última lista, nem se descarrega nem se interpreta
    const r=await api('GET','/api/trips', undefined, listTag ? {'If-None-Match':listTag} : undefined);
    if(r.status===304 || !r.ok) return; const d=await r.json(), tag=r.headers.get('ETag');
    // com alterações por gravar, a lista fica por aplicar e o ETag por guardar (senão o próximo refresh dava 304)
    if(S.saving || computeDirty()) return;
    const sig=a=>JSON.stringify(a.sort());
    if(sig(S.store.trips.map(t=>t.id+':'+revs[t.id]))===sig(d.trips.map(x=>x.trip.id+':'+x.rev))){ listTag=tag||''; return; }
    applyServer(d, tag); clearHistory(); closeSheets(); ensureActive(); render();
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
