/* Editor de uma atividade. */
import { tr } from '../i18n.js';
import { $, esc, short, newId, SNAP, WD, CATS, mlabel, durLabel, dayLabel, toast } from '../util.js';
import { S, T, pushHistory } from '../state.js';
import { view, placeName, findBlock, moveTo, toTray, boardFrame, toBoard, fromBoard } from '../trip.js';
import { catName, hasCat, autoCat, catOptions } from '../costs.js';
import { TZ, secondTz } from '../tz.js';
import { absStart, dateAt } from '../span.js';
import { commit } from '../sync.js';
import { closeSheets } from './sheets.js';

let editorSnap=false;   // já foi guardado um ponto de Desfazer nesta edição?
export function buildWdays(){ $('#f-wdays').innerHTML=[1,2,3,4,5,6,0].map(w=>`<label><input type="checkbox" value="${w}" id="f-wd-${w}">${WD()[w]}</label>`).join(''); }
buildWdays();
function fillSelects(){
  const t=T(); if(!t) return; const v=view(t); const ds=boardFrame(t).ds;
  $('#f-day').innerHTML=`<option value="tray">${tr('unscheduled')}</option>`+ds.map(d=>`<option value="${d}">${dayLabel(d,true)}${(t.dayPlaces[d]||[]).length?' · '+(t.dayPlaces[d]).map(p=>esc(short(placeName(p)))).join(' → '):''}</option>`).join('');
  // qualquer hora do dia: o horário do quadro só decide o que se vê
  const grp=(key,a,b)=>{ let o=''; for(let m=a; m<b; m+=SNAP) o+=`<option value="${m}">${mlabel(m)}${m>=1440?tr('afterMidnight'):''}</option>`; return o?`<optgroup label="${esc(tr(key))}">${o}</optgroup>`:''; };
  $('#f-start').innerHTML=grp('startBefore',0,v.T0)+grp('startBoard',v.T0,v.T1)+grp('startAfter',v.T1,v.T0+1440);
  let lo=''; for(let m=SNAP; m<=4320; m+=(m<1440?SNAP:30)) lo+=`<option value="${m}">${durLabel(m)}</option>`; $('#f-len').innerHTML=lo;
  $('#f-place').innerHTML=`<option value="">${tr('anywhere')}</option>`+t.places.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
}
export function openEditor(id,isNew){
  if(S.suppressClick) return; closeSheets(); S.editingId=id; editorSnap=!!isNew;
  fillSelects(); $('#editor').hidden=false; $('#f-del-confirm').hidden=true; fillEditor(true);
  if(isNew){ const i=$('#f-title'); i.focus(); i.select(); } else $('#editor [data-close]').focus();
}
/* F: o boardFrame(t) que render() já calculou. */
export function fillEditor(full, F0){
  const f=findBlock(S.editingId); if(!f){ $('#editor').hidden=true; S.editingId=null; return; }
  // dia e hora mostrados na hora do quadro (vb), como na grelha
  const b=f.b, act=document.activeElement, t=T(), F=F0||boardFrame(t), vb=f.where==='tray'?null:toBoard(t,F,b);
  const set=(sel,val)=>{ const el=$(sel); if(full||el!==act){ if(el.type==='checkbox') el.checked=!!val; else el.value=val; } };
  set('#f-title',b.title); if(vb && ![...$('#f-day').options].some(o=>o.value===vb.date)) $('#f-day').insertAdjacentHTML('beforeend',`<option value="${vb.date}">${dayLabel(vb.date,true)}</option>`);
  set('#f-day', vb?vb.date:'tray'); $('#f-start').disabled=f.where==='tray';
  if(vb){ if(![...$('#f-start').options].some(o=>+o.value===vb.start)) $('#f-start').insertAdjacentHTML('beforeend',`<option value="${vb.start}">${mlabel(vb.start)}${tr('outsideBoard')}</option>`); set('#f-start',String(vb.start)); }
  if(![...$('#f-len').options].some(o=>+o.value===b.len)) $('#f-len').insertAdjacentHTML('beforeend',`<option value="${b.len}">${durLabel(b.len)}</option>`);
  set('#f-len',String(b.len)); set('#f-cat',b.cat); set('#f-status',b.status||''); set('#f-place',b.place||'');
  if(full||$('#f-ccat')!==act){ $('#f-ccat').innerHTML=catOptions(t, (b.ccat&&hasCat(t,b.ccat))?b.ccat:'', `<option value="">${tr('autoCat',{name:esc(catName(t,autoCat(t,b)))})}</option>`); }
  set('#f-pp',b.pp??''); set('#f-total',b.total??''); set('#f-address',b.address||''); set('#f-link',b.link||''); set('#f-ref',b.ref||''); set('#f-note',b.note||''); set('#f-lock',b.locked);
  [0,1,2,3,4,5,6].forEach(w=>{ const c=$('#f-wd-'+w); if(full||c!==act) c.checked=!!(b.weekdays&&b.weekdays.includes(w)); });
  const cur=t.currency||'€'; $('#f-pp-l').textContent=tr('costPPCur',{cur}); $('#f-total-l').textContent=tr('costTotalCur',{cur});
  const lo=$('#f-link-open'); if(/^https?:\/\//i.test(b.link||'')){ lo.hidden=false; lo.href=b.link; lo.textContent=tr('openLink'); } else lo.hidden=true;
  $('#f-tray').hidden=f.where==='tray'; $('#ed-h').textContent=CATS()[b.cat]||tr('activity');
  // a outra hora: o segundo fuso, ou a hora da viagem quando o quadro está no segundo fuso
  const sec=secondTz(t), other=sec && (F.off ? {tz:t.tz, diff:-sec.diff} : sec), fs=$('#f-sec');
  if(other && vb){ const a=vb.start+other.diff, sh=Math.floor(a/1440)-Math.floor(vb.start/1440);
    fs.textContent=tr('secAt',{city:TZ.city(other.tz), range:`${mlabel(a)}–${mlabel(a+b.len)}`})+(sh<0?tr('prevDay'):sh>0?tr('nextDay'):''); fs.hidden=false; }
  else fs.hidden=true;
}
/* Aplica uma alteração à atividade aberta (um só ponto de Desfazer por abertura do editor).
   lazy nos campos de texto: o quadro só é redesenhado numa pausa da escrita (ver commit). */
function edit(fn, lazy){ const f=findBlock(S.editingId); if(!f) return; if(!editorSnap){ pushHistory(); editorSnap=true; } fn(f.b,f); commit(lazy); }
const optStr=(k)=>e=>edit(b=>{ const v=e.target.value.trim(); if(v) b[k]=e.target.value; else delete b[k]; }, true);
$('#f-title').addEventListener('input',e=>edit(b=>{ b.title=e.target.value||tr('untitled'); }, true));
['note','address','link','ref'].forEach(k=>$('#f-'+k).addEventListener('input',optStr(k)));
$('#f-cat').addEventListener('change',e=>edit(b=>{ b.cat=e.target.value; }));
$('#f-status').addEventListener('change',e=>edit(b=>{ if(e.target.value) b.status=e.target.value; else delete b.status; }));
$('#f-place').addEventListener('change',e=>edit(b=>{ if(e.target.value) b.place=e.target.value; else delete b.place; }));
$('#f-ccat').addEventListener('change',e=>edit(b=>{ if(e.target.value) b.ccat=e.target.value; else delete b.ccat; }));
$('#f-lock').addEventListener('change',e=>edit(b=>{ if(e.target.checked) b.locked=true; else delete b.locked; }));
$('#f-pp').addEventListener('input',e=>edit(b=>{ const v=parseFloat(e.target.value); if(v>0) b.pp=v; else delete b.pp; }, true));
$('#f-total').addEventListener('input',e=>edit(b=>{ const v=parseFloat(e.target.value); if(v>0) b.total=v; else delete b.total; }, true));
$('#f-wdays').addEventListener('change',()=>edit(b=>{ const ws=[0,1,2,3,4,5,6].filter(w=>$('#f-wd-'+w).checked); if(ws.length&&ws.length<7) b.weekdays=ws; else delete b.weekdays; }));
/* Dia e hora vêm na hora do quadro (pode ser o segundo fuso); fromBoard converte para a hora da viagem. */
$('#f-len').addEventListener('change',e=>edit(b=>{ b.len=+e.target.value; }));
$('#f-start').addEventListener('change',e=>edit(b=>{ const t=T(), F=boardFrame(t); Object.assign(b, fromBoard(t,F,toBoard(t,F,b).date,+e.target.value)); }));
$('#f-day').addEventListener('change',e=>edit((b,f)=>{ if(e.target.value==='tray'){ toTray(b.id); return; }
  const t=T(), F=boardFrame(t), p=fromBoard(t,F,e.target.value, f.where==='tray'?Math.max(view(t).T0,600):toBoard(t,F,b).start); moveTo(b.id,p.date,p.start); }));
$('#f-dup').addEventListener('click',()=>{ const f=findBlock(S.editingId); if(!f) return; pushHistory(); const c=structuredClone(f.b); c.id=newId('a'); delete c.locked; const t=T();
  // a cópia fica logo a seguir ao original, mesmo fora das datas da viagem (aí aparece o aviso próprio)
  if(f.where==='tray') t.tray.push(c); else { Object.assign(c, dateAt(t, absStart(t,f.b)+f.b.len)); t.blocks.push(c); } commit(); openEditor(c.id); toast(tr('tDupActivity')); });
$('#f-tray').addEventListener('click',()=>{ edit(b=>toTray(b.id)); $('#editor').hidden=true; S.editingId=null; });
$('#f-del').addEventListener('click',()=>{ $('#f-del-confirm').hidden=false; $('#f-del-yes').focus(); });
$('#f-del-no').addEventListener('click',()=>{ $('#f-del-confirm').hidden=true; });
$('#f-del-yes').addEventListener('click',()=>{ const id=S.editingId, t=T(); pushHistory(); t.blocks=t.blocks.filter(b=>b.id!==id); t.tray=t.tray.filter(b=>b.id!==id); $('#editor').hidden=true; S.editingId=null; commit(); toast(tr('tDelActivity')); });
