// Testes do tempo absoluto no quadro (web/js/span.js): atividades que passam de um dia
// para o outro ou ficam nas horas que o quadro não mostra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { view, absStart, segments, hiddenEdge, slotAt, dayShift } from '../web/js/span.js';

const trip = (dayStart, dayEnd) => ({ start: '2027-07-01', end: '2027-07-03', dayStart, dayEnd });
const N = 3;   // três colunas: 1, 2 e 3 de julho
const H = h => h * 60;

test('o horário do quadro continua a dar T0, span e T1', () => {
  assert.deepEqual(view(trip(8, 2)), { T0: H(8), span: H(18), T1: H(26) });
  assert.deepEqual(view(trip(8, 0)), { T0: H(8), span: H(16), T1: H(24) });
  assert.deepEqual(view(trip(7, 7)), { T0: H(7), span: H(24), T1: H(31) });
});

test('saída à noite continua a existir quando o quadro deixa de a mostrar', () => {
  const b = { date: '2027-07-01', start: H(25), len: H(1) };   // 01:00–02:00 da noite de dia 1
  // quadro das 8h às 2h: vê-se no fim da coluna de dia 1
  assert.deepEqual(segments(trip(8, 2), b, N), [{ i: 0, top: H(17), bot: H(18), cutTop: false, cutBot: false }]);
  assert.equal(hiddenEdge(trip(8, 2), b, N), null);
  // quadro das 8h às 0h: fica escondida e a marca vai para o fundo de dia 1 (a ponta mais próxima)
  assert.deepEqual(segments(trip(8, 0), b, N), []);
  assert.deepEqual(hiddenEdge(trip(8, 0), b, N), { i: 0, edge: 'bot' });
});

test('atividade escondida perto da manhã fica marcada no topo do dia seguinte', () => {
  const b = { date: '2027-07-01', start: H(30) + 30, len: 60 };   // 06:30–07:30 de dia 2
  assert.deepEqual(hiddenEdge(trip(8, 0), b, N), { i: 1, edge: 'top' });
  // nas pontas da viagem não há coluna seguinte nem anterior
  assert.deepEqual(hiddenEdge(trip(8, 0), { date: '2027-07-01', start: H(6), len: 60 }, N), { i: 0, edge: 'top' });
  assert.deepEqual(hiddenEdge(trip(8, 0), { date: '2027-07-03', start: H(30), len: 60 }, N), { i: 2, edge: 'bot' });
});

test('viagem de 34 h aparece nos dois dias, cortada nas horas escondidas', () => {
  const b = { date: '2027-07-01', start: H(10), len: H(34) };   // dia 1 10:00 → dia 2 20:00
  assert.equal(absStart(trip(8, 2), b), H(10));
  assert.deepEqual(segments(trip(8, 2), b, N), [
    { i: 0, top: H(2), bot: H(18), cutTop: false, cutBot: true },
    { i: 1, top: 0, bot: H(12), cutTop: true, cutBot: false },
  ]);
  assert.equal(hiddenEdge(trip(8, 2), b, N), null);
  assert.equal(dayShift(b), 1);
});

test('com o quadro de 24 h não há horas escondidas', () => {
  const b = { date: '2027-07-01', start: H(10), len: H(34) };
  const s = segments(trip(7, 7), b, N);
  assert.equal(s.reduce((n, x) => n + x.bot - x.top, 0), H(34));
});

test('slotAt põe a madrugada no dia anterior e respeita os limites da viagem', () => {
  const t = trip(8, 2);
  assert.deepEqual(slotAt(t, H(24 + 25), N), { i: 1, start: H(25) });   // 01:00 de dia 3 → noite de dia 2
  assert.deepEqual(slotAt(t, H(24 + 9), N), { i: 1, start: H(9) });
  assert.deepEqual(slotAt(t, H(6), N), { i: 0, start: H(6) });           // antes do quadro no 1.º dia
  assert.deepEqual(slotAt(t, -H(2), N), { i: 0, start: 0 });
  assert.equal(slotAt(t, H(24 * 5), N).i, 2);
});

test('dayShift conta as meias-noites atravessadas', () => {
  assert.equal(dayShift({ start: H(22), len: H(2) }), 0);   // acaba à meia-noite em ponto
  assert.equal(dayShift({ start: H(23), len: H(2) }), 1);
  assert.equal(dayShift({ start: H(25), len: H(1) }), 0);
  assert.equal(dayShift({ start: H(8), len: H(50) }), 2);
});
