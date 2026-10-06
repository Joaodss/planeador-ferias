/* Ajudas de DOM partilhadas pela interface: seletor, avisos, tamanho do ecrã, escala da grelha e selects de fuso. */
import { tr, I18N } from '../i18n.js';
import { esc } from '../util.js';
import { tzOptions, tzFilter, tzMatch } from '../tz.js';
export const $ = s => document.querySelector(s);
export const isMobile = () => matchMedia('(max-width:640px)').matches;

/* Altura de 30 min na grelha (vem do CSS --slot). render() volta a lê-la com refreshSlot() antes de desenhar. */
let SLOT = 24;
export function refreshSlot(){ SLOT = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--slot')) || 24; }
export function pxPerMin(){ return SLOT/30; }

/* ---------- avisos ao utilizador ---------- */
/* Um aviso fica à vista 4,2 s: dá para ler uma frase curta sem tapar o quadro muito tempo. */
const TOAST_MS=4200;
let toastT=null;
export function toast(m){ const t=$('#toast'); t.textContent=m; t.hidden=false; clearTimeout(toastT); toastT=setTimeout(()=>t.hidden=true, TOAST_MS); }
export function announce(m){ $('#announce').textContent=m; }

/* ---------- selects de fuso ---------- */
/* As opções de cada select de fuso (o select → {first, opts}), para a pesquisa as voltar a filtrar. */
const tzLists=new WeakMap();
/* A caixa de pesquisa de um select de fuso tem o id dele com "-q" (index.html). */
const tzSearchBox = el => document.getElementById(el.id+'-q');

/* Enche um select de fusos como os outros dropdowns (#43): primeiro a opção first (valor ''),
   depois os fusos pela diferença para GMT na data date (tzOptions em tz.js). Fica escolhido cur e a pesquisa vazia. */
export function fillTzSelect(el, first, cur, date){
  tzLists.set(el, {first, opts:tzOptions(cur, date, I18N.lang)});
  const q=tzSearchBox(el); if(q) q.value='';
  drawTz(el, '', cur||'');
}
/* Escreve as opções que servem para query, sem perder a escolhida (cur). */
function drawTz(el, query, cur){
  const {first, opts}=tzLists.get(el), shown=tzFilter(opts, query, cur);
  el.innerHTML=`<option value="">${esc(first)}</option>`+shown.map(z=>`<option value="${esc(z.tz)}">${esc(z.label)}</option>`).join('')
    +(shown.some(z=>z.tz!==cur) ? '' : `<option value="" disabled>${esc(tr('tzNoMatch'))}</option>`);
  el.value=cur;
}
/* Liga a caixa de pesquisa ao select de fuso el (o init… do painel chama-a uma vez): escrever filtra a lista pela
   cidade, país ou diferença para GMT, e Enter escolhe a primeira que serve (com um evento change, como no select). */
export function linkTzSearch(el){
  const q=tzSearchBox(el);
  q.addEventListener('input',()=>{ if(tzLists.has(el)) drawTz(el, q.value, el.value); });
  q.addEventListener('keydown',e=>{
    if(e.key!=='Enter') return;
    e.preventDefault();   // no painel da viagem, Enter gravava o formulário
    if(!q.value.trim()) return;   // sem pesquisa todas servem: Enter escolheria a primeira da lista sem querer
    const hit=tzLists.get(el)?.opts.find(o=>tzMatch(o, q.value));
    if(!hit || hit.tz===el.value) return;
    el.value=hit.tz; el.dispatchEvent(new Event('change', {bubbles:true}));
  });
}
