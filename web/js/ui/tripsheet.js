/* Painel da viagem: criar/editar datas e horário, sítios, categorias de custo, duplicar e apagar. */
import { tr } from '../i18n.js';
import { esc, pad, newId, iso, addDays } from '../util.js';
import { $, toast, fillTzSelect } from './dom.js';
import { S, T, ensureActive, setActive, pushHistory } from '../state.js';
import { addPlace, removePlace } from '../trip.js';
import { validateTrip, tripFields, newTrip, applyTripEdit } from '../tripform.js';
import { cats, ownCats } from '../costs.js';
import { TZ, defaultHomeTz, ownHomeTz, homeTz, saveHomeTz, resolveTz } from '../tz.js';
import { commit } from '../sync.js';
import { render } from './board.js';
import { closeSheets } from './sheets.js';

let tripMode='edit';
export function openTripSheet(isNew){
  closeSheets(); tripMode=isNew?'new':'edit'; const t=T(); $('#tripsheet').hidden=false; $('#t-err').hidden=true; $('#t-del-confirm').hidden=true;
  $('#t-h').textContent=tr(isNew?'newTrip':'datesPlaces'); $('#t-submit').textContent=tr(isNew?'createTrip':'save');
  $('#t-places-wrap').hidden=isNew;
  if(isNew||!t){ const n=new Date(); const s=iso(addDays(n,30)), e=iso(addDays(n,36)); $('#t-name').value=''; $('#t-start').value=s; $('#t-end').value=e; $('#t-ds').value='7'; $('#t-de').value='1'; $('#t-people').value='2'; $('#t-cur').value='€'; $('#t-budget').value=''; fillTzSelect($('#t-tz'), tr('tzNone'), homeTz()); }
  else { $('#t-name').value=t.name; $('#t-start').value=t.start; $('#t-end').value=t.end; $('#t-ds').value=String(t.dayStart); $('#t-de').value=String(t.dayEnd); $('#t-people').value=String(t.people||1); $('#t-cur').value=t.currency||'€'; $('#t-budget').value=t.budget||''; fillTzSelect($('#t-tz'), tr('tzNone'), t.tz||''); renderPlaces(); renderCats(); }
  // a primeira opção do segundo fuso é o valor por omissão (PLANNER_HOME_TZ ou o do browser)
  fillTzSelect($('#t-hometz'), tr('homeTzDefault',{tz:TZ.city(defaultHomeTz())||'—'}), ownHomeTz());
  $('#t-name').focus();
}

/* sítios */
function renderPlaces(){
  const t=T(), box=$('#t-places'); box.innerHTML='';
  if(!t.places.length){ box.innerHTML=`<p class="hint">${tr('noPlaces')}</p>`; return; }
  t.places.forEach(p=>{ const row=document.createElement('div'); row.className='place-row'; row.style.setProperty('--pc',`var(--p${(p.c-1)%8+1})`);
    row.innerHTML=`<i aria-hidden="true"></i><input type="text" value="${esc(p.name)}" aria-label="${tr('placeNameAria')}" style="border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:6px 8px;min-width:0"><button class="btn danger" type="button">${tr('remove')}</button>`;
    const inp=row.querySelector('input'); let snap=false;
    inp.addEventListener('input',()=>{ if(!snap){ pushHistory(); snap=true; } p.name=inp.value||tr('untitled'); commit(true); });
    row.querySelector('button').addEventListener('click',()=>{ pushHistory(); removePlace(t, p.id); commit(); renderPlaces(); });
    box.appendChild(row); });
}
/* categorias de custo */
function renderCats(){
  const t=T(), box=$('#t-cats'); box.innerHTML='';
  cats(t).forEach(c=>{ const row=document.createElement('div'); row.className='place-row cat-edit';
    row.innerHTML=`<input type="text" id="cat-${esc(c.id)}" value="${esc(c.name)}" aria-label="${tr('catNameAria')}" style="border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:6px 8px;min-width:0"><button class="btn danger" type="button">${tr('remove')}</button>`;
    const inp=row.querySelector('input'); let snap=false;
    inp.addEventListener('input',()=>{ if(!snap){ pushHistory(); snap=true; } const own=ownCats(t).find(x=>x.id===c.id); if(own) own.name=inp.value||tr('untitled'); commit(true); });
    row.querySelector('button').addEventListener('click',()=>{ pushHistory(); t.costCats=ownCats(t).filter(x=>x.id!==c.id); commit(); renderCats(); toast(tr('tCatRemoved',{name:c.name})); });
    box.appendChild(row); });
  if(!cats(t).length) box.innerHTML=`<p class="hint">${tr('noCats')}</p>`;
}
/* Opções fixas e botões do painel (main.js chama-a uma vez ao arrancar). */
export function initTripsheet(){
  const h=Array.from({length:24},(_,i)=>`<option value="${i}">${pad(i)}:00</option>`).join(''); $('#t-ds').innerHTML=h; $('#t-de').innerHTML=h;

  $('#t-addplace').addEventListener('click',()=>{ const v=$('#t-newplace').value; if(!v.trim()) return; pushHistory(); addPlace(T(),v); $('#t-newplace').value=''; commit(); renderPlaces(); });
  $('#t-newplace').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#t-addplace').click(); } });

  $('#t-addcat').addEventListener('click',()=>{ const t=T(), v=$('#t-newcat').value.trim(); if(!v) return;
    if(cats(t).some(c=>c.name.toLowerCase()===v.toLowerCase())){ toast(tr('tCatExists')); return; }
    pushHistory(); ownCats(t).push({id:newId('k'), name:v}); $('#t-newcat').value=''; commit(); renderCats(); });
  $('#t-newcat').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#t-addcat').click(); } });

  /* gravar / cancelar / duplicar / apagar */
  $('#t-form').addEventListener('submit',e=>{
    e.preventDefault(); const err=$('#t-err');
    // os campos tal como estão; validar e converter é com tripform.js
    const f={name:$('#t-name').value, start:$('#t-start').value, end:$('#t-end').value, dayStart:$('#t-ds').value, dayEnd:$('#t-de').value,
      people:$('#t-people').value, currency:$('#t-cur').value, budget:$('#t-budget').value, tz:$('#t-tz').value, homeTz:$('#t-hometz').value};
    const bad=validateTrip(f); if(bad){ err.textContent=tr(bad.key, bad.params); err.hidden=false; return; }
    saveHomeTz(resolveTz(f.homeTz));
    pushHistory(tripMode==='new');   // criar uma viagem muda a store, editar só mexe nesta
    if(tripMode==='new'){
      const t=newTrip(tripFields(f), newId);
      S.store.trips.push(t); setActive(t.id);
      $('#tripsheet').hidden=true; commit(); $('#scroller').scrollTo(0,0); toast(tr('tTripCreated'));
    } else {
      const out=applyTripEdit(T(), tripFields(f));
      $('#tripsheet').hidden=true; commit(); if(out) toast(tr('tOutOfDates',{n:out}));
    }
  });
  $('#t-cancel').addEventListener('click',()=>{ $('#tripsheet').hidden=true; render(); });
  $('#t-dup').addEventListener('click',()=>{ const t=T(); pushHistory(true); const c=structuredClone(t); c.id=newId('t'); c.name=t.name+tr('copySuffix'); S.store.trips.push(c); setActive(c.id); $('#tripsheet').hidden=true; commit(); toast(tr('tTripDup')); });
  $('#t-del').addEventListener('click',()=>{ $('#t-del-confirm').hidden=false; $('#t-del-yes').focus(); });
  $('#t-del-no').addEventListener('click',()=>{ $('#t-del-confirm').hidden=true; });
  $('#t-del-yes').addEventListener('click',()=>{ const t=T(); pushHistory(true); S.store.trips=S.store.trips.filter(x=>x!==t); S.activeId=null; ensureActive(); $('#tripsheet').hidden=true; commit(); toast(tr('tTripDel',{name:t.name})); });
}
