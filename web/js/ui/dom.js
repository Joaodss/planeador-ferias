/* Ajudas de DOM partilhadas pela interface: seletor, avisos, tamanho do ecrã e escala da grelha. */
export const $ = s => document.querySelector(s);
export const isMobile = () => matchMedia('(max-width:640px)').matches;

/* Altura de 30 min na grelha (vem do CSS --slot). render() volta a lê-la com refreshSlot() antes de desenhar. */
let SLOT = 24;
export function refreshSlot(){ SLOT = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--slot')) || 24; }
export function PXM(){ return SLOT/30; }

/* ---------- avisos ao utilizador ---------- */
let toastT=null;
export function toast(m){ const t=$('#toast'); t.textContent=m; t.hidden=false; clearTimeout(toastT); toastT=setTimeout(()=>t.hidden=true, 4200); }
export function announce(m){ $('#announce').textContent=m; }
