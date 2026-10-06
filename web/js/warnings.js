/* Regras que geram os "pontos a rever" (sobreposições, dias errados, etc.). */
import { tr } from './i18n.js';
import { parseISO, clockLabel, dayLabel, onWeekday, daysPhrase } from './util.js';
import { tripDates, placeName, boardLayout } from './trip.js';
import { absStart } from './span.js';

/* Pontos a rever da viagem t: {sev ('bad' ou 'warn'), ids das atividades, date, title, detail}.
   tripLayout: o quadro em hora da viagem, boardLayout(t, tripDates(t)), quando quem chama já o calculou (render). */
export function computeWarnings(t, tripLayout){
  if(!t) return []; const W=[]; const ds=tripDates(t);
  // agrupa uma vez: as atividades de cada dia (pela ordem de blocksOf) e o dia da semana de cada data
  const byDate=new Map(ds.map(d=>[d,[]])), wdOf=new Map(ds.map(d=>[d,parseISO(d).getDay()]));
  for(const b of t.blocks){ const a=byDate.get(b.date); if(a) a.push(b); }
  for(const a of byDate.values()) a.sort((x,y)=>x.start-y.start||y.len-x.len);
  // sobreposições em tempo absoluto, para apanhar também as que passam de um dia para o outro
  const all=t.blocks.filter(b=>byDate.has(b.date)).map(b=>({b, a:absStart(t,b)})).sort((p,q)=>p.a-q.a||q.b.len-p.b.len);
  for(let i=0;i<all.length;i++) for(let k=i+1;k<all.length && all[k].a<all[i].a+all[i].b.len;k++){
    const x=all[i].b, y=all[k].b, s=all[k].a-all[i].a+x.start;   // horas na escala do dia de x
    const withSleep = x.cat==='sleep'||y.cat==='sleep'; const o = x.cat==='sleep'?y:x;
    W.push({sev:withSleep?'warn':'bad', ids:[x.id,y.id], date:y.date, title:withSleep?tr('wSleep',{a:o.title}):tr('wOverlap',{a:x.title,b:y.title}), detail:`${dayLabel(y.date,true)} · ${clockLabel(s)}–${clockLabel(Math.min(x.start+x.len, s+y.len))}`});
  }
  const {top, bot}=tripLayout||boardLayout(t,ds), hidden=new Set(top.concat(bot).flat());
  // dias em que uma atividade com dias da semana pode ficar: só dependem desses dias e do sítio
  const okDays=new Map();
  const okOf=b=>{ const k=b.weekdays.join()+'|'+(b.place||''); let ok=okDays.get(k);
    if(ok===undefined){ ok=ds.filter(dd=>b.weekdays.includes(wdOf.get(dd)) && (!b.place || !(t.dayPlaces[dd]||[]).length || t.dayPlaces[dd].includes(b.place))).map(dd=>dayLabel(dd)).join(', ')||tr('none'); okDays.set(k,ok); }
    return ok; };
  ds.forEach((date,i)=>{
    const list=byDate.get(date); const wd=wdOf.get(date); const dp=t.dayPlaces[date]||[];
    for(const b of list){
      if(b.weekdays && b.weekdays.length && !b.weekdays.includes(wd)){
        W.push({sev:'bad', ids:[b.id], date, title:tr('wWeekday',{a:b.title,day:onWeekday(wd)}), detail:tr('wWeekdayD',{days:daysPhrase(b.weekdays), ok:okOf(b)})});
      }
      if(b.place && dp.length && !dp.includes(b.place)){
        W.push({sev:'bad', ids:[b.id], date, title:tr('wPlace',{a:b.title,place:placeName(t,b.place)}), detail:tr('wPlaceD',{day:dayLabel(date,true), places:dp.map(p=>placeName(t,p)).join(' → ')})});
      }
      if(hidden.has(b)){
        W.push({sev:'warn', ids:[b.id], date, title:tr('wHours',{a:b.title}), detail:tr('wHoursD',{time:clockLabel(b.start)})});
      }
      if(b.cat==='party' && b.start+b.len>=1380 && i<ds.length-1){
        for(const n of byDate.get(ds[i+1]).filter(n=>['tour','transport','party'].includes(n.cat) && n.start<600))
          W.push({sev:'warn', ids:[b.id,n.id], date:ds[i+1], title:tr('wNight',{b:n.title}), detail:tr('wNightD',{a:b.title, t1:clockLabel(b.start+b.len), b:n.title, t2:clockLabel(n.start), day:dayLabel(ds[i+1])})});
      }
    }
  });
  for(const b of t.blocks) if(!byDate.has(b.date)) W.push({sev:'bad', ids:[b.id], date:b.date, title:tr('wDates',{a:b.title}), detail:tr('wDatesD',{date:b.date})});
  return W;
}

/* Ordem do painel "Pontos a rever": por data e, no mesmo dia, os graves ('bad') primeiro. Não muda a lista recebida. */
export function sortWarnings(ws){ return ws.slice().sort((a,b)=>String(a.date).localeCompare(String(b.date)) || (a.sev===b.sev ? 0 : a.sev==='bad' ? -1 : 1)); }
