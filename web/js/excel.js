/* Conteúdo do Excel exportado: três folhas como listas de linhas (arrays), sem o SheetJS.
   ui/files.js carrega a biblioteca, converte as linhas em folhas e descarrega o ficheiro.
   Módulo sem DOM (testado em tests/excel.test.mjs). */
import { tr } from './i18n.js';
import { kindLabels, statusLabel, parseISO, clockLabel, durationLabel, dayLabel } from './util.js';
import { tripDates, boardHours, placeName, boardLayout } from './trip.js';
import { dayShift } from './span.js';
import { catName, blockCat, nPeople, costItems } from './costs.js';

const r2 = x => Math.round(x*100)/100;

/** @typedef {import('./clean.js').Trip} Trip */

/** Folha "Plano": uma coluna por dia e uma linha por meia hora do horário do quadro.
   Atividades que se sobrepõem na mesma coluna ficam na mesma célula, separadas por xAnd;
   uma célula que ocupa várias meias horas fica unida (merges, no formato do SheetJS).
   @param {Trip} t
   @returns {{aoa: string[][], merges: Array<{s: {r: number, c: number}, e: {r: number, c: number}}>, cols: Array<{wch: number}>}}
     aoa: as linhas (a primeira é o cabeçalho dos dias); merges e cols: células unidas e larguras, para o SheetJS */
export function planSheet(t){
  const hours=boardHours(t), ds=tripDates(t), rows=hours.span/30;
  const MONL=tr('xMonths'), WDX=tr('xWeekdays');
  const aoa=[[''].concat(ds.map(d=>{ const x=parseISO(d); return tr('xDay',{d:x.getDate(), m:MONL[x.getMonth()], w:WDX[x.getDay()]}); }))];
  for(let r=0;r<rows;r++) aoa.push([clockLabel(hours.from+r*30)].concat(ds.map(()=>'')));
  const merges=[], L=boardLayout(t,ds);
  const cell=b=>b.title+(b.pp?`\n${b.pp} ${tr('xPP')}`:'')+(b.total?`\n${b.total}`:'');
  ds.forEach((d,ci)=>{
    let g=null;   // grupo de atividades seguidas que se sobrepõem: linhas [r0, r1) e textos
    const flush=()=>{
      if(!g) return;
      aoa[g.r0+1][ci+1]=g.tx.join('\n'+tr('xAnd')+'\n');
      if(g.r1-g.r0>1) merges.push({s:{r:g.r0+1,c:ci+1}, e:{r:g.r1,c:ci+1}});
      g=null;
    };
    for(const {b,top,bot} of L.cols[ci]){
      const r0=Math.max(0, Math.min(rows-1, Math.floor(top/30)));
      const r1=Math.max(r0+1, Math.min(rows, Math.ceil(bot/30)));
      if(g && r0<g.r1){
        g.tx.push(cell(b));
        g.r1=Math.max(g.r1,r1);
      } else {
        flush();
        g={r0, r1, tx:[cell(b)]};
      }
    }
    flush();
  });
  return {aoa, merges, cols:[{wch:7}].concat(ds.map(()=>({wch:24})))};
}

/** Folha "Detalhes": o cabeçalho xHead e uma linha por atividade (sem o sono), pela ordem do quadro,
   e depois as que estão por agendar.
   As colunas de rowOf têm de ficar pela mesma ordem que os títulos de xHead (i18n.js, nas duas línguas) e que as
   larguras da folha em ui/files.js: ao acrescentar, tirar ou trocar uma coluna, mudar os três.
   @param {Trip} t
   @returns {Array<Array<string | number>>} */
export function detailRows(t){
  const rowOf=b=>[
    b.date ? dayLabel(b.date,true) : tr('unscheduled'),
    b.date ? clockLabel(b.start) : '',
    b.date ? clockLabel(b.start+b.len)+(dayShift(b)?' +'+dayShift(b):'') : durationLabel(b.len),
    b.title, kindLabels()[b.cat]||'', placeName(t,b.place)||'', statusLabel(b.status),
    (b.pp||b.total) ? catName(t,blockCat(t,b)) : '',
    b.pp||'', b.total||'', b.address||'', b.link||'', b.ref||'', b.note||''];
  const grid=t.blocks.filter(b=>b.cat!=='sleep').slice().sort((a,b)=>a.date.localeCompare(b.date)||a.start-b.start);
  return [tr('xHead')].concat(grid.map(rowOf), t.tray.map(rowOf));
}

/** Folha "Custos": totais por categoria (o maior primeiro), total, orçamento e margem, e depois cada parcela.
   As colunas seguem xCatHead e xItemHead (i18n.js) e as larguras em ui/files.js.
   @param {Trip} t
   @returns {Array<Array<string | number>>} valores para o grupo e por pessoa, arredondados a cêntimos */
export function costSheet(t){
  const items=costItems(t), np=nPeople(t), sum=items.reduce((s,i)=>s+i.total,0);
  const byCat=new Map();
  for(const i of items) byCat.set(i.cat, (byCat.get(i.cat)||0)+i.total);
  const pct=v=>sum ? Math.round(v/sum*100) : 0;
  const cs=[tr('xCatHead')].concat([...byCat.entries()].sort((a,b)=>b[1]-a[1]).map(([id,v])=>[catName(t,id), r2(v), r2(v/np), pct(v)]));
  cs.push([tr('total'), r2(sum), r2(sum/np), sum?100:0]);
  if(t.budget>0){
    cs.push([tr('budget'), t.budget, r2(t.budget/np), '']);
    cs.push([tr('xMargin'), r2(t.budget-sum), r2((t.budget-sum)/np), '']);
  }
  cs.push([], tr('xItemHead'));
  for(const i of items.slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))))
    cs.push([i.date?dayLabel(i.date,true):tr('general'), i.label, catName(t,i.cat), r2(i.total), r2(i.total/np), i.paid?tr('xYes'):'']);
  return cs;
}

/** Nome do ficheiro: o nome da viagem sem os caracteres que o Windows não aceita.
   @param {Trip} t
   @returns {string} */
export function excelName(t){ return tr('xFile',{name:(t.name||tr('trip')).replace(/[\\/:*?"<>|]+/g,'').trim()}); }
