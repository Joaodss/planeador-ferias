/* Painel "Alterações da IA": o que o assistente de IA mudou e ainda não foi visto (aiChanges em ai.js),
   para abrir cada coisa e dar como vista, e o botão que desfaz no servidor a última alteração da IA (undoLastAi). */
import { tr } from '../i18n.js';
import { esc, dayLabel } from '../util.js';
import { $, isMobile } from './dom.js';
import { activeTrip, pushHistory } from '../state.js';
import { tripLock } from '../trip.js';
import { aiChanges, clearAiMark, clearAiMarks, aiStampLabel } from '../ai.js';
import { commit, undoLastAi } from '../sync.js';
import { closeSheets } from './sheets.js';
import { focusBlock } from './board.js';
import { openDay } from './daysheet.js';
import { openTripSheet } from './tripsheet.js';

/** O nome de uma alteração no painel: o da atividade, "Custo: …" ou "Dados da viagem".
    @param {import('../ai.js').AiChange} c */
function changeTitle(c){
  if(c.kind==='trip') return tr('aiTrip');
  if(c.kind==='cost') return tr('aiCost',{a:c.title});
  return c.title;
}
/* Abre o que a IA mudou: a atividade no quadro, o dia do custo (ou os custos gerais) ou o painel da viagem. */
function openChange(c){
  if(c.kind==='block'){ if(isMobile()) $('#aisheet').hidden=true; focusBlock(c.id); return; }
  if(c.kind==='cost'){ if(c.date) openDay(c.date); else { closeSheets(); $('#costs-btn').click(); } return; }
  openTripSheet();
}

/** Escreve a lista do painel (render() chama-a quando o painel está aberto). */
export function renderAiSheet(){
  const t=activeTrip(), box=$('#ai-list'), list=aiChanges(t), locked=!!tripLock(t);
  box.innerHTML = list.length ? '' : `<div class="empty-ok">${tr('aiNone')}</div>`;
  for(const c of list){
    const title=changeTitle(c), where=c.date ? dayLabel(c.date,true) : (c.kind==='trip' ? '' : tr('aiNoDate'));
    const row=document.createElement('div'); row.className='ai-item';
    row.innerHTML=`<button type="button" class="ai-open"><div class="wt">✨ ${esc(title)}</div><div class="wd">${esc([where, aiStampLabel(c.at)].filter(Boolean).join(' · '))}</div></button>`
      + `<button type="button" class="btn ai-seen" aria-label="${esc(tr('aiSeenAria',{a:title}))}"${locked?' disabled':''}>${tr('aiSeen')}</button>`;
    row.querySelector('.ai-open').addEventListener('click',()=>openChange(c));
    row.querySelector('.ai-seen').addEventListener('click',()=>{ pushHistory(); clearAiMark(activeTrip(), c.kind, c.id); commit(); });
    box.appendChild(row);
  }
  // numa viagem bloqueada nada muda, nem as marcas
  $('#ai-all-seen').disabled = locked || !list.length;
  $('#ai-undo').disabled = locked;
}

/* O botão "✨ n da IA" e os botões do painel (main.js chama-a uma vez ao arrancar). */
export function initAisheet(){
  $('#ai-btn').addEventListener('click',()=>{ const p=$('#aisheet'); if(!p.hidden){ p.hidden=true; return; } closeSheets(); renderAiSheet(); p.hidden=false; p.querySelector('[data-close]').focus(); });
  $('#ai-all-seen').addEventListener('click',()=>{ pushHistory(); clearAiMarks(activeTrip()); commit(); });
  $('#ai-undo').addEventListener('click',async e=>{
    const b=e.currentTarget; b.disabled=true;
    try{ await undoLastAi(); } finally { b.disabled=!!tripLock(activeTrip()); }
  });
}
