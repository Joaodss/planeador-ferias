// Testes de costs.js: categorias, totais e parcelas de custo (sem DOM).
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { I18N } from '../web/js/i18n.js';
import { cats, ownCats, catName, hasCat, autoCat, blockCat, lineCat, nPeople, blockTotal, lineTotal, costLines, dayCostPP, dayTotalsPP, tripTotal, costItems, catOptions } from '../web/js/costs.js';

const D1 = '2027-07-05', D2 = '2027-07-06';
function trip(extra) {
  return {
    id: 't', start: D1, end: D2, people: 2,
    blocks: [
      { id: 'museu', date: D1, title: 'Museu', cat: 'tour', pp: 10, status: 'pago' },
      { id: 'jantar', date: D1, title: 'Jantar', cat: 'food', total: 30 },
      { id: 'voo', date: D2, title: 'Voo', cat: 'transport', pp: 100, total: 20, ccat: 'outros' },
      { id: 'livre', date: D2, title: 'Praia', cat: 'rest' },
    ],
    costs: [
      { id: 'c1', label: 'Hotel', amount: 100, per: 'total', date: D1, cat: 'alojamento', paid: true },
      { id: 'c2', label: '', amount: 5, per: 'pp' },
      { id: 'c3', label: 'Gorjeta', amount: 0, per: 'total', date: D2 },
    ],
    ...extra,
  };
}

test('cats: categorias por omissão traduzidas; ownCats copia uma vez e depois devolve sempre a mesma lista', () => {
  const t = trip();
  assert.deepEqual(cats(t).map(c => c.id), ['alojamento', 'transporte', 'alimentacao', 'atividades', 'festas', 'compras', 'outros']);
  assert.equal(cats(null)[0].name, 'Alojamento');
  I18N.set('en');
  try { assert.equal(cats(t)[0].name, 'Accommodation'); } finally { I18N.set('pt'); }
  assert.equal(t.costCats, undefined, 'só ler não copia as categorias para a viagem');

  const own = ownCats(t);
  assert.equal(t.costCats, own);
  assert.equal(ownCats(t), own);
  assert.equal(cats(t), own);
  I18N.set('en');
  try { assert.equal(cats(t)[0].name, 'Alojamento', 'depois de copiadas, os nomes são da viagem'); } finally { I18N.set('pt'); }
});

test('catName e hasCat: uma categoria desconhecida dá "Sem categoria"', () => {
  const t = trip({ costCats: [{ id: 'k1', name: 'Museus' }] });
  assert.equal(catName(t, 'k1'), 'Museus');
  assert.equal(hasCat(t, 'k1'), true);
  assert.equal(catName(t, 'alojamento'), 'Sem categoria', 'as da lista por omissão já não existem nesta viagem');
  assert.equal(hasCat(t, 'alojamento'), false);
  assert.equal(catName(t, undefined), 'Sem categoria');
});

test('autoCat e blockCat: tipo → categoria; ccat que já não existe volta à automática; "sem" se a automática foi removida', () => {
  const t = trip();
  assert.equal(autoCat(t, { cat: 'tour' }), 'atividades');
  assert.equal(autoCat(t, { cat: 'party' }), 'festas');
  assert.equal(autoCat(t, { cat: 'transport' }), 'transporte');
  assert.equal(autoCat(t, { cat: 'food' }), 'alimentacao');
  assert.equal(autoCat(t, { cat: 'sleep' }), 'outros');
  assert.equal(autoCat(t, { cat: 'xpto' }), 'sem');
  assert.equal(blockCat(t, { cat: 'tour', ccat: 'compras' }), 'compras');
  assert.equal(blockCat(t, { cat: 'tour', ccat: 'apagada' }), 'atividades');
  const sem = trip({ costCats: [{ id: 'compras', name: 'Compras' }] });
  assert.equal(blockCat(sem, { cat: 'tour' }), 'sem');
  assert.equal(blockCat(sem, { cat: 'tour', ccat: 'compras' }), 'compras');
});

test('lineCat, lineTotal (pp × pessoas ou total), nPeople (0 ou undefined → 1), blockTotal e tripTotal', () => {
  const t = trip();
  assert.equal(lineCat(t, { cat: 'alojamento' }), 'alojamento');
  assert.equal(lineCat(t, { cat: 'apagada' }), 'sem');
  assert.equal(lineCat(t, {}), 'sem');
  assert.equal(nPeople(t), 2);
  assert.equal(nPeople({ people: 0 }), 1);
  assert.equal(nPeople({}), 1);
  assert.equal(lineTotal(t, { amount: 5, per: 'pp' }), 10);
  assert.equal(lineTotal(t, { amount: 5, per: 'total' }), 5);
  assert.equal(lineTotal(t, { per: 'pp' }), 0);
  assert.equal(blockTotal(t, { pp: 100, total: 20 }), 220);
  assert.equal(blockTotal(t, {}), 0);
  // 10×2 + 30 + 100×2+20 + 0  +  100 + 5×2 + 0
  assert.equal(tripTotal(t), 270 + 110);
  assert.equal(tripTotal({ people: 1, blocks: [] }), 0, 'viagem antiga sem costs');
});

test('costLines(null) só dá os gerais; costLines(data) só os desse dia; dayCostPP', () => {
  const t = trip();
  assert.deepEqual(costLines(t, null).map(c => c.id), ['c2']);
  assert.deepEqual(costLines(t, D1).map(c => c.id), ['c1']);
  assert.deepEqual(costLines(t, '2027-07-09'), []);
  assert.deepEqual(costLines({}, null), []);
  assert.equal(dayCostPP(t, D1), 50);
  assert.equal(dayCostPP(t, null), 5);
});

test('dayTotalsPP soma por pessoa as atividades e os custos de cada dia', () => {
  const m = dayTotalsPP(trip());
  assert.equal(m.get(D1), 10 + 30 / 2 + 100 / 2);   // museu pp + jantar total + hotel do dia
  assert.equal(m.get(D2), 100 + 20 / 2);            // a gorjeta é 0 e a praia não custa nada
  assert.equal(m.size, 2, 'os custos gerais não têm dia');
});

test('costItems: valores 0 ficam de fora; pago pelo estado "pago"; blockId; "Sem descrição"', () => {
  assert.deepEqual(costItems(trip()), [
    { label: 'Museu', date: D1, cat: 'atividades', total: 20, paid: true, blockId: 'museu' },
    { label: 'Jantar', date: D1, cat: 'alimentacao', total: 30, paid: false, blockId: 'jantar' },
    { label: 'Voo', date: D2, cat: 'outros', total: 220, paid: false, blockId: 'voo' },
    { label: 'Hotel', date: D1, cat: 'alojamento', total: 100, paid: true },
    { label: 'Sem descrição', date: null, cat: 'sem', total: 10, paid: false },
  ]);
});

test('catOptions escapa os nomes e marca a escolhida', () => {
  const t = trip({ costCats: [{ id: 'a"b', name: '<Festas & cia>' }, { id: 'k2', name: 'Outros' }] });
  assert.equal(catOptions(t, 'k2', '<option value="">—</option>'),
    '<option value="">—</option><option value="a&quot;b">&lt;Festas &amp; cia&gt;</option><option value="k2" selected>Outros</option>');
  assert.equal(catOptions(t), '<option value="a&quot;b">&lt;Festas &amp; cia&gt;</option><option value="k2">Outros</option>');
});
