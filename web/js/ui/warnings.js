/* Painel "Pontos a rever": lista os avisos calculados no último render. */
import { tr } from '../i18n.js';
import { esc } from '../util.js';
import { $, isMobile } from './dom.js';
import { S } from '../state.js';
import { sortWarnings } from '../warnings.js';
import { closeSheets } from './sheets.js';
import { focusBlock } from './board.js';

export function renderWarnings(){
  const box=$('#w-list'); box.innerHTML='';
  if(!S.lastWarnings.length){ box.innerHTML=`<div class="empty-ok">${tr('warnOk')}</div>`; return; }
  box.insertAdjacentHTML('beforeend',`<p class="hint">${tr('warnHint')}</p>`);
  sortWarnings(S.lastWarnings).forEach(w=>{
    const it=document.createElement('button'); it.type='button'; it.className='warn-item'+(w.sev==='bad'?' bad':'');
    it.innerHTML=`<span class="sev"></span><span><div class="wt">${esc(w.title)}</div><div class="wd">${esc(w.detail)}</div></span>`;
    it.addEventListener('click',()=>{ if(isMobile()) $('#warnings').hidden=true; focusBlock(w.ids[0]); });
    box.appendChild(it);
  });
}
/* Botão dos pontos a rever (main.js chama-a uma vez ao arrancar). */
export function initWarnings(){
  $('#warn-btn').addEventListener('click',()=>{ const w=$('#warnings'); if(!w.hidden){ w.hidden=true; return; } closeSheets(); renderWarnings(); w.hidden=false; w.querySelector('[data-close]').focus(); });
}
