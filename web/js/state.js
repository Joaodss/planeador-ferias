/* Estado partilhado da aplicação.
   Tudo o que muda e é lido por mais de um módulo vive no objeto S
   (um módulo ES não pode reatribuir um `let` importado de outro).
   Não mexe no DOM: o botão Desfazer acompanha S.history em render() (ui/board.js). */
const ACTIVE_KEY='ferias-active-trip';
/* Pontos do Desfazer guardados: os mais antigos saem (ver o comentário de pushHistory sobre a memória). */
const MAX_UNDO=60;
/** Chave do localStorage de "Mostrar sono" (ui/toolbar.js), guardada por dispositivo. */
export const SLEEP_KEY='ferias-hide-sleep';

/** @typedef {import('./clean.js').Trip} Trip */
/**
 * Ponto do Desfazer: só a viagem ativa ({id, trip}) ou a store inteira ({store, id}), em JSON.
 * @typedef {{id: string, trip: string} | {store: string, id: string | null}} UndoPoint
 */

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

/** @returns {Trip | null} a viagem aberta */
export function activeTrip(){ return S.store.trips.find(t=>t.id===S.activeId) || null; }
/** Se a viagem ativa já não existe (apagada, ou a store mudou), abre a primeira. */
export function ensureActive(){ if(!activeTrip()) S.activeId = S.store.trips.length ? S.store.trips[0].id : null; }
/** Abre a viagem id e lembra-a neste dispositivo.
    @param {string} id */
export function setActive(id){ S.activeId=id; try{ localStorage.setItem(ACTIVE_KEY,id); }catch{} }

/* ---------- desfazer ----------
   Cada ponto guarda em JSON só a viagem ativa, porque quase todas as alterações mexem só nela
   (com várias viagens grandes, 60 cópias da store inteira chegavam às centenas de MB).
   id: a viagem aberta, que o Desfazer volta a mostrar. */
/** Guarda um ponto do Desfazer antes de mudar a viagem ativa (sem viagem ativa, guarda a store inteira). */
export function pushHistory(){
  const t=activeTrip();
  if(t) addPoint({id:t.id, trip:JSON.stringify(t)}); else pushStoreHistory();
}
/** Ponto com a store inteira, para criar, duplicar, apagar e importar viagens. */
export function pushStoreHistory(){ addPoint({store:JSON.stringify(S.store), id:S.activeId}); }
function addPoint(p){
  S.history.push(p);
  if(S.history.length>MAX_UNDO) S.history.shift();
}
/** Descarta a última entrada (quando afinal não houve alteração). */
export function dropHistory(){ S.history.pop(); }
/** Esquece todos os pontos do Desfazer (ao carregar outra versão do servidor ou depois de um conflito). */
export function clearHistory(){ S.history=[]; }
/** Repõe o último ponto do Desfazer: a store inteira ou só a viagem desse ponto, que volta a ficar aberta.
   Devolve false se não havia nada para desfazer. Gravar e redesenhar fica para quem chama (undo() em sync.js).
   @returns {boolean} */
export function restoreLast(){
  if(!S.history.length) return false;
  const h=S.history.pop();
  if(h.store) S.store=JSON.parse(h.store);
  else { const t=JSON.parse(h.trip), i=S.store.trips.findIndex(x=>x.id===h.id); if(i>=0) S.store.trips[i]=t; else S.store.trips.push(t); }
  if(h.id) setActive(h.id);
  ensureActive();
  return true;
}
