// Testes de excel.js: as três folhas do Excel como listas de linhas, sem o SheetJS (sem DOM).
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tr } from '../web/js/i18n.js';
import { dayLabel } from '../web/js/util.js';
import { normTrip } from '../web/js/trip.js';
import { catName } from '../web/js/costs.js';
import { planSheet, detailRows, costSheet, excelName } from '../web/js/excel.js';

const H = h => h * 60, D1 = '2027-07-05', D2 = '2027-07-06';
const act = (id, date, start, len, extra) => ({ id, date, start, len, title: id.toUpperCase(), cat: 'tour', ...extra });
// 5 e 6 de julho, quadro das 08:00 às 12:00 (8 meias horas), 2 pessoas
const trip = extra => normTrip({
  id: 't', name: 'Açores: 2027/verão', start: D1, end: D2, dayStart: 8, dayEnd: 12, people: 2, budget: 100,
  blocks: [
    act('a', D1, H(9), 60, { pp: 10 }),
    act('b', D1, H(9.5), 30),                           // sobrepõe-se à A: mesma célula
    act('c', D1, H(11), 15),                            // sozinha, numa só linha
    act('d', D2, H(8), 30, { total: 30, cat: 'food', status: 'pago' }),
    act('e', D2, H(20), 60),                            // fora do horário do quadro: não aparece no plano
    act('zz', D1, H(23), H(8), { cat: 'sleep' }),       // o sono não entra nos detalhes
  ],
  tray: [{ id: 'f', len: 90, title: 'Por agendar', cat: 'tour' }],
  costs: [{ id: 'k', label: 'Hotel', amount: 50, per: 'total', cat: 'alojamento', date: D1, paid: true }],
  ...extra,
});

test('planSheet: cabeçalho com os dias, uma linha por meia hora e as horas na primeira coluna', () => {
  const { aoa, cols } = planSheet(trip());
  const M = tr('xMonths'), W = tr('xWeekdays');
  assert.deepEqual(aoa[0], ['', tr('xDay', { d: 5, m: M[6], w: W[1] }), tr('xDay', { d: 6, m: M[6], w: W[2] })]);
  assert.equal(aoa.length, 1 + 8);
  assert.deepEqual(aoa.slice(1).map(r => r[0]), ['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  assert.deepEqual(cols, [{ wch: 7 }, { wch: 24 }, { wch: 24 }]);
});

test('planSheet: atividades sobrepostas na mesma célula, células unidas e o resto vazio', () => {
  const { aoa, merges } = planSheet(trip());
  const sep = '\n' + tr('xAnd') + '\n';
  assert.equal(aoa[3][1], 'A\n10 ' + tr('xPP') + sep + 'B', 'A e B das 09:00 às 10:00 na mesma célula');
  assert.equal(aoa[7][1], 'C');
  assert.equal(aoa[1][2], 'D\n30');
  assert.deepEqual(merges, [{ s: { r: 3, c: 1 }, e: { r: 4, c: 1 } }], 'só a célula da A e da B ocupa duas meias horas');
  const filled = aoa.slice(1).flatMap((r, i) => r.slice(1).map((v, c) => v && `${i}:${c}`)).filter(Boolean);
  assert.deepEqual(filled, ['0:1', '2:0', '6:0'], 'a E (às 20:00) não aparece');
});

test('detailRows: colunas pela ordem de xHead, pela ordem do quadro, sem o sono e com as por agendar no fim', () => {
  const rows = detailRows(trip());
  assert.deepEqual(rows[0], tr('xHead'));
  assert.equal(rows[0].length, 14);
  assert.deepEqual(rows.slice(1).map(r => r[3]), ['A', 'B', 'C', 'D', 'E', 'Por agendar']);
  assert.ok(rows.every(r => r.length === 14));
  const d = rows[4];
  assert.deepEqual(d, [dayLabel(D2, true), '08:00', '08:30', 'D', tr('cats').food, '', tr('status').pago, catName(trip(), 'alimentacao'), '', 30, '', '', '', '']);
  assert.deepEqual(rows[6].slice(0, 4), [tr('unscheduled'), '', '1h30', 'Por agendar']);
  const night = detailRows(trip({ blocks: [act('n', D1, H(22), H(8))] }))[1];
  assert.deepEqual(night.slice(1, 3), ['22:00', '06:00 +1'], 'o fim no dia seguinte leva +1');
});

test('costSheet: por categoria (a maior primeiro), total, orçamento, margem e cada parcela por data', () => {
  const t = trip(), cs = costSheet(t);
  assert.deepEqual(cs[0], tr('xCatHead'));
  assert.deepEqual(cs.slice(1, 4), [
    [catName(t, 'alojamento'), 50, 25, 50],
    [catName(t, 'alimentacao'), 30, 15, 30],
    [catName(t, 'atividades'), 20, 10, 20],
  ]);
  assert.deepEqual(cs[4], [tr('total'), 100, 50, 100]);
  assert.deepEqual(cs[5], [tr('budget'), 100, 50, '']);
  assert.deepEqual(cs[6], [tr('xMargin'), 0, 0, '']);
  assert.deepEqual(cs[7], []);
  assert.deepEqual(cs[8], tr('xItemHead'));
  assert.deepEqual(cs.slice(9).map(r => [r[1], r[5]]), [['A', ''], ['Hotel', tr('xYes')], ['D', tr('xYes')]]);
});

test('costSheet sem orçamento nem custos: só o cabeçalho, o total a zero e as parcelas vazias', () => {
  const cs = costSheet(trip({ budget: 0, blocks: [], costs: [] }));
  assert.deepEqual(cs, [tr('xCatHead'), [tr('total'), 0, 0, 0], [], tr('xItemHead')]);
  const over = costSheet(trip({ budget: 60 }));
  assert.deepEqual(over[6], [tr('xMargin'), -40, -20, ''], 'orçamento ultrapassado dá margem negativa');
});

test('excelName tira os caracteres que o Windows não aceita', () => {
  assert.equal(excelName(trip()), tr('xFile', { name: 'Açores 2027verão' }));
  assert.equal(excelName(trip({ name: '' })), tr('xFile', { name: tr('trip') }));
});
