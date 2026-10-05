/* Modelo de uma viagem: dias, horário do quadro, sítios e atividades. */
import { I18N } from './i18n.js';
import { parseISO, iso, addDays, newId, mlabel } from './util.js';
import { T } from './state.js';
import { view, dayShift, absStart, addISO, frameShift, toFrame, fromFrame } from './span.js';
import { viewOffset } from './tz.js';
import { cleanTrip } from './clean.js';

export { view, boardLayout } from './span.js';

/* Preenche o que falta nos dados antigos e limpa o que vem malformado do servidor ou de uma importação (clean.js). */
export function normTrip(t){ return cleanTrip(t, newId); }
export function days(t){ const out=[]; if(!t) return out; let d=parseISO(t.start); const e=parseISO(t.end); while(d<=e && out.length<120){ out.push(iso(d)); d=addDays(d,1);} return out; }
/* "22:00–06:00 +1": o +N conta as meias-noites atravessadas. */
export function rangeLabel(b){ const n=dayShift(b); return `${mlabel(b.start)}–${mlabel(b.start+b.len)}${n?' +'+n:''}`; }
/* Um formatador por língua: toLocaleString criava um Intl.NumberFormat novo em cada chamada (~50× mais lento). */
const numFmts = {};
export function fmt(v){ const t=T(); const cur=(t&&t.currency)||'€', L=I18N.locale;
  const n=(numFmts[L] || (numFmts[L]=new Intl.NumberFormat(L,{maximumFractionDigits:2}))).format(Math.round(v*100)/100);
  return cur==='€' && I18N.lang==='pt' ? n+' €' : cur+n; }
export function blockCostPP(b){ const t=T(); return (b.pp||0) + (b.total ? b.total/Math.max(1,t.people||1) : 0); }

/* ---------- sítios ---------- */
export function placeById(id){ const t=T(); return t && t.places.find(p=>p.id===id); }
export function placeName(id){ const p=placeById(id); return p ? p.name : ''; }
export function addPlace(name){ const t=T(); name=name.trim(); if(!name) return null; const ex=t.places.find(p=>p.name.toLowerCase()===name.toLowerCase()); if(ex) return ex;
  const used=t.places.map(p=>p.c); let c=1; while(used.includes(c) && c<8) c++; if(used.includes(c)) c=(t.places.length%8)+1;
  const p={id:newId('p'), name, c}; t.places.push(p); return p; }

/* ---------- lookup / mutate ---------- */
export function findBlock(id){ const t=T(); if(!t) return null; let b=t.blocks.find(x=>x.id===id); if(b) return {b,where:'grid'}; b=t.tray.find(x=>x.id===id); return b?{b,where:'tray'}:null; }
export function blocksOf(date){ return T().blocks.filter(b=>b.date===date).sort((a,b)=>a.start-b.start||b.len-a.len); }
/* O horário do quadro é só o que se vê: a atividade pode começar a qualquer hora e durar vários dias. */
export function moveTo(id,date,start){ const t=T(), f=findBlock(id); if(!f) return; const b=f.b;
  if(f.where==='tray'){ t.tray=t.tray.filter(x=>x!==b); t.blocks.push(b); }
  b.date=date; b.start=Math.max(0,start); }
export function toTray(id){ const t=T(), f=findBlock(id); if(!f||f.where==='tray') return; t.blocks=t.blocks.filter(x=>x!==f.b); delete f.b.date; delete f.b.start; t.tray.push(f.b); }

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
