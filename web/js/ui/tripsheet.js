/* Painel da viagem: criar/editar datas e horário, sítios, categorias de custo, duplicar e apagar. */
import { tr } from '../i18n.js';
import { $, esc, pad, clone, newId, parseISO, iso, addDays, toast } from '../util.js';
import { S, T, ensureActive, setActive, pushHistory } from '../state.js';
import { days, toTray, addPlace } from '../trip.js';
import { cats, ownCats } from '../costs.js';
import { TZ, defaultHomeTz, ownHomeTz, homeTz, saveHomeTz, resolveTz } from '../tz.js';
import { commit } from '../sync.js';
import { render } from './board.js';
import { closeSheets } from './sheets.js';

let tripMode='edit';
(function(){ const h=Array.from({length:24},(_,i)=>`<option value="${i}">${pad(i)}:00</option>`).join(''); $('#t-ds').innerHTML=h; $('#t-de').innerHTML=h; })();
$('#tz-list').innerHTML=TZ.all.map(z=>`<option value="${z}">`).join('');
export function openTripSheet(isNew){
  closeSheets(); tripMode=isNew?'new':'edit'; const t=T(); $('#tripsheet').hidden=false; $('#t-err').hidden=true; $('#t-del-confirm').hidden=true;
  $('#t-h').textContent=tr(isNew?'newTrip':'datesPlaces'); $('#t-submit').textContent=tr(isNew?'createTrip':'save');
  $('#t-places-wrap').hidden=isNew;
  if(isNew||!t){ const n=new Date(); const s=iso(addDays(n,30)), e=iso(addDays(n,36)); $('#t-name').value=''; $('#t-start').value=s; $('#t-end').value=e; $('#t-ds').value='7'; $('#t-de').value='1'; $('#t-people').value='2'; $('#t-cur').value='€'; $('#t-budget').value=''; $('#t-tz').value=homeTz(); }
  else { $('#t-name').value=t.name; $('#t-start').value=t.start; $('#t-end').value=t.end; $('#t-ds').value=String(t.dayStart); $('#t-de').value=String(t.dayEnd); $('#t-people').value=String(t.people||1); $('#t-cur').value=t.currency||'€'; $('#t-budget').value=t.budget||''; $('#t-tz').value=t.tz||''; renderPlaces(); renderCats(); }
  $('#t-hometz').value=ownHomeTz(); $('#t-hometz').placeholder=tr('homeTzDefault',{tz:defaultHomeTz()||'—'});
  $('#t-name').focus();
}

/* sítios */
function renderPlaces(){
  const t=T(), box=$('#t-places'); box.innerHTML='';
  if(!t.places.length){ box.innerHTML=`<p class="hint">${tr('noPlaces')}</p>`; return; }
  t.places.forEach(p=>{ const row=document.createElement('div'); row.className='place-row'; row.style.setProperty('--pc',`var(--p${(p.c-1)%8+1})`);
    row.innerHTML=`<i aria-hidden="true"></i><input type="text" value="${esc(p.name)}" aria-label="${tr('placeNameAria')}" style="border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:6px 8px;min-width:0"><button class="btn danger" type="button">${tr('remove')}</button>`;
    const inp=row.querySelector('input'); let snap=false;
    inp.addEventListener('input',()=>{ if(!snap){ pushHistory(); snap=true; } p.name=inp.value||tr('untitled'); commit(); });
    row.querySelector('button').addEventListener('click',()=>{ pushHistory(); t.places=t.places.filter(x=>x!==p); Object.keys(t.dayPlaces).forEach(d=>{ t.dayPlaces[d]=t.dayPlaces[d].filter(x=>x!==p.id); if(!t.dayPlaces[d].length) delete t.dayPlaces[d]; }); t.blocks.concat(t.tray).forEach(b=>{ if(b.place===p.id) delete b.place; }); commit(); renderPlaces(); });
    box.appendChild(row); });
}
$('#t-addplace').addEventListener('click',()=>{ const v=$('#t-newplace').value; if(!v.trim()) return; pushHistory(); addPlace(v); $('#t-newplace').value=''; commit(); renderPlaces(); });
$('#t-newplace').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#t-addplace').click(); } });

/* categorias de custo */
function renderCats(){
  const t=T(), box=$('#t-cats'); box.innerHTML='';
  cats(t).forEach(c=>{ const row=document.createElement('div'); row.className='place-row cat-edit';
    row.innerHTML=`<input type="text" id="cat-${esc(c.id)}" value="${esc(c.name)}" aria-label="${tr('catNameAria')}" style="border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:6px 8px;min-width:0"><button class="btn danger" type="button">${tr('remove')}</button>`;
    const inp=row.querySelector('input'); let snap=false;
    inp.addEventListener('input',()=>{ if(!snap){ pushHistory(); snap=true; } const own=ownCats(t).find(x=>x.id===c.id); if(own) own.name=inp.value||tr('untitled'); commit(); });
    row.querySelector('button').addEventListener('click',()=>{ pushHistory(); t.costCats=ownCats(t).filter(x=>x.id!==c.id); commit(); renderCats(); toast(tr('tCatRemoved',{name:c.name})); });
    box.appendChild(row); });
  if(!cats(t).length) box.innerHTML=`<p class="hint">${tr('noCats')}</p>`;
}
$('#t-addcat').addEventListener('click',()=>{ const t=T(), v=$('#t-newcat').value.trim(); if(!v) return;
  if(cats(t).some(c=>c.name.toLowerCase()===v.toLowerCase())){ toast(tr('tCatExists')); return; }
  pushHistory(); ownCats(t).push({id:newId('k'), name:v}); $('#t-newcat').value=''; commit(); renderCats(); });
$('#t-newcat').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#t-addcat').click(); } });

/* gravar / cancelar / duplicar / apagar */
$('#t-form').addEventListener('submit',e=>{
  e.preventDefault(); const err=$('#t-err');
  const name=$('#t-name').value.trim(), s=$('#t-start').value, en=$('#t-end').value;
  const fail=m=>{ err.textContent=m; err.hidden=false; };
  if(!name) return fail(tr('errTripName'));
  if(!s||!en) return fail(tr('errTripDates'));
  if(en<s) return fail(tr('errTripOrder'));
  const n=Math.round((parseISO(en)-parseISO(s))/864e5)+1; if(n>60) return fail(tr('errTripLong',{n}));
  const ds=+$('#t-ds').value, de=+$('#t-de').value, people=Math.max(1,parseInt($('#t-people').value)||1), cur=$('#t-cur').value, budget=parseFloat($('#t-budget').value)>0?parseFloat($('#t-budget').value):0;
  const tz=resolveTz($('#t-tz').value), home=resolveTz($('#t-hometz').value);
  if(tz===null) return fail(tr('errTz',{v:$('#t-tz').value.trim()}));
  if(home===null) return fail(tr('errTz',{v:$('#t-hometz').value.trim()}));
  saveHomeTz(home);
  pushHistory();
  if(tripMode==='new'){
    const t={id:newId('t'), name, start:s, end:en, dayStart:ds, dayEnd:de, people, currency:cur, places:[], dayPlaces:{}, blocks:[], tray:[], costs:[]}; if(budget) t.budget=budget; if(tz) t.tz=tz;
    S.store.trips.push(t); setActive(t.id);
    $('#tripsheet').hidden=true; commit(); $('#scroller').scrollTo(0,0); toast(tr('tTripCreated'));
  } else {
    const t=T(); Object.assign(t,{name,start:s,end:en,dayStart:ds,dayEnd:de,people,currency:cur}); if(budget) t.budget=budget; else delete t.budget; if(tz) t.tz=tz; else delete t.tz;
    const dset=new Set(days(t)); const out=t.blocks.filter(b=>!dset.has(b.date));
    out.forEach(b=>toTray(b.id)); (t.costs||[]).forEach(c=>{ if(c.date && !dset.has(c.date)) delete c.date; }); Object.keys(t.dayPlaces).forEach(d=>{ if(!dset.has(d)) delete t.dayPlaces[d]; });
    $('#tripsheet').hidden=true; commit(); if(out.length) toast(tr('tOutOfDates',{n:out.length}));
  }
});
$('#t-cancel').addEventListener('click',()=>{ $('#tripsheet').hidden=true; render(); });
$('#t-dup').addEventListener('click',()=>{ const t=T(); pushHistory(); const c=clone(t); c.id=newId('t'); c.name=t.name+tr('copySuffix'); S.store.trips.push(c); setActive(c.id); $('#tripsheet').hidden=true; commit(); toast(tr('tTripDup')); });
$('#t-del').addEventListener('click',()=>{ $('#t-del-confirm').hidden=false; $('#t-del-yes').focus(); });
$('#t-del-no').addEventListener('click',()=>{ $('#t-del-confirm').hidden=true; });
$('#t-del-yes').addEventListener('click',()=>{ const t=T(); pushHistory(); S.store.trips=S.store.trips.filter(x=>x!==t); S.activeId=null; ensureActive(); $('#tripsheet').hidden=true; commit(); toast(tr('tTripDel',{name:t.name})); });
