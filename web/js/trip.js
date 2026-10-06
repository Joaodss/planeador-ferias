/* Modelo de uma viagem: dias, horário do quadro, sítios e atividades.
   Todas as funções recebem a viagem t: quem chama na interface passa activeTrip(). */
import { I18N, tr } from './i18n.js';
import { parseISO, iso, addDays, newId, clockLabel, monthNames } from './util.js';
import { boardHours, dayShift, dayIndex, absStart, addISO, frameShift, toFrame, fromFrame, dateAt } from './span.js';
import { TZ, viewOffset, homeTz } from './tz.js';
import { cleanTrip } from './clean.js';

export { boardHours, boardLayout } from './span.js';

/* Preenche o que falta nos dados antigos e limpa o que vem malformado do servidor ou de uma importação (clean.js). */
export function normTrip(t){ return cleanTrip(t, newId); }
export function tripDates(t){ const out=[]; if(!t) return out; let d=parseISO(t.start); const e=parseISO(t.end); while(d<=e && out.length<120){ out.push(iso(d)); d=addDays(d,1);} return out; }
/* "22:00–06:00 +1": o +N conta as meias-noites atravessadas. */
export function rangeLabel(b){ const n=dayShift(b); return `${clockLabel(b.start)}–${clockLabel(b.start+b.len)}${n?' +'+n:''}`; }
/* Valor v na moeda da viagem t (€ se não houver viagem). Um formatador por língua: toLocaleString criava
   um Intl.NumberFormat novo em cada chamada (~50× mais lento). */
const numFmts = {};
export function money(t, v){ const cur=(t&&t.currency)||'€', L=I18N.locale;
  const n=(numFmts[L] || (numFmts[L]=new Intl.NumberFormat(L,{maximumFractionDigits:2}))).format(Math.round(v*100)/100);
  return cur==='€' && I18N.lang==='pt' ? n+' €' : cur+n; }

/* ---------- sítios ---------- */
export function placeById(t, id){ return t && t.places.find(p=>p.id===id); }
export function placeName(t, id){ const p=placeById(t,id); return p ? p.name : ''; }
export function addPlace(t, name){ name=name.trim(); if(!name) return null; const ex=t.places.find(p=>p.name.toLowerCase()===name.toLowerCase()); if(ex) return ex;
  const used=t.places.map(p=>p.c); let c=1; while(used.includes(c) && c<8) c++; if(used.includes(c)) c=(t.places.length%8)+1;
  const p={id:newId('p'), name, c}; t.places.push(p); return p; }

/* ---------- lookup / mutate ---------- */
export function findBlock(t, id){ if(!t) return null; let b=t.blocks.find(x=>x.id===id); if(b) return {b,where:'grid'}; b=t.tray.find(x=>x.id===id); return b?{b,where:'tray'}:null; }
export function blocksOf(t, date){ return t.blocks.filter(b=>b.date===date).sort((a,b)=>a.start-b.start||b.len-a.len); }
/* O horário do quadro é só o que se vê: a atividade pode começar a qualquer hora e durar vários dias. */
export function moveTo(t, id, date, start){ const f=findBlock(t,id); if(!f) return; const b=f.b;
  if(f.where==='tray'){ t.tray=t.tray.filter(x=>x!==b); t.blocks.push(b); }
  b.date=date; b.start=Math.max(0,start); }
export function toTray(t, id){ const f=findBlock(t,id); if(!f||f.where==='tray') return; t.blocks=t.blocks.filter(x=>x!==f.b); delete f.b.date; delete f.b.start; t.tray.push(f.b); }

/* ---------- quadro noutro fuso ----------
   As atividades guardam-se sempre na hora da viagem; o quadro pode estar no segundo fuso (viewOffset em tz.js).
   frame={dates, firstDate, shiftMin, offsetMin}: as colunas a mostrar (dias no fuso do quadro, a começar em firstDate),
   o deslocamento shiftMin (ver frameShift em span.js) e offsetMin, os minutos que o fuso do quadro está à frente da hora da viagem.
   Na hora da viagem: dates=tripDates(t), shiftMin=offsetMin=0 e as conversões não mexem em nada. */
export function boardFrame(t){
  const ds=tripDates(t), off=viewOffset(t); if(!off || !ds.length) return {dates:ds, firstDate:ds[0], shiftMin:0, offsetMin:0};
  const {from}=boardHours(t), sh0=frameShift(t,off,ds[0]); let a=0, z=ds.length-1;
  // dias antes ou depois da viagem só aparecem se alguma atividade começar lá, na hora do quadro;
  // até dois de cada lado: diferenças até ±26 h somadas a dayStart podem empurrar uma atividade dois dias
  const EXTRA=2, inTrip=new Set(ds);
  for(const b of t.blocks) if(inTrip.has(b.date)){ const i=Math.floor((absStart(t,b)+sh0-from)/1440); a=Math.max(-EXTRA,Math.min(a,i)); z=Math.min(ds.length-1+EXTRA,Math.max(z,i)); }
  const out=[]; for(let i=a;i<=z;i++) out.push(addISO(ds[0],i));
  return {dates:out, firstDate:out[0], shiftMin:frameShift(t,off,out[0]), offsetMin:off};
}
/* Dia e hora em que a atividade aparece no quadro. */
export function toBoard(t,frame,b){ return frame.offsetMin ? toFrame(t,b,frame.shiftMin,frame.firstDate) : {date:b.date, start:b.start}; }
/* Dia e hora do quadro → date/start a guardar (hora da viagem). */
export function fromBoard(t,frame,date,start){ return frame.offsetMin ? fromFrame(t,date,start,frame.shiftMin,frame.firstDate) : {date, start}; }

/* ---------- fuso de uma atividade ----------
   Uma atividade pode ter um fuso seu, b.tz (ex.: a partida de um voo). date/start guardam-se sempre na hora da viagem:
   o fuso só muda como o editor mostra e lê o dia e a hora, e a hora local que o bloco mostra no quadro.
   off: minutos que o fuso da atividade está à frente da hora da viagem, ao meio-dia UTC do dia (TZ.diff). */
/* Dia e hora (de relógio, start < 1440) da atividade b no seu fuso, com off; null sem fuso, sem dia ou sem fuso da viagem. */
export function toZone(t, b){
  if(!b.tz || b.date==null) return null;
  const off=TZ.diff(t.tz, b.tz, b.date);
  if(off===null) return null;
  const A=absStart(t,b)+off, i=Math.floor(A/1440);
  return {date:addISO(t.start,i), start:A-i*1440, off};
}
/* O contrário: dia e hora no fuso tz → date/start a guardar. A diferença conta-se no dia da viagem a que se chega:
   se esse dia tiver outra diferença (mudança de hora pelo meio), volta a converter com ela. */
export function fromZone(t, tz, date, start){
  const A=dayIndex(t,date)*1440+start, off=TZ.diff(t.tz, tz, date)||0;
  const p=dateAt(t, A-off), off2=TZ.diff(t.tz, tz, p.date)||0;
  return off2===off ? p : dateAt(t, A-off2);
}
/* Dia e hora que o editor mostra: no fuso da atividade, se tiver um (e a viagem também), senão na hora do quadro. */
export function editorTime(t, frame, b){ return toZone(t,b) || toBoard(t,frame,b); }
/* O contrário: o dia e a hora escolhidos no editor → date/start a guardar. */
export function fromEditor(t, frame, b, date, start){
  return b.tz && TZ.diff(t.tz, b.tz, date)!==null ? fromZone(t, b.tz, date, start) : fromBoard(t, frame, date, start);
}
/* Hora local para o bloco no quadro (frame: boardFrame), quando o fuso da atividade não é o do quadro.
   {tz, start, len, days}: days é quantos dias o relógio do fuso está à frente do dia do quadro. null quando não há nada a mostrar. */
export function blockZoneTime(t, frame, b){
  const z=toZone(t,b);
  if(!z || z.off===frame.offsetMin || b.tz===(frame.offsetMin ? homeTz() : t.tz)) return null;
  const boardPos=toBoard(t,frame,b), days=dayIndex(t,z.date)-dayIndex(t,boardPos.date)-Math.floor(boardPos.start/1440);
  return {tz:b.tz, start:z.start, len:b.len, days};
}

/* ---------- alterações feitas nos painéis ---------- */
/* Atividade nova (por agendar, ou no dia e hora de where={date, start}), com os valores por omissão. */
export function newBlock(where, newId){ return {id:newId('a'), ...where, len:60, title:tr('newActivity'), cat:'tour', status:'ideia'}; }
/* Cópia da atividade id, logo a seguir à original (ou em "por agendar", se a original lá estiver). Não fica bloqueada.
   Pode cair fora das datas da viagem: aí aparece o aviso próprio. Devolve a cópia, ou null se id não existir. */
export function duplicateBlock(t, id, newId){
  const f=findBlock(t,id);
  if(!f) return null;
  const c=structuredClone(f.b);
  c.id=newId('a');
  delete c.locked;
  if(f.where==='tray') t.tray.push(c);
  else { Object.assign(c, dateAt(t, absStart(t,f.b)+f.b.len)); t.blocks.push(c); }
  return c;
}
/* Tira o sítio id da viagem, dos dias onde estava e das atividades (na grelha e por agendar). */
export function removePlace(t, id){
  t.places=t.places.filter(p=>p.id!==id);
  for(const d of Object.keys(t.dayPlaces)){
    t.dayPlaces[d]=noRepeats(t.dayPlaces[d].filter(p=>p!==id));
    if(!t.dayPlaces[d].length) delete t.dayPlaces[d];
  }
  for(const b of t.blocks.concat(t.tray)) if(b.place===id) delete b.place;
}
/* Os sítios de um dia são [onde começam, paragens pelo caminho…, onde acabam] (uma viagem de carro passa por vários).
   Sem vazios nem o mesmo sítio duas vezes seguidas. */
function noRepeats(ids){ const out=[]; for(const p of ids) if(p && p!==out[out.length-1]) out.push(p); return out; }
/* A lista de um dia separada como no painel do dia: first, as paragens do meio e last ('' quando não há). */
export function splitDayPlaces(list){
  const a=list||[];
  return {first:a[0]||'', stops:a.slice(1,-1), last:a.length>1 ? a[a.length-1] : ''};
}
/* O que o cabeçalho do dia mostra: só onde começam e onde acabam. As paragens do meio ficam na dica. */
export function dayEnds(list){
  const a=list||[];
  if(a.length<2 || a[0]===a[a.length-1]) return a.slice(0,1);
  return [a[0], a[a.length-1]];
}
/* Painel do dia, "Aplicar": o sítio first de from até until (inclusive; until vazio = só from).
   later são os sítios por onde passam durante o dia (as paragens e, no fim, onde acabam): só ficam no último dia
   do intervalo. Sem sítios, limpa. Devolve true quando later ficou só no último dia de um intervalo com mais
   de um dia (a página avisa). */
export function setDayPlaces(t, from, until, first, later=[]){
  const ds=tripDates(t), i=ds.indexOf(from), j=until ? ds.indexOf(until) : i;
  const day=noRepeats([first]), end=noRepeats([first, ...later]);
  for(let k=i;k<=j;k++){
    const arr=k===j ? end : day;
    if(arr.length) t.dayPlaces[ds[k]]=arr.slice(); else delete t.dayPlaces[ds[k]];
  }
  return j>i && end.length>day.length;
}

/* ---------- cabeçalho do quadro ---------- */
/* Os sítios por onde a viagem passa, pela ordem dos dias e sem repetir o mesmo sítio seguido. */
export function routeSummary(t){
  const seq=[];
  for(const d of tripDates(t)) for(const p of t.dayPlaces[d]||[]) if(seq[seq.length-1]!==p) seq.push(p);
  return seq;
}
/* "5–8 jul 2027" no mesmo mês, "30 jun – 2 jul 2027" em meses diferentes. */
export function dateRangeLabel(t){
  const s0=parseISO(t.start), s1=parseISO(t.end), M=monthNames();
  if(s0.getMonth()===s1.getMonth() && s0.getFullYear()===s1.getFullYear()) return `${s0.getDate()}–${s1.getDate()} ${M[s1.getMonth()]} ${s1.getFullYear()}`;
  return `${s0.getDate()} ${M[s0.getMonth()]} – ${s1.getDate()} ${M[s1.getMonth()]} ${s1.getFullYear()}`;
}
