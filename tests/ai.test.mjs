// Testes de ai.js: as marcas das alterações feitas pela IA (o campo ai que o MCP do servidor escreve).
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normTrip } from '../web/js/trip.js';
import { aiChanges, clearAiMark, clearAiMarks, aiStampLabel } from '../web/js/ai.js';

process.env.TZ = 'Europe/Lisbon';
const t1 = '2026-10-13T09:00:00Z', t2 = '2026-10-13T10:30:00Z';
const trip = () => normTrip({ id: 't1', name: 'Açores', start: '2027-07-01', end: '2027-07-03', ai: t1,
  blocks: [{ id: 'a1', title: 'Baleias', date: '2027-07-01', start: 600, ai: t1 }, { id: 'a2', title: 'Sem marca', date: '2027-07-01', start: 0 }],
  tray: [{ id: 'a3', title: 'Termas', ai: t2 }],
  costs: [{ id: 'c1', label: 'Hotel', amount: 100, date: '2027-07-02', ai: t1 }, { id: 'c2', label: 'Seguro', amount: 5 }] });

test('aiChanges: as marcas da viagem, das atividades e dos custos, da mais recente para a mais antiga', () => {
  assert.deepEqual(aiChanges(trip()), [
    { kind: 'block', id: 'a3', title: 'Termas', at: t2 },
    { kind: 'trip', id: 't1', title: '', at: t1 },
    { kind: 'block', id: 'a1', title: 'Baleias', at: t1, date: '2027-07-01' },
    { kind: 'cost', id: 'c1', title: 'Hotel', at: t1, date: '2027-07-02' },
  ]);
  assert.deepEqual(aiChanges(null), []);
  assert.deepEqual(aiChanges(normTrip({ id: 'x', name: 'x', start: '2027-07-01', end: '2027-07-01' })), []);
});

test('clearAiMark tira uma marca; clearAiMarks tira todas e diz quantas eram', () => {
  const t = trip();
  assert.equal(clearAiMark(t, 'block', 'a3'), true);
  assert.equal(t.tray[0].ai, undefined);
  assert.equal(clearAiMark(t, 'block', 'a3'), false, 'já não tinha marca');
  assert.equal(clearAiMark(t, 'block', 'a2'), false, 'nunca teve marca');
  assert.equal(clearAiMark(t, 'cost', 'nada'), false);
  assert.equal(clearAiMark(t, 'trip', 'outra'), false);
  assert.equal(clearAiMark(t, 'cost', 'c1'), true);
  assert.equal(clearAiMarks(t), 2);
  assert.deepEqual(aiChanges(t), []);
  assert.equal(clearAiMarks(t), 0);
});

test('aiStampLabel: dia/mês e hora na hora do dispositivo', () => {
  assert.equal(aiStampLabel(t2), '13/10 11:30');   // Lisboa está em UTC+1 em outubro
  assert.equal(aiStampLabel('2026-01-05T23:15:00Z'), '05/01 23:15');
  assert.equal(aiStampLabel('ontem'), '');
});
