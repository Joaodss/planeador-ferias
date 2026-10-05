/* Painel de custos: resumo, por categoria, por dia e linhas de custo editáveis. */
import { tr } from '../i18n.js';
import { $, esc, newId, dayLabel } from '../util.js';
import { T, pushHistory } from '../state.js';
import { days, fmt } from '../trip.js';
import { catName, hasCat, lineCat, nPeople, costLines, costItems, catOptions } from '../costs.js';
import { commit } from '../sync.js';
import { closeSheets } from './sheets.js';
import { openEditor } from './editor.js';
import { openDay } from './daysheet.js';

/* Linhas de custo editáveis (do dia, ou gerais quando date === null). */
export function renderCostRows(box, date, force){
  if(!force && box.contains(document.activeElement)) return;
  const t=T(); if(!t) return; const lines=costLines(t,date); box.innerHTML='';
  if(!lines.length){ box.innerHTML = `<p class="hint">${tr(date===null ? 'noGeneralCosts' : 'noDayCosts')}</p>`; return; }
  for(const c of lines){
    const row=document.createElement('div'); row.className='cost-row'; const k='c-'+c.id;
    row.innerHTML = `<input type="text" id="${k}-l" class="c-label" value="${esc(c.label||'')}" placeholder="${tr('costDescPh')}" aria-label="${tr('costDescAria')}">`
      + `<input type="number" id="${k}-a" class="c-amt" min="0" step="0.01" inputmode="decimal" value="${c.amount??''}" placeholder="0" aria-label="${tr('costAmountAria',{cur:esc(t.currency||'€')})}">`
      + `<select id="${k}-p" class="c-per" aria-label="${tr('costPerAria')}"><option value="total">${tr('perTotal')}</option><option value="pp"${c.per==='pp'?' selected':''}>${tr('perPersonLower')}</option></select>`
      + `<select id="${k}-c" class="c-cat" aria-label="${tr('costCat')}">${catOptions(t, lineCat(t,c), `<option value="">${tr('noCat')}</option>`)}</select>`
      + `<label class="toggle c-paid"><input type="checkbox" id="${k}-d"${c.paid?' checked':''}>${tr('paid')}</label>`
      + `<button class="x c-del" type="button" aria-label="${tr('removeCost')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
    let snap=false; const touch=()=>{ if(!snap){ pushHistory(); snap=true; } };
    row.querySelector('.c-label').addEventListener('input',e=>{ touch(); c.label=e.target.value; commit(); });
    row.querySelector('.c-amt').addEventListener('input',e=>{ touch(); const v=parseFloat(e.target.value); c.amount = v>0 ? v : 0; commit(); });
    row.querySelector('.c-per').addEventListener('change',e=>{ touch(); c.per=e.target.value; commit(); });
    row.querySelector('.c-cat').addEventListener('change',e=>{ touch(); if(e.target.value) c.cat=e.target.value; else delete c.cat; commit(); });
    row.querySelector('.c-paid input').addEventListener('change',e=>{ touch(); if(e.target.checked) c.paid=true; else delete c.paid; commit(); });
    row.querySelector('.c-del').addEventListener('click',()=>{ pushHistory(); t.costs=t.costs.filter(x=>x!==c); commit(); renderCostRows(box,date,true); if(!$('#costsheet').hidden) renderDash(true); });
    box.appendChild(row);
  }
}
export function addCost(box, date, defCat){
  const t=T(); if(!t) return; pushHistory(); t.costs=t.costs||[];
  const c={id:newId('c'), label:'', amount:0, per:'total'}; if(date) c.date=date; if(defCat && hasCat(t,defCat)) c.cat=defCat;
  t.costs.push(c); commit(); renderCostRows(box,date,true);
  const inp=box.querySelector('#'+CSS.escape('c-'+c.id+'-l')); if(inp) inp.focus();
}

/* Painel de resumo */
function barRow(label, value, max, total, extra){
  const pct = total>0 ? Math.round(value/total*100) : 0; const w = max>0 ? Math.max(value>0?2:0, value/max*100) : 0;
  return `<span class="bar-name">${label}</span><span class="bar-track" aria-hidden="true"><span class="bar-fill" style="width:${w}%"></span></span><span class="bar-val">${fmt(value)}</span>${extra===false?'':`<span class="bar-pct">${pct}%</span>`}`;
}
export function renderDash(force){
  const t=T(); if(!t) return; const items=costItems(t); const n=nPeople(t);
  const total=items.reduce((s,i)=>s+i.total,0); const paid=items.filter(i=>i.paid).reduce((s,i)=>s+i.total,0);
  // resumo
  let h = `<div class="dash-figs"><div class="dash-fig"><span class="k">${n>1?tr('totalFor',{n}):tr('total')}</span><span class="v big">${fmt(total)}</span></div>`
    + (n>1?`<div class="dash-fig"><span class="k">${tr('perPerson')}</span><span class="v">${fmt(total/n)}</span></div>`:'')
    + `<div class="dash-fig"><span class="k">${tr('alreadyPaid')}</span><span class="v">${fmt(paid)}</span></div><div class="dash-fig"><span class="k">${tr('toPay')}</span><span class="v">${fmt(total-paid)}</span></div></div>`;
  if(t.budget>0){
    const left=t.budget-total, over=left<0, pct=Math.round(total/t.budget*100);
    h += `<div class="budget${over?' over':''}"><div class="budget-top"><span>${tr('budget')}: <b>${fmt(t.budget)}</b></span><span class="budget-state">${over?tr('overBudget',{x:fmt(-left)}):tr('left',{x:fmt(left)})}</span></div>`
      + `<div class="bar-track tall" role="img" aria-label="${tr('budgetUsedAria',{pct})}"><span class="bar-fill" style="width:${Math.min(100,pct)}%"></span></div><div class="budget-sub">${tr('budgetUsed',{pct})}${n>1?' · '+tr('budgetPP',{x:fmt(Math.abs(left)/n), over}):''}</div></div>`;
  } else h += `<p class="hint">${tr('budgetHint')}</p>`;
  $('#c-summary').innerHTML=h;
  // por categoria
  const open=new Set([...document.querySelectorAll('#c-bycat details[open]')].map(d=>d.dataset.cat));
  const groups=new Map(); for(const i of items){ if(!groups.has(i.cat)) groups.set(i.cat,[]); groups.get(i.cat).push(i); }
  const rows=[...groups.entries()].map(([id,list])=>({id, list, sum:list.reduce((s,i)=>s+i.total,0)})).sort((a,b)=>b.sum-a.sum);
  const max=rows.length?rows[0].sum:0; const box=$('#c-bycat');
  if(!rows.length) box.innerHTML=`<p class="hint">${tr('noCosts')}</p>`;
  else {
    box.innerHTML = rows.map(r=>`<details class="cat-row" data-cat="${esc(r.id)}"${open.has(r.id)?' open':''}><summary title="${esc(catName(t,r.id))}: ${fmt(r.sum)}${n>1?' · '+fmt(r.sum/n)+' '+tr('perPersonLower'):''}">${barRow(esc(catName(t,r.id)), r.sum, max, total)}</summary><ul class="cat-items">`
      + r.list.slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))||b.total-a.total).map(i=>`<li${i.blockId?` data-block="${esc(i.blockId)}" tabindex="0" role="button"`:''}><span class="ci-d">${i.date?dayLabel(i.date,true):tr('general')}</span><span class="ci-l">${esc(i.label)}</span>${i.paid?`<span class="st st-pago">${tr('paidMark')}</span>`:''}<span class="ci-v">${fmt(i.total)}</span></li>`).join('')
      + `</ul></details>`).join('');
    box.querySelectorAll('li[data-block]').forEach(li=>{ const go=()=>openEditor(li.dataset.block); li.addEventListener('click',go); li.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); go(); } }); });
  }
  // por dia
  const ds=days(t); const byDay=ds.map(d=>({d, sum:items.filter(i=>i.date===d).reduce((s,i)=>s+i.total,0)}));
  const gen=items.filter(i=>!i.date || !ds.includes(i.date)).reduce((s,i)=>s+i.total,0);
  const dmax=Math.max(gen, ...byDay.map(x=>x.sum), 0);
  $('#c-byday').innerHTML = (gen>0?`<div class="day-row static" title="${tr('generalCosts')}: ${fmt(gen)}">${barRow(tr('generalPl'), gen, dmax, total, false)}</div>`:'')
    + byDay.map(x=>`<button type="button" class="day-row" data-date="${x.d}" title="${dayLabel(x.d,true)}: ${fmt(x.sum)}${n>1?' · '+fmt(x.sum/n)+' '+tr('perPersonLower'):''}. ${tr('openDay')}">${barRow(dayLabel(x.d,true), x.sum, dmax, total, false)}</button>`).join('');
  $('#c-byday').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>openDay(b.dataset.date)));
  renderCostRows($('#c-general'), null, force);
}
function openCosts(){ closeSheets(); $('#costsheet').hidden=false; renderDash(true); $('#costsheet [data-close]').focus(); }
$('#costs-btn').addEventListener('click',()=>{ if(!T()) return; if(!$('#costsheet').hidden){ $('#costsheet').hidden=true; return; } openCosts(); });
$('#c-add-general').addEventListener('click',()=>addCost($('#c-general'), null));
