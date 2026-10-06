/* ---------- drag & drop ----------
   Rato: arrasta logo. Toque: carregar ~300 ms antes de arrastar (a pega de baixo arrasta logo).
   Mover para outra coluna/hora, para o tabuleiro "por agendar", ou mudar a duração pela pega. */
import { tr } from '../i18n.js';
import { clockLabel, durationLabel, dayLabel } from '../util.js';
import { $, pxPerMin, toast, announce } from './dom.js';
import { S, activeTrip, pushHistory, dropHistory } from '../state.js';
import { findBlock, moveTo, toTray, rangeLabel, boardFrame, toBoard } from '../trip.js';
import { absStart, segments } from '../span.js';
import { boardTime, dropSlot, resizeEnd, clashesOn } from '../moves.js';
import { commit } from '../sync.js';
import { render } from './board.js';
import { openEditor } from './editor.js';

function onPointerDown(e){
  const el=e.target.closest('.blk'); if(!el || e.button>0 || !activeTrip()) return;
  const f=findBlock(activeTrip(),el.dataset.id); if(!f) return;
  const isGrip=!!e.target.closest('.grip'); const r=el.getBoundingClientRect();
  S.drag={id:el.dataset.id, el, pointerId:e.pointerId, type:e.pointerType, x0:e.clientX, y0:e.clientY, x:e.clientX, y:e.clientY, mode:isGrip?'resize':'move', active:false, offY:e.clientY-r.top, offX:e.clientX-r.left, w:r.width, h:r.height, locked:!!f.b.locked, timer:null};
  if(isGrip && e.pointerType!=='mouse'){ e.preventDefault(); startDrag(); }
  else if(e.pointerType!=='mouse' && !isGrip){ S.drag.timer=setTimeout(()=>{ const drag=S.drag; if(drag && !drag.active && !drag.cancelled) startDrag(); },300); }
}
/* Tudo aqui é na hora do quadro (frame, ver boardFrame); as contas de onde fica estão em moves.js.
   As posições do rato passam a minutos com /pxPerMin() antes de lá chegarem. */
function startDrag(){
  const drag=S.drag; if(!drag) return;
  if(drag.locked){ toast(tr('tLocked')); drag.cancelled=true; return; }
  drag.active=true; pushHistory(); drag.undoPoint=S.history[S.history.length-1]; document.body.classList.add('is-dragging');
  const t=activeTrip(), f=findBlock(activeTrip(),drag.id), col=drag.el.closest('.day-col'); drag.frame=boardFrame(t);
  if(drag.mode==='move'){
    // no quadro, o fantasma tem o tamanho do pedaço agarrado (uma atividade de 30 h não cabe no ecrã)
    const g=drag.el.cloneNode(true); g.classList.add('ghost'); g.classList.remove('flash');
    const hp=col ? drag.h : Math.min(f.b.len*pxPerMin(), 160)-2; g.style.width=Math.max(drag.w,130)+'px'; g.style.height=hp+'px'; g.style.left='0'; g.style.top='0';
    document.body.appendChild(g); drag.ghost=g; drag.offY=Math.min(drag.offY,hp-4); drag.el.classList.add('dragging');
  }
  // que minuto da atividade ficou debaixo do dedo ou do rato
  drag.grab = col ? boardTime(t,drag.frame,col.dataset.date,(drag.y0-col.getBoundingClientRect().top)/pxPerMin())-absStart(t,f.b)-drag.frame.shiftMin : drag.offY/pxPerMin();
  if(navigator.vibrate && drag.type==='touch'){ try{ navigator.vibrate(12); }catch{} }
  updateDrag(); autoScroll();
}
function onPointerMove(e){
  const drag=S.drag; if(!drag || e.pointerId!==drag.pointerId) return;
  drag.x=e.clientX; drag.y=e.clientY;
  if(!drag.active){ const dist=Math.hypot(e.clientX-drag.x0,e.clientY-drag.y0);
    if(drag.type==='mouse' && dist>4 && !drag.cancelled) startDrag();
    else if(drag.type!=='mouse' && dist>8){ clearTimeout(drag.timer); drag.cancelled=true; }
    return; }
  e.preventDefault(); queueDrag();
}
/* No máximo uma atualização por frame: o rato e o toque mandam vários eventos por frame (e no toque chegam pointermove e touchmove). */
let dragRaf=0;
function queueDrag(){ if(!dragRaf) dragRaf=requestAnimationFrame(()=>{ dragRaf=0; updateDrag(); }); }
function clearTargets(){ document.querySelectorAll('.drop-target').forEach(x=>x.classList.remove('drop-target')); document.querySelectorAll('.preview').forEach(p=>p.remove()); }
/* Contorno de onde a atividade vai ficar, em todas as colunas por onde passa (b na hora da viagem). */
function preview(t, frame, b, label, bad){
  segments(t,b,frame.dates.length,frame.shiftMin).forEach((s,k)=>{
    const col=document.querySelector(`.day-col[data-date="${CSS.escape(frame.dates[s.i])}"]`); if(!col) return;
    const p=document.createElement('div'); p.className='preview'+(bad?' bad':'')+(s.cutTop?' cut-top':'')+(s.cutBot?' cut-bot':'');
    p.style.top=(s.top*pxPerMin())+'px'; p.style.height=((s.bot-s.top)*pxPerMin())+'px';
    if(!k) p.innerHTML=`<span>${label}</span>`; col.appendChild(p);
  });
}
function updateDrag(){
  const drag=S.drag; if(!drag||!drag.active) return;
  const t=activeTrip(), f=findBlock(activeTrip(),drag.id); if(!f) return; const b=f.b, frame=drag.frame;
  // primeiro as leituras do DOM e só depois as escritas, para o browser não ter de refazer o layout a meio
  const hit=document.elementFromPoint(drag.x,drag.y), tray=hit&&hit.closest('#tray');
  const col=(hit&&hit.closest('.day-col')) || (drag.mode==='resize' ? drag.el.closest('.day-col') : null);
  const dy=col ? drag.y-col.getBoundingClientRect().top : 0;
  if(drag.ghost) drag.ghost.style.transform=`translate(${drag.x-Math.min(drag.offX,120)}px, ${drag.y-drag.offY}px) rotate(-1.2deg)`;
  // a grelha anda de 15 em 15 minutos: enquanto o destino for o mesmo, as marcas ficam como estão
  const show=(key, target, draw)=>{ if(key===drag.key) return; drag.key=key; drag.target=target; clearTargets(); if(draw) draw(); };
  if(drag.mode==='resize'){
    if(!col) return show('', null);
    // o fim pode ir para a coluna seguinte: a atividade passa a continuar no outro dia (resizeEnd em moves.js)
    const tripPos={date:b.date, start:b.start, len:resizeEnd(t,frame,b,col.dataset.date,dy/pxPerMin())};
    return show('len'+tripPos.len, {len:tripPos.len}, ()=>preview(t, frame, tripPos, `${rangeLabel({start:toBoard(t,frame,b).start, len:tripPos.len})} · ${durationLabel(tripPos.len)}`, false));
  }
  if(col){
    // boardDate/boardStart: onde fica no quadro; tripPos: o mesmo na hora da viagem (o que se grava)
    const {date, start, boardDate, boardStart}=dropSlot(t,frame,col.dataset.date,dy/pxPerMin(),drag.grab), tripPos={date, start, len:b.len};
    return show(col.dataset.date+'|'+boardDate+'|'+boardStart, {date:tripPos.date, start:tripPos.start, boardDate, boardStart}, ()=>{
      col.classList.add('drop-target');
      const clash=clashesOn(t,b,tripPos.date);
      preview(t, frame, tripPos, `${dayLabel(boardDate)} · ${rangeLabel({start:boardStart, len:b.len})}${clash?tr('seeWarnings'):''}`, clash);
    });
  }
  if(tray) show('tray', {tray:true}, ()=>tray.classList.add('drop-target'));
  else show('', null);
}
function autoScroll(){
  const drag=S.drag; if(!drag||!drag.active) return;
  const scroller=$('#scroller'), r=scroller.getBoundingClientRect(), edge=56; let dx=0, dy=0;
  if(drag.y<r.top+edge+50 && drag.y>r.top-20) dy=-Math.ceil((r.top+edge+50-drag.y)/6);
  else if(drag.y>r.bottom-edge && drag.y<r.bottom+10) dy=Math.ceil((drag.y-(r.bottom-edge))/6);
  if(drag.x<r.left+edge+40) dx=-Math.ceil((r.left+edge+40-drag.x)/5);
  else if(drag.x>r.right-edge) dx=Math.ceil((drag.x-(r.right-edge))/5);
  if(dx||dy){ scroller.scrollBy(dx,dy); queueDrag(); }
  requestAnimationFrame(autoScroll);
}
/* Tira o ponto de Desfazer do arrasto, mas só se ainda for o do topo: um 409 ou o refetch podem tê-lo apagado. */
function dropOwn(d){ if(S.history.length && S.history[S.history.length-1]===d.undoPoint) dropHistory(); }
function endDrag(e){
  if(!S.drag || e.pointerId!==S.drag.pointerId) return;
  // a última posição pode ainda estar à espera do próximo frame
  if(dragRaf){ cancelAnimationFrame(dragRaf); dragRaf=0; updateDrag(); }
  clearTimeout(S.drag.timer); const d=S.drag; S.drag=null;
  document.body.classList.remove('is-dragging'); if(d.ghost) d.ghost.remove(); clearTargets();
  if(!d.active){ if(!d.cancelled && e.type==='pointerup' && Math.hypot(e.clientX-d.x0,e.clientY-d.y0)<8 && !(e.target.closest&&e.target.closest('.grip'))) openEditor(d.id); return; }
  if(e.type==='pointercancel' || !d.target){ dropOwn(d); render(); return; }
  // desfeita, apagada ou substituída por um 409 ou pelo refetch durante o arrasto
  const f=findBlock(activeTrip(),d.id); if(!f){ dropOwn(d); render(); return; }
  if(d.mode==='resize'){ f.b.len=d.target.len; announce(`${f.b.title}: ${durationLabel(f.b.len)}`); }
  else if(d.target.tray){ toTray(activeTrip(),d.id); announce(tr('movedToTray',{a:f.b.title})); }
  else { moveTo(activeTrip(),d.id,d.target.date,d.target.start); announce(`${f.b.title} → ${dayLabel(d.target.boardDate,true)}, ${clockLabel(d.target.boardStart)}`); }
  commit(); S.suppressClick=true; setTimeout(()=>S.suppressClick=false,50);
}
/* Liga o arrasto (main.js chama-a uma vez ao arrancar). */
export function initDrag(){
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove, {passive:false});
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', e=>{ const drag=S.drag; if(drag && drag.active && drag.type!=='mouse') return; endDrag(e); });
  document.addEventListener('touchmove', e=>{ const drag=S.drag; if(drag&&drag.active){ e.preventDefault(); const tt=e.touches[0]; if(tt){ drag.x=tt.clientX; drag.y=tt.clientY; queueDrag(); } } },{passive:false});
  document.addEventListener('touchend', ()=>{ const drag=S.drag; if(drag&&drag.active&&drag.type!=='mouse') endDrag({pointerId:drag.pointerId,type:'pointerup',clientX:drag.x,clientY:drag.y,target:document.body}); });
  document.addEventListener('contextmenu', e=>{ if(e.target.closest('.blk')) e.preventDefault(); });
}
