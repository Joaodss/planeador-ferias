/* Barra de ferramentas: trocar de viagem, desfazer, nova atividade, sono, língua e o indicador de gravação. */
import { I18N, tr } from '../i18n.js';
import { newId } from '../util.js';
import { $ } from './dom.js';
import { S, activeTrip, SLEEP_KEY, setActive, pushHistory } from '../state.js';
import { commit, undo, refreshSaveLabel } from '../sync.js';
import { render } from './board.js';
import { closeSheets } from './sheets.js';
import { openEditor, buildWdays } from './editor.js';
import { newBlock } from '../trip.js';
import { openTripSheet } from './tripsheet.js';

/* Indicador de gravação (sync.js chama-o com 'saving', 'error', 'dirty' ou 'saved' e o texto). */
export function showSaveState(s, txt){ $('#save').dataset.s=s; $('#save-txt').textContent=txt; }

export function initToolbar(){
  $('#trip-sel').addEventListener('change',e=>{ if(!e.target.value) return; if(e.target.value==='__new'){ e.target.value=''; openTripSheet({isNew:true}); return; } setActive(e.target.value); closeSheets(); render(); $('#scroller').scrollTo(0,0); });
  $('#undo').addEventListener('click',undo);
  $('#add').addEventListener('click',()=>{ const t=activeTrip(); if(!t){ openTripSheet({isNew:true}); return; } pushHistory(); const b=newBlock({}, newId); t.tray.push(b); commit(); openEditor(b.id,{isNew:true}); });
  $('#trip-settings').addEventListener('click',()=>openTripSheet({isNew:!activeTrip()}));
  $('#show-sleep').addEventListener('change',e=>{ S.hideSleep=!e.target.checked; document.body.classList.toggle('hide-sleep',S.hideSleep); try{ localStorage.setItem(SLEEP_KEY,S.hideSleep?'1':'0'); }catch{} render(); });
  try{ if(localStorage.getItem(SLEEP_KEY)==='1'){ S.hideSleep=true; $('#show-sleep').checked=false; document.body.classList.add('hide-sleep'); } }catch{}
  /* Trocar de língua: os textos fixos mudam logo; o resto volta a ser desenhado. */
  document.querySelectorAll('[data-lang-toggle]').forEach(b=>b.addEventListener('click',()=>{
    I18N.set(I18N.other()); I18N.apply(); buildWdays(); closeSheets(); $('#l-err').hidden=true;
    if(S.authed){ render(); refreshSaveLabel(); } else document.title=tr('appName');
  }));
}
