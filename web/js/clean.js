/* Limpeza dos dados de uma viagem que vêm do servidor ou de uma cópia importada.
   O servidor não conhece o esquema da viagem, por isso o cliente é a única barreira contra dados malformados:
   uma atividade sem data partia o quadro em todos os dispositivos e um estado com HTML entrava na página.
   Módulo puro (testado em tests/clean.test.mjs); normTrip (trip.js) chama-o com newId.
   Os tipos dos dados (Trip, Block, Cost, Place, CostCat) estão definidos aqui, junto de quem garante o esquema:
   os outros módulos usam-nos com import('./clean.js').Trip nos comentários JSDoc. */
import { TZ } from './tz.js';

/**
 * Data "AAAA-MM-DD" (sem hora nem fuso). Os dias da viagem estão sempre na hora da viagem.
 * @typedef {string} ISODate
 */
/**
 * Tipo de atividade: decide a cor no quadro e alguns avisos. Não é a categoria de custo (essa é Block.ccat).
 * @typedef {'tour'|'party'|'transport'|'food'|'rest'|'sleep'} Kind
 */
/**
 * Estado de uma atividade. Os ids são dados guardados em português: só a tradução muda.
 * @typedef {'ideia'|'reservar'|'reservado'|'pago'} Status
 */
/**
 * Atividade. No quadro tem `date` e `start`; em "por agendar" (Trip.tray) não tem nenhum dos dois.
 * @typedef {object} Block
 * @property {string} id
 * @property {string} title
 * @property {ISODate} [date]   dia a que pertence, na hora da viagem
 * @property {number} [start]   minutos desde a meia-noite de `date`, na hora da viagem; pode passar de 1440 (madrugada)
 * @property {number} len       duração em minutos (≥ 15); pode durar vários dias
 * @property {Kind} cat         tipo de atividade (não é a categoria de custo)
 * @property {Status} [status]
 * @property {true} [locked]    fixa: não se arrasta nem se move com as setas
 * @property {number} [pp]      custo por pessoa (> 0)
 * @property {number} [total]   custo para o grupo (> 0); pode ter pp e total ao mesmo tempo
 * @property {string} [ccat]    categoria de custo (CostCat.id); sem ela, usa autoCat() (costs.js)
 * @property {number[]} [weekdays] dias da semana em que acontece (0 = domingo … 6 = sábado); nunca os 7
 * @property {string} [place]   sítio onde acontece (Place.id)
 * @property {string} [tz]      fuso próprio (IANA), só para o editor mostrar e ler o dia e a hora nesse fuso
 * @property {string} [address]
 * @property {string} [link]
 * @property {string} [ref]     referência da reserva
 * @property {string} [note]
 */
/**
 * Sítio por onde a viagem passa.
 * @typedef {object} Place
 * @property {string} id
 * @property {string} name   "Lisboa · Hotel Avenida": o que vem antes de " ·" é o nome curto (shortPlaceName)
 * @property {number} c      cor, de 1 a 8 (--p1 … --p8 no CSS; ver addPlace)
 */
/**
 * Custo que não é de uma atividade: de um dia (`date`) ou geral (sem `date`).
 * @typedef {object} Cost
 * @property {string} id
 * @property {string} label
 * @property {number} amount        valor (≥ 0), na moeda da viagem
 * @property {'total'|'pp'} per     amount é para o grupo ou por pessoa
 * @property {string} [cat]         categoria de custo (CostCat.id)
 * @property {ISODate} [date]
 * @property {true} [paid]
 */
/**
 * Categoria de custo. Os ids por omissão estão em português (alojamento, transporte, …): são dados guardados.
 * @typedef {object} CostCat
 * @property {string} id
 * @property {string} name
 */
/**
 * Viagem, tal como fica no servidor (o servidor não conhece este esquema: guarda o JSON tal e qual).
 * @typedef {object} Trip
 * @property {string} id          cumpre ID
 * @property {string} name
 * @property {ISODate} start      primeiro dia
 * @property {ISODate} end        último dia (inclusive)
 * @property {number} dayStart    hora (0–23) a que o quadro começa
 * @property {number} dayEnd      hora (0–23) a que o quadro acaba; menor que dayStart quando acaba depois da meia-noite
 * @property {string} [tz]        fuso da viagem (IANA): as horas do quadro são a hora local deste fuso
 * @property {number} people      quantas pessoas (≥ 1), para dividir os custos
 * @property {string} currency    símbolo da moeda (até 5 caracteres, sem caracteres de HTML)
 * @property {number} [budget]    orçamento para o grupo (> 0)
 * @property {Place[]} places
 * @property {Object<ISODate, string[]>} dayPlaces  ids dos sítios de cada dia: [onde começam, …paragens, onde acabam]
 * @property {Block[]} blocks     atividades no quadro (com date e start)
 * @property {Block[]} tray       atividades por agendar (sem date nem start)
 * @property {Cost[]} costs
 * @property {CostCat[]} [costCats]  sem elas usam-se as categorias por omissão, traduzidas (costs.js)
 */

/** Estados (Status). IDs guardados (em português de propósito): nunca mudar o nome, só a tradução. */
export const STATUSES = ['ideia', 'reservar', 'reservado', 'pago'];
/** Tipos de atividade (Kind), pela ordem da legenda. Também são dados guardados: nunca mudar o nome. */
export const KINDS = ['tour', 'party', 'transport', 'food', 'rest', 'sleep'];

/** Sítios de um dia no máximo: onde começam, as paragens pelo caminho e onde acabam. */
export const MAX_DAY_PLACES = 12;
/** Data AAAA-MM-DD e identificador (o mesmo que o servidor aceita no caminho). backup.js também os usa. */
export const ISO = /^\d{4}-\d{2}-\d{2}$/, ID = /^[A-Za-z0-9_-]{1,64}$/;
/* Número finito a partir de um número ou de texto ("600"); qualquer outra coisa dá d. */
function num(v, d){ const n = typeof v==='number' ? v : (typeof v==='string' && v.trim()) ? +v : NaN; return Number.isFinite(n) ? n : d; }
const int = (v, lo, hi, d) => { const n = num(v, NaN); return Number.isInteger(n) && n>=lo && n<=hi ? n : d; };
const text = v => typeof v==='string' ? v : (typeof v==='number' ? String(v) : '');
const obj = v => !!v && typeof v==='object' && !Array.isArray(v);
const list = v => (Array.isArray(v) ? v : []).filter(obj);
/* id válido e único na sua lista; senão um novo. */
function uid(v, used, prefix, newId){ let id = typeof v==='string' && ID.test(v) && !used.has(v) ? v : newId(prefix); while(used.has(id)) id = newId(prefix); used.add(id); return id; }

/* placed: está no quadro (tem date e start) ou no tabuleiro "por agendar" (não tem nenhum). */
function cleanBlock(b, placed, used, newId){
  b.id = uid(b.id, used, 'a', newId);
  b.title = text(b.title);
  if(placed) b.start = Math.max(0, Math.round(num(b.start, 0))); else { delete b.date; delete b.start; }
  b.len = Math.max(15, Math.round(num(b.len, 60)));
  if(!KINDS.includes(b.cat)) b.cat = 'tour';
  if(!STATUSES.includes(b.status)) delete b.status;
  if(b.locked!==true) delete b.locked;
  for(const k of ['pp', 'total']){ const v = num(b[k], 0); if(v>0) b[k] = v; else delete b[k]; }
  const ws = Array.isArray(b.weekdays) ? [...new Set(b.weekdays.map(w => int(w, 0, 6, -1)))].filter(w => w>=0) : [];
  if(ws.length && ws.length<7) b.weekdays = ws; else delete b.weekdays;
  for(const k of ['place', 'ccat']) if(typeof b[k]!=='string' || !b[k]) delete b[k];
  // fuso próprio da atividade (ex.: um voo): só um que o browser reconheça
  if(typeof b.tz!=='string' || !TZ.valid(b.tz)) delete b.tz;
  for(const k of ['address', 'link', 'ref', 'note']) if(b[k]!=null) b[k] = text(b[k]);
  return b;
}

/* Atividades: as que não têm uma data válida passam para "por agendar" em vez de se perderem. */
function cleanActivities(t, newId){
  const used = new Set(), all = list(t.blocks), ok = b => typeof b.date==='string' && ISO.test(b.date);
  t.blocks = all.filter(ok).map(b => cleanBlock(b, true, used, newId));
  t.tray = list(t.tray).concat(all.filter(b => !ok(b))).map(b => cleanBlock(b, false, used, newId));
  return t;
}

/**
 * Limpa a viagem t no próprio objeto: a viagem toda menos id, name, start, end e tz (validados à parte).
 * @param {object} t  viagem como veio do servidor ou de uma importação (qualquer forma)
 * @param {(prefix: string) => string} newId  gerador de ids novos (newId de util.js; os testes passam um fixo)
 * @returns {Trip} o mesmo objeto t, já com a forma de Trip
 */
export function cleanTrip(t, newId){
  t.dayStart = int(t.dayStart, 0, 23, 7); t.dayEnd = int(t.dayEnd, 0, 23, 1);
  t.people = Math.max(1, Math.round(num(t.people, 1)));
  const budget = num(t.budget, 0); if(budget>0) t.budget = budget; else delete t.budget;
  // a moeda entra no HTML através de money (trip.js)
  if(typeof t.currency!=='string' || !t.currency.trim() || t.currency.length>5 || /[<>&"'`]/.test(t.currency)) t.currency = '€';
  const pids = new Set();
  t.places = list(t.places).map(p => { p.id = uid(p.id, pids, 'p', newId); p.name = text(p.name); p.c = int(p.c, 1, 8, 1); return p; });
  const dp = {};
  if(obj(t.dayPlaces)) for(const [d, v] of Object.entries(t.dayPlaces)) if(ISO.test(d) && Array.isArray(v)){ const a = v.filter(x => typeof x==='string' && x).slice(0, MAX_DAY_PLACES); if(a.length) dp[d] = a; }
  t.dayPlaces = dp;
  const cids = new Set();
  t.costs = list(t.costs).map(c => {
    c.id = uid(c.id, cids, 'c', newId); c.label = text(c.label); c.amount = Math.max(0, num(c.amount, 0)); if(c.per!=='pp') c.per = 'total';
    if(typeof c.cat!=='string' || !c.cat) delete c.cat;
    if(typeof c.date!=='string' || !ISO.test(c.date)) delete c.date;
    if(c.paid!==true) delete c.paid;
    return c; });
  if(t.costCats!=null){ const kids = new Set(); t.costCats = list(t.costCats).filter(c => typeof c.id==='string' && c.id && !kids.has(c.id) && kids.add(c.id)).map(c => { c.name = text(c.name); return c; }); }
  return cleanActivities(t, newId);
}
