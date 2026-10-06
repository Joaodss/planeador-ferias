/* Editor de uma atividade. */
import { tr } from '../i18n.js';
import { esc, shortPlaceName, newId, SNAP, weekdayNames, kindLabels, clockLabel, durationLabel, dayLabel } from '../util.js';
import { $, toast, fillTzSelect, linkTzSearch } from './dom.js';
import { S, activeTrip, pushHistory } from '../state.js';
import { boardHours, placeName, findBlock, moveTo, toTray, boardFrame, toBoard, editorTime, fromEditor, blockZoneTime, duplicateBlock, dayEnds, FROM_TRAY_START } from '../trip.js';
import { catName, hasCat, autoCat, catOptions } from '../costs.js';
import { TZ, secondTz } from '../tz.js';
import { commit, commitTyping } from '../sync.js';
import { closeSheets } from './sheets.js';

let undoTaken=false;   // já foi guardado um ponto de Desfazer desde que o editor abriu?
/* A lista de durações vai até 3 dias (72 h): de 15 em 15 min (SNAP) até 24 h e depois de 30 em 30, para a lista
   não ficar com centenas de opções. Uma atividade mais longa, ou com outra duração, ganha a sua opção em fillEditor. */
const MAX_LEN_OPTION = 3*1440, LONG_LEN_STEP = 30;
export function buildWdays(){ $('#f-wdays').innerHTML=[1,2,3,4,5,6,0].map(w=>`<label><input type="checkbox" value="${w}" id="f-wd-${w}">${weekdayNames()[w]}</label>`).join(''); }
function fillSelects(){
  const t=activeTrip(); if(!t) return; const hours=boardHours(t); const ds=boardFrame(t).dates;
  $('#f-day').innerHTML=`<option value="tray">${tr('unscheduled')}</option>`+ds.map(d=>`<option value="${d}">${dayLabel(d,true)}${dayEnds(t.dayPlaces[d]).length?' · '+dayEnds(t.dayPlaces[d]).map(p=>esc(shortPlaceName(placeName(t,p)))).join(' → '):''}</option>`).join('');
  // qualquer hora do dia: o horário do quadro só decide o que se vê
  const grp=(key,a,b)=>{ let o=''; for(let m=a; m<b; m+=SNAP) o+=`<option value="${m}">${clockLabel(m)}${m>=1440?tr('afterMidnight'):''}</option>`; return o?`<optgroup label="${esc(tr(key))}">${o}</optgroup>`:''; };
  $('#f-start').innerHTML=grp('startBefore',0,hours.from)+grp('startBoard',hours.from,hours.to)+grp('startAfter',hours.to,hours.from+1440);
  let lo=''; for(let m=SNAP; m<=MAX_LEN_OPTION; m+=(m<1440?SNAP:LONG_LEN_STEP)) lo+=`<option value="${m}">${durationLabel(m)}</option>`; $('#f-len').innerHTML=lo;
  $('#f-place').innerHTML=`<option value="">${tr('anywhere')}</option>`+t.places.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
}
/* Fuso da atividade: a primeira opção é a hora da viagem. Sem fuso da viagem não há como converter: fica desativado
   (a não ser que a atividade já tenha um, para o poder tirar). */
function fillTz(t, b){
  const ok=TZ.valid(t.tz);
  fillTzSelect($('#f-tz'), ok ? tr('fTzTrip',{city:TZ.city(t.tz)}) : tr('fTzNeedTrip'), b.tz||'', b.date||t.start);
  $('#f-tz').disabled=!ok && !b.tz; $('#f-tz-q').disabled=$('#f-tz').disabled;
}
/* isNew: a atividade acabou de ser criada (com o seu ponto de Desfazer) e o título fica selecionado para escrever. */
export function openEditor(id, {isNew=false}={}){
  if(S.suppressClick) return; closeSheets(); S.editingId=id; undoTaken=isNew;
  fillSelects(); $('#editor').hidden=false; $('#f-del-confirm').hidden=true; fillEditor();
  if(isNew){ const i=$('#f-title'); i.focus(); i.select(); } else $('#editor [data-close]').focus();
}
/* Sem opções (ao abrir) escreve todos os campos. Com refresh (render()) não mexe no campo com foco.
   frame: o boardFrame(t) que render() já calculou. */
export function fillEditor({refresh=false, frame}={}){
  const f=findBlock(activeTrip(),S.editingId); if(!f){ $('#editor').hidden=true; S.editingId=null; return; }
  // dia e hora mostrados na hora do quadro (boardPos), como na grelha, ou no fuso da atividade (z), se tiver um
  const b=f.b, act=document.activeElement, t=activeTrip(); frame=frame||boardFrame(t); const boardPos=f.where==='tray'?null:toBoard(t,frame,b), fd=boardPos&&editorTime(t,frame,b);
  const set=(sel,val)=>{ const el=$(sel); if(!refresh||el!==act){ if(el.type==='checkbox') el.checked=!!val; else el.value=val; } };
  if(!refresh || ($('#f-tz')!==act && $('#f-tz').value!==(b.tz||''))) fillTz(t,b);
  set('#f-title',b.title); if(fd && ![...$('#f-day').options].some(o=>o.value===fd.date)) $('#f-day').insertAdjacentHTML('beforeend',`<option value="${fd.date}">${dayLabel(fd.date,true)}</option>`);
  set('#f-day', fd?fd.date:'tray'); $('#f-start').disabled=f.where==='tray';
  if(fd){ if(![...$('#f-start').options].some(o=>+o.value===fd.start)) $('#f-start').insertAdjacentHTML('beforeend',`<option value="${fd.start}">${clockLabel(fd.start)}${tr('outsideBoard')}</option>`); set('#f-start',String(fd.start)); }
  if(![...$('#f-len').options].some(o=>+o.value===b.len)) $('#f-len').insertAdjacentHTML('beforeend',`<option value="${b.len}">${durationLabel(b.len)}</option>`);
  set('#f-len',String(b.len)); set('#f-cat',b.cat); set('#f-status',b.status||''); set('#f-place',b.place||'');
  if(!refresh||$('#f-ccat')!==act){ $('#f-ccat').innerHTML=catOptions(t, (b.ccat&&hasCat(t,b.ccat))?b.ccat:'', `<option value="">${tr('autoCat',{name:esc(catName(t,autoCat(t,b)))})}</option>`); }
  set('#f-pp',b.pp??''); set('#f-total',b.total??''); set('#f-address',b.address||''); set('#f-link',b.link||''); set('#f-ref',b.ref||''); set('#f-note',b.note||''); set('#f-lock',b.locked);
  [0,1,2,3,4,5,6].forEach(w=>{ const c=$('#f-wd-'+w); if(!refresh||c!==act) c.checked=!!(b.weekdays&&b.weekdays.includes(w)); });
  const cur=t.currency||'€'; $('#f-pp-l').textContent=tr('costPPCur',{cur}); $('#f-total-l').textContent=tr('costTotalCur',{cur});
  const lo=$('#f-link-open'); if(/^https?:\/\//i.test(b.link||'')){ lo.hidden=false; lo.href=b.link; lo.textContent=tr('openLink'); } else lo.hidden=true;
  $('#f-tray').hidden=f.where==='tray'; $('#ed-h').textContent=kindLabels()[b.cat]||tr('activity');
  // a outra hora: a do quadro quando os campos estão no fuso da atividade; senão o segundo fuso,
  // ou a hora da viagem quando o quadro está no segundo fuso
  const sec=secondTz(t), other=sec && (frame.offsetMin ? {tz:t.tz, diff:-sec.diff} : sec), fs=$('#f-sec'), bz=boardPos&&blockZoneTime(t,frame,b);
  if(bz){ fs.textContent=tr('secAt',{city:TZ.city(frame.offsetMin?sec.tz:t.tz), range:`${clockLabel(boardPos.start)}–${clockLabel(boardPos.start+b.len)}`})+(bz.days>0?tr('prevDay'):bz.days<0?tr('nextDay'):''); fs.hidden=false; }
  else if(other && boardPos){ const a=boardPos.start+other.diff, sh=Math.floor(a/1440)-Math.floor(boardPos.start/1440);
    fs.textContent=tr('secAt',{city:TZ.city(other.tz), range:`${clockLabel(a)}–${clockLabel(a+b.len)}`})+(sh<0?tr('prevDay'):sh>0?tr('nextDay'):''); fs.hidden=false; }
  else fs.hidden=true;
}
/* Aplica uma alteração à atividade aberta (um só ponto de Desfazer por abertura do editor) e grava com done:
   commit, ou commitTyping nos campos de texto, onde o quadro só é redesenhado numa pausa da escrita. */
function edit(fn, done=commit){ const f=findBlock(activeTrip(),S.editingId); if(!f) return; if(!undoTaken){ pushHistory(); undoTaken=true; } fn(f.b,f); done(); }
const optStr=(k)=>e=>edit(b=>{ const v=e.target.value.trim(); if(v) b[k]=e.target.value; else delete b[k]; }, commitTyping);
/* Campos do editor (main.js chama-a uma vez ao arrancar). */
export function initEditor(){
  buildWdays(); linkTzSearch($('#f-tz'));
  $('#f-title').addEventListener('input',e=>edit(b=>{ b.title=e.target.value||tr('untitled'); }, commitTyping));
  ['note','address','link','ref'].forEach(k=>$('#f-'+k).addEventListener('input',optStr(k)));
  $('#f-cat').addEventListener('change',e=>edit(b=>{ b.cat=e.target.value; }));
  $('#f-status').addEventListener('change',e=>edit(b=>{ if(e.target.value) b.status=e.target.value; else delete b.status; }));
  $('#f-place').addEventListener('change',e=>edit(b=>{ if(e.target.value) b.place=e.target.value; else delete b.place; }));
  $('#f-ccat').addEventListener('change',e=>edit(b=>{ if(e.target.value) b.ccat=e.target.value; else delete b.ccat; }));
  $('#f-lock').addEventListener('change',e=>edit(b=>{ if(e.target.checked) b.locked=true; else delete b.locked; }));
  $('#f-pp').addEventListener('input',e=>edit(b=>{ const v=parseFloat(e.target.value); if(v>0) b.pp=v; else delete b.pp; }, commitTyping));
  $('#f-total').addEventListener('input',e=>edit(b=>{ const v=parseFloat(e.target.value); if(v>0) b.total=v; else delete b.total; }, commitTyping));
  $('#f-wdays').addEventListener('change',()=>edit(b=>{ const ws=[0,1,2,3,4,5,6].filter(w=>$('#f-wd-'+w).checked); if(ws.length&&ws.length<7) b.weekdays=ws; else delete b.weekdays; }));
  /* Dia e hora vêm na hora do quadro (pode ser o segundo fuso) ou no fuso da atividade; fromEditor converte para a hora da viagem.
     Mudar o fuso da atividade não mexe na hora guardada: só muda como o dia e a hora se mostram. */
  $('#f-tz').addEventListener('change',e=>edit(b=>{ if(e.target.value) b.tz=e.target.value; else delete b.tz; }));
  $('#f-len').addEventListener('change',e=>edit(b=>{ b.len=+e.target.value; }));
  $('#f-start').addEventListener('change',e=>edit(b=>{ const t=activeTrip(), frame=boardFrame(t); Object.assign(b, fromEditor(t,frame,b,editorTime(t,frame,b).date,+e.target.value)); }));
  $('#f-day').addEventListener('change',e=>edit((b,f)=>{ if(e.target.value==='tray'){ toTray(activeTrip(),b.id); return; }
    const t=activeTrip(), frame=boardFrame(t), p=fromEditor(t,frame,b,e.target.value, f.where==='tray'?Math.max(boardHours(t).from,FROM_TRAY_START):editorTime(t,frame,b).start); moveTo(t,b.id,p.date,p.start); }));
  // a cópia fica logo a seguir ao original (duplicateBlock em trip.js)
  $('#f-dup').addEventListener('click',()=>{ if(!findBlock(activeTrip(),S.editingId)) return; pushHistory(); const c=duplicateBlock(activeTrip(), S.editingId, newId); commit(); openEditor(c.id); toast(tr('tDupActivity')); });
  $('#f-tray').addEventListener('click',()=>{ edit(b=>toTray(activeTrip(),b.id)); $('#editor').hidden=true; S.editingId=null; });
  $('#f-del').addEventListener('click',()=>{ $('#f-del-confirm').hidden=false; $('#f-del-yes').focus(); });
  $('#f-del-no').addEventListener('click',()=>{ $('#f-del-confirm').hidden=true; });
  $('#f-del-yes').addEventListener('click',()=>{ const id=S.editingId, t=activeTrip(); pushHistory(); t.blocks=t.blocks.filter(b=>b.id!==id); t.tray=t.tray.filter(b=>b.id!==id); $('#editor').hidden=true; S.editingId=null; commit(); toast(tr('tDelActivity')); });
}
