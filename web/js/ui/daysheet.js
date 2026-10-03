/* Painel de um dia: onde estão, custos do dia e lista de atividades. */
import { tr } from '../i18n.js';
import { $, esc, newId, STATUS, mlabel, dayLabel, toast, announce } from '../util.js';
import { S, T, pushHistory } from '../state.js';
import { days, view, fmt, blockCostPP, blocksOf, addPlace } from '../trip.js';
import { dayCostPP } from '../costs.js';
import { commit } from '../sync.js';
import { closeSheets } from './sheets.js';
import { openEditor } from './editor.js';
import { renderCostRows, addCost } from './costsheet.js';

export function openDay(date){ closeSheets(); S.dayOpen=date; $('#daysheet').hidden=false; fillDay(true); $('#d-place').focus(); }
export function fillDay(full){
  const t=T(); if(!t||!S.dayOpen) return; const ds=days(t); const cur=t.dayPlaces[S.dayOpen]||[];
  $('#d-h').textContent=dayLabel(S.dayOpen,true);
  const popts=t.places.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  if(full!==false || document.activeElement!==$('#d-place')){ $('#d-place').innerHTML=`<option value="">${tr('noPlace')}</option>`+popts; $('#d-place').value=cur[0]||''; }
  if(full!==false || document.activeElement!==$('#d-place2')){ $('#d-place2').innerHTML=`<option value="">${tr('noChange')}</option>`+popts; $('#d-place2').value=cur[1]||''; }
  if(full!==false){ const i=ds.indexOf(S.dayOpen); $('#d-until').innerHTML=`<option value="">${tr('justThisDay')}</option>`+ds.slice(i+1).map(d=>`<option value="${d}">${dayLabel(d,true)}</option>`).join(''); }
  const list=blocksOf(S.dayOpen); const box=$('#d-list'); box.innerHTML='';
  const cost=list.reduce((s,b)=>s+blockCostPP(b),0);
  $('#d-list-h').textContent = tr('dayActivities')+(cost?' · '+fmt(cost)+' '+tr('perPersonLower'):'');
  const dc=dayCostPP(S.dayOpen); $('#d-costs-h').textContent = tr('dayCosts')+(dc?' · '+fmt(dc)+' '+tr('perPersonLower'):'');
  renderCostRows($('#d-costs'), S.dayOpen, full===true);
  if(!list.length) box.innerHTML=`<p class="hint">${tr('dayEmpty')}</p>`;
  list.filter(b=>b.cat!=='sleep').forEach(b=>{ const it=document.createElement('button'); it.type='button'; it.className='day-item cat-'+b.cat;
    it.innerHTML=`<span class="tm">${mlabel(b.start)}–${mlabel(b.start+b.len)}</span><span class="nm">${esc(b.title)}</span>${b.status?`<span class="st st-${b.status}" style="margin-left:auto;font-size:10px;font-weight:700;padding:0 5px;border-radius:4px">${STATUS()[b.status]}</span>`:''}`;
    it.addEventListener('click',()=>openEditor(b.id)); box.appendChild(it); });
}
$('#d-apply').addEventListener('click',()=>{
  const t=T(); const p1=$('#d-place').value, p2=$('#d-place2').value, until=$('#d-until').value; const ds=days(t);
  const i=ds.indexOf(S.dayOpen), j=until?ds.indexOf(until):i; pushHistory();
  for(let k=i;k<=j;k++){ const d=ds[k]; const arr=[]; if(p1) arr.push(p1); if(p2 && p2!==p1 && k===j) arr.push(p2); if(arr.length) t.dayPlaces[d]=arr; else delete t.dayPlaces[d]; }
  if(p2 && j>i && p2!==p1) toast(tr('tPlaceLastDay'));
  commit(); fillDay(true); announce(tr('placeSaved'));
});
$('#d-addplace').addEventListener('click',()=>{ const v=$('#d-newplace').value; if(!v.trim()) return; pushHistory(); const p=addPlace(v); $('#d-newplace').value=''; commit(); fillDay(true); $('#d-place').value=p.id; toast(tr('tPlaceAdded',{name:p.name})); });
$('#d-newplace').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#d-addplace').click(); } });
$('#d-add').addEventListener('click',()=>{ const t=T(), v=view(t); let s=Math.max(v.T0,540);
  pushHistory(); const b={id:newId('a'), date:S.dayOpen, start:Math.min(s,v.T1-60), len:60, title:tr('newActivity'), cat:'tour', status:'ideia'}; t.blocks.push(b); commit(); openEditor(b.id,true); });
$('#d-addcost').addEventListener('click',()=>addCost($('#d-costs'), S.dayOpen));
