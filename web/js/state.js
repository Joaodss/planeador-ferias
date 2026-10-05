/* Estado partilhado da aplicação.
   Tudo o que muda e é lido por mais de um módulo vive no objeto S
   (um módulo ES não pode reatribuir um `let` importado de outro).
   Não mexe no DOM: o botão Desfazer acompanha S.history em render() (ui/board.js). */
const ACTIVE_KEY='ferias-active-trip';
export const SLEEP_KEY='ferias-hide-sleep';

export const S = {
  store: {version:2, trips:[]},
  activeId: null,
  history: [],          // pilha do Desfazer (ver pushHistory)
  dirty: false, saving: false, online: true, authed: false,
  drag: null, suppressClick: false,
  editingId: null,      // atividade aberta no editor
  dayOpen: null,        // dia aberto no painel do dia
  hideSleep: false,
  lastWarnings: [],
};
try{ S.activeId = localStorage.getItem(ACTIVE_KEY); }catch{}

export function T(){ return S.store.trips.find(t=>t.id===S.activeId) || null; }
export function ensureActive(){ if(!T()) S.activeId = S.store.trips.length ? S.store.trips[0].id : null; }
export function setActive(id){ S.activeId=id; try{ localStorage.setItem(ACTIVE_KEY,id); }catch{} }

/* ---------- desfazer ----------
   Cada ponto guarda em JSON só a viagem ativa, porque quase todas as alterações mexem só nela
   (com várias viagens grandes, 60 cópias da store inteira chegavam às centenas de MB).
   whole: guarda a store inteira, para criar, duplicar, apagar e importar viagens.
   id: a viagem aberta, que o Desfazer volta a mostrar. */
export function pushHistory(whole){
  const t=T(); S.history.push(whole||!t ? {store:JSON.stringify(S.store), id:S.activeId} : {id:t.id, trip:JSON.stringify(t)});
  if(S.history.length>60) S.history.shift();
}
/* Descarta a última entrada (quando afinal não houve alteração). */
export function dropHistory(){ S.history.pop(); }
export function clearHistory(){ S.history=[]; }
/* Repõe o último ponto do Desfazer: a store inteira ou só a viagem desse ponto, que volta a ficar aberta.
   Devolve false se não havia nada para desfazer. Gravar e redesenhar fica para quem chama (undo() em sync.js). */
export function restoreLast(){
  if(!S.history.length) return false;
  const h=S.history.pop();
  if(h.store) S.store=JSON.parse(h.store);
  else { const t=JSON.parse(h.trip), i=S.store.trips.findIndex(x=>x.id===h.id); if(i>=0) S.store.trips[i]=t; else S.store.trips.push(t); }
  if(h.id) setActive(h.id);
  ensureActive();
  return true;
}
