/* Marcas das alterações feitas pela IA: o campo ai que o servidor MCP escreve (tripedit.go) nas atividades,
   nos custos e na própria viagem (dados, sítios, sítios dos dias), com a data e hora da alteração.
   A página mostra-as (✨ nos blocos e o painel ui/aisheet.js) até o utilizador as dar como vistas.
   Módulo puro, testado em tests/ai.test.mjs. */
import { pad } from './util.js';

/** @typedef {import('./clean.js').Trip} Trip */
/** @typedef {import('./clean.js').ISODate} ISODate */
/**
 * Uma alteração da IA ainda por ver.
 * @typedef {object} AiChange
 * @property {'block'|'cost'|'trip'} kind  atividade (no quadro ou por agendar), custo, ou os dados da viagem
 * @property {string} id      Block.id, Cost.id ou Trip.id
 * @property {string} title   título da atividade ou descrição do custo ('' na viagem)
 * @property {string} at      quando a IA mudou (AI_STAMP em clean.js, UTC)
 * @property {ISODate} [date] dia da atividade ou do custo; sem ele está por agendar ou é geral
 */

/** As alterações da IA ainda por ver na viagem t, da mais recente para a mais antiga.
   @param {Trip | null} t
   @returns {AiChange[]} */
export function aiChanges(t){
  if(!t) return [];
  const out=[];
  if(t.ai) out.push({kind:'trip', id:t.id, title:'', at:t.ai});
  for(const b of t.blocks.concat(t.tray)){
    if(b.ai) out.push({kind:'block', id:b.id, title:b.title, at:b.ai, ...(b.date ? {date:b.date} : {})});
  }
  for(const c of t.costs){
    if(c.ai) out.push({kind:'cost', id:c.id, title:c.label, at:c.ai, ...(c.date ? {date:c.date} : {})});
  }
  // a mais recente primeiro; na mesma alteração, pela ordem da viagem
  return out.map((x, i)=>({x, i})).sort((p, q)=>q.x.at.localeCompare(p.x.at) || p.i-q.i).map(p=>p.x);
}

/* O objeto da viagem t com a marca de kind/id, ou null. */
function marked(t, kind, id){
  if(kind==='trip') return t.id===id ? t : null;
  const list = kind==='cost' ? t.costs : t.blocks.concat(t.tray);
  return list.find(o=>o.id===id) || null;
}

/** Dá como vista a alteração da IA em kind/id (tira o campo ai). Devolve false se não havia marca.
   @param {Trip} t  mudada no próprio objeto
   @param {AiChange['kind']} kind
   @param {string} id
   @returns {boolean} */
export function clearAiMark(t, kind, id){
  const o=marked(t, kind, id);
  if(!o || !o.ai) return false;
  delete o.ai;
  return true;
}

/** Dá como vistas todas as alterações da IA na viagem t. Devolve quantas eram.
   @param {Trip} t  mudada no próprio objeto
   @returns {number} */
export function clearAiMarks(t){
  const all=aiChanges(t);
  for(const c of all) clearAiMark(t, c.kind, c.id);
  return all.length;
}

/** "13/10 10:00": a data de uma marca na hora deste dispositivo (a do servidor vem em UTC).
   @param {string} at  AI_STAMP
   @returns {string} */
export function aiStampLabel(at){
  const d=new Date(at);
  if(Number.isNaN(d.getTime())) return '';
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
