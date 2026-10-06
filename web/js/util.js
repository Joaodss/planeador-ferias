/* Utilitários puros (sem DOM): texto, datas e horas. O que mexe na página está em ui/dom.js. */
import { tr } from './i18n.js';

export const pad = n => String(n).padStart(2,'0');
export const esc = s => String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
/* Data + contador + 4 caracteres aleatórios. O contador separa os ids criados no mesmo milissegundo
   (só com a parte aleatória, 10 000 seguidos repetiam-se sempre); a parte aleatória separa os de dispositivos diferentes. */
let idSeq=0;
export function newId(p){ return (p||'n')+Date.now().toString(36)+(idSeq++).toString(36)+Math.random().toString(36).slice(2,6); }
export function short(n){ return n.split(' ·')[0]; }
export const SNAP = 15;

/* Textos que dependem da língua. */
export const WD = () => tr('wd'), MON = () => tr('mon'), kindLabels = () => tr('cats'), STATUS = () => tr('status');
/* Nome do estado, ou '' se não for um dos conhecidos: só o enum entra no HTML e nas classes (st-…). */
export const statusLabel = s => typeof s==='string' && Object.hasOwn(STATUS(), s) ? STATUS()[s] : '';
export const artDay = w => tr('onDay',{w});
export const daysPhrase = ws => ws.slice().sort((x,y)=>((x||7)-(y||7))).map(artDay).join(', ').replace(/, ([^,]*)$/,' '+tr('and')+' $1');

/* ---------- dates & times ---------- */
export const parseISO = s => { const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); };
export const iso = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
export const addDays = (d,n) => { const x=new Date(d); x.setDate(x.getDate()+n); return x; };
export const mlabel = m => { const x=((m%1440)+1440)%1440; return pad(Math.floor(x/60))+':'+pad(x%60); };
export const durLabel = n => { const h=Math.floor(n/60), m=n%60; return h ? (m? `${h}h${pad(m)}` : `${h}h`) : `${m} min`; };
export function dayLabel(date, withMonth){ const d=parseISO(date); return `${WD()[d.getDay()]} ${d.getDate()}${withMonth?' '+MON()[d.getMonth()]:''}`; }
