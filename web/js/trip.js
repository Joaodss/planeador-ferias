/* Modelo de uma viagem: dias, horário do quadro, sítios e atividades. */
import { I18N } from './i18n.js';
import { parseISO, iso, addDays, newId } from './util.js';
import { T } from './state.js';

export function normTrip(t){ t.places=t.places||[]; t.dayPlaces=t.dayPlaces||{}; t.blocks=t.blocks||[]; t.tray=t.tray||[]; t.people=t.people||1; t.currency=t.currency||'€'; if(t.dayStart==null) t.dayStart=7; if(t.dayEnd==null) t.dayEnd=1; return t; }
export function days(t){ const out=[]; if(!t) return out; let d=parseISO(t.start); const e=parseISO(t.end); while(d<=e && out.length<120){ out.push(iso(d)); d=addDays(d,1);} return out; }
export function view(t){ const T0=t.dayStart*60; const span=(((t.dayEnd - t.dayStart)+24)%24 || 24)*60; return {T0, span, T1:T0+span}; }
export function fmt(v){ const t=T(); const cur=(t&&t.currency)||'€'; const n=(Math.round(v*100)/100).toLocaleString(I18N.locale,{maximumFractionDigits:2}); return cur==='€' && I18N.lang==='pt' ? n+' €' : cur+n; }
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
export function moveTo(id,date,start){ const t=T(), f=findBlock(id); if(!f) return; const b=f.b; const v=view(t);
  if(f.where==='tray'){ t.tray=t.tray.filter(x=>x!==b); t.blocks.push(b); }
  b.date=date; b.start=Math.max(v.T0, Math.min(v.T1-b.len, start)); }
export function toTray(id){ const t=T(), f=findBlock(id); if(!f||f.where==='tray') return; t.blocks=t.blocks.filter(x=>x!==f.b); delete f.b.date; delete f.b.start; t.tray.push(f.b); }
