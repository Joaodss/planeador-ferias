/* Regras que geram os "pontos a rever" (sobreposições, dias errados, etc.). */
import { tr } from './i18n.js';
import { parseISO, mlabel, dayLabel, artDay, daysPhrase } from './util.js';
import { T } from './state.js';
import { days, view, blocksOf, placeName } from './trip.js';

export function computeWarnings(){
  const t=T(); if(!t) return []; const W=[]; const v=view(t); const ds=days(t);
  ds.forEach((date,i)=>{
    const list=blocksOf(date); const wd=parseISO(date).getDay(); const dp=t.dayPlaces[date]||[];
    for(let a=0;a<list.length;a++) for(let c=a+1;c<list.length;c++){
      const x=list[a], y=list[c];
      if(y.start < x.start+x.len && x.start < y.start+y.len){
        const sl = x.cat==='sleep'||y.cat==='sleep'; const o = x.cat==='sleep'?y:x;
        W.push({sev:sl?'warn':'bad', ids:[x.id,y.id], date, t: sl?tr('wSleep',{a:o.title}):tr('wOverlap',{a:x.title,b:y.title}), d:`${dayLabel(date,true)} · ${mlabel(Math.max(x.start,y.start))}–${mlabel(Math.min(x.start+x.len,y.start+y.len))}`});
      }
    }
    for(const b of list){
      if(b.weekdays && b.weekdays.length && !b.weekdays.includes(wd)){
        const ok = ds.filter(dd=>b.weekdays.includes(parseISO(dd).getDay()) && (!b.place || !(t.dayPlaces[dd]||[]).length || (t.dayPlaces[dd]||[]).includes(b.place)));
        W.push({sev:'bad', ids:[b.id], date, t:tr('wWeekday',{a:b.title,day:artDay(wd)}), d:tr('wWeekdayD',{days:daysPhrase(b.weekdays), ok:ok.map(dd=>dayLabel(dd)).join(', ')||tr('none')})});
      }
      if(b.place && dp.length && !dp.includes(b.place)){
        W.push({sev:'bad', ids:[b.id], date, t:tr('wPlace',{a:b.title,place:placeName(b.place)}), d:tr('wPlaceD',{day:dayLabel(date,true), places:dp.map(placeName).join(' → ')})});
      }
      if(b.start < v.T0 || b.start+b.len > v.T1){
        W.push({sev:'warn', ids:[b.id], date, t:tr('wHours',{a:b.title}), d:tr('wHoursD',{time:mlabel(b.start)})});
      }
      if(b.cat==='party' && b.start+b.len>=1380 && i<ds.length-1){
        for(const n of blocksOf(ds[i+1]).filter(n=>['tour','transport','party'].includes(n.cat) && n.start<600))
          W.push({sev:'warn', ids:[b.id,n.id], date:ds[i+1], t:tr('wNight',{b:n.title}), d:tr('wNightD',{a:b.title, t1:mlabel(b.start+b.len), b:n.title, t2:mlabel(n.start), day:dayLabel(ds[i+1])})});
      }
    }
  });
  const outside = t.blocks.filter(b=>!ds.includes(b.date));
  for(const b of outside) W.push({sev:'bad', ids:[b.id], date:b.date, t:tr('wDates',{a:b.title}), d:tr('wDatesD',{date:b.date})});
  return W;
}
