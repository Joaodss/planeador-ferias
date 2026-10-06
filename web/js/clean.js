/* Limpeza dos dados de uma viagem que vêm do servidor ou de uma cópia importada.
   O servidor não conhece o esquema da viagem, por isso o cliente é a única barreira contra dados malformados:
   uma atividade sem data partia o quadro em todos os dispositivos e um estado com HTML entrava na página.
   Módulo puro (testado em tests/clean.test.mjs); normTrip (trip.js) chama-o com newId. */
import { TZ } from './tz.js';

/* IDs guardados (em português de propósito): nunca mudar o nome, só a tradução. */
export const STATUSES = ['ideia', 'reservar', 'reservado', 'pago'];
export const KINDS = ['tour', 'party', 'transport', 'food', 'rest', 'sleep'];

/* Sítios de um dia no máximo: onde começam, as paragens pelo caminho e onde acabam. */
export const MAX_DAY_PLACES = 12;
/* Data AAAA-MM-DD e identificador (o mesmo que o servidor aceita no caminho). backup.js também os usa. */
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

/* A viagem toda menos id, name, start, end e tz (validados à parte). */
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
