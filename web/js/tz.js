/* Fusos horários.
   As horas do planeador são a hora local da viagem (o fuso escolhido em "Datas e sítios").
   Daqui sai só a conversão para um segundo fuso, mostrada ao lado na grelha. */

let ALL = [];
try{ ALL = Intl.supportedValuesOf('timeZone'); }catch{}

const fmts = {};
function fmt(tz){
  if(!fmts[tz]) fmts[tz] = new Intl.DateTimeFormat('en-US',{timeZone:tz, hourCycle:'h23', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit'});
  return fmts[tz];
}
function valid(tz){ if(!tz) return false; try{ fmt(tz); return true; }catch{ return false; } }
function local(){ try{ return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }catch{ return ''; } }

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

export const TZ = {all: ALL, valid, local, offsetAt, diff, city, diffLabel};

/* ---------- segundo fuso ----------
   O segundo fuso aparece numa coluna de horas ao lado da grelha:
   o escolhido neste dispositivo, senão PLANNER_HOME_TZ, senão o do browser. */
const HOME_KEY='ferias-home-tz';
let serverHomeTz='';
export function setServerHomeTz(v){ serverHomeTz=v||''; }
export function defaultHomeTz(){ return valid(serverHomeTz) ? serverHomeTz : local(); }
export function ownHomeTz(){ try{ const v=localStorage.getItem(HOME_KEY)||''; return valid(v)?v:''; }catch{ return ''; } }
export function homeTz(){ return ownHomeTz() || defaultHomeTz(); }
/* Guarda o segundo fuso deste dispositivo (só se for diferente do valor por omissão). */
export function saveHomeTz(home){ try{ if(home && home!==defaultHomeTz()) localStorage.setItem(HOME_KEY,home); else localStorage.removeItem(HOME_KEY); }catch{} }
/* Segundo fuso da viagem t, ou null se não houver fuso da viagem ou se forem iguais. */
export function secondTz(t){
  const h=homeTz(); if(!t || !valid(t.tz) || !valid(h)) return null;
  const d=diff(t.tz,h,t.start); return d ? {tz:h, diff:d} : null;
}

/* ---------- quadro noutro fuso ----------
   Clicar numa cidade no canto da grelha mostra o quadro na hora desse fuso (escolha deste dispositivo).
   As atividades continuam guardadas na hora da viagem: só a vista muda. */
const VIEW_KEY='ferias-view-home';
export function viewingHome(){ try{ return localStorage.getItem(VIEW_KEY)==='1'; }catch{ return false; } }
export function setViewingHome(on){ try{ if(on) localStorage.setItem(VIEW_KEY,'1'); else localStorage.removeItem(VIEW_KEY); }catch{} }
/* Minutos que o fuso do quadro está à frente da hora da viagem (0 quando o quadro está na hora da viagem). */
export function viewOffset(t){ const s=viewingHome() && secondTz(t); return s ? s.diff : 0; }
/* Aceita "Asia/Tokyo", "asia/tokyo" ou só "Tokyo". Devolve '' se vazio e null se não reconhecer. */
export function resolveTz(v){
  v=v.trim(); if(!v) return '';
  const n=v.toLowerCase().replace(/\s+/g,'_');
  const hit=ALL.find(z=>z.toLowerCase()===n) || ALL.find(z=>z.toLowerCase().endsWith('/'+n));
  return hit || (valid(v) ? v : null);
}
