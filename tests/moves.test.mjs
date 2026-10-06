// Testes de moves.js: setas, largar e redimensionar no quadro, também no segundo fuso (sem DOM).
import { store, clearStore } from './env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { normTrip, boardFrame, fromBoard } from '../web/js/trip.js';
import { boardTime, keyMove, dropSlot, resizeEnd, clashesOn } from '../web/js/moves.js';

process.env.TZ = 'Europe/Lisbon';
const H = h => h * 60, D0 = '2027-07-04', D1 = '2027-07-05', D2 = '2027-07-06', D3 = '2027-07-07';
// 5 a 7 de julho (segunda a quarta), quadro das 08:00 às 02:00: T0 = 480, T1 = 1560
const trip = blocks => normTrip({ id: 't', name: 'T', start: D1, end: D3, dayStart: 8, dayEnd: 2, tz: 'Europe/Lisbon', blocks });
const act = (date, start, len = 60, extra) => ({ id: 'a', date, start, len, title: 'A', cat: 'tour', ...extra });
beforeEach(clearStore);

test('boardTime: minuto absoluto do quadro a partir da coluna e do minuto desde o topo', () => {
  const t = trip([]), F = boardFrame(t);
  assert.equal(boardTime(t, F, D1, 0), H(8));
  assert.equal(boardTime(t, F, D2, 90), 1440 + H(9.5));
});

test('keyMove: ↑/↓ 15 min dentro do horário, ←/→ de coluna, shift muda a duração', () => {
  const b = act(D1, H(10)), t = trip([b]), F = boardFrame(t);
  assert.deepEqual(keyMove(t, F, b, 'ArrowUp'), { date: D1, start: H(10) - 15, len: 60, bd: D1, bs: H(10) - 15 });
  assert.deepEqual(keyMove(t, F, b, 'ArrowDown'), { date: D1, start: H(10) + 15, len: 60, bd: D1, bs: H(10) + 15 });
  assert.deepEqual(keyMove(t, F, b, 'ArrowRight'), { date: D2, start: H(10), len: 60, bd: D2, bs: H(10) });
  assert.equal(keyMove(t, F, b, 'ArrowLeft'), null, 'já está na primeira coluna');
  assert.deepEqual(keyMove(t, F, b, 'ArrowDown', true), { date: D1, start: H(10), len: 75, bd: D1, bs: H(10) });
  assert.deepEqual(keyMove(t, F, b, 'ArrowUp', true), { date: D1, start: H(10), len: 45, bd: D1, bs: H(10) });
  assert.equal(keyMove(t, F, b, 'ArrowLeft', true), null, 'com shift, ←/→ não fazem nada');
  assert.equal(keyMove(t, F, b, 'Enter'), null);
  assert.equal(b.start, H(10), 'keyMove não mexe na atividade');
});

test('keyMove: limites do horário, última coluna, duração mínima, bloqueada e por agendar', () => {
  const t = trip([]), F = boardFrame(t);
  assert.equal(keyMove(t, F, act(D1, H(8)), 'ArrowUp'), null, 'às 08:00 não sobe');
  assert.equal(keyMove(t, F, act(D1, H(26) - 15), 'ArrowDown'), null, 'às 01:45 não desce para as 02:00');
  assert.equal(keyMove(t, F, act(D3, H(10)), 'ArrowRight'), null, 'já está na última coluna');
  assert.equal(keyMove(t, F, act(D1, H(10), 15), 'ArrowUp', true), null, 'menos de 15 min não');
  assert.equal(keyMove(t, F, act(D1, H(10), 60, { locked: true }), 'ArrowDown'), null);
  assert.equal(keyMove(t, F, { id: 'x', len: 60 }, 'ArrowDown'), null, 'por agendar não tem hora');
  assert.equal(keyMove(t, F, act('2027-08-01', H(10)), 'ArrowRight'), null, 'fora das datas não tem coluna');
});

test('keyMove no segundo fuso: as setas andam no quadro e o resultado vem na hora da viagem', () => {
  store['ferias-home-tz'] = 'America/New_York';   // 5 h atrás de Lisboa em julho
  store['ferias-view-home'] = '1';
  const b = act(D1, H(9)), t = trip([b]), F = boardFrame(t);
  assert.equal(F.ds[0], D0, 'as 09:00 de Lisboa são as 04:00 em Nova Iorque: no fim da coluna de dia 4');
  // → passa para a coluna de dia 5 no quadro, às mesmas 04:00 de Nova Iorque: 09:00 de dia 6 em Lisboa
  assert.deepEqual(keyMove(t, F, b, 'ArrowRight'), { date: D2, start: H(9), len: 60, bd: D1, bs: H(28) });
  assert.deepEqual(keyMove(t, F, b, 'ArrowUp'), { date: D1, start: H(9) - 15, len: 60, bd: D0, bs: H(28) - 15 });
});

test('dropSlot: arredonda a 15 min, desconta o ponto onde se agarrou e pode cair noutra coluna', () => {
  const t = trip([]), F = boardFrame(t);
  assert.deepEqual(dropSlot(t, F, D2, 125, 0), { date: D2, start: H(10), bd: D2, bs: H(10) }, '10:05 → 10:00');
  assert.equal(dropSlot(t, F, D2, 128, 0).start, H(10) + 15, '10:08 → 10:15');
  assert.deepEqual(dropSlot(t, F, D2, 60, 30), { date: D2, start: H(8.5), bd: D2, bs: H(8.5) }, 'agarrada meia hora depois do início');
  // agarrada 2 h depois do início e largada às 09:00 de dia 6: começa às 07:00, antes do topo, por isso fica na noite de dia 5
  assert.deepEqual(dropSlot(t, F, D2, 60, 120), { date: D1, start: H(31), bd: D1, bs: H(31) });
  assert.deepEqual(dropSlot(t, F, D1, 0, 120), { date: D1, start: H(6), bd: D1, bs: H(6) }, 'antes da primeira coluna fica no primeiro dia');
});

test('dropSlot no segundo fuso devolve o mesmo que fromBoard', () => {
  store['ferias-home-tz'] = 'America/New_York';
  store['ferias-view-home'] = '1';
  const t = trip([act(D1, H(9))]), F = boardFrame(t), r = dropSlot(t, F, D1, 120, 0);
  assert.deepEqual([r.bd, r.bs], [D1, H(10)]);
  assert.deepEqual({ date: r.date, start: r.start }, fromBoard(t, F, D1, H(10)));
  assert.deepEqual({ date: r.date, start: r.start }, { date: D1, start: H(15) }, '10:00 em Nova Iorque são 15:00 em Lisboa');
});

test('resizeEnd: arredonda a 15 min, pelo menos 15 min, até ao fim do horário e pode passar para a coluna seguinte', () => {
  const b = act(D1, H(10)), t = trip([b]), F = boardFrame(t);
  assert.equal(resizeEnd(t, F, b, D1, 240), 120, 'até às 12:00');
  assert.equal(resizeEnd(t, F, b, D1, 247), 120, '12:07 → 12:00');
  assert.equal(resizeEnd(t, F, b, D1, 60), 15, 'antes do início fica com 15 min');
  assert.equal(resizeEnd(t, F, b, D1, 5000), H(26) - H(10), 'não passa das 02:00 da coluna');
  assert.equal(resizeEnd(t, F, b, D2, 60), 1440 + H(9) - H(10), 'até às 09:00 do dia seguinte');
});

test('clashesOn: dias da semana e sítio do dia', () => {
  const t = trip([]);
  t.dayPlaces[D2] = ['lx'];
  assert.equal(clashesOn(t, act(D1, 0), D1), false);
  assert.equal(clashesOn(t, act(D1, 0, 60, { weekdays: [1] }), D1), false, 'dia 5 é segunda');
  assert.equal(clashesOn(t, act(D1, 0, 60, { weekdays: [3] }), D1), true);
  assert.equal(clashesOn(t, act(D1, 0, 60, { place: 'po' }), D2), true, 'nesse dia estão em Lisboa');
  assert.equal(clashesOn(t, act(D1, 0, 60, { place: 'lx' }), D2), false);
  assert.equal(clashesOn(t, act(D1, 0, 60, { place: 'po' }), D3), false, 'dia sem sítio não choca');
  t.dayPlaces[D3] = ['lx', 'co', 'po'];
  assert.equal(clashesOn(t, act(D1, 0, 60, { place: 'co' }), D3), false, 'uma paragem pelo caminho não choca (#41)');
  assert.equal(clashesOn(t, act(D1, 0, 60, { place: 'fa' }), D3), true);
});
