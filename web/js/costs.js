/* Cálculo de custos: categorias, totais e parcelas. */
import { tr } from './i18n.js';
import { esc } from './util.js';
import { T } from './state.js';

const DEFAULT_CAT_IDS = ['alojamento','transporte','alimentacao','atividades','festas','compras','outros'];
const defaultCats = () => DEFAULT_CAT_IDS.map(id=>({id, name:tr('defaultCats')[id]}));
const AUTO_CAT = {tour:'atividades', party:'festas', transport:'transporte', food:'alimentacao', rest:'outros', sleep:'outros'};
const NO_CAT = 'sem';
export function cats(t){ return (t && t.costCats) || defaultCats(); }
export function ownCats(t){ if(!t.costCats) t.costCats=defaultCats(); return t.costCats; }
export function catName(t,id){ const c=cats(t).find(c=>c.id===id); return c ? c.name : tr('noCat'); }
export function hasCat(t,id){ return cats(t).some(c=>c.id===id); }
export function autoCat(t,b){ const id=AUTO_CAT[b.cat]; return hasCat(t,id) ? id : NO_CAT; }
export function blockCat(t,b){ return (b.ccat && hasCat(t,b.ccat)) ? b.ccat : autoCat(t,b); }
export function lineCat(t,c){ return (c.cat && hasCat(t,c.cat)) ? c.cat : NO_CAT; }
export function nPeople(t){ return Math.max(1, t.people||1); }
export function blockTotal(t,b){ return (b.pp||0)*nPeople(t) + (b.total||0); }
export function lineTotal(t,c){ return c.per==='pp' ? (c.amount||0)*nPeople(t) : (c.amount||0); }
export function costLines(t,date){ return (t.costs||[]).filter(c=> date===null ? !c.date : c.date===date); }
export function dayCostPP(date){ const t=T(); return costLines(t,date).reduce((s,c)=>s+lineTotal(t,c),0)/nPeople(t); }
export function tripTotal(t){ return t.blocks.reduce((s,b)=>s+blockTotal(t,b),0) + (t.costs||[]).reduce((s,c)=>s+lineTotal(t,c),0); }
/* Todas as parcelas de custo da viagem, já em valor total para o grupo. */
export function costItems(t){
  const out=[];
  for(const b of t.blocks){ const v=blockTotal(t,b); if(v>0) out.push({label:b.title, date:b.date, cat:blockCat(t,b), total:v, paid:b.status==='pago', blockId:b.id}); }
  for(const c of (t.costs||[])){ const v=lineTotal(t,c); if(v>0) out.push({label:c.label||tr('noDesc'), date:c.date||null, cat:lineCat(t,c), total:v, paid:!!c.paid}); }
  return out;
}
export function catOptions(t, sel, first){ return (first||'') + cats(t).map(c=>`<option value="${esc(c.id)}"${c.id===sel?' selected':''}>${esc(c.name)}</option>`).join(''); }
