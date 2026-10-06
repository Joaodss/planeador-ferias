/* Utilitários puros (sem DOM): texto, datas e horas. O que mexe na página está em ui/dom.js. */
import { tr } from './i18n.js';

/** Número com dois dígitos: 7 → "07".
    @type {(n: number) => string} */
export const pad = n => String(n).padStart(2,'0');
/** Escapa & < > " para pôr texto livre (nomes, títulos, notas) dentro de innerHTML. É a única barreira contra
   HTML injetado, por isso a regra tem de se cumprir: serve para texto entre tags e para valores de atributos
   entre aspas DUPLAS (title="${esc(x)}"). Não escapa a aspa simples, por isso nunca num atributo entre aspas
   simples, nem dentro de um URL (href, src), de JavaScript (onclick, <script>) ou de CSS: aí é preciso outra coisa.
   @type {(s: any) => string} */
export const esc = s => String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
/* Data + contador + 4 caracteres aleatórios. O contador separa os ids criados no mesmo milissegundo
   (só com a parte aleatória, 10 000 seguidos repetiam-se sempre); a parte aleatória separa os de dispositivos diferentes. */
let idSeq=0;
/** @param {string} [p]  prefixo: 'a' atividade, 'p' sítio, 'c' custo, 't' viagem
    @returns {string} id que cumpre ID (clean.js) */
export function newId(p){ return (p||'n')+Date.now().toString(36)+(idSeq++).toString(36)+Math.random().toString(36).slice(2,6); }
/** Nome de um sítio sem o que vem depois de " ·" ("Lisboa · Hotel Avenida" → "Lisboa"), para o cabeçalho e o percurso.
   @param {string} n
   @returns {string} */
export function shortPlaceName(n){ return n.split(' ·')[0]; }
/** Passo da grelha, em minutos: arrastar, as setas e as horas do editor andam de 15 em 15. */
export const SNAP = 15;

/** Textos que dependem da língua: nomes curtos dos dias (0 = domingo), dos meses (0 = janeiro),
   dos tipos de atividade (Kind → nome) e dos estados (Status → nome). */
export const weekdayNames = () => tr('wd'), monthNames = () => tr('mon'), kindLabels = () => tr('cats'), statusLabels = () => tr('status');
/** Nome do estado, ou '' se não for um dos conhecidos: só o enum entra no HTML e nas classes (st-…).
   @type {(s: unknown) => string} */
export const statusLabel = s => typeof s==='string' && Object.hasOwn(statusLabels(), s) ? statusLabels()[s] : '';
/** "à segunda", "ao sábado" (on Monday).
    @type {(w: number) => string} w: dia da semana, 0 = domingo */
export const onWeekday = w => tr('onDay',{w});
/** Os dias da semana numa frase, de segunda a domingo: [6, 1] → "à segunda e ao sábado".
    @type {(ws: number[]) => string} */
export const daysPhrase = ws => ws.slice().sort((x,y)=>((x||7)-(y||7))).map(onWeekday).join(', ').replace(/, ([^,]*)$/,' '+tr('and')+' $1');

/* ---------- dates & times ----------
   Duas convenções de propósito: aqui as datas são Date em hora LOCAL (meia-noite do dia no fuso do browser),
   que dão o dia da semana e o mês certos para os rótulos. Para contar dias, span.js usa UTC (utc, addISO,
   dayIndex): em hora local um dia da mudança de hora tem 23 ou 25 h e a divisão por 24 h falhava. */
/** @type {(s: string) => Date} "AAAA-MM-DD" → meia-noite local desse dia */
export const parseISO = s => { const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); };
/** @type {(d: Date) => string} o dia local de d, como "AAAA-MM-DD" */
export const iso = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
/** @type {(d: Date, n: number) => Date} n dias de calendário depois (em hora local) */
export const addDays = (d,n) => { const x=new Date(d); x.setDate(x.getDate()+n); return x; };
/* Minutos → "HH:MM" no relógio (1500 → "01:00") e duração em minutos → "1h30", "2h" ou "45 min". */
/** @type {(m: number) => string} m: minutos do dia, qualquer valor (negativo ou ≥ 1440 dá a volta) */
export const clockLabel = m => { const x=((m%1440)+1440)%1440; return pad(Math.floor(x/60))+':'+pad(x%60); };
/** @type {(n: number) => string} n: duração em minutos */
export const durationLabel = n => { const h=Math.floor(n/60), m=n%60; return h ? (m? `${h}h${pad(m)}` : `${h}h`) : `${m} min`; };
/** "Sáb 12" ou, com withMonth, "Sáb 12 jul".
    @param {string} date  "AAAA-MM-DD"
    @param {boolean} [withMonth]
    @returns {string} */
export function dayLabel(date, withMonth){ const d=parseISO(date); return `${weekdayNames()[d.getDay()]} ${d.getDate()}${withMonth?' '+monthNames()[d.getMonth()]:''}`; }
