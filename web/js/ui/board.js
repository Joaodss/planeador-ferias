/* O quadro: cabeçalho da viagem, grelha de dias e horas, tabuleiro "por agendar" e totais. */
import { tr } from '../i18n.js';
import { $, esc, short, isMobile, refreshSlot, PXM, SNAP, WD, MON, statusLabel, parseISO, mlabel, durLabel, dayLabel, newId, announce } from '../util.js';
import { S, T, ensureActive, pushHistory, dropHistory } from '../state.js';
import { days, view, fmt, blockCostPP, placeById, placeName, findBlock, blocksOf, boardLayout, rangeLabel, boardFrame, toBoard, fromBoard } from '../trip.js';
import { nPeople, tripTotal, dayCostPP } from '../costs.js';
import { computeWarnings } from '../warnings.js';
import { TZ, secondTz, setViewingHome } from '../tz.js';
import { commit, undo } from '../sync.js';
import { closeSheets } from './sheets.js';
import { openEditor, fillEditor } from './editor.js';
import { openDay, fillDay } from './daysheet.js';
import { openTripSheet } from './tripsheet.js';
import { renderDash } from './costsheet.js';
import { renderWarnings } from './review.js';

/* Faixas lado a lado para pedaços que se sobrepõem numa coluna (top/bot em minutos desde T0). */
function laneLayout(list){
  const res=new Map(); let cl=[], end=-1;
  const flush=()=>{ const lanes=[]; for(const s of cl){ let li=lanes.findIndex(e=>e<=s.top); if(li<0){ li=lanes.length; lanes.push(0);} lanes[li]=s.bot; res.set(s.b.id,{lane:li}); } for(const s of cl) res.get(s.b.id).n=lanes.length; cl=[]; end=-1; };
  for(const s of list){ if(cl.length && s.top>=end) flush(); cl.push(s); end=Math.max(end,s.bot); }
  if(cl.length) flush(); return res;
}
/* seg: o pedaço visível numa coluna (null no tabuleiro). Um pedaço cortado continua noutro dia ou nas horas escondidas.
   vb: dia e hora da atividade no quadro (toBoard), que pode estar no segundo fuso. */
function blockEl(b, warnMap, seg, vb){
  const inTray=!seg; const el=document.createElement('div');
  el.className='blk cat-'+b.cat+(b.locked?' locked':'')+(b.status==='ideia'?' status-ideia':'')+(seg&&seg.cutTop?' cut-top':'')+(seg&&seg.cutBot?' cut-bot':'');
  el.dataset.id=b.id; el.tabIndex=0; el.setAttribute('role','button');
  const w=warnMap.get(b.id);
  const cost = b.pp ? `<span class="eur">${fmt(b.pp)} pp</span>` : (b.total ? `<span class="eur">${fmt(b.total)}</span>` : '');
  const sl = statusLabel(b.status), st = sl ? `<span class="st st-${b.status}">${(b.status==='reservado'||b.status==='pago')?'✓ ':''}${esc(sl)}</span>` : '';
  const time = inTray ? durLabel(b.len) : rangeLabel({start:vb.start, len:b.len});
  el.innerHTML = `<div class="t">${esc(b.title)}</div><div class="m"><span>${time}</span>${cost}${st}</div>`
    + (w?`<span class="badge" title="${esc(w.map(x=>x.t).join('\n'))}">!</span>`:'')
    + (b.locked?`<svg class="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`:'')
    + (inTray||seg.cutBot?'':'<div class="grip" aria-hidden="true"></div>');
  if(w){ el.classList.add('has-badge'); if(w.some(x=>x.sev==='bad')) el.classList.add('bad'); }
  el.setAttribute('aria-label', `${b.title}, ${inTray?tr('unscheduledLower'):dayLabel(vb.date,true)+' '+time}${sl?', '+sl:''}${w?', '+tr('nWarnings',{n:w.length}):''}`);
  return el;
}
export function render(){
  refreshSlot(); ensureActive();
  const t=T();
  // trip switcher
  const sel=$('#trip-sel'); sel.innerHTML = `<option value="">${S.store.trips.length>1?tr('switchTrip'):tr('trips')}</option>` + S.store.trips.map(x=>`<option value="${esc(x.id)}"${t&&x.id===t.id?' disabled':''}>${esc(x.name)}${t&&x.id===t.id?tr('openMark'):''}</option>`).join('') + `<option value="__new">${tr('newTripOpt')}</option>`;
  sel.value='';
  const board=$('#board'); const sc=$('#scroller'); const sl=sc.scrollLeft, st=sc.scrollTop;
  board.innerHTML='';
  if(!t){
    $('#trip-name').textContent=tr('appName'); $('#route').textContent=''; board.classList.remove('two-tz');
    board.style.gridTemplateColumns='1fr';
    board.innerHTML = `<div class="empty-board"><div class="card"><h2>${tr('emptyH')}</h2><p>${tr('emptyP')}</p><div class="actions"><button class="btn primary" type="button" id="empty-new">${tr('newTrip')}</button><button class="btn" type="button" id="empty-import">${tr('importBackup')}</button></div></div></div>`;
    $('#empty-new').addEventListener('click',()=>openTripSheet(true));
    $('#empty-import').addEventListener('click',()=>$('#import-file').click());
    document.title=tr('appName');
    $('#tray-list').innerHTML=''; ['#tot-pp','#tot-n','#tot-res'].forEach(s=>$(s).textContent='—'); $('#warn-txt').textContent='—'; return;
  }
  document.title = t.name ? `${t.name} · ${tr('appName')}` : tr('appName');
  $('#trip-name').textContent=t.name;
  // F: colunas do quadro e deslocamento quando o quadro está no segundo fuso (ver boardFrame)
  const tds=days(t), v=view(t), H=v.span*PXM(), F=boardFrame(t), ds=F.ds;
  // route summary
  const seq=[]; tds.forEach(d=>(t.dayPlaces[d]||[]).forEach(p=>{ if(seq[seq.length-1]!==p) seq.push(p); }));
  const s0=parseISO(t.start), s1=parseISO(t.end);
  const range = s0.getMonth()===s1.getMonth() ? `${s0.getDate()}–${s1.getDate()} ${MON()[s1.getMonth()]} ${s1.getFullYear()}` : `${s0.getDate()} ${MON()[s0.getMonth()]} – ${s1.getDate()} ${MON()[s1.getMonth()]} ${s1.getFullYear()}`;
  // sec: segundo fuso. off≠0 quando o quadro está na hora do segundo fuso: aí as duas cidades trocam de papel.
  const sec=secondTz(t), off=F.off;
  const main = off ? sec.tz : t.tz, other = sec && (off ? {tz:t.tz, diff:-sec.diff} : sec);
  $('#route').innerHTML = `<span>${range} · ${tr('nDays',{n:tds.length})}</span>` + (seq.length ? '<span class="arrow">·</span>'+seq.map(p=>`<b>${esc(short(placeName(p)))}</b>`).join('<span class="arrow">→</span>') : `<span class="arrow">·</span><span>${tr('clickDay')}</span>`)
    + (TZ.valid(t.tz) ? `<span class="arrow">·</span><span title="${esc(main)}">${tr('tzRoute',{city:esc(TZ.city(main))})}${other?` (${esc(TZ.city(other.tz))} ${TZ.diffLabel(other.diff)})`:''}</span>` : '')
    + (off ? `<span class="arrow">·</span><span>${tr('tzDatesNote',{city:esc(TZ.city(t.tz))})}</span>` : '');
  const narrow=isMobile();
  board.classList.toggle('two-tz', !!sec);
  board.style.gridTemplateColumns = `${sec?(narrow?84:98):(narrow?48:58)}px repeat(${ds.length}, minmax(${narrow?124:138}px,1fr))`;
  // warnings
  const warns=computeWarnings(); const warnMap=new Map();
  for(const w of warns) for(const id of w.ids){ if(!warnMap.has(id)) warnMap.set(id,[]); warnMap.get(id).push(w); }
  const corner=Object.assign(document.createElement('div'),{className:'corner'});
  // as duas cidades: a da direita é a do quadro; clicar na outra passa o quadro para esse fuso
  const tzBtn=(tz,home,on)=>`<button type="button" class="tzv${on?'':' sec'}" data-home="${home?1:0}" aria-pressed="${on}" title="${esc(on?tr('viewingIn',{city:TZ.city(tz)}):tr('viewIn',{city:TZ.city(tz)}))}">${esc(TZ.city(tz))}</button>`;
  if(sec) corner.innerHTML = off ? tzBtn(t.tz,false,false)+tzBtn(sec.tz,true,true) : tzBtn(sec.tz,true,false)+tzBtn(t.tz,false,true);
  board.appendChild(corner);
  ds.forEach((date,i)=>{
    const d=parseISO(date), wd=d.getDay(), extra=!tds.includes(date);
    // dia fora da viagem: só aparece quando, na hora do segundo fuso, há atividades nele. Não tem painel.
    const h=document.createElement(extra?'div':'button'); h.className='dh'+((wd===0||wd===6)?' weekend':'')+(extra?' extra':''); if(!extra){ h.type='button'; h.dataset.date=date; }
    const locs=t.dayPlaces[date]||[];
    const cost=blocksOf(date).reduce((s,b)=>s+blockCostPP(b),0)+dayCostPP(date);
    if(locs.length) h.style.setProperty('--loc-c', `linear-gradient(90deg, ${locs.map((l,k)=>`var(--p${((placeById(l)||{c:1}).c-1)%8+1}) ${k*100/locs.length}% ${(k+1)*100/locs.length}%`).join(',')})`);
    const showMonth = i===0 || d.getDate()===1;
    h.innerHTML = `<div class="strip"></div><div class="date"><span class="num">${d.getDate()}</span><span class="wd">${WD()[wd]}${showMonth?' · '+MON()[d.getMonth()]:''}</span><span class="cost">${cost?fmt(cost)+' pp':''}</span></div>`
      + (locs.length ? `<div class="loc" title="${esc(locs.map(placeName).join(' → '))}">${locs.map(l=>esc(short(placeName(l)))).join(' <span class="ferry">→</span> ')}</div>` : `<div class="loc none">${extra?tr('outsideTrip'):tr('whereClick')}</div>`);
    if(!extra) h.setAttribute('aria-label', `${dayLabel(date,true)}${locs.length?', '+locs.map(placeName).join(tr('placesJoin')):''}. ${tr('openDay')}`);
    board.appendChild(h);
  });
  const times=document.createElement('div'); times.className='times'; times.style.height=H+'px'; times.style.position='sticky';
  for(let m=Math.ceil((v.T0+1)/60)*60; m<v.T1; m+=60){ const sp=document.createElement('span'); sp.style.top=((m-v.T0)*PXM())+'px'; sp.textContent=mlabel(m); if(m%1440===0) sp.className='mid'; times.appendChild(sp);
    if(other){ const m2=m+other.diff, s2=document.createElement('span'); s2.className='sec'+(((m2%1440)+1440)%1440===0?' mid':''); s2.style.top=sp.style.top; s2.textContent=mlabel(m2); times.appendChild(s2); } }
  board.appendChild(times);
  const BL=boardLayout(t,ds,F.sh), noSleep=x=>!(S.hideSleep && (x.b||x).cat==='sleep');
  ds.forEach((date,i)=>{
    const col=document.createElement('div'); col.className='day-col'; col.dataset.date=date; col.style.height=H+'px';
    if(v.T1>1440 && v.T0<1440){ col.style.setProperty('--night-top', ((1440-v.T0)*PXM())+'px'); col.insertAdjacentHTML('beforeend', `<div class="midnight" style="top:${(1440-v.T0)*PXM()}px" aria-hidden="true"></div>`); }
    const list=BL.cols[i];
    const layout=laneLayout(list.filter(noSleep));
    for(const s of list){
      const el=blockEl(s.b,warnMap,s,toBoard(t,F,s.b)); const L=layout.get(s.b.id)||{lane:0,n:1}; const wp=100/L.n;
      const top=s.top*PXM(), hp=(s.bot-s.top)*PXM()-2;
      el.style.top=(top+1)+'px'; el.style.height=hp+'px'; el.style.left=`calc(${L.lane*wp}% + 3px)`; el.style.width=`calc(${wp}% - 6px)`;
      if(hp<40) el.classList.add('short');
      el.style.setProperty('--lines', Math.max(1, Math.floor((hp-22-(s.cutTop?5:0)-(s.cutBot?5:0))/15)));
      col.appendChild(el);
    }
    // atividades que ficam todas nas horas escondidas: uma marca na ponta do dia, para não desaparecerem
    for(const [edge,arr] of [['top',BL.top[i]],['bot',BL.bot[i]]]){
      const hid=arr.filter(noSleep); if(!hid.length) continue;
      const box=document.createElement('div'); box.className='hid '+edge;
      for(const b of hid){ const w=warnMap.get(b.id)||[], vb={start:toBoard(t,F,b).start, len:b.len};
        const c=document.createElement('button'); c.type='button'; c.className='hid-chip cat-'+b.cat+(w.some(x=>x.sev==='bad')?' bad':''); c.dataset.id=b.id;
        c.innerHTML=`<span class="ar" aria-hidden="true">${edge==='top'?'↑':'↓'}</span><span class="hm">${mlabel(vb.start)}</span><span class="nm">${esc(b.title)}</span>`;
        c.title=tr('hiddenChip',{a:b.title, time:rangeLabel(vb)}); c.setAttribute('aria-label', c.title);
        c.addEventListener('click',()=>openEditor(b.id)); box.appendChild(c); }
      col.appendChild(box);
    }
    board.appendChild(col);
  });
  sc.scrollLeft=sl; sc.scrollTop=st;
  // tray
  const tl=$('#tray-list'); tl.innerHTML='';
  if(!t.tray.length) tl.innerHTML=`<span class="tray-empty">${tr('trayEmpty')}</span>`;
  for(const b of t.tray) tl.appendChild(blockEl(b,warnMap,null));
  // stats
  const pp=tripTotal(t)/nPeople(t);
  $('#tot-pp').textContent=fmt(pp); $('#tot-n-k').textContent = t.people>1 ? tr('totalFor',{n:t.people}) : tr('total'); $('#tot-n').textContent=fmt(pp*(t.people||1));
  const res=t.blocks.concat(t.tray).filter(b=>b.status==='reservar').length; $('#tot-res').textContent=String(res);
  const btn=$('#warn-btn'); const bad=warns.filter(w=>w.sev==='bad').length;
  btn.classList.toggle('has-warn', warns.length>0 && !bad); btn.classList.toggle('has-bad', bad>0);
  $('#warn-txt').textContent = warns.length ? tr('nToReview',{n:warns.length}) : tr('noConflicts');
  S.lastWarnings=warns;
  // painéis abertos acompanham a alteração
  if(!$('#warnings').hidden) renderWarnings();
  if(S.editingId && !$('#editor').hidden) fillEditor(false);
  if(S.dayOpen && !$('#daysheet').hidden) fillDay();
  if(!$('#costsheet').hidden) renderDash();
}
export function focusBlock(id){
  const el=document.querySelector(`.blk[data-id="${id}"], .hid-chip[data-id="${id}"]`); if(!el){ openEditor(id); return; }
  if(el.closest('.day-col')){ const scroller=$('#scroller'); const r=el.getBoundingClientRect(), sr=scroller.getBoundingClientRect(); scroller.scrollBy({left:r.left-sr.left-90, top:r.top-sr.top-90, behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'}); }
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); el.focus({preventScroll:true});
}

/* Duplo clique numa coluna cria uma atividade nessa hora; clique no cabeçalho abre o dia. */
$('#board').addEventListener('dblclick', e=>{
  if(e.target.closest('.blk,.hid')) return; const col=e.target.closest('.day-col'); if(!col) return;
  const t=T(), v=view(t), r=col.getBoundingClientRect();
  const s=Math.max(v.T0, Math.min(v.T1-30, v.T0+Math.floor((e.clientY-r.top)/PXM()/30)*30));
  pushHistory(); const b={id:newId('a'), ...fromBoard(t,boardFrame(t),col.dataset.date,s), len:60, title:tr('newActivity'), cat:'tour', status:'ideia'};
  t.blocks.push(b); commit(); openEditor(b.id,true);
});
$('#board').addEventListener('click', e=>{
  const z=e.target.closest('.tzv'); if(z){ if(z.getAttribute('aria-pressed')!=='true'){ setViewingHome(z.dataset.home==='1'); render(); } return; }
  const h=e.target.closest('button.dh'); if(h) openDay(h.dataset.date); });

/* Teclado: Ctrl/⌘+Z, Esc, e setas para mover ou redimensionar a atividade com foco. */
document.addEventListener('keydown', e=>{
  // durante um arrasto o Desfazer tiraria a atividade de debaixo do rato
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z' && !e.target.closest('input,textarea,select')){ e.preventDefault(); if(!(S.drag&&S.drag.active)) undo(); return; }
  if(e.key==='Escape'){ closeSheets(); return; }
  const el=e.target.closest&&e.target.closest('.blk'); if(!el) return;
  const f=findBlock(el.dataset.id); if(!f) return; const b=f.b;
  if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openEditor(b.id); return; }
  if(f.where==='tray'||b.locked) return;
  const k=e.key; if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(k)) return;
  // as setas andam na hora do quadro (pode ser o segundo fuso); no fim converte-se para a hora da viagem
  e.preventDefault(); const t=T(), v=view(t), F=boardFrame(t), ds=F.ds; let {date,start}=toBoard(t,F,b); const di=ds.indexOf(date); let ch=false; pushHistory();
  // a duração não tem limite (pode passar para o dia seguinte); o início fica dentro do horário visível para não perder o foco
  if(e.shiftKey){ if(k==='ArrowDown'){ b.len+=SNAP; ch=true; } if(k==='ArrowUp'&&b.len>SNAP){ b.len-=SNAP; ch=true; } }
  else { if(k==='ArrowUp'&&start>v.T0){ start-=SNAP; ch=true; } if(k==='ArrowDown'&&start+SNAP<v.T1){ start+=SNAP; ch=true; }
    if(k==='ArrowLeft'&&di>0){ date=ds[di-1]; ch=true; } if(k==='ArrowRight'&&di>=0&&di<ds.length-1){ date=ds[di+1]; ch=true; }
    if(ch) Object.assign(b, fromBoard(t,F,date,start)); }
  if(!ch){ dropHistory(); return; }
  commit(); announce(`${b.title}: ${dayLabel(date,true)} ${rangeLabel({start, len:b.len})}`);
  const again=document.querySelector(`.blk[data-id="${b.id}"]`); if(again) again.focus();
});

let rz=null; window.addEventListener('resize',()=>{ clearTimeout(rz); rz=setTimeout(render,120); });
