/* Painel "Pontos a rever": lista os avisos calculados no último render. */
import { tr } from '../i18n.js';
import { $, esc, isMobile } from '../util.js';
import { S } from '../state.js';
import { closeSheets } from './sheets.js';
import { focusBlock } from './board.js';

export function renderWarnings(){
  const box=$('#w-list'); box.innerHTML='';
  if(!S.lastWarnings.length){ box.innerHTML=`<div class="empty-ok">${tr('warnOk')}</div>`; return; }
  box.insertAdjacentHTML('beforeend',`<p class="hint">${tr('warnHint')}</p>`);
  S.lastWarnings.slice().sort((a,b)=>String(a.date).localeCompare(String(b.date))||(a.sev==='bad'?-1:1)).forEach(w=>{
    const it=document.createElement('button'); it.type='button'; it.className='warn-item'+(w.sev==='bad'?' bad':'');
    it.innerHTML=`<span class="sev"></span><span><div class="wt">${esc(w.t)}</div><div class="wd">${esc(w.d)}</div></span>`;
    it.addEventListener('click',()=>{ if(isMobile()) $('#warnings').hidden=true; focusBlock(w.ids[0]); });
    box.appendChild(it);
  });
}
$('#warn-btn').addEventListener('click',()=>{ const w=$('#warnings'); if(!w.hidden){ w.hidden=true; return; } closeSheets(); renderWarnings(); w.hidden=false; w.querySelector('[data-close]').focus(); });
