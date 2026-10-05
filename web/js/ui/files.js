/* Ficheiros: exportar Excel, cópia de segurança e importar. */
import { tr } from '../i18n.js';
import { pad, newId, CATS, statusLabel, parseISO, mlabel, durLabel, dayLabel } from '../util.js';
import { $, toast } from './dom.js';
import { S, T, setActive, pushHistory } from '../state.js';
import { normTrip, days, view, placeName, boardLayout } from '../trip.js';
import { dayShift } from '../span.js';
import { catName, blockCat, nPeople, costItems } from '../costs.js';
import { commit } from '../sync.js';
import { closeSheets } from './sheets.js';

function saveFile(name, blob){
  const u=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=u; a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(u),2000);
}
/* A biblioteca do Excel só é carregada quando é precisa. */
let xlsxP=null;
function loadXLSX(){
  if(window.XLSX) return Promise.resolve(true);
  if(!xlsxP) xlsxP=new Promise(res=>{ const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload=()=>res(true); s.onerror=()=>{ xlsxP=null; s.remove(); res(false); }; document.head.appendChild(s); });
  return xlsxP;
}

/* Botões de exportar, cópia de segurança e importar (main.js chama-a uma vez ao arrancar). */
export function initFiles(){
  /* excel export */
  $('#export').addEventListener('click', async ()=>{
    const t=T(); if(!t) return;
    if(!(await loadXLSX())){ toast(tr('tExcelFail')); return; }
    const XLSX=window.XLSX;
    const v=view(t), ds=days(t);
    const MONL=tr('xMonths'), WDX=tr('xWeekdays');
    const aoa=[[''].concat(ds.map(d=>{ const x=parseISO(d); return tr('xDay',{d:x.getDate(), m:MONL[x.getMonth()], w:WDX[x.getDay()]}); }))];
    const rows=v.span/30; for(let r=0;r<rows;r++){ const row=[mlabel(v.T0+r*30)]; ds.forEach(()=>row.push('')); aoa.push(row); }
    const merges=[], L=boardLayout(t,ds); const cell=b=>b.title+(b.pp?`\n${b.pp} ${tr('xPP')}`:'')+(b.total?`\n${b.total}`:'');
    ds.forEach((d,ci)=>{ let g=null; const flush=()=>{ if(!g) return; aoa[g.r0+1][ci+1]=g.tx.join('\n'+tr('xAnd')+'\n'); if(g.r1-g.r0>1) merges.push({s:{r:g.r0+1,c:ci+1},e:{r:g.r1,c:ci+1}}); g=null; };
      for(const {b,top,bot} of L.cols[ci]){ let r0=Math.floor(top/30), r1=Math.ceil(bot/30); r0=Math.max(0,Math.min(rows-1,r0)); r1=Math.max(r0+1,Math.min(rows,r1));
        if(g && r0<g.r1){ g.tx.push(cell(b)); g.r1=Math.max(g.r1,r1); } else { flush(); g={r0,r1,tx:[cell(b)]}; } }
      flush(); });
    const ws=XLSX.utils.aoa_to_sheet(aoa); ws['!merges']=merges; ws['!cols']=[{wch:7}].concat(ds.map(()=>({wch:24})));
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,tr('xPlan'));
    const head=tr('xHead');
    const rowOf=b=>[b.date?dayLabel(b.date,true):tr('unscheduled'), b.date?mlabel(b.start):'', b.date?mlabel(b.start+b.len)+(dayShift(b)?' +'+dayShift(b):''):durLabel(b.len), b.title, CATS()[b.cat]||'', placeName(t,b.place)||'', statusLabel(b.status), (b.pp||b.total)?catName(t,blockCat(t,b)):'', b.pp||'', b.total||'', b.address||'', b.link||'', b.ref||'', b.note||''];
    const det=t.blocks.filter(b=>b.cat!=='sleep').slice().sort((a,b)=>a.date.localeCompare(b.date)||a.start-b.start).map(rowOf).concat(t.tray.map(rowOf));
    const ws2=XLSX.utils.aoa_to_sheet([head].concat(det)); ws2['!cols']=[14,7,7,34,11,16,12,18,9,10,24,30,14,40].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb,ws2,tr('xDetails'));
    const items=costItems(t), np=nPeople(t), sumAll=items.reduce((s,i)=>s+i.total,0);
    const byCat=new Map(); items.forEach(i=>byCat.set(i.cat,(byCat.get(i.cat)||0)+i.total));
    const r2=x=>Math.round(x*100)/100;
    const cs=[tr('xCatHead')].concat([...byCat.entries()].sort((a,b)=>b[1]-a[1]).map(([id,v])=>[catName(t,id), r2(v), r2(v/np), sumAll?Math.round(v/sumAll*100):0]));
    cs.push([tr('total'), r2(sumAll), r2(sumAll/np), sumAll?100:0]); if(t.budget>0){ cs.push([tr('budget'), t.budget, r2(t.budget/np), '']); cs.push([tr('xMargin'), r2(t.budget-sumAll), r2((t.budget-sumAll)/np), '']); }
    cs.push([]); cs.push(tr('xItemHead'));
    items.slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))).forEach(i=>cs.push([i.date?dayLabel(i.date,true):tr('general'), i.label, catName(t,i.cat), r2(i.total), r2(i.total/np), i.paid?tr('xYes'):'']));
    const ws3=XLSX.utils.aoa_to_sheet(cs); ws3['!cols']=[18,36,20,10,11,11].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb,ws3,tr('xCosts'));
    const out=XLSX.write(wb,{bookType:'xlsx',type:'array'});
    const fname=tr('xFile',{name:(t.name||tr('trip')).replace(/[\\/:*?"<>|]+/g,'').trim()});
    saveFile(fname, new Blob([out],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  });

  /* backup / import */
  $('#backup').addEventListener('click',()=>{
    const d=new Date(); const stamp=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    saveFile(`planeador-ferias-${stamp}.json`, new Blob([JSON.stringify({version:2, savedAt:Date.now(), trips:S.store.trips})],{type:'application/json'}));
    toast(tr('tBackup'));
  });
  $('#import').addEventListener('click',()=>$('#import-file').click());
  $('#import-file').addEventListener('change', async e=>{
    const f=e.target.files[0]; e.target.value=''; if(!f) return;
    try{
      const data=JSON.parse(await f.text()); if(!data || !Array.isArray(data.trips)) throw new Error('formato');
      const ok=data.trips.filter(t=>t && typeof t==='object' && t.name && /^\d{4}-\d{2}-\d{2}$/.test(t.start||'') && /^\d{4}-\d{2}-\d{2}$/.test(t.end||''));
      if(!ok.length) throw new Error('vazio');
      pushHistory(true); let added=0, replaced=0, first=null;
      for(const raw of ok){
        const t=normTrip(raw); if(!/^[A-Za-z0-9_-]{1,64}$/.test(t.id||'')) t.id=newId('t');
        const i=S.store.trips.findIndex(x=>x.id===t.id);
        if(i>=0){ S.store.trips[i]=t; replaced++; } else { S.store.trips.push(t); added++; }
        if(!first) first=t.id;
      }
      setActive(first);
      closeSheets(); commit(); $('#scroller').scrollTo(0,0);
      toast(tr('tImported',{added, replaced}));
    }catch{ toast(tr('tImportBad')); }
  });
}
