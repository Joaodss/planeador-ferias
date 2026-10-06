/* Formulário "Datas e sítios": validar os campos, criar uma viagem nova ou aplicar as alterações a uma que existe.
   f são os valores dos campos tal como vêm do formulário (texto): {name, start, end, dayStart, dayEnd, people,
   currency, budget, tz, homeTz}. Módulo sem DOM (testado em tests/tripform.test.mjs); ui/tripsheet.js lê e escreve os campos. */
import { parseISO } from './util.js';
import { resolveTz } from './tz.js';
import { tripDates, toTray } from './trip.js';

/** Máximo de dias de uma viagem criada ou editada no formulário "Datas e sítios" (o erro errTripLong).
   MAX_TRIP_DATES (span.js) é maior e não é o mesmo limite: protege das viagens que não passam por aqui (importadas ou editadas à mão). */
export const MAX_DAYS = 60;

/** @typedef {import('./clean.js').Trip} Trip */
/**
 * Os campos do formulário, tal como vêm da página (texto).
 * @typedef {object} TripForm
 * @property {string} name
 * @property {string} start    "AAAA-MM-DD" ou ''
 * @property {string} end      "AAAA-MM-DD" ou ''
 * @property {string} dayStart hora (0–23)
 * @property {string} dayEnd   hora (0–23)
 * @property {string} people
 * @property {string} currency
 * @property {string} budget
 * @property {string} tz       fuso da viagem, nome completo ou só a cidade ('' para nenhum)
 * @property {string} homeTz   segundo fuso deste dispositivo ('' para o por omissão)
 */
/**
 * Os mesmos campos já convertidos para os da viagem (tripFields).
 * @typedef {object} TripFields
 * @property {string} name
 * @property {string} start
 * @property {string} end
 * @property {number} dayStart  hora (0–23)
 * @property {number} dayEnd    hora (0–23)
 * @property {number} people
 * @property {string} currency
 * @property {number} budget    0 para "sem orçamento"
 * @property {string} tz        '' para "sem fuso"
 */

/** O primeiro erro do formulário, como {key, params} para a função de tradução, ou null se estiver tudo bem.
   @param {TripForm} f
   @returns {{key: string, params?: object} | null} */
export function validateTrip(f){
  if(!f.name.trim()) return {key:'errTripName'};
  if(!f.start || !f.end) return {key:'errTripDates'};
  if(f.end<f.start) return {key:'errTripOrder'};
  const n=Math.round((parseISO(f.end)-parseISO(f.start))/864e5)+1;
  if(n>MAX_DAYS) return {key:'errTripLong', params:{n}};
  if(resolveTz(f.tz)===null) return {key:'errTz', params:{v:f.tz.trim()}};
  if(resolveTz(f.homeTz)===null) return {key:'errTz', params:{v:f.homeTz.trim()}};
  return null;
}

/** Os campos já validados, convertidos para os da viagem. budget 0 e tz '' querem dizer "sem".
   @param {TripForm} f
   @returns {TripFields} */
export function tripFields(f){
  const budget=parseFloat(f.budget);
  return {
    name:f.name.trim(), start:f.start, end:f.end, dayStart:+f.dayStart, dayEnd:+f.dayEnd,
    people:Math.max(1, parseInt(f.people)||1), currency:f.currency,
    budget:budget>0 ? budget : 0, tz:resolveTz(f.tz) || '',
  };
}

/** Viagem nova e vazia com os campos do formulário.
   @param {TripFields} fields
   @param {(prefix: string) => string} newId
   @returns {Trip} */
export function newTrip(fields, newId){
  const {budget, tz, ...rest}=fields;
  const t={id:newId('t'), ...rest, places:[], dayPlaces:{}, blocks:[], tray:[], costs:[]};
  if(budget) t.budget=budget;
  if(tz) t.tz=tz;
  return t;
}

/** Aplica os campos à viagem t. O que fica fora das novas datas não se perde: as atividades vão para
   "por agendar", os custos desse dia passam a gerais e os sítios desses dias saem.
   Devolve quantas atividades foram para "por agendar".
   @param {Trip} t  mudada no próprio objeto
   @param {TripFields} fields
   @returns {number} */
export function applyTripEdit(t, fields){
  const {budget, tz, ...rest}=fields;
  Object.assign(t, rest);
  if(budget) t.budget=budget; else delete t.budget;
  if(tz) t.tz=tz; else delete t.tz;
  const inTrip=new Set(tripDates(t));
  const out=t.blocks.filter(b=>!inTrip.has(b.date));
  for(const b of out) toTray(t, b.id);
  for(const c of t.costs||[]) if(c.date && !inTrip.has(c.date)) delete c.date;
  for(const d of Object.keys(t.dayPlaces)) if(!inTrip.has(d)) delete t.dayPlaces[d];
  return out.length;
}
