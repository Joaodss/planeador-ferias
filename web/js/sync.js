/* ---------- server sync ----------
   Cada viagem é um ficheiro no servidor com um número de revisão (rev).
   A página guarda só as viagens que mudaram e envia a revisão em que se baseou;
   se outro dispositivo gravou entretanto, o servidor responde 409 e fica a versão dele.
   Aqui ficam os pedidos, a gravação e a sessão. Este módulo não importa nada de ui/ e não toca no DOM:
   main.js liga a interface com connectUI() e os eventos do browser com initSync(); os testes passam espiões. */
import { tr } from './i18n.js';
import { S, ensureActive, clearHistory, restoreLast } from './state.js';
import { normTrip } from './trip.js';
import { setServerHomeTz } from './tz.js';

/* O que sync.js pede à interface. Por omissão não faz nada. */
const noop=()=>{};
let ui={
  render:noop,        // redesenha o quadro (ui/board.js)
  closeSheets:noop,   // fecha os painéis (ui/sheets.js)
  toast:noop, announce:noop,
  saveState:noop,     // (estado, texto): 'saving' | 'error' | 'dirty' | 'saved', no indicador de gravação
  showLogin:noop, showApp:noop, showOffline:noop,   // ecrãs (ui/login.js)
};
export function connectUI(hooks){ ui={...ui, ...hooks}; }

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

/* ---------- decisões (funções puras) ---------- */
/* O que falta gravar, comparando o JSON de cada viagem (snap) com o que o servidor confirmou (synced):
   deletes são as viagens que o servidor tem e a página já não; puts as que mudaram ou são novas. */
export function pendingOps(snap, synced){
  return {deletes:[...synced.keys()].filter(id=>!snap.has(id)), puts:[...snap.keys()].filter(id=>synced.get(id)!==snap.get(id))};
}
/* Trata a resposta a um PUT da viagem t, enviada com o JSON js. st={trips, revs, synced, snap} é mudado aqui.
   200: fica a revisão nova. 409: fica a versão do servidor, ou a viagem sai se foi apagada noutro dispositivo.
   413: fica marcada como gravada, para não tentar para sempre. Devolve 'ok', 'conflict', 'tooBig' ou 'error'. */
export function applyPutResponse(st, t, js, status, body){
  if(status>=200 && status<300){ st.revs.set(t.id, body.rev); st.synced.set(t.id, js); return 'ok'; }
  if(status===409){
    const i=st.trips.indexOf(t); st.snap.delete(t.id);
    if(body.deleted){ if(i>=0) st.trips.splice(i,1); st.synced.delete(t.id); st.revs.delete(t.id); }
    else { const nt=normTrip(body.trip), njs=JSON.stringify(nt); if(i>=0) st.trips[i]=nt; st.revs.set(nt.id, body.rev); st.synced.set(nt.id, njs); st.snap.set(nt.id, njs); }
    return 'conflict';
  }
  if(status===413){ st.synced.set(t.id, js); return 'tooBig'; }
  return 'error';
}
/* refresh(): a página e o servidor têm as mesmas viagens nas mesmas revisões? (serverTrips: os registos {rev, trip}) */
export function sameRevisions(trips, revs, serverTrips){
  const sig=a=>JSON.stringify(a.sort());
  return sig(trips.map(t=>t.id+':'+revs.get(t.id)))===sig(serverTrips.map(x=>x.trip.id+':'+x.rev));
}

/* ---------- gravar ---------- */
/* O JSON de cada viagem, serializado uma só vez por gravação. */
const snapshot = () => new Map(S.store.trips.map(t=>[t.id, JSON.stringify(t)]));
function dirtyIn(snap){ const o=pendingOps(snap, synced); return o.deletes.length>0 || o.puts.length>0; }
export function computeDirty(){ return dirtyIn(snapshot()); }
export function refreshSaveLabel(){
  if(S.saving) return ui.saveState('saving',tr('saving'));
  if(!S.online) return ui.saveState('error',tr('saveError'));
  if(S.dirty) return ui.saveState('dirty',tr('unsaved'));
  ui.saveState('saved',tr('allSaved'));
}
export function scheduleSave(delay){ clearTimeout(saveTimer); saveTimer=setTimeout(doSave, delay ?? 1200); refreshSaveLabel(); }
async function doSave(){
  if(S.saving || !S.authed) return;
  // snap serve para ver o que mudou, para o corpo dos PUT e, se nada mudar entretanto, para o estado no fim
  const snap=snapshot(), e0=edits, {deletes, puts}=pendingOps(snap, synced);
  if(!deletes.length && !puts.length){ S.dirty=false; refreshSaveLabel(); return; }
  S.saving=true; refreshSaveLabel(); let conflict=false, tooBig=false;
  try{
    for(const id of deletes){
      const r=await api('DELETE','/api/trips/'+encodeURIComponent(id));
      if(!r.ok) throw new ApiError('http');
      synced.delete(id); revs.delete(id);
    }
    const todo=new Set(puts);
    // pela ordem da store de agora: uma viagem apagada enquanto se esperava pelos pedidos já não é enviada
    for(const t of S.store.trips.slice()){
      if(!todo.has(t.id)) continue; const js=snap.get(t.id);
      // O corpo junta-se à mão para levar o JSON de snap tal e qual: é o que fica em synced se a gravação correr bem.
      // Com JSON.stringify({baseRev, trip}) a viagem era serializada outra vez e podia já não ser a mesma,
      // porque pode ser editada enquanto se espera pelos pedidos anteriores.
      const r=await api('PUT','/api/trips/'+encodeURIComponent(t.id), `{"baseRev":${revs.get(t.id) ?? 0},"trip":${js}}`);
      const res=applyPutResponse({trips:S.store.trips, revs, synced, snap}, t, js, r.status, r.ok||r.status===409 ? await r.json() : null);
      if(res==='conflict') conflict=true; else if(res==='tooBig') tooBig=true; else if(res==='error') throw new ApiError('http');
    }
    S.online=true;
  }catch(e){ if(!isAuthError(e)) S.online=false; }
  S.saving=false; S.dirty = edits===e0 ? dirtyIn(snap) : computeDirty(); refreshSaveLabel();
  if(conflict){ clearHistory(); ui.closeSheets(); ensureActive(); ui.render(); ui.toast(tr('tConflict')); }
  if(tooBig) ui.toast(tr('tTooBig'));
  if(S.dirty && S.authed) scheduleSave(S.online?1200:8000);
}
/* Depois de qualquer alteração: marca por gravar, agenda a gravação e redesenha.
   lazy (campos de texto, a cada tecla): o quadro só é redesenhado numa pausa de 150 ms, não a cada letra. */
export function commit(lazy){ S.dirty=true; edits++; scheduleSave(); clearTimeout(renderTimer); if(lazy) renderTimer=setTimeout(()=>ui.render(),150); else ui.render(); }
/* Desfaz o último ponto (ver restoreLast em state.js) e grava. */
export function undo(){ if(!restoreLast()) return; ui.closeSheets(); commit(); ui.announce(tr('undone')); }

/* ---------- ler do servidor e sessão ---------- */
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
function startSession(){ S.authed=true; ui.showApp(); }
function endSession(){ S.authed=false; clearTimeout(saveTimer); ui.showLogin(); }
async function loadAll(){
  const r=await api('GET','/api/trips'); if(!r.ok) throw new ApiError('http');
  applyServer(await r.json(), r.headers.get('ETag')); clearHistory(); S.dirty=false; S.online=true;
  startSession(); ensureActive(); ui.render(); refreshSaveLabel();
}
/* Arranque: vai buscar as viagens; sem ligação mostra o aviso e tenta de novo a cada 5 s. */
export async function boot(){
  try{ await loadAll(); }
  catch(e){ if(isAuthError(e)) return; ui.showOffline(); setTimeout(boot,5000); }
}
/* Entrar: devolve o código HTTP do login (200, 401 credenciais erradas, 429 demasiadas tentativas).
   Com 200 abre o quadro; se a sessão tinha acabado com alterações por gravar, grava-as em vez de ir buscar a lista. */
export async function signIn(user, password){
  const r=await api('POST','/api/login', JSON.stringify({user, password}));
  if(r.ok){ if(computeDirty()){ startSession(); ui.render(); doSave(); } else await loadAll(); }
  return r.status;
}
/* Sair: antes grava o que falta; se não conseguir, devolve false e a sessão continua. */
export async function signOut(){
  if(computeDirty()){ clearTimeout(saveTimer); await doSave(); if(computeDirty()) return false; }
  try{ await api('POST','/api/logout'); }catch{}
  applyServer({trips:[]}); clearHistory(); ui.closeSheets(); endSession();
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
    if(sameRevisions(S.store.trips, revs, d.trips)){ listTag=tag||''; return; }
    applyServer(d, tag); clearHistory(); ui.closeSheets(); ensureActive(); ui.render();
    ui.toast(tr('tRefreshed'));
  }catch{}
}
/* O separador ficou escondido (grava o que falta) ou voltou a estar visível (vai buscar o que mudou). */
export function onVisibilityChange(hidden){
  if(!S.authed) return;
  if(hidden){ if(computeDirty()){ clearTimeout(saveTimer); doSave(); } return; }
  if(!S.saving && !S.drag && !computeDirty()) return refresh();
}
/* Liga os eventos do browser: mudar de separador e fechar a página com alterações por gravar. */
export function initSync(){
  document.addEventListener('visibilitychange',()=>onVisibilityChange(document.hidden));
  window.addEventListener('beforeunload',e=>{ if(S.authed && computeDirty()){ e.preventDefault(); e.returnValue=''; } });
}
