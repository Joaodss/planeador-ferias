/* Editor de uma atividade. */
import { tr } from '../i18n.js';
import { $, esc, clone, short, newId, SNAP, WD, CATS, mlabel, durLabel, dayLabel, toast } from '../util.js';
import { S, T, pushHistory } from '../state.js';
import { days, view, placeName, findBlock, moveTo, toTray } from '../trip.js';
import { catName, hasCat, autoCat, catOptions } from '../costs.js';
import { commit } from '../sync.js';
import { closeSheets } from './sheets.js';

let editorSnap=false;   // já foi guardado um ponto de Desfazer nesta edição?
export function buildWdays(){ $('#f-wdays').innerHTML=[1,2,3,4,5,6,0].map(w=>`<label><input type="checkbox" value="${w}" id="f-wd-${w}">${WD()[w]}</label>`).join(''); }
buildWdays();
function fillSelects(){
  const t=T(); if(!t) return; const v=view(t); const ds=days(t);
  $('#f-day').innerHTML=`<option value="tray">${tr('unscheduled')}</option>`+ds.map(d=>`<option value="${d}">${dayLabel(d,true)}${(t.dayPlaces[d]||[]).length?' · '+(t.dayPlaces[d]).map(p=>short(placeName(p))).join(' → '):''}</option>`).join('');
  let so=''; for(let m=v.T0; m<v.T1; m+=SNAP) so+=`<option value="${m}">${mlabel(m)}${m>=1440?tr('afterMidnight'):''}</option>`; $('#f-start').innerHTML=so;
  let lo=''; for(let m=SNAP; m<=v.span; m+=SNAP) lo+=`<option value="${m}">${durLabel(m)}</option>`; $('#f-len').innerHTML=lo;
  $('#f-place').innerHTML=`<option value="">${tr('anywhere')}</option>`+t.places.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
}
export function openEditor(id,isNew){
  if(S.suppressClick) return; closeSheets(); S.editingId=id; editorSnap=!!isNew;
  fillSelects(); $('#editor').hidden=false; $('#f-del-confirm').hidden=true; fillEditor(true);
  if(isNew){ const i=$('#f-title'); i.focus(); i.select(); } else $('#editor [data-close]').focus();
}
export function fillEditor(full){
  const f=findBlock(S.editingId); if(!f){ $('#editor').hidden=true; S.editingId=null; return; }
  const b=f.b, act=document.activeElement, t=T();
  const set=(sel,val)=>{ const el=$(sel); if(full||el!==act){ if(el.type==='checkbox') el.checked=!!val; else el.value=val; } };
  set('#f-title',b.title); set('#f-day', f.where==='tray'?'tray':b.date); $('#f-start').disabled=f.where==='tray';
  if(f.where!=='tray'){ if(![...$('#f-start').options].some(o=>+o.value===b.start)) $('#f-start').insertAdjacentHTML('beforeend',`<option value="${b.start}">${mlabel(b.start)}${tr('outsideBoard')}</option>`); set('#f-start',String(b.start)); }
  if(![...$('#f-len').options].some(o=>+o.value===b.len)) $('#f-len').insertAdjacentHTML('beforeend',`<option value="${b.len}">${durLabel(b.len)}</option>`);
  set('#f-len',String(b.len)); set('#f-cat',b.cat); set('#f-status',b.status||''); set('#f-place',b.place||'');
  if(full||$('#f-ccat')!==act){ $('#f-ccat').innerHTML=catOptions(t, (b.ccat&&hasCat(t,b.ccat))?b.ccat:'', `<option value="">${tr('autoCat',{name:esc(catName(t,autoCat(t,b)))})}</option>`); }
  set('#f-pp',b.pp??''); set('#f-total',b.total??''); set('#f-address',b.address||''); set('#f-link',b.link||''); set('#f-ref',b.ref||''); set('#f-note',b.note||''); set('#f-lock',b.locked);
  [0,1,2,3,4,5,6].forEach(w=>{ const c=$('#f-wd-'+w); if(full||c!==act) c.checked=!!(b.weekdays&&b.weekdays.includes(w)); });
  const cur=t.currency||'€'; $('#f-pp-l').textContent=tr('costPPCur',{cur}); $('#f-total-l').textContent=tr('costTotalCur',{cur});
  const lo=$('#f-link-open'); if(/^https?:\/\//i.test(b.link||'')){ lo.hidden=false; lo.href=b.link; lo.textContent=tr('openLink'); } else lo.hidden=true;
  $('#f-tray').hidden=f.where==='tray'; $('#ed-h').textContent=CATS()[b.cat]||tr('activity');
}
/* Aplica uma alteração à atividade aberta (um só ponto de Desfazer por abertura do editor). */
function edit(fn){ const f=findBlock(S.editingId); if(!f) return; if(!editorSnap){ pushHistory(); editorSnap=true; } fn(f.b,f); commit(); }
const optStr=(k)=>e=>edit(b=>{ const v=e.target.value.trim(); if(v) b[k]=e.target.value; else delete b[k]; });
$('#f-title').addEventListener('input',e=>edit(b=>{ b.title=e.target.value||tr('untitled'); }));
['note','address','link','ref'].forEach(k=>$('#f-'+k).addEventListener('input',optStr(k)));
$('#f-cat').addEventListener('change',e=>edit(b=>{ b.cat=e.target.value; }));
$('#f-status').addEventListener('change',e=>edit(b=>{ if(e.target.value) b.status=e.target.value; else delete b.status; }));
$('#f-place').addEventListener('change',e=>edit(b=>{ if(e.target.value) b.place=e.target.value; else delete b.place; }));
$('#f-ccat').addEventListener('change',e=>edit(b=>{ if(e.target.value) b.ccat=e.target.value; else delete b.ccat; }));
$('#f-lock').addEventListener('change',e=>edit(b=>{ if(e.target.checked) b.locked=true; else delete b.locked; }));
$('#f-pp').addEventListener('input',e=>edit(b=>{ const v=parseFloat(e.target.value); if(v>0) b.pp=v; else delete b.pp; }));
$('#f-total').addEventListener('input',e=>edit(b=>{ const v=parseFloat(e.target.value); if(v>0) b.total=v; else delete b.total; }));
$('#f-wdays').addEventListener('change',()=>edit(b=>{ const ws=[0,1,2,3,4,5,6].filter(w=>$('#f-wd-'+w).checked); if(ws.length&&ws.length<7) b.weekdays=ws; else delete b.weekdays; }));
$('#f-len').addEventListener('change',e=>edit(b=>{ b.len=+e.target.value; const v=view(T()); if(b.start!=null && b.start+b.len>v.T1) b.start=Math.max(v.T0,v.T1-b.len); }));
$('#f-start').addEventListener('change',e=>edit(b=>{ const v=view(T()); b.start=Math.min(+e.target.value, v.T1-b.len); }));
$('#f-day').addEventListener('change',e=>edit((b,f)=>{ if(e.target.value==='tray') toTray(b.id); else moveTo(b.id,e.target.value, f.where==='tray'?Math.max(view(T()).T0,600):b.start); }));
$('#f-dup').addEventListener('click',()=>{ const f=findBlock(S.editingId); if(!f) return; pushHistory(); const c=clone(f.b); c.id=newId('a'); delete c.locked; const t=T();
  if(f.where==='tray') t.tray.push(c); else { c.start=Math.min(view(t).T1-c.len, f.b.start+f.b.len); t.blocks.push(c); } commit(); openEditor(c.id); toast(tr('tDupActivity')); });
$('#f-tray').addEventListener('click',()=>{ edit(b=>toTray(b.id)); $('#editor').hidden=true; S.editingId=null; });
$('#f-del').addEventListener('click',()=>{ $('#f-del-confirm').hidden=false; $('#f-del-yes').focus(); });
$('#f-del-no').addEventListener('click',()=>{ $('#f-del-confirm').hidden=true; });
$('#f-del-yes').addEventListener('click',()=>{ const id=S.editingId, t=T(); pushHistory(); t.blocks=t.blocks.filter(b=>b.id!==id); t.tray=t.tray.filter(b=>b.id!==id); $('#editor').hidden=true; S.editingId=null; commit(); toast(tr('tDelActivity')); });
