/* Painel de um dia: onde estão, custos do dia e lista de atividades. */
import { tr } from '../i18n.js';
import { esc, newId, statusLabel, dayLabel } from '../util.js';
import { $, toast, announce } from './dom.js';
import { S, T, pushHistory } from '../state.js';
import { days, view, money, blockCostPP, blocksOf, addPlace, boardLayout, rangeLabel, setDayPlaces, newBlock } from '../trip.js';
import { dayCostPP } from '../costs.js';
import { commit } from '../sync.js';
import { closeSheets } from './sheets.js';
import { openEditor } from './editor.js';
import { renderCostRows, addCost } from './costsheet.js';

export function openDay(date){ closeSheets(); S.dayOpen=date; $('#daysheet').hidden=false; fillDay(true); $('#d-place').focus(); }
/* full: ao abrir e depois de Aplicar mostra o que está gravado. Num refresh (render(), full=false) os selects
   são um rascunho que só conta em Aplicar: refazem-se as opções (os sítios ou as datas podem ter mudado),
   mas fica o que estava escolhido, se ainda existir. O select com foco não se mexe.
   L0: o layout em hora da viagem que render() já calculou (boardLayout(t, days(t))). */
export function fillDay(full, L0){
  const t=T(); if(!t||!S.dayOpen) return; const ds=days(t); const cur=t.dayPlaces[S.dayOpen]||[];
  $('#d-h').textContent=dayLabel(S.dayOpen,true);
  const refill=(el, html, saved)=>{ if(!full && el===document.activeElement) return;
    const draft=el.value; el.innerHTML=html; el.value=full ? saved : draft; if(el.selectedIndex<0) el.value=saved; };
  const popts=t.places.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  refill($('#d-place'), `<option value="">${tr('noPlace')}</option>`+popts, cur[0]||'');
  refill($('#d-place2'), `<option value="">${tr('noChange')}</option>`+popts, cur[1]||'');
  const di=ds.indexOf(S.dayOpen);
  refill($('#d-until'), `<option value="">${tr('justThisDay')}</option>`+ds.slice(di+1).map(d=>`<option value="${d}">${dayLabel(d,true)}</option>`).join(''), '');
  const list=blocksOf(t,S.dayOpen); const box=$('#d-list'); box.innerHTML='';
  const cost=list.reduce((s,b)=>s+blockCostPP(t,b),0);
  $('#d-list-h').textContent = tr('dayActivities')+(cost?' · '+money(t,cost)+' '+tr('perPersonLower'):'');
  const dc=dayCostPP(t,S.dayOpen); $('#d-costs-h').textContent = tr('dayCosts')+(dc?' · '+money(t,dc)+' '+tr('perPersonLower'):'');
  renderCostRows($('#d-costs'), S.dayOpen, full===true);
  // atividades de dias anteriores que ainda decorrem neste dia (ex.: um voo de 30 h)
  const L=L0||boardLayout(t,ds), i=ds.indexOf(S.dayOpen);
  const cont=i<0?[]:L.cols[i].filter(s=>s.cutTop && s.b.date!==S.dayOpen).map(s=>s.b);
  if(!list.length && !cont.length) box.innerHTML=`<p class="hint">${tr('dayEmpty')}</p>`;
  cont.concat(list).filter(b=>b.cat!=='sleep').forEach(b=>{ const it=document.createElement('button'); it.type='button'; it.className='day-item cat-'+b.cat;
    const from=b.date!==S.dayOpen ? `<span class="from">${tr('fromDay',{day:dayLabel(b.date)})}</span>` : '';
    it.innerHTML=`<span class="tm">${rangeLabel(b)}</span><span class="nm">${esc(b.title)}${from}</span>${statusLabel(b.status)?`<span class="st st-${b.status}" style="margin-left:auto;font-size:10px;font-weight:700;padding:0 5px;border-radius:4px">${esc(statusLabel(b.status))}</span>`:''}`;
    it.addEventListener('click',()=>openEditor(b.id)); box.appendChild(it); });
}
/* Botões do painel do dia (main.js chama-a uma vez ao arrancar). */
export function initDaysheet(){
  $('#d-apply').addEventListener('click',()=>{
    pushHistory();
    if(setDayPlaces(T(), S.dayOpen, $('#d-until').value, $('#d-place').value, $('#d-place2').value)) toast(tr('tPlaceLastDay'));
    commit(); fillDay(true); announce(tr('placeSaved'));
  });
  $('#d-addplace').addEventListener('click',()=>{ const v=$('#d-newplace').value; if(!v.trim()) return; pushHistory(); const p=addPlace(T(),v); $('#d-newplace').value=''; commit(); fillDay(false); $('#d-place').value=p.id; toast(tr('tPlaceAdded',{name:p.name})); });
  $('#d-newplace').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#d-addplace').click(); } });
  $('#d-add').addEventListener('click',()=>{ const t=T(), v=view(t); let s=Math.max(v.T0,540);
    pushHistory(); const b=newBlock({date:S.dayOpen, start:Math.min(s,v.T1-60)}, newId); t.blocks.push(b); commit(); openEditor(b.id,true); });
  $('#d-addcost').addEventListener('click',()=>addCost($('#d-costs'), S.dayOpen));
}
