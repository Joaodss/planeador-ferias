/* Modelo de uma viagem: dias, horário do quadro, sítios e atividades.
   Todas as funções recebem a viagem t: quem chama na interface passa T(). */
import { I18N, tr } from './i18n.js';
import { parseISO, iso, addDays, newId, mlabel, MON } from './util.js';
import { view, dayShift, absStart, addISO, frameShift, toFrame, fromFrame, dateAt } from './span.js';
import { viewOffset } from './tz.js';
import { cleanTrip } from './clean.js';

export { view, boardLayout } from './span.js';

/* Preenche o que falta nos dados antigos e limpa o que vem malformado do servidor ou de uma importação (clean.js). */
export function normTrip(t){ return cleanTrip(t, newId); }
export function days(t){ const out=[]; if(!t) return out; let d=parseISO(t.start); const e=parseISO(t.end); while(d<=e && out.length<120){ out.push(iso(d)); d=addDays(d,1);} return out; }
/* "22:00–06:00 +1": o +N conta as meias-noites atravessadas. */
export function rangeLabel(b){ const n=dayShift(b); return `${mlabel(b.start)}–${mlabel(b.start+b.len)}${n?' +'+n:''}`; }
/* Valor v na moeda da viagem t (€ se não houver viagem). Um formatador por língua: toLocaleString criava
   um Intl.NumberFormat novo em cada chamada (~50× mais lento). */
const numFmts = {};
export function money(t, v){ const cur=(t&&t.currency)||'€', L=I18N.locale;
  const n=(numFmts[L] || (numFmts[L]=new Intl.NumberFormat(L,{maximumFractionDigits:2}))).format(Math.round(v*100)/100);
  return cur==='€' && I18N.lang==='pt' ? n+' €' : cur+n; }
export function blockCostPP(t, b){ return (b.pp||0) + (b.total ? b.total/Math.max(1,t.people||1) : 0); }

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
   F={ds, d0, sh, off}: colunas a mostrar (dias no fuso do quadro, a começar em d0) e deslocamento sh (ver span.js).
   Na hora da viagem: ds=days(t), sh=off=0 e as conversões não mexem em nada. */
export function boardFrame(t){
  const ds=days(t), off=viewOffset(t); if(!off || !ds.length) return {ds, d0:ds[0], sh:0, off:0};
  const {T0}=view(t), sh0=frameShift(t,off,ds[0]); let a=0, z=ds.length-1;
  // dias antes ou depois da viagem só aparecem se alguma atividade começar lá, na hora do quadro;
  // até dois de cada lado: diferenças até ±26 h somadas a dayStart podem empurrar uma atividade dois dias
  const EXTRA=2, inTrip=new Set(ds);
  for(const b of t.blocks) if(inTrip.has(b.date)){ const i=Math.floor((absStart(t,b)+sh0-T0)/1440); a=Math.max(-EXTRA,Math.min(a,i)); z=Math.min(ds.length-1+EXTRA,Math.max(z,i)); }
  const out=[]; for(let i=a;i<=z;i++) out.push(addISO(ds[0],i));
  return {ds:out, d0:out[0], sh:frameShift(t,off,out[0]), off};
}
/* Dia e hora em que a atividade aparece no quadro. */
export function toBoard(t,F,b){ return F.off ? toFrame(t,b,F.sh,F.d0) : {date:b.date, start:b.start}; }
/* Dia e hora do quadro → date/start a guardar (hora da viagem). */
export function fromBoard(t,F,date,start){ return F.off ? fromFrame(t,date,start,F.sh,F.d0) : {date, start}; }

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
    t.dayPlaces[d]=t.dayPlaces[d].filter(p=>p!==id);
    if(!t.dayPlaces[d].length) delete t.dayPlaces[d];
  }
  for(const b of t.blocks.concat(t.tray)) if(b.place===id) delete b.place;
}
/* Painel do dia, "Aplicar": o sítio p1 de from até until (inclusive; until vazio = só from).
   O segundo sítio p2 (para onde se vai durante o dia) só fica no último dia do intervalo. Sem p1 nem p2, limpa.
   Devolve true quando p2 ficou só no último dia de um intervalo com mais de um dia (a página avisa). */
export function setDayPlaces(t, from, until, p1, p2){
  const ds=days(t), i=ds.indexOf(from), j=until ? ds.indexOf(until) : i;
  for(let k=i;k<=j;k++){
    const arr=[];
    if(p1) arr.push(p1);
    if(p2 && p2!==p1 && k===j) arr.push(p2);
    if(arr.length) t.dayPlaces[ds[k]]=arr; else delete t.dayPlaces[ds[k]];
  }
  return !!(p2 && j>i && p2!==p1);
}

/* ---------- cabeçalho do quadro ---------- */
/* Os sítios por onde a viagem passa, pela ordem dos dias e sem repetir o mesmo sítio seguido. */
export function routeSummary(t){
  const seq=[];
  for(const d of days(t)) for(const p of t.dayPlaces[d]||[]) if(seq[seq.length-1]!==p) seq.push(p);
  return seq;
}
/* "5–8 jul 2027" no mesmo mês, "30 jun – 2 jul 2027" em meses diferentes. */
export function dateRangeLabel(t){
  const s0=parseISO(t.start), s1=parseISO(t.end), M=MON();
  if(s0.getMonth()===s1.getMonth() && s0.getFullYear()===s1.getFullYear()) return `${s0.getDate()}–${s1.getDate()} ${M[s1.getMonth()]} ${s1.getFullYear()}`;
  return `${s0.getDate()} ${M[s0.getMonth()]} – ${s1.getDate()} ${M[s1.getMonth()]} ${s1.getFullYear()}`;
}
