/* ---------- drag & drop ----------
   Rato: arrasta logo. Toque: carregar ~300 ms antes de arrastar (a pega de baixo arrasta logo).
   Mover para outra coluna/hora, para o tabuleiro "por agendar", ou mudar a duração pela pega. */
import { tr } from '../i18n.js';
import { $, PXM, SNAP, parseISO, mlabel, durLabel, dayLabel, toast, announce } from '../util.js';
import { S, T, pushHistory, dropHistory } from '../state.js';
import { view, findBlock, moveTo, toTray, inView, fromView } from '../trip.js';
import { commit } from '../sync.js';
import { render } from './board.js';
import { openEditor } from './editor.js';

const scroller=$('#scroller');
document.addEventListener('pointerdown', e=>{
  const el=e.target.closest('.blk'); if(!el || e.button>0 || !T()) return;
  const f=findBlock(el.dataset.id); if(!f) return;
  const isGrip=!!e.target.closest('.grip'); const r=el.getBoundingClientRect();
  S.drag={id:el.dataset.id, el, pointerId:e.pointerId, type:e.pointerType, x0:e.clientX, y0:e.clientY, x:e.clientX, y:e.clientY, mode:isGrip?'resize':'move', active:false, offY:e.clientY-r.top, offX:e.clientX-r.left, w:r.width, locked:!!f.b.locked, timer:null};
  if(isGrip && e.pointerType!=='mouse'){ e.preventDefault(); startDrag(); }
  else if(e.pointerType!=='mouse' && !isGrip){ S.drag.timer=setTimeout(()=>{ const drag=S.drag; if(drag && !drag.active && !drag.cancelled) startDrag(); },300); }
});
function startDrag(){
  const drag=S.drag; if(!drag) return;
  if(drag.locked){ toast(tr('tLocked')); drag.cancelled=true; return; }
  drag.active=true; pushHistory(); document.body.classList.add('is-dragging');
  const f=findBlock(drag.id);
  if(drag.mode==='move'){
    const g=drag.el.cloneNode(true); g.classList.add('ghost'); g.classList.remove('flash');
    const hp=f.b.len*PXM()-2; g.style.width=Math.max(drag.w,130)+'px'; g.style.height=hp+'px'; g.style.left='0'; g.style.top='0';
    document.body.appendChild(g); drag.ghost=g; drag.offY=Math.min(drag.offY,hp-4); drag.el.classList.add('dragging');
  }
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
  e.preventDefault(); updateDrag();
},{passive:false});
function clearTargets(){ document.querySelectorAll('.drop-target').forEach(x=>x.classList.remove('drop-target')); const p=document.querySelector('.preview'); if(p) p.remove(); }
function updateDrag(){
  const drag=S.drag; if(!drag||!drag.active) return;
  const t=T(), f=findBlock(drag.id); if(!f) return; const b=f.b, v=view(t);
  // tudo aqui é na hora do quadro (vs = início da atividade no quadro); moveTo converte para a hora da viagem
  clearTargets(); drag.target=null;
  if(drag.mode==='resize'){
    const col=drag.el.closest('.day-col'); if(!col) return; const r=col.getBoundingClientRect();
    const vs=inView(t,b).start;
    let end=v.T0+Math.round((drag.y-r.top)/PXM()/SNAP)*SNAP; end=Math.max(vs+SNAP, Math.min(v.T1,end));
    drag.target={len:end-vs};
    const p=document.createElement('div'); p.className='preview'; p.style.top=((vs-v.T0)*PXM())+'px'; p.style.height=((end-vs)*PXM())+'px';
    p.innerHTML=`<span>${mlabel(vs)}–${mlabel(end)} · ${durLabel(end-vs)}</span>`; col.appendChild(p); return;
  }
  drag.ghost.style.transform=`translate(${drag.x-Math.min(drag.offX,120)}px, ${drag.y-drag.offY}px) rotate(-1.2deg)`;
  const hit=document.elementFromPoint(drag.x,drag.y); const col=hit&&hit.closest('.day-col'); const tray=hit&&hit.closest('#tray');
  if(col){
    const date=col.dataset.date, r=col.getBoundingClientRect();
    let s=v.T0+Math.round((drag.y-drag.offY-r.top)/PXM()/SNAP)*SNAP; s=Math.max(v.T0, Math.min(v.T1-b.len, s));
    drag.target={date,start:s}; col.classList.add('drop-target');
    const td=fromView(t,date,s).date, wd=parseISO(td).getDay(); const dp=t.dayPlaces[td]||[];
    const clash=(b.weekdays&&b.weekdays.length&&!b.weekdays.includes(wd)) || (b.place&&dp.length&&!dp.includes(b.place));
    const p=document.createElement('div'); p.className='preview'+(clash?' bad':''); p.style.top=((s-v.T0)*PXM())+'px'; p.style.height=(b.len*PXM())+'px';
    p.innerHTML=`<span>${dayLabel(date)} · ${mlabel(s)}–${mlabel(s+b.len)}${clash?tr('seeWarnings'):''}</span>`; col.appendChild(p);
  } else if(tray){ drag.target={tray:true}; tray.classList.add('drop-target'); }
}
function autoScroll(){
  const drag=S.drag; if(!drag||!drag.active) return;
  const r=scroller.getBoundingClientRect(), edge=56; let dx=0, dy=0;
  if(drag.y<r.top+edge+50 && drag.y>r.top-20) dy=-Math.ceil((r.top+edge+50-drag.y)/6);
  else if(drag.y>r.bottom-edge && drag.y<r.bottom+10) dy=Math.ceil((drag.y-(r.bottom-edge))/6);
  if(drag.x<r.left+edge+40) dx=-Math.ceil((r.left+edge+40-drag.x)/5);
  else if(drag.x>r.right-edge) dx=Math.ceil((drag.x-(r.right-edge))/5);
  if(dx||dy){ scroller.scrollBy(dx,dy); updateDrag(); }
  requestAnimationFrame(autoScroll);
}
function endDrag(e){
  if(!S.drag || e.pointerId!==S.drag.pointerId) return;
  clearTimeout(S.drag.timer); const d=S.drag; S.drag=null;
  document.body.classList.remove('is-dragging'); if(d.ghost) d.ghost.remove(); clearTargets();
  if(!d.active){ if(!d.cancelled && e.type==='pointerup' && Math.hypot(e.clientX-d.x0,e.clientY-d.y0)<8 && !(e.target.closest&&e.target.closest('.grip'))) openEditor(d.id); return; }
  if(e.type==='pointercancel' || !d.target){ dropHistory(); render(); return; }
  const f=findBlock(d.id);
  if(d.mode==='resize'){ f.b.len=d.target.len; announce(`${f.b.title}: ${durLabel(f.b.len)}`); }
  else if(d.target.tray){ toTray(d.id); announce(tr('movedToTray',{a:f.b.title})); }
  else { moveTo(d.id,d.target.date,d.target.start); announce(`${f.b.title} → ${dayLabel(d.target.date,true)}, ${mlabel(d.target.start)}`); }
  commit(); S.suppressClick=true; setTimeout(()=>S.suppressClick=false,50);
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', e=>{ const drag=S.drag; if(drag && drag.active && drag.type!=='mouse') return; endDrag(e); });
document.addEventListener('touchmove', e=>{ const drag=S.drag; if(drag&&drag.active){ e.preventDefault(); const tt=e.touches[0]; if(tt){ drag.x=tt.clientX; drag.y=tt.clientY; updateDrag(); } } },{passive:false});
document.addEventListener('touchend', ()=>{ const drag=S.drag; if(drag&&drag.active&&drag.type!=='mouse') endDrag({pointerId:drag.pointerId,type:'pointerup',clientX:drag.x,clientY:drag.y,target:document.body}); });
document.addEventListener('contextmenu', e=>{ if(e.target.closest('.blk')) e.preventDefault(); });
