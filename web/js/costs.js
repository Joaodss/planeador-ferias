/* Cálculo de custos: categorias, totais e parcelas. */
import { tr } from './i18n.js';
import { esc } from './util.js';
import { tripDates } from './trip.js';

const DEFAULT_CAT_IDS = ['alojamento','transporte','alimentacao','atividades','festas','compras','outros'];
const defaultCats = () => DEFAULT_CAT_IDS.map(id=>({id, name:tr('defaultCats')[id]}));
const AUTO_CAT = {tour:'atividades', party:'festas', transport:'transporte', food:'alimentacao', rest:'outros', sleep:'outros'};
const NO_CAT = 'sem';
export function costCats(t){ return (t && t.costCats) || defaultCats(); }
export function ownCats(t){ if(!t.costCats) t.costCats=defaultCats(); return t.costCats; }
export function catName(t,id){ const c=costCats(t).find(c=>c.id===id); return c ? c.name : tr('noCat'); }
export function hasCat(t,id){ return costCats(t).some(c=>c.id===id); }
export function autoCat(t,b){ const id=AUTO_CAT[b.cat]; return hasCat(t,id) ? id : NO_CAT; }
export function blockCat(t,b){ return (b.ccat && hasCat(t,b.ccat)) ? b.ccat : autoCat(t,b); }
export function lineCat(t,c){ return (c.cat && hasCat(t,c.cat)) ? c.cat : NO_CAT; }
export function nPeople(t){ return Math.max(1, t.people||1); }
/* Custo de uma atividade: pp é por pessoa e total para o grupo; uma pode ter os dois. */
export function blockCostTotal(t,b){ return (b.pp||0)*nPeople(t) + (b.total||0); }
export function blockCostPerPerson(t,b){ return (b.pp||0) + (b.total||0)/nPeople(t); }
export function lineTotal(t,c){ return c.per==='pp' ? (c.amount||0)*nPeople(t) : (c.amount||0); }
export function costLines(t,date){ return (t.costs||[]).filter(c=> date===null ? !c.date : c.date===date); }
export function dayCostPP(t, date){ return costLines(t,date).reduce((s,c)=>s+lineTotal(t,c),0)/nPeople(t); }
/* Custo por pessoa de cada dia (atividades + custos do dia) numa só passagem: date → valor. */
export function dayTotalsPP(t){
  const n=nPeople(t), m=new Map(), add=(d,v)=>m.set(d,(m.get(d)||0)+v);
  for(const b of t.blocks) add(b.date, blockCostPerPerson(t,b));
  for(const c of (t.costs||[])) if(c.date) add(c.date, lineTotal(t,c)/n);
  return m;
}
export function tripTotal(t){ return t.blocks.reduce((s,b)=>s+blockCostTotal(t,b),0) + (t.costs||[]).reduce((s,c)=>s+lineTotal(t,c),0); }
/* Todas as parcelas de custo da viagem, já em valor total para o grupo. */
export function costItems(t){
  const out=[];
  for(const b of t.blocks){ const v=blockCostTotal(t,b); if(v>0) out.push({label:b.title, date:b.date, cat:blockCat(t,b), total:v, paid:b.status==='pago', blockId:b.id}); }
  for(const c of (t.costs||[])){ const v=lineTotal(t,c); if(v>0) out.push({label:c.label||tr('noDesc'), date:c.date||null, cat:lineCat(t,c), total:v, paid:!!c.paid}); }
  return out;
}
export function catOptions(t, sel, first){ return (first||'') + costCats(t).map(c=>`<option value="${esc(c.id)}"${c.id===sel?' selected':''}>${esc(c.name)}</option>`).join(''); }

/* Totais do rodapé do quadro: por pessoa, para o grupo e quantas atividades estão por reservar. */
export function tripStats(t){
  const pp=tripTotal(t)/nPeople(t);
  return {pp, total:pp*(t.people||1), toBook:t.blocks.concat(t.tray).filter(b=>b.status==='reservar').length};
}

/* Tudo o que o painel de custos mostra, já somado (valores para o grupo):
   total e pago; byCat com as parcelas de cada categoria (a mais cara primeiro; dentro, por data e depois pelo valor);
   byDay com cada dia da viagem; general com os custos sem dia ou fora das datas;
   budget {left, over, pct} se houver orçamento, senão null. */
export function costSummary(t){
  const items=costItems(t);
  const sum=list=>list.reduce((s,i)=>s+i.total,0);
  const total=sum(items), paid=sum(items.filter(i=>i.paid));
  const groups=new Map();
  for(const i of items){
    if(!groups.has(i.cat)) groups.set(i.cat,[]);
    groups.get(i.cat).push(i);
  }
  const byCat=[...groups.entries()]
    .map(([id,list])=>({id, sum:sum(list), list:list.slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))||b.total-a.total)}))
    .sort((a,b)=>b.sum-a.sum);
  const ds=tripDates(t), inTrip=new Set(ds), sumOf=new Map();
  for(const i of items) if(i.date) sumOf.set(i.date, (sumOf.get(i.date)||0)+i.total);
  const byDay=ds.map(d=>({d, sum:sumOf.get(d)||0}));
  const general=sum(items.filter(i=>!i.date || !inTrip.has(i.date)));
  let budget=null;
  if(t.budget>0){
    const left=t.budget-total;
    budget={left, over:left<0, pct:Math.round(total/t.budget*100)};
  }
  return {total, paid, byCat, byDay, general, budget};
}
