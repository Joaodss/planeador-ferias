// Testes do tempo absoluto no quadro (web/js/span.js): atividades que passam de um dia
// para o outro ou ficam nas horas que o quadro não mostra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { view, absStart, segments, hiddenEdge, slotAt, dateAt, dayShift, frameShift, toFrame, fromFrame, boardLayout } from '../web/js/span.js';

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

test('quadro noutro fuso: desloca as atividades e volta ao mesmo sítio', () => {
  // viagem a Tóquio vista em Lisboa (8 h atrás), quadro das 8h à 1h
  const t = { start: '2026-10-10', end: '2026-10-13', dayStart: 8, dayEnd: 1 };
  const off = -H(8), d0 = '2026-10-10', sh = frameShift(t, off, d0);
  const at = (date, start) => toFrame(t, { date, start }, sh, d0);
  assert.deepEqual(at('2026-10-10', H(20)), { date: '2026-10-10', start: H(12) }, '20h em Tóquio = 12h em Lisboa');
  assert.deepEqual(at('2026-10-10', H(8)), { date: '2026-10-09', start: H(24) }, 'meia-noite fica no fim do dia anterior');
  assert.deepEqual(at('2026-10-10', H(24)), { date: '2026-10-10', start: H(16) }, 'madrugada de Tóquio guardada com start ≥ 1440');
  // segments com sh: o jantar das 20h aparece às 12h na coluna de dia 10
  assert.deepEqual(segments(t, { date: '2026-10-10', start: H(20), len: H(1) }, 4, sh), [{ i: 0, top: H(4), bot: H(5), cutTop: false, cutBot: false }]);
  // um quadro que começa no dia anterior (coluna extra antes da viagem)
  const d1 = '2026-10-09', sh1 = frameShift(t, off, d1);
  assert.deepEqual(toFrame(t, { date: '2026-10-10', start: H(8) }, sh1, d1), { date: '2026-10-09', start: H(24) });
  assert.deepEqual(fromFrame(t, '2026-10-09', H(24), sh1, d1), { date: '2026-10-10', start: H(8) });
  // ida e volta: o que se larga no quadro fica guardado na hora da viagem e volta ao mesmo sítio
  for (const [date, start] of [['2026-10-10', H(8)], ['2026-10-11', H(12) + 15], ['2026-10-12', H(23) + 45], ['2026-10-12', H(24) + 30]]) {
    const back = fromFrame(t, date, start, sh, d0);
    assert.deepEqual(toFrame(t, back, sh, d0), { date, start }, `${date} ${start}`);
  }
  assert.deepEqual(fromFrame(t, '2026-10-11', H(22), sh, d0), { date: '2026-10-12', start: H(6) }, '22h de dia 11 em Lisboa = 6h de dia 12 em Tóquio');
});

test('quadro noutro fuso 24 h atrás (sh = 0): as marcas usam as datas da viagem', () => {
  // viagem em Tonga (+13) vista em Midway (−11): mesma hora, um dia antes, por isso sh dá 0
  const t = { ...trip(8, 0), blocks: [] };
  const d0 = '2027-06-30', ds = ['2027-06-30', '2027-07-01', '2027-07-02'], sh = frameShift(t, -H(24), d0);
  assert.equal(sh, 0);
  const last = { date: '2027-07-03', start: H(2), len: 60 };     // último dia da viagem, escondida
  const before = { date: '2027-06-30', start: H(2), len: 60 };   // antes da viagem: já tem o aviso "fora das datas"
  t.blocks.push(last, before);
  const L = boardLayout(t, ds, sh);
  assert.deepEqual(L.bot[1], [last], 'a do último dia tem marca, embora a data não seja uma coluna do quadro');
  assert.deepEqual(L.top.flat().concat(L.bot.flat()).includes(before), false, 'a de fora da viagem não tem marca');
});

test('dateAt põe a cópia logo a seguir, sem limitar às colunas da viagem', () => {
  const t = trip(8, 0);
  assert.deepEqual(dateAt(t, H(24 + 9)), { date: '2027-07-02', start: H(9) });
  assert.deepEqual(dateAt(t, H(24 + 25)), { date: '2027-07-02', start: H(25) }, 'madrugada fica no dia anterior, como no quadro');
  assert.deepEqual(dateAt(t, H(6)), { date: '2027-07-01', start: H(6) }, 'antes do quadro no 1.º dia fica nesse dia');
  assert.deepEqual(dateAt(t, -H(2)), { date: '2027-06-30', start: H(22) }, 'antes da viagem não salta para o 1.º dia');
  assert.deepEqual(dateAt(t, H(24 * 5 + 10)), { date: '2027-07-06', start: H(10) }, 'depois da viagem não fica no último dia');
});
