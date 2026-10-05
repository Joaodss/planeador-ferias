/* Regras que geram os "pontos a rever" (sobreposições, dias errados, etc.). */
import { tr } from './i18n.js';
import { parseISO, mlabel, dayLabel, artDay, daysPhrase } from './util.js';
import { days, placeName, boardLayout } from './trip.js';
import { absStart } from './span.js';

/* Pontos a rever da viagem t. L0: o layout em hora da viagem, boardLayout(t, days(t)), quando quem chama já o calculou (render). */
export function computeWarnings(t, L0){
  if(!t) return []; const W=[]; const ds=days(t);
  // agrupa uma vez: as atividades de cada dia (pela ordem de blocksOf) e o dia da semana de cada data
  const byDate=new Map(ds.map(d=>[d,[]])), wdOf=new Map(ds.map(d=>[d,parseISO(d).getDay()]));
  for(const b of t.blocks){ const a=byDate.get(b.date); if(a) a.push(b); }
  for(const a of byDate.values()) a.sort((x,y)=>x.start-y.start||y.len-x.len);
  // sobreposições em tempo absoluto, para apanhar também as que passam de um dia para o outro
  const all=t.blocks.filter(b=>byDate.has(b.date)).map(b=>({b, a:absStart(t,b)})).sort((p,q)=>p.a-q.a||q.b.len-p.b.len);
  for(let i=0;i<all.length;i++) for(let k=i+1;k<all.length && all[k].a<all[i].a+all[i].b.len;k++){
    const x=all[i].b, y=all[k].b, s=all[k].a-all[i].a+x.start;   // horas na escala do dia de x
    const sl = x.cat==='sleep'||y.cat==='sleep'; const o = x.cat==='sleep'?y:x;
    W.push({sev:sl?'warn':'bad', ids:[x.id,y.id], date:y.date, t: sl?tr('wSleep',{a:o.title}):tr('wOverlap',{a:x.title,b:y.title}), d:`${dayLabel(y.date,true)} · ${mlabel(s)}–${mlabel(Math.min(x.start+x.len, s+y.len))}`});
  }
  const L=L0||boardLayout(t,ds), hidden=new Set(L.top.concat(L.bot).flat());
  // dias em que uma atividade com dias da semana pode ficar: só dependem desses dias e do sítio
  const okDays=new Map();
  const okOf=b=>{ const k=b.weekdays.join()+'|'+(b.place||''); let ok=okDays.get(k);
    if(ok===undefined){ ok=ds.filter(dd=>b.weekdays.includes(wdOf.get(dd)) && (!b.place || !(t.dayPlaces[dd]||[]).length || t.dayPlaces[dd].includes(b.place))).map(dd=>dayLabel(dd)).join(', ')||tr('none'); okDays.set(k,ok); }
    return ok; };
  ds.forEach((date,i)=>{
    const list=byDate.get(date); const wd=wdOf.get(date); const dp=t.dayPlaces[date]||[];
    for(const b of list){
      if(b.weekdays && b.weekdays.length && !b.weekdays.includes(wd)){
        W.push({sev:'bad', ids:[b.id], date, t:tr('wWeekday',{a:b.title,day:artDay(wd)}), d:tr('wWeekdayD',{days:daysPhrase(b.weekdays), ok:okOf(b)})});
      }
      if(b.place && dp.length && !dp.includes(b.place)){
        W.push({sev:'bad', ids:[b.id], date, t:tr('wPlace',{a:b.title,place:placeName(t,b.place)}), d:tr('wPlaceD',{day:dayLabel(date,true), places:dp.map(p=>placeName(t,p)).join(' → ')})});
      }
      if(hidden.has(b)){
        W.push({sev:'warn', ids:[b.id], date, t:tr('wHours',{a:b.title}), d:tr('wHoursD',{time:mlabel(b.start)})});
      }
      if(b.cat==='party' && b.start+b.len>=1380 && i<ds.length-1){
        for(const n of byDate.get(ds[i+1]).filter(n=>['tour','transport','party'].includes(n.cat) && n.start<600))
          W.push({sev:'warn', ids:[b.id,n.id], date:ds[i+1], t:tr('wNight',{b:n.title}), d:tr('wNightD',{a:b.title, t1:mlabel(b.start+b.len), b:n.title, t2:mlabel(n.start), day:dayLabel(ds[i+1])})});
      }
    }
  });
  for(const b of t.blocks) if(!byDate.has(b.date)) W.push({sev:'bad', ids:[b.id], date:b.date, t:tr('wDates',{a:b.title}), d:tr('wDatesD',{date:b.date})});
  return W;
}
