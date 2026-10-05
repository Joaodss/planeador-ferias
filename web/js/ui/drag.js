/* ---------- drag & drop ----------
   Rato: arrasta logo. Toque: carregar ~300 ms antes de arrastar (a pega de baixo arrasta logo).
   Mover para outra coluna/hora, para o tabuleiro "por agendar", ou mudar a duração pela pega. */
import { tr } from '../i18n.js';
import { $, PXM, SNAP, parseISO, mlabel, durLabel, dayLabel, toast, announce } from '../util.js';
import { S, T, pushHistory, dropHistory } from '../state.js';
import { view, findBlock, moveTo, toTray, rangeLabel, boardFrame, toBoard, fromBoard } from '../trip.js';
import { absStart, slotAt, segments } from '../span.js';
import { commit } from '../sync.js';
import { render } from './board.js';
import { openEditor } from './editor.js';

const scroller=$('#scroller');
document.addEventListener('pointerdown', e=>{
  const el=e.target.closest('.blk'); if(!el || e.button>0 || !T()) return;
  const f=findBlock(el.dataset.id); if(!f) return;
  const isGrip=!!e.target.closest('.grip'); const r=el.getBoundingClientRect();
  S.drag={id:el.dataset.id, el, pointerId:e.pointerId, type:e.pointerType, x0:e.clientX, y0:e.clientY, x:e.clientX, y:e.clientY, mode:isGrip?'resize':'move', active:false, offY:e.clientY-r.top, offX:e.clientX-r.left, w:r.width, h:r.height, locked:!!f.b.locked, timer:null};
  if(isGrip && e.pointerType!=='mouse'){ e.preventDefault(); startDrag(); }
  else if(e.pointerType!=='mouse' && !isGrip){ S.drag.timer=setTimeout(()=>{ const drag=S.drag; if(drag && !drag.active && !drag.cancelled) startDrag(); },300); }
});
/* Minuto absoluto do quadro (desde a meia-noite da 1.ª coluna) dy píxeis abaixo do topo da coluna do dia date.
   Tudo aqui é na hora do quadro (F, ver boardFrame); só o que se grava passa para a hora da viagem. */
function timeAt(t, F, date, dy){ return F.ds.indexOf(date)*1440 + view(t).T0 + dy/PXM(); }
function startDrag(){
  const drag=S.drag; if(!drag) return;
  if(drag.locked){ toast(tr('tLocked')); drag.cancelled=true; return; }
  drag.active=true; pushHistory(); drag.snap=S.history[S.history.length-1]; document.body.classList.add('is-dragging');
  const t=T(), f=findBlock(drag.id), col=drag.el.closest('.day-col'); drag.F=boardFrame(t);
  if(drag.mode==='move'){
    // no quadro, o fantasma tem o tamanho do pedaço agarrado (uma atividade de 30 h não cabe no ecrã)
    const g=drag.el.cloneNode(true); g.classList.add('ghost'); g.classList.remove('flash');
    const hp=col ? drag.h : Math.min(f.b.len*PXM(), 160)-2; g.style.width=Math.max(drag.w,130)+'px'; g.style.height=hp+'px'; g.style.left='0'; g.style.top='0';
    document.body.appendChild(g); drag.ghost=g; drag.offY=Math.min(drag.offY,hp-4); drag.el.classList.add('dragging');
  }
  // que minuto da atividade ficou debaixo do dedo ou do rato
  drag.grab = col ? timeAt(t,drag.F,col.dataset.date,drag.y0-col.getBoundingClientRect().top)-absStart(t,f.b)-drag.F.sh : drag.offY/PXM();
  if(navigator.vibrate && drag.type==='touch'){ try{ navigator.vibrate(12); }catch(e){} }
  updateDrag(); autoScroll();
}
document.addEventListener('pointermove', e=>{
  const drag=S.drag; if(!drag || e.pointerId!==drag.pointerId) return;
  drag.x=e.clientX; drag.y=e.clientY;
  if(!drag.active){ const dist=Math.hypot(e.clientX-drag.x0,e.clientY-drag.y0);
    if(drag.type==='mouse' && dist>4 && !drag.cancelled) startDrag();
    else if(drag.type!=='mouse' && dist>8){ clearTimeout(drag.timer); drag.cancelled=true; }
    return; }
  e.preventDefault(); queueDrag();
},{passive:false});
/* No máximo uma atualização por frame: o rato e o toque mandam vários eventos por frame (e no toque chegam pointermove e touchmove). */
let dragRaf=0;
function queueDrag(){ if(!dragRaf) dragRaf=requestAnimationFrame(()=>{ dragRaf=0; updateDrag(); }); }
function clearTargets(){ document.querySelectorAll('.drop-target').forEach(x=>x.classList.remove('drop-target')); document.querySelectorAll('.preview').forEach(p=>p.remove()); }
/* Contorno de onde a atividade vai ficar, em todas as colunas por onde passa (b na hora da viagem). */
function preview(t, F, b, label, bad){
  segments(t,b,F.ds.length,F.sh).forEach((s,k)=>{
    const col=document.querySelector(`.day-col[data-date="${CSS.escape(F.ds[s.i])}"]`); if(!col) return;
    const p=document.createElement('div'); p.className='preview'+(bad?' bad':'')+(s.cutTop?' cut-top':'')+(s.cutBot?' cut-bot':'');
    p.style.top=(s.top*PXM())+'px'; p.style.height=((s.bot-s.top)*PXM())+'px';
    if(!k) p.innerHTML=`<span>${label}</span>`; col.appendChild(p);
  });
}
function updateDrag(){
  const drag=S.drag; if(!drag||!drag.active) return;
  const t=T(), f=findBlock(drag.id); if(!f) return; const b=f.b, v=view(t), F=drag.F, ds=F.ds;
  // primeiro as leituras do DOM e só depois as escritas, para o browser não ter de refazer o layout a meio
  const hit=document.elementFromPoint(drag.x,drag.y), tray=hit&&hit.closest('#tray');
  const col=(hit&&hit.closest('.day-col')) || (drag.mode==='resize' ? drag.el.closest('.day-col') : null);
  const dy=col ? drag.y-col.getBoundingClientRect().top : 0;
  if(drag.ghost) drag.ghost.style.transform=`translate(${drag.x-Math.min(drag.offX,120)}px, ${drag.y-drag.offY}px) rotate(-1.2deg)`;
  // a grelha anda de 15 em 15 minutos: enquanto o destino for o mesmo, as marcas ficam como estão
  const show=(key, target, draw)=>{ if(key===drag.key) return; drag.key=key; drag.target=target; clearTargets(); if(draw) draw(); };
  if(drag.mode==='resize'){
    if(!col) return show('', null);
    // o fim pode ir para a coluna seguinte: a atividade passa a continuar no outro dia
    const j=ds.indexOf(col.dataset.date), A=absStart(t,b)+F.sh;
    let end=j*1440+v.T0+Math.round(dy/PXM()/SNAP)*SNAP; end=Math.max(A+SNAP, Math.min(j*1440+v.T1,end));
    const nb={date:b.date, start:b.start, len:end-A};
    return show('len'+nb.len, {len:nb.len}, ()=>preview(t, F, nb, `${rangeLabel({start:toBoard(t,F,b).start, len:nb.len})} · ${durLabel(nb.len)}`, false));
  }
  if(col){
    // bd/bs: onde fica no quadro; nb: o mesmo na hora da viagem (o que se grava)
    const raw=timeAt(t,F,col.dataset.date,dy)-drag.grab; const sl=slotAt(t, Math.round(raw/SNAP)*SNAP, ds.length);
    const bd=ds[sl.i], bs=sl.start, nb={...fromBoard(t,F,bd,bs), len:b.len};
    return show(col.dataset.date+'|'+bd+'|'+bs, {date:nb.date, start:nb.start, bd, bs}, ()=>{
      col.classList.add('drop-target');
      const wd=parseISO(nb.date).getDay(); const dp=t.dayPlaces[nb.date]||[];
      const clash=(b.weekdays&&b.weekdays.length&&!b.weekdays.includes(wd)) || (b.place&&dp.length&&!dp.includes(b.place));
      preview(t, F, nb, `${dayLabel(bd)} · ${rangeLabel({start:bs, len:b.len})}${clash?tr('seeWarnings'):''}`, clash);
    });
  }
  if(tray) show('tray', {tray:true}, ()=>tray.classList.add('drop-target'));
  else show('', null);
}
function autoScroll(){
  const drag=S.drag; if(!drag||!drag.active) return;
  const r=scroller.getBoundingClientRect(), edge=56; let dx=0, dy=0;
  if(drag.y<r.top+edge+50 && drag.y>r.top-20) dy=-Math.ceil((r.top+edge+50-drag.y)/6);
  else if(drag.y>r.bottom-edge && drag.y<r.bottom+10) dy=Math.ceil((drag.y-(r.bottom-edge))/6);
  if(drag.x<r.left+edge+40) dx=-Math.ceil((r.left+edge+40-drag.x)/5);
  else if(drag.x>r.right-edge) dx=Math.ceil((drag.x-(r.right-edge))/5);
  if(dx||dy){ scroller.scrollBy(dx,dy); queueDrag(); }
  requestAnimationFrame(autoScroll);
}
/* Tira o ponto de Desfazer do arrasto, mas só se ainda for o do topo: um 409 ou o refetch podem tê-lo apagado. */
function dropOwn(d){ if(S.history.length && S.history[S.history.length-1]===d.snap) dropHistory(); }
function endDrag(e){
  if(!S.drag || e.pointerId!==S.drag.pointerId) return;
  // a última posição pode ainda estar à espera do próximo frame
  if(dragRaf){ cancelAnimationFrame(dragRaf); dragRaf=0; updateDrag(); }
  clearTimeout(S.drag.timer); const d=S.drag; S.drag=null;
  document.body.classList.remove('is-dragging'); if(d.ghost) d.ghost.remove(); clearTargets();
  if(!d.active){ if(!d.cancelled && e.type==='pointerup' && Math.hypot(e.clientX-d.x0,e.clientY-d.y0)<8 && !(e.target.closest&&e.target.closest('.grip'))) openEditor(d.id); return; }
  if(e.type==='pointercancel' || !d.target){ dropOwn(d); render(); return; }
  // desfeita, apagada ou substituída por um 409 ou pelo refetch durante o arrasto
  const f=findBlock(d.id); if(!f){ dropOwn(d); render(); return; }
  if(d.mode==='resize'){ f.b.len=d.target.len; announce(`${f.b.title}: ${durLabel(f.b.len)}`); }
  else if(d.target.tray){ toTray(d.id); announce(tr('movedToTray',{a:f.b.title})); }
  else { moveTo(d.id,d.target.date,d.target.start); announce(`${f.b.title} → ${dayLabel(d.target.bd,true)}, ${mlabel(d.target.bs)}`); }
  commit(); S.suppressClick=true; setTimeout(()=>S.suppressClick=false,50);
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', e=>{ const drag=S.drag; if(drag && drag.active && drag.type!=='mouse') return; endDrag(e); });
document.addEventListener('touchmove', e=>{ const drag=S.drag; if(drag&&drag.active){ e.preventDefault(); const tt=e.touches[0]; if(tt){ drag.x=tt.clientX; drag.y=tt.clientY; queueDrag(); } } },{passive:false});
document.addEventListener('touchend', ()=>{ const drag=S.drag; if(drag&&drag.active&&drag.type!=='mouse') endDrag({pointerId:drag.pointerId,type:'pointerup',clientX:drag.x,clientY:drag.y,target:document.body}); });
document.addEventListener('contextmenu', e=>{ if(e.target.closest('.blk')) e.preventDefault(); });
