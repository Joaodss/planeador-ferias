/* O quadro: cabeçalho da viagem, grelha de dias e horas, tabuleiro "por agendar" e totais. */
import { tr } from '../i18n.js';
import { esc, shortPlaceName, weekdayNames, monthNames, statusLabel, parseISO, clockLabel, durationLabel, dayLabel, newId } from '../util.js';
import { $, isMobile, refreshSlot, pxPerMin, announce } from './dom.js';
import { S, activeTrip, ensureActive, pushHistory } from '../state.js';
import { tripDates, boardHours, money, placeById, placeName, findBlock, boardLayout, rangeLabel, boardFrame, toBoard, fromBoard, blockZoneTime, newBlock, routeSummary, dateRangeLabel, dayEnds } from '../trip.js';
import { laneLayout } from '../span.js';
import { keyMove } from '../moves.js';
import { tripStats, dayTotalsPP } from '../costs.js';
import { computeWarnings } from '../warnings.js';
import { TZ, secondTz, setViewingHome } from '../tz.js';
import { commit, undo } from '../sync.js';
import { closeSheets } from './sheets.js';
import { openEditor, fillEditor } from './editor.js';
import { openDay, fillDay } from './daysheet.js';
import { openTripSheet } from './tripsheet.js';
import { renderDash } from './costsheet.js';
import { renderWarnings } from './warnings.js';

/* seg: o pedaço visível numa coluna (null no tabuleiro). Um pedaço cortado continua noutro dia ou nas horas escondidas.
   boardPos: dia e hora da atividade no quadro (toBoard), que pode estar no segundo fuso.
   bz: a hora local no fuso da atividade, quando não é o do quadro (blockZoneTime). */
function blockEl(t, b, warnMap, seg, boardPos, bz){
  const inTray=!seg; const el=document.createElement('div');
  el.className='blk cat-'+b.cat+(b.locked?' locked':'')+(b.status==='ideia'?' status-ideia':'')+(seg&&seg.cutTop?' cut-top':'')+(seg&&seg.cutBot?' cut-bot':'');
  el.dataset.id=b.id; el.tabIndex=0; el.setAttribute('role','button');
  const w=warnMap.get(b.id);
  const cost = b.pp ? `<span class="eur">${money(t,b.pp)} pp</span>` : (b.total ? `<span class="eur">${money(t,b.total)}</span>` : '');
  const statusText = statusLabel(b.status), statusBadge = statusText ? `<span class="st st-${b.status}">${(b.status==='reservado'||b.status==='pago')?'✓ ':''}${esc(statusText)}</span>` : '';
  const time = inTray ? durationLabel(b.len) : rangeLabel({start:boardPos.start, len:b.len});
  const ltz = bz ? tr('secAt',{city:TZ.city(bz.tz), range:`${clockLabel(bz.start)}–${clockLabel(bz.start+bz.len)}`})+(bz.days<0?tr('prevDay'):bz.days>0?tr('nextDay'):'') : '';
  el.innerHTML = `<div class="t">${esc(b.title)}</div><div class="m"><span>${time}</span>${bz?`<span class="ltz" title="${esc(ltz)}">${clockLabel(bz.start)} ${esc(TZ.city(bz.tz))}</span>`:''}${cost}${statusBadge}</div>`
    + (w?`<span class="badge" title="${esc(w.map(x=>x.title).join('\n'))}">!</span>`:'')
    + (b.locked?`<svg class="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`:'')
    + (inTray||seg.cutBot?'':'<div class="grip" aria-hidden="true"></div>');
  if(w){ el.classList.add('has-badge'); if(w.some(x=>x.sev==='bad')) el.classList.add('bad'); }
  el.setAttribute('aria-label', `${b.title}, ${inTray?tr('unscheduledLower'):dayLabel(boardPos.date,true)+' '+time}${ltz?', '+ltz:''}${statusText?', '+statusText:''}${w?', '+tr('nWarnings',{n:w.length}):''}`);
  return el;
}
/* Redesenha tudo a partir do estado (S e a viagem ativa); é o gancho render de sync.js, chamado por commit()
   depois de cada alteração, ao carregar do servidor e ao mudar de língua. Pode ser chamada a qualquer momento,
   também sem viagem (mostra o ecrã vazio). Passos:
   1. o seletor de viagens, o título e o cabeçalho (datas, percurso e fusos);
   2. as colunas do quadro (boardFrame) e onde fica cada atividade: layout no fuso do quadro e tripLayout na hora
      da viagem, que só é outro cálculo quando o quadro está no segundo fuso;
   3. os pontos a rever (computeWarnings), para as marcas "!" nos blocos;
   4. cabeçalhos dos dias, coluna das horas e colunas com os blocos (laneLayout põe lado a lado os que se sobrepõem)
      e as marcas das atividades escondidas;
   5. o tabuleiro "por agendar" e os totais do rodapé;
   6. os painéis abertos (editor, dia, custos, avisos), com {refresh:true} para não mexer no campo com o foco.
   Mantém o scroll da grelha (guardado antes de esvaziar o quadro). Não grava; do estado só acerta a viagem ativa
   (ensureActive) e guarda os avisos em S.lastWarnings. */
export function render(){
  refreshSlot(); ensureActive(); refreshUndo();
  const t=activeTrip();
  // trip switcher
  const sel=$('#trip-sel'); sel.innerHTML = `<option value="">${S.store.trips.length>1?tr('switchTrip'):tr('trips')}</option>` + S.store.trips.map(x=>`<option value="${esc(x.id)}"${t&&x.id===t.id?' disabled':''}>${esc(x.name)}${t&&x.id===t.id?tr('openMark'):''}</option>`).join('') + `<option value="__new">${tr('newTripOpt')}</option>`;
  sel.value='';
  const board=$('#board'); const sc=$('#scroller'); const scrollX=sc.scrollLeft, scrollY=sc.scrollTop;
  board.innerHTML='';
  if(!t){
    $('#trip-name').textContent=tr('appName'); $('#route').textContent=''; board.classList.remove('two-tz');
    board.style.gridTemplateColumns='1fr';
    board.innerHTML = `<div class="empty-board"><div class="card"><h2>${tr('emptyH')}</h2><p>${tr('emptyP')}</p><div class="actions"><button class="btn primary" type="button" id="empty-new">${tr('newTrip')}</button><button class="btn" type="button" id="empty-import">${tr('importBackup')}</button></div></div></div>`;
    $('#empty-new').addEventListener('click',()=>openTripSheet({isNew:true}));
    $('#empty-import').addEventListener('click',()=>$('#import-file').click());
    document.title=tr('appName');
    $('#tray-list').innerHTML=''; ['#tot-pp','#tot-n','#tot-res'].forEach(s=>$(s).textContent='—'); $('#warn-txt').textContent='—'; return;
  }
  document.title = t.name ? `${t.name} · ${tr('appName')}` : tr('appName');
  $('#trip-name').textContent=t.name;
  // frame: colunas do quadro e deslocamento quando o quadro está no segundo fuso (ver boardFrame)
  const tds=tripDates(t), hours=boardHours(t), colHeight=hours.span*pxPerMin(), frame=boardFrame(t), ds=frame.dates;
  // sítios por onde passa e datas
  const seq=routeSummary(t), range=dateRangeLabel(t);
  // sec: segundo fuso. off≠0 quando o quadro está na hora do segundo fuso: aí as duas cidades trocam de papel.
  const sec=secondTz(t), off=frame.offsetMin;
  const main = off ? sec.tz : t.tz, other = sec && (off ? {tz:t.tz, diff:-sec.diff} : sec);
  $('#route').innerHTML = `<span>${range} · ${tr('nDays',{n:tds.length})}</span>` + (seq.length ? '<span class="arrow">·</span>'+seq.map(p=>`<b>${esc(shortPlaceName(placeName(t,p)))}</b>`).join('<span class="arrow">→</span>') : `<span class="arrow">·</span><span>${tr('clickDay')}</span>`)
    + (TZ.valid(t.tz) ? `<span class="arrow">·</span><span title="${esc(main)}">${tr('tzRoute',{city:esc(TZ.city(main))})}${other?` (${esc(TZ.city(other.tz))} ${TZ.diffLabel(other.diff)})`:''}</span>` : '')
    + (off ? `<span class="arrow">·</span><span>${tr('tzDatesNote',{city:esc(TZ.city(t.tz))})}</span>` : '');
  const narrow=isMobile();
  board.classList.toggle('two-tz', !!sec);
  board.style.gridTemplateColumns = `${sec?(narrow?84:98):(narrow?48:58)}px repeat(${ds.length}, minmax(${narrow?124:138}px,1fr))`;
  // layout: pedaços de cada atividade nas colunas do quadro. tripLayout: o mesmo em hora da viagem, para os avisos e o painel do dia;
  // só é outro cálculo quando o quadro está no segundo fuso (na hora da viagem frame.dates=tds e frame.shiftMin=0)
  const layout=boardLayout(t,ds,frame.shiftMin), tripLayout=frame.offsetMin ? boardLayout(t,tds) : layout, noSleep=x=>!(S.hideSleep && (x.b||x).cat==='sleep');
  // warnings
  const warns=computeWarnings(t,tripLayout); const warnMap=new Map();
  for(const w of warns) for(const id of w.ids){ if(!warnMap.has(id)) warnMap.set(id,[]); warnMap.get(id).push(w); }
  const corner=Object.assign(document.createElement('div'),{className:'corner'});
  // as duas cidades: a da direita é a do quadro; clicar na outra passa o quadro para esse fuso
  const tzBtn=(tz,home,on)=>`<button type="button" class="tzv${on?'':' sec'}" data-home="${home?1:0}" aria-pressed="${on}" title="${esc(on?tr('viewingIn',{city:TZ.city(tz)}):tr('viewIn',{city:TZ.city(tz)}))}">${esc(TZ.city(tz))}</button>`;
  if(sec) corner.innerHTML = off ? tzBtn(t.tz,false,false)+tzBtn(sec.tz,true,true) : tzBtn(sec.tz,true,false)+tzBtn(t.tz,false,true);
  board.appendChild(corner);
  const inTrip=new Set(tds), costOf=dayTotalsPP(t);
  ds.forEach((date,i)=>{
    const d=parseISO(date), wd=d.getDay(), extra=!inTrip.has(date);
    // dia fora da viagem: só aparece quando, na hora do segundo fuso, há atividades nele. Não tem painel.
    const head=document.createElement(extra?'div':'button'); head.className='dh'+((wd===0||wd===6)?' weekend':'')+(extra?' extra':''); if(!extra){ head.type='button'; head.dataset.date=date; }
    // ends: só onde começam e onde acabam; as paragens do meio aparecem na dica e na leitura do ecrã
    const locs=t.dayPlaces[date]||[], ends=dayEnds(locs);
    const cost=costOf.get(date)||0;
    if(ends.length) head.style.setProperty('--loc-c', `linear-gradient(90deg, ${ends.map((l,k)=>`var(--p${((placeById(t,l)||{c:1}).c-1)%8+1}) ${k*100/ends.length}% ${(k+1)*100/ends.length}%`).join(',')})`);
    const showMonth = i===0 || d.getDate()===1;
    head.innerHTML = `<div class="strip"></div><div class="date"><span class="num">${d.getDate()}</span><span class="wd">${weekdayNames()[wd]}${showMonth?' · '+monthNames()[d.getMonth()]:''}</span><span class="cost">${cost?money(t,cost)+' pp':''}</span></div>`
      + (ends.length ? `<div class="loc" title="${esc(locs.map(l=>placeName(t,l)).join(' → '))}">${ends.map(l=>esc(shortPlaceName(placeName(t,l)))).join(` <span class="ferry">${locs.length>2?'⇢':'→'}</span> `)}</div>` : `<div class="loc none">${extra?tr('outsideTrip'):tr('whereClick')}</div>`);
    if(!extra) head.setAttribute('aria-label', `${dayLabel(date,true)}${locs.length?', '+locs.map(l=>placeName(t,l)).join(tr('placesJoin')):''}. ${tr('openDay')}`);
    board.appendChild(head);
  });
  const times=document.createElement('div'); times.className='times'; times.style.height=colHeight+'px'; times.style.position='sticky';
  for(let m=Math.ceil((hours.from+1)/60)*60; m<hours.to; m+=60){ const sp=document.createElement('span'); sp.style.top=((m-hours.from)*pxPerMin())+'px'; sp.textContent=clockLabel(m); if(m%1440===0) sp.className='mid'; times.appendChild(sp);
    if(other){ const m2=m+other.diff, s2=document.createElement('span'); s2.className='sec'+(((m2%1440)+1440)%1440===0?' mid':''); s2.style.top=sp.style.top; s2.textContent=clockLabel(m2); times.appendChild(s2); } }
  board.appendChild(times);
  ds.forEach((date,i)=>{
    const col=document.createElement('div'); col.className='day-col'; col.dataset.date=date; col.style.height=colHeight+'px';
    if(hours.to>1440 && hours.from<1440){ col.style.setProperty('--night-top', ((1440-hours.from)*pxPerMin())+'px'); col.insertAdjacentHTML('beforeend', `<div class="midnight" style="top:${(1440-hours.from)*pxPerMin()}px" aria-hidden="true"></div>`); }
    const list=layout.cols[i];
    const lanes=laneLayout(list.filter(noSleep));
    for(const s of list){
      const el=blockEl(t,s.b,warnMap,s,toBoard(t,frame,s.b),blockZoneTime(t,frame,s.b)); const {lane, n}=lanes.get(s.b.id)||{lane:0,n:1}; const wp=100/n;
      const top=s.top*pxPerMin(), hp=(s.bot-s.top)*pxPerMin()-2;
      el.style.top=(top+1)+'px'; el.style.height=hp+'px'; el.style.left=`calc(${lane*wp}% + 3px)`; el.style.width=`calc(${wp}% - 6px)`;
      if(hp<40) el.classList.add('short');
      el.style.setProperty('--lines', Math.max(1, Math.floor((hp-22-(s.cutTop?5:0)-(s.cutBot?5:0))/15)));
      col.appendChild(el);
    }
    // atividades que ficam todas nas horas escondidas: uma marca na ponta do dia, para não desaparecerem
    for(const [edge,arr] of [['top',layout.top[i]],['bot',layout.bot[i]]]){
      const hid=arr.filter(noSleep); if(!hid.length) continue;
      const box=document.createElement('div'); box.className='hid '+edge;
      for(const b of hid){ const w=warnMap.get(b.id)||[], boardPos={start:toBoard(t,frame,b).start, len:b.len};
        const c=document.createElement('button'); c.type='button'; c.className='hid-chip cat-'+b.cat+(w.some(x=>x.sev==='bad')?' bad':''); c.dataset.id=b.id;
        c.innerHTML=`<span class="ar" aria-hidden="true">${edge==='top'?'↑':'↓'}</span><span class="hm">${clockLabel(boardPos.start)}</span><span class="nm">${esc(b.title)}</span>`;
        c.title=tr('hiddenChip',{a:b.title, time:rangeLabel(boardPos)}); c.setAttribute('aria-label', c.title);
        c.addEventListener('click',()=>openEditor(b.id)); box.appendChild(c); }
      col.appendChild(box);
    }
    board.appendChild(col);
  });
  sc.scrollLeft=scrollX; sc.scrollTop=scrollY;
  // tray
  const tl=$('#tray-list'); tl.innerHTML='';
  if(!t.tray.length) tl.innerHTML=`<span class="tray-empty">${tr('trayEmpty')}</span>`;
  for(const b of t.tray) tl.appendChild(blockEl(t,b,warnMap,null));
  // totais
  const stats=tripStats(t);
  $('#tot-pp').textContent=money(t,stats.pp); $('#tot-n-k').textContent = t.people>1 ? tr('totalFor',{n:t.people}) : tr('total'); $('#tot-n').textContent=money(t,stats.total);
  $('#tot-res').textContent=String(stats.toBook);
  const btn=$('#warn-btn'); const bad=warns.filter(w=>w.sev==='bad').length;
  btn.classList.toggle('has-warn', warns.length>0 && !bad); btn.classList.toggle('has-bad', bad>0);
  $('#warn-txt').textContent = warns.length ? tr('nToReview',{n:warns.length}) : tr('noConflicts');
  S.lastWarnings=warns;
  // painéis abertos acompanham a alteração
  if(!$('#warnings').hidden) renderWarnings();
  if(S.editingId && !$('#editor').hidden) fillEditor({refresh:true, frame});
  if(S.dayOpen && !$('#daysheet').hidden) fillDay({refresh:true, tripLayout});
  if(!$('#costsheet').hidden) renderDash({refresh:true});
}
export function focusBlock(id){
  const q=CSS.escape(id), el=document.querySelector(`.blk[data-id="${q}"], .hid-chip[data-id="${q}"]`); if(!el){ openEditor(id); return; }
  if(el.closest('.day-col')){ const scroller=$('#scroller'); const r=el.getBoundingClientRect(), sr=scroller.getBoundingClientRect(); scroller.scrollBy({left:r.left-sr.left-90, top:r.top-sr.top-90, behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'}); }
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); el.focus({preventScroll:true});
}

/* O botão Desfazer só fica ativo com pontos para desfazer (render() chama-a; quem fizer dropHistory sem render também). */
export function refreshUndo(){ $('#undo').disabled=!S.history.length; }

/* Eventos do quadro (main.js chama-a uma vez ao arrancar).
   Duplo clique numa coluna cria uma atividade nessa hora; clique no cabeçalho abre o dia. */
export function initBoard(){
  $('#board').addEventListener('dblclick', e=>{
    if(e.target.closest('.blk,.hid')) return; const col=e.target.closest('.day-col'); if(!col) return;
    const t=activeTrip(), hours=boardHours(t), r=col.getBoundingClientRect();
    const s=Math.max(hours.from, Math.min(hours.to-30, hours.from+Math.floor((e.clientY-r.top)/pxPerMin()/30)*30));
    pushHistory(); const b=newBlock(fromBoard(t,boardFrame(t),col.dataset.date,s), newId);
    t.blocks.push(b); commit(); openEditor(b.id,{isNew:true});
  });
  $('#board').addEventListener('click', e=>{
    const z=e.target.closest('.tzv'); if(z){ if(z.getAttribute('aria-pressed')!=='true'){ setViewingHome(z.dataset.home==='1'); render(); } return; }
    const head=e.target.closest('button.dh'); if(head) openDay(head.dataset.date); });

  /* Teclado: Ctrl/⌘+Z, Esc, e setas para mover ou redimensionar a atividade com foco. */
  document.addEventListener('keydown', e=>{
    // durante um arrasto o Desfazer tiraria a atividade de debaixo do rato
    if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z' && !e.target.closest('input,textarea,select')){ e.preventDefault(); if(!(S.drag&&S.drag.active)) undo(); return; }
    if(e.key==='Escape'){ closeSheets(); return; }
    const el=e.target.closest&&e.target.closest('.blk'); if(!el) return;
    const f=findBlock(activeTrip(),el.dataset.id); if(!f) return; const b=f.b;
    if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openEditor(b.id); return; }
    if(f.where==='tray'||b.locked) return;
    const k=e.key; if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(k)) return;
    // as setas andam na hora do quadro (pode ser o segundo fuso); keyMove (moves.js) devolve o que se guarda
    e.preventDefault(); const t=activeTrip(), m=keyMove(t, boardFrame(t), b, k, e.shiftKey); if(!m) return;
    pushHistory(); b.date=m.date; b.start=m.start; b.len=m.len;
    commit(); announce(`${b.title}: ${dayLabel(m.boardDate,true)} ${rangeLabel({start:m.boardStart, len:b.len})}`);
    const again=document.querySelector(`.blk[data-id="${CSS.escape(b.id)}"]`); if(again) again.focus();
  });

  let rz=null; window.addEventListener('resize',()=>{ clearTimeout(rz); rz=setTimeout(render,120); });
}
