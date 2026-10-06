/* Painel de um dia: onde estão, custos do dia e lista de atividades. */
import { tr } from '../i18n.js';
import { esc, newId, statusLabel, dayLabel } from '../util.js';
import { $, toast, announce } from './dom.js';
import { S, T, pushHistory } from '../state.js';
import { days, view, money, blockCostPP, blocksOf, addPlace, boardLayout, rangeLabel, setDayPlaces, splitDayPlaces, newBlock } from '../trip.js';
import { dayCostPP } from '../costs.js';
import { commit } from '../sync.js';
import { closeSheets } from './sheets.js';
import { openEditor } from './editor.js';
import { renderCostRows, addCost } from './costsheet.js';

export function openDay(date){ closeSheets(); S.dayOpen=date; $('#daysheet').hidden=false; fillDay(); $('#d-place').focus(); }
/* Sem opções (ao abrir e depois de Aplicar) mostra o que está gravado. Com refresh (render() e um sítio novo) os selects
   são um rascunho que só conta em Aplicar: refazem-se as opções (os sítios ou as datas podem ter mudado),
   mas fica o que estava escolhido, se ainda existir. O select com foco não se mexe.
   tripLayout: o quadro em hora da viagem que render() já calculou (boardLayout(t, days(t))). */
export function fillDay({refresh=false, tripLayout}={}){
  const t=T(); if(!t||!S.dayOpen) return; const ds=days(t); const cur=t.dayPlaces[S.dayOpen]||[];
  $('#d-h').textContent=dayLabel(S.dayOpen,true);
  const refill=(el, html, saved)=>{ if(refresh && el===document.activeElement) return;
    const draft=el.value; el.innerHTML=html; el.value=refresh ? draft : saved; if(el.selectedIndex<0) el.value=saved; };
  const popts=t.places.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''), sp=splitDayPlaces(cur);
  refill($('#d-place'), `<option value="">${tr('noPlace')}</option>`+popts, sp.first);
  refill($('#d-place2'), `<option value="">${tr('noChange')}</option>`+popts, sp.last);
  // paragens: ao abrir, as gravadas; num refresh, as do rascunho (sai a linha de um sítio que já não existe)
  if(!refresh){ $('#d-stops').innerHTML=''; sp.stops.forEach(p=>addStopRow(p)); }
  else $('#d-stops').querySelectorAll('select').forEach(el=>{ refill(el, popts, el.value); if(el.selectedIndex<0) el.parentElement.remove(); });
  numberStops(); $('#d-addstop').disabled=!t.places.length;
  const di=ds.indexOf(S.dayOpen);
  refill($('#d-until'), `<option value="">${tr('justThisDay')}</option>`+ds.slice(di+1).map(d=>`<option value="${d}">${dayLabel(d,true)}</option>`).join(''), '');
  const list=blocksOf(t,S.dayOpen); const box=$('#d-list'); box.innerHTML='';
  const cost=list.reduce((s,b)=>s+blockCostPP(t,b),0);
  $('#d-list-h').textContent = tr('dayActivities')+(cost?' · '+money(t,cost)+' '+tr('perPersonLower'):'');
  const dc=dayCostPP(t,S.dayOpen); $('#d-costs-h').textContent = tr('dayCosts')+(dc?' · '+money(t,dc)+' '+tr('perPersonLower'):'');
  renderCostRows($('#d-costs'), S.dayOpen, {refresh});
  // atividades de dias anteriores que ainda decorrem neste dia (ex.: um voo de 30 h)
  const {cols}=tripLayout||boardLayout(t,ds), i=ds.indexOf(S.dayOpen);
  const cont=i<0?[]:cols[i].filter(s=>s.cutTop && s.b.date!==S.dayOpen).map(s=>s.b);
  if(!list.length && !cont.length) box.innerHTML=`<p class="hint">${tr('dayEmpty')}</p>`;
  cont.concat(list).filter(b=>b.cat!=='sleep').forEach(b=>{ const it=document.createElement('button'); it.type='button'; it.className='day-item cat-'+b.cat;
    const from=b.date!==S.dayOpen ? `<span class="from">${tr('fromDay',{day:dayLabel(b.date)})}</span>` : '';
    it.innerHTML=`<span class="tm">${rangeLabel(b)}</span><span class="nm">${esc(b.title)}${from}</span>${statusLabel(b.status)?`<span class="st st-${b.status}" style="margin-left:auto;font-size:10px;font-weight:700;padding:0 5px;border-radius:4px">${esc(statusLabel(b.status))}</span>`:''}`;
    it.addEventListener('click',()=>openEditor(b.id)); box.appendChild(it); });
}
/* Uma linha de paragem (rascunho até Aplicar): o sítio p e o botão Remover. */
function addStopRow(p){
  const t=T(), row=document.createElement('div'); row.className='stop-row';
  row.innerHTML=`<select>${t.places.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select><button class="btn danger" type="button">${tr('remove')}</button>`;
  const sel=row.querySelector('select'); sel.value=p;
  row.querySelector('button').addEventListener('click',()=>{ const next=row.nextElementSibling; row.remove(); numberStops(); (next ? next.querySelector('select') : $('#d-addstop')).focus(); });
  $('#d-stops').appendChild(row);
  return sel;
}
function numberStops(){ $('#d-stops').querySelectorAll('.stop-row').forEach((row,k)=>{ row.querySelector('select').setAttribute('aria-label',tr('stopN',{n:k+1})); row.querySelector('button').setAttribute('aria-label',tr('removeStopN',{n:k+1})); }); }
/* Botões do painel do dia (main.js chama-a uma vez ao arrancar). */
export function initDaysheet(){
  $('#d-addstop').addEventListener('click',()=>{ const t=T(); if(!t.places.length) return; const sel=addStopRow(t.places[0].id); numberStops(); sel.focus(); });
  $('#d-apply').addEventListener('click',()=>{
    pushHistory();
    const later=[...$('#d-stops').querySelectorAll('select')].map(el=>el.value).concat($('#d-place2').value);
    if(setDayPlaces(T(), S.dayOpen, $('#d-until').value, $('#d-place').value, later)) toast(tr('tPlaceLastDay'));
    commit(); fillDay(); announce(tr('placeSaved'));
  });
  $('#d-addplace').addEventListener('click',()=>{ const v=$('#d-newplace').value; if(!v.trim()) return; pushHistory(); const p=addPlace(T(),v); $('#d-newplace').value=''; commit(); fillDay({refresh:true}); $('#d-place').value=p.id; toast(tr('tPlaceAdded',{name:p.name})); });
  $('#d-newplace').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#d-addplace').click(); } });
  $('#d-add').addEventListener('click',()=>{ const t=T(), v=view(t); let s=Math.max(v.T0,540);
    pushHistory(); const b=newBlock({date:S.dayOpen, start:Math.min(s,v.T1-60)}, newId); t.blocks.push(b); commit(); openEditor(b.id,{isNew:true}); });
  $('#d-addcost').addEventListener('click',()=>addCost($('#d-costs'), S.dayOpen));
}
