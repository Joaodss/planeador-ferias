/* Ajudas de DOM partilhadas pela interface: seletor, avisos, tamanho do ecrã, escala da grelha e selects de fuso. */
import { tr } from '../i18n.js';
import { esc } from '../util.js';
import { tzGroups } from '../tz.js';
export const $ = s => document.querySelector(s);
export const isMobile = () => matchMedia('(max-width:640px)').matches;

/* Altura de 30 min na grelha (vem do CSS --slot). render() volta a lê-la com refreshSlot() antes de desenhar. */
let SLOT = 24;
export function refreshSlot(){ SLOT = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--slot')) || 24; }
export function pxPerMin(){ return SLOT/30; }

/* ---------- avisos ao utilizador ---------- */
let toastT=null;
export function toast(m){ const t=$('#toast'); t.textContent=m; t.hidden=false; clearTimeout(toastT); toastT=setTimeout(()=>t.hidden=true, 4200); }
export function announce(m){ $('#announce').textContent=m; }

/* ---------- selects de fuso ---------- */
/* Enche um select de fusos como os outros dropdowns (#43): primeiro a opção first (valor ''),
   depois os fusos por região (tzGroups em tz.js). Fica escolhido cur. */
export function fillTzSelect(el, first, cur){
  const R=tr('tzRegions');
  el.innerHTML=`<option value="">${esc(first)}</option>`+tzGroups(cur).map(g=>{
    const o=g.zones.map(z=>`<option value="${esc(z.tz)}">${esc(z.label)}</option>`).join('');
    return g.region ? `<optgroup label="${esc(R[g.region]||g.region)}">${o}</optgroup>` : o;
  }).join('');
  el.value=cur||'';
}
