/* Cópia de segurança: o ficheiro que se descarrega e o que se importa ({version:2, trips}).
   Módulo sem DOM (testado em tests/backup.test.mjs); ui/files.js lê e escreve os ficheiros. */
import { pad } from './util.js';
import { ISO, ID } from './clean.js';
import { normTrip } from './trip.js';

/** @typedef {import('./clean.js').Trip} Trip */

/** Nome do ficheiro da cópia feita no dia d: planeador-ferias-AAAA-MM-DD.json.
   @param {Date} d  em hora local
   @returns {string} */
export function backupName(d){ return `planeador-ferias-${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}.json`; }
/** Conteúdo do ficheiro da cópia.
   @param {Trip[]} trips
   @param {number} savedAt  quando (ms desde 1970, Date.now())
   @returns {string} JSON {version:2, savedAt, trips} */
export function backupJSON(trips, savedAt){ return JSON.stringify({version:2, savedAt, trips}); }

/** As viagens de um ficheiro importado: só as que têm nome e datas AAAA-MM-DD (ainda por limpar com normTrip).
   Lança um erro se o texto não for JSON, não tiver a lista trips ou não tiver nenhuma viagem válida.
   @param {string} text  o conteúdo do ficheiro
   @returns {object[]} */
export function parseBackup(text){
  const data=JSON.parse(text);
  if(!data || !Array.isArray(data.trips)) throw new Error('formato');
  const ok=data.trips.filter(t=>t && typeof t==='object' && t.name && ISO.test(t.start||'') && ISO.test(t.end||''));
  if(!ok.length) throw new Error('vazio');
  return ok;
}

/** Junta as viagens importadas à store: uma com o mesmo id substitui a que lá está, as outras entram no fim.
   Uma viagem sem id válido recebe um novo. Devolve quantas entraram, quantas foram substituídas e o id da primeira.
   @param {{trips: Trip[]}} store  mudada no próprio objeto (S.store)
   @param {object[]} trips  de parseBackup; passam por normTrip
   @param {(prefix: string) => string} newId
   @returns {{added: number, replaced: number, first: string | null}} */
export function mergeTrips(store, trips, newId){
  let added=0, replaced=0, first=null;
  for(const raw of trips){
    const t=normTrip(raw);
    if(!ID.test(t.id||'')) t.id=newId('t');
    const i=store.trips.findIndex(x=>x.id===t.id);
    if(i>=0){
      store.trips[i]=t;
      replaced++;
    } else {
      store.trips.push(t);
      added++;
    }
    if(!first) first=t.id;
  }
  return {added, replaced, first};
}
