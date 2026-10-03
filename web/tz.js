/* Fusos horários.
   As horas do planeador são a hora local da viagem (o fuso escolhido em "Datas e sítios").
   Daqui sai só a conversão para um segundo fuso, mostrada ao lado na grelha. */
(function(g){
"use strict";

let ALL = [];
try{ ALL = Intl.supportedValuesOf('timeZone'); }catch(e){}

const fmts = {};
function fmt(tz){
  if(!fmts[tz]) fmts[tz] = new Intl.DateTimeFormat('en-US',{timeZone:tz, hourCycle:'h23', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit'});
  return fmts[tz];
}
function valid(tz){ if(!tz) return false; try{ fmt(tz); return true; }catch(e){ return false; } }
function local(){ try{ return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }catch(e){ return ''; } }

/* Diferença (minutos) entre a hora local de tz e UTC no instante ms. */
function offsetAt(tz, ms){
  const p = {}; for(const x of fmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  const asUTC = Date.UTC(+p.year, +p.month-1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - Math.floor(ms/1000)*1000) / 60000);
}

/* Quantos minutos o fuso b está à frente do fuso a, ao meio-dia (UTC) da data "AAAA-MM-DD". */
function diff(a, b, date){
  if(!valid(a) || !valid(b)) return null;
  const [y,m,d] = date.split('-').map(Number), ms = Date.UTC(y, m-1, d, 12);
  return offsetAt(b, ms) - offsetAt(a, ms);
}

/* "Asia/Tokyo" → "Tokyo"; "America/Argentina/Buenos_Aires" → "Buenos Aires". */
const city = tz => String(tz||'').split('/').pop().replace(/_/g,' ');

function diffLabel(min){
  if(!min) return '';
  const s = min<0?'−':'+', h = Math.floor(Math.abs(min)/60), m = Math.abs(min)%60;
  return s + h + (m ? ':' + String(m).padStart(2,'0') : '') + 'h';
}

g.TZ = {all: ALL, valid, local, offsetAt, diff, city, diffLabel};
})(typeof window !== 'undefined' ? window : globalThis);
