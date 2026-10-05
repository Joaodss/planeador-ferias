/* ---------- server sync ----------
   Cada viagem é um ficheiro no servidor com um número de revisão (rev).
   A página guarda só as viagens que mudaram e envia a revisão em que se baseou;
   se outro dispositivo gravou entretanto, o servidor responde 409 e fica a versão dele.
   Aqui ficam os pedidos, a gravação e a sessão; os ecrãs de login e sem ligação estão em ui/login.js. */
import { tr } from './i18n.js';
import { $, toast, announce } from './util.js';
import { S, ensureActive, setActive, clearHistory } from './state.js';
import { normTrip } from './trip.js';
import { setServerHomeTz } from './tz.js';
import { render } from './ui/board.js';
import { closeSheets } from './ui/sheets.js';
import { showLogin, showApp, showOffline } from './ui/login.js';

let saveTimer=null, renderTimer=null;
let edits=0;      // conta os commit(): se não mudou durante uma gravação, o que foi serializado no início ainda é o estado atual
let listTag='';   // ETag da última lista de viagens aplicada: o refresh() pergunta com If-None-Match
const revs=new Map(), synced=new Map();   // por viagem: a revisão e o JSON que o servidor confirmou

/* Erro de um pedido: code 'auth' (a sessão acabou e o login já está à vista) ou 'http' (o servidor respondeu com erro). */
class ApiError extends Error {
  constructor(code){ super('API: '+code); this.name='ApiError'; this.code=code; }
}
export const isAuthError = e => e instanceof ApiError && e.code==='auth';

/* Todos os pedidos ao servidor passam por aqui, com o X-Requested-With que o servidor exige (guarda contra CSRF).
   body já vem em JSON. Um 401 quer dizer que a sessão acabou e mostra o login, exceto no próprio login,
   onde são credenciais erradas e quem pediu trata da resposta. */
async function api(method, path, body, headers){
  const h={'X-Requested-With':'planner', ...headers}; if(body!==undefined) h['Content-Type']='application/json';
  const r=await fetch(path,{method, headers:h, body, credentials:'same-origin', cache:'no-store'});
  if(r.status===401 && path!=='/api/login'){ endSession(); throw new ApiError('auth'); }
  return r;
}
/* O JSON de cada viagem, serializado uma só vez por gravação. */
const snapshot = () => new Map(S.store.trips.map(t=>[t.id, JSON.stringify(t)]));
function dirtyIn(snap){ for(const [id,js] of snap) if(synced.get(id)!==js) return true; return [...synced.keys()].some(id=>!snap.has(id)); }
export function computeDirty(){ const ids=new Set(S.store.trips.map(t=>t.id)); return S.store.trips.some(t=>synced.get(t.id)!==JSON.stringify(t)) || [...synced.keys()].some(id=>!ids.has(id)); }
function setSave(s,txt){ $('#save').dataset.s=s; $('#save-txt').textContent=txt; }
export function refreshSaveLabel(){
  if(S.saving) return setSave('saving',tr('saving'));
  if(!S.online) return setSave('error',tr('saveError'));
  if(S.dirty) return setSave('dirty',tr('unsaved'));
  setSave('saved',tr('allSaved'));
}
export function scheduleSave(delay){ clearTimeout(saveTimer); saveTimer=setTimeout(doSave, delay ?? 1200); refreshSaveLabel(); }
async function doSave(){
  if(S.saving || !S.authed) return;
  // snap serve para ver o que mudou, para o corpo dos PUT e, se nada mudar entretanto, para o estado no fim
  const snap=snapshot(), e0=edits;
  if(!dirtyIn(snap)){ S.dirty=false; refreshSaveLabel(); return; }
  S.saving=true; refreshSaveLabel(); let conflict=false, tooBig=false;
  try{
    for(const id of [...synced.keys()]){
      if(snap.has(id)) continue;
      const r=await api('DELETE','/api/trips/'+encodeURIComponent(id));
      if(!r.ok) throw new ApiError('http');
      synced.delete(id); revs.delete(id);
    }
    for(const t of S.store.trips.slice()){
      const js=snap.get(t.id); if(js===undefined || synced.get(t.id)===js) continue;
      // O corpo junta-se à mão para levar o JSON de snap tal e qual: é o que fica em synced se a gravação correr bem.
      // Com JSON.stringify({baseRev, trip}) a viagem era serializada outra vez e podia já não ser a mesma,
      // porque pode ser editada enquanto se espera pelos pedidos anteriores.
      const r=await api('PUT','/api/trips/'+encodeURIComponent(t.id), `{"baseRev":${revs.get(t.id) ?? 0},"trip":${js}}`);
      if(r.ok){ const d=await r.json(); revs.set(t.id, d.rev); synced.set(t.id, js); }
      else if(r.status===409){
        const d=await r.json(); conflict=true; const i=S.store.trips.indexOf(t); snap.delete(t.id);
        if(d.deleted){ if(i>=0) S.store.trips.splice(i,1); synced.delete(t.id); revs.delete(t.id); }
        else { const nt=normTrip(d.trip), njs=JSON.stringify(nt); if(i>=0) S.store.trips[i]=nt; revs.set(nt.id, d.rev); synced.set(nt.id, njs); snap.set(nt.id, njs); }
      }
      else if(r.status===413){ tooBig=true; synced.set(t.id, js); }
      else throw new ApiError('http');
    }
    S.online=true;
  }catch(e){ if(!isAuthError(e)) S.online=false; }
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
  revs.clear(); synced.clear();
  setServerHomeTz(d.homeTz);
  const trips=d.trips.map(x=>{ const t=normTrip(x.trip); revs.set(t.id, x.rev); synced.set(t.id, JSON.stringify(t)); return t; });
  trips.sort((a,b)=>String(a.start).localeCompare(String(b.start)));
  S.store={version:2, trips};
}
/* Sessão: startSession abre o quadro; endSession (401 ou Sair) para as gravações e mostra o login.
   O que ficou por gravar continua na página e é gravado depois de voltar a entrar. */
function startSession(){ S.authed=true; showApp(); }
function endSession(){ S.authed=false; clearTimeout(saveTimer); showLogin(); }
async function loadAll(){
  const r=await api('GET','/api/trips'); if(!r.ok) throw new ApiError('http');
  applyServer(await r.json(), r.headers.get('ETag')); clearHistory(); S.dirty=false; S.online=true;
  startSession(); ensureActive(); render(); refreshSaveLabel();
}
export async function boot(){
  try{ await loadAll(); }
  catch(e){ if(isAuthError(e)) return; showOffline(); setTimeout(boot,5000); }
}
/* Entrar: devolve o código HTTP do login (200, 401 credenciais erradas, 429 demasiadas tentativas).
   Com 200 abre o quadro; se a sessão tinha acabado com alterações por gravar, grava-as em vez de ir buscar a lista. */
export async function signIn(user, password){
  const r=await api('POST','/api/login', JSON.stringify({user, password}));
  if(r.ok){ if(computeDirty()){ startSession(); render(); doSave(); } else await loadAll(); }
  return r.status;
}
/* Sair: antes grava o que falta; se não conseguir, devolve false e a sessão continua. */
export async function signOut(){
  if(computeDirty()){ clearTimeout(saveTimer); await doSave(); if(computeDirty()) return false; }
  try{ await api('POST','/api/logout'); }catch{}
  applyServer({trips:[]}); clearHistory(); closeSheets(); endSession();
  return true;
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
    if(sig(S.store.trips.map(t=>t.id+':'+revs.get(t.id)))===sig(d.trips.map(x=>x.trip.id+':'+x.rev))){ listTag=tag||''; return; }
    applyServer(d, tag); clearHistory(); closeSheets(); ensureActive(); render();
    toast(tr('tRefreshed'));
  }catch{}
}
document.addEventListener('visibilitychange',()=>{
  if(!S.authed) return;
  if(document.hidden){ if(computeDirty()){ clearTimeout(saveTimer); doSave(); } return; }
  if(!S.saving && !S.drag && !computeDirty()) refresh();
});
window.addEventListener('beforeunload',e=>{ if(S.authed && computeDirty()){ e.preventDefault(); e.returnValue=''; } });
