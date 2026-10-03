/* Estado partilhado da aplicação.
   Tudo o que muda e é lido por mais de um módulo vive no objeto S
   (um módulo ES não pode reatribuir um `let` importado de outro). */
import { $ } from './util.js';

const ACTIVE_KEY='ferias-active-trip';
export const SLEEP_KEY='ferias-hide-sleep';

export const S = {
  store: {version:2, trips:[]},
  activeId: null,
  history: [],          // pilha do Desfazer (cópias JSON de store)
  dirty: false, saving: false, online: true, authed: false,
  drag: null, suppressClick: false,
  editingId: null,      // atividade aberta no editor
  dayOpen: null,        // dia aberto no painel do dia
  hideSleep: false,
  lastWarnings: [],
};
try{ S.activeId = localStorage.getItem(ACTIVE_KEY); }catch(e){}

export function T(){ return S.store.trips.find(t=>t.id===S.activeId) || null; }
export function ensureActive(){ if(!T()) S.activeId = S.store.trips.length ? S.store.trips[0].id : null; }
export function setActive(id){ S.activeId=id; try{ localStorage.setItem(ACTIVE_KEY,id); }catch(_){} }

/* ---------- desfazer ---------- */
export function pushHistory(){ S.history.push(JSON.stringify(S.store)); if(S.history.length>60) S.history.shift(); $('#undo').disabled=false; }
/* Descarta a última entrada (quando afinal não houve alteração). */
export function dropHistory(){ S.history.pop(); $('#undo').disabled=!S.history.length; }
export function clearHistory(){ S.history=[]; $('#undo').disabled=true; }
