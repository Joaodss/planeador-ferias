// Testes de trip.js: dias, sítios, mover atividades e o quadro noutro fuso (sem DOM).
// Os avisos estão em warnings.test.mjs e os custos em costs.test.mjs.
import { store, clearStore } from './env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { I18N } from '../web/js/i18n.js';
import { normTrip, days, rangeLabel, money, blockCostPP, placeById, placeName, addPlace, findBlock, blocksOf, moveTo, toTray, boardFrame, toBoard, fromBoard } from '../web/js/trip.js';

process.env.TZ = 'Europe/Lisbon';   // TZ.local(): o segundo fuso quando não há outro escolhido
const H = h => h * 60;
const D1 = '2027-07-05', D2 = '2027-07-06', D3 = '2027-07-07';
const trip = extra => normTrip({ id: 't', name: 'Teste', start: D1, end: D3, dayStart: 8, dayEnd: 2, people: 2, currency: '€', ...extra });
beforeEach(clearStore);

test('days: datas inclusive; início depois do fim → []; máximo 120; sem viagem → []', () => {
  assert.deepEqual(days(trip()), [D1, D2, D3]);
  assert.deepEqual(days(trip({ end: D1 })), [D1]);
  assert.deepEqual(days(trip({ start: D3, end: D1 })), []);
  assert.deepEqual(days({ start: '2027-12-30', end: '2028-01-02' }), ['2027-12-30', '2027-12-31', '2028-01-01', '2028-01-02']);
  const long = days({ start: '2027-01-01', end: '2028-12-31' });
  assert.equal(long.length, 120);
  assert.equal(long.at(-1), '2027-04-30');
  assert.deepEqual(days(null), []);
});

test('rangeLabel: +1 e +2 nas que passam da meia-noite', () => {
  assert.equal(rangeLabel({ start: H(10), len: H(2) }), '10:00–12:00');
  assert.equal(rangeLabel({ start: H(22), len: H(2) }), '22:00–00:00', 'acabar à meia-noite em ponto não é +1');
  assert.equal(rangeLabel({ start: H(22), len: H(8) }), '22:00–06:00 +1');
  assert.equal(rangeLabel({ start: H(23), len: H(26) }), '23:00–01:00 +2');
  assert.equal(rangeLabel({ start: H(25), len: H(1) }), '01:00–02:00', 'já começou depois da meia-noite');
});

test('money dá o mesmo que toLocaleString, nas duas línguas', () => {
  const t = trip();
  const L = (v, loc) => (Math.round(v * 100) / 100).toLocaleString(loc, { maximumFractionDigits: 2 });
  for (const v of [0, 7, 1234.5, 0.005, 98765.4321]) {
    I18N.set('pt'); assert.equal(money(t, v), L(v, 'pt-PT') + ' €');
    I18N.set('en'); assert.equal(money(t, v), '€' + L(v, 'en-GB'));
  }
  I18N.set('pt');
});

test('money: moeda que não é € vem antes do número, em PT e EN', () => {
  const t = trip({ currency: 'R$' });
  assert.equal(money(t, 1234.5), 'R$' + (1234.5).toLocaleString('pt-PT'));
  I18N.set('en');
  try { assert.equal(money(t, 1234.5), 'R$1,234.5'); } finally { I18N.set('pt'); }
  assert.equal(money(null, 5), '5 €', 'sem viagem usa €');
});

test('blockCostPP: só pp, só total (people 0, 1 e 3), os dois', () => {
  const t = trip();
  assert.equal(blockCostPP(t, { pp: 10 }), 10);
  assert.equal(blockCostPP(t, {}), 0);
  for (const [people, want] of [[0, 30], [1, 30], [3, 10]]) {
    t.people = people;
    assert.equal(blockCostPP(t, { total: 30 }), want, `${people} pessoas`);
  }
  assert.equal(blockCostPP(t, { pp: 10, total: 30 }), 20);
});

test('addPlace: tira espaços, não repete (sem olhar a maiúsculas), primeira cor livre e depois cíclica, vazio → null', () => {
  const t = trip({ places: [{ id: 'p1', name: 'Lisboa', c: 1 }, { id: 'p2', name: 'Porto', c: 3 }] });
  const faro = addPlace(t, '  Faro ');
  assert.equal(faro.name, 'Faro');
  assert.equal(faro.c, 2, 'a primeira cor livre');
  assert.match(faro.id, /^p/);
  assert.equal(placeById(t, faro.id), faro);
  assert.equal(addPlace(t, 'LISBOA'), t.places[0]);
  assert.equal(addPlace(t, '   '), null);
  assert.equal(t.places.length, 3);
  assert.deepEqual(['A', 'B', 'C', 'D', 'E'].map(n => addPlace(t, n).c), [4, 5, 6, 7, 8]);
  assert.equal(addPlace(t, 'Z').c, 1, 'com as 8 cores usadas, recomeça');
  assert.equal(addPlace(t, 'Y').c, 2);
  assert.equal(placeName(t, 'p2'), 'Porto');
  assert.equal(placeName(t, 'nada'), '');
  assert.equal(placeById(null, 'p1'), null);
});

test('findBlock, moveTo e toTray: grelha ↔ por agendar, start nunca negativo, em "por agendar" sem date/start', () => {
  const t = trip({
    blocks: [{ id: 'a', date: D1, start: H(10), len: 60, title: 'A', cat: 'tour' }],
    tray: [{ id: 'b', len: 30, title: 'B', cat: 'tour' }],
  });
  assert.equal(findBlock(t, 'a').where, 'grid');
  assert.equal(findBlock(t, 'b').where, 'tray');
  assert.equal(findBlock(t, 'b').b, t.tray[0]);
  assert.equal(findBlock(t, 'x'), null);

  moveTo(t, 'b', D2, -30);
  assert.equal(findBlock(t, 'b').where, 'grid');
  assert.deepEqual(t.tray, []);
  assert.equal(t.blocks[1].date, D2);
  assert.equal(t.blocks[1].start, 0, 'start nunca fica negativo');
  moveTo(t, 'a', D3, H(30));
  assert.deepEqual([t.blocks[0].date, t.blocks[0].start], [D3, H(30)], 'pode começar depois da meia-noite');
  moveTo(t, 'x', D1, 0);
  assert.equal(t.blocks.length, 2);

  toTray(t, 'a');
  assert.equal(findBlock(t, 'a').where, 'tray');
  assert.equal('date' in t.tray[0] || 'start' in t.tray[0], false);
  toTray(t, 'a'); toTray(t, 'x');
  assert.deepEqual([t.blocks.length, t.tray.length], [1, 1]);

  assert.equal(findBlock(null, 'b'), null);
});

test('blocksOf: por início, e as mais longas primeiro', () => {
  const b = (id, date, start, len) => ({ id, date, start, len, title: id, cat: 'tour' });
  const t = trip({ blocks: [b('c', D1, H(12), 60), b('x', D2, H(9), 60), b('a', D1, H(9), 30), b('b', D1, H(9), 90)] });
  assert.deepEqual(blocksOf(t, D1).map(x => x.id), ['b', 'a', 'c']);
  assert.deepEqual(blocksOf(t, D3), []);
});

test('boardFrame, toBoard e fromBoard: nada muda na hora da viagem; no segundo fuso há colunas extra (no máximo 2) e a ida e volta dá o mesmo', () => {
  const blocks = [
    { id: 'manha', date: D1, start: H(9), len: 60, title: 'Manhã', cat: 'tour' },
    { id: 'noite', date: D2, start: H(25), len: 60, title: 'Noite', cat: 'tour' },
    { id: 'fim', date: D3, start: H(20), len: 60, title: 'Fim', cat: 'tour' },
  ];
  const t = trip({ tz: 'Europe/Lisbon', blocks });
  store['ferias-home-tz'] = 'America/New_York';   // 5 h atrás de Lisboa em julho

  // Na hora da viagem: as colunas são os dias da viagem e nada é convertido.
  const F0 = boardFrame(t);
  assert.deepEqual(F0, { ds: [D1, D2, D3], d0: D1, sh: 0, off: 0 });
  for (const b of blocks) {
    assert.deepEqual(toBoard(t, F0, b), { date: b.date, start: b.start });
    assert.deepEqual(fromBoard(t, F0, b.date, b.start), { date: b.date, start: b.start });
  }

  // No fuso de Nova Iorque: as 09:00 de dia 5 em Lisboa são as 04:00, antes do início do quadro (08:00),
  // e ficam no fim da coluna de dia 4, que só aparece por isso.
  store['ferias-view-home'] = '1';
  const F = boardFrame(t);
  assert.deepEqual(F.ds, ['2027-07-04', D1, D2, D3]);
  assert.equal(F.off, -300);
  assert.deepEqual(toBoard(t, F, blocks[0]), { date: '2027-07-04', start: H(28) });
  assert.deepEqual(toBoard(t, F, blocks[1]), { date: D2, start: H(20) });
  for (const b of blocks) {
    const v = toBoard(t, F, b);
    assert.deepEqual(fromBoard(t, F, v.date, v.start), { date: b.date, start: b.start }, b.id);
  }

  // Kiritimati (+14) visto de Pago Pago (−11): 25 h atrás, duas colunas antes da viagem.
  const far = trip({ tz: 'Pacific/Kiritimati', blocks: [{ id: 'cedo', date: D1, start: 0, len: 60, title: 'Cedo', cat: 'tour' }] });
  store['ferias-home-tz'] = 'Pacific/Pago_Pago';
  assert.deepEqual(boardFrame(far).ds, ['2027-07-03', '2027-07-04', D1, D2, D3]);
  far.blocks[0].start = -H(40);   // mais cedo ainda (só possível com dados à mão): continua a haver só duas
  assert.equal(boardFrame(far).ds[0], '2027-07-03');
  // dias fora da viagem não acrescentam colunas
  far.blocks[0] = { id: 'fora', date: '2027-06-01', start: 0, len: 60, title: 'Fora', cat: 'tour' };
  assert.deepEqual(boardFrame(far).ds, [D1, D2, D3]);
});
