// Testes de tripform.js: validar o formulário da viagem, criá-la e aplicar as alterações (sem DOM).
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normTrip } from '../web/js/trip.js';
import { validateTrip, tripFields, newTrip, applyTripEdit, MAX_DAYS } from '../web/js/tripform.js';

let n = 0;
const newId = p => `${p}novo${++n}`;
// os campos como vêm do formulário: tudo texto
const form = extra => ({ name: '  Açores  ', start: '2027-07-01', end: '2027-07-10', dayStart: '8', dayEnd: '2', people: '3', currency: '€', budget: '', tz: '', homeTz: '', ...extra });

test('validateTrip: nome vazio, datas em falta, fim antes do início, mais de 60 dias, fuso desconhecido', () => {
  assert.equal(validateTrip(form()), null);
  assert.deepEqual(validateTrip(form({ name: '   ' })), { key: 'errTripName' });
  assert.deepEqual(validateTrip(form({ start: '' })), { key: 'errTripDates' });
  assert.deepEqual(validateTrip(form({ end: '' })), { key: 'errTripDates' });
  assert.deepEqual(validateTrip(form({ end: '2027-06-30' })), { key: 'errTripOrder' });
  assert.equal(validateTrip(form({ end: '2027-07-01' })), null, 'um dia só é uma viagem');
  assert.equal(MAX_DAYS, 60);
  assert.equal(validateTrip(form({ end: '2027-08-29' })), null, '60 dias ainda passa');
  assert.deepEqual(validateTrip(form({ end: '2027-08-30' })), { key: 'errTripLong', params: { n: 61 } });
  assert.deepEqual(validateTrip(form({ tz: ' Atlantida ' })), { key: 'errTz', params: { v: 'Atlantida' } });
  assert.deepEqual(validateTrip(form({ homeTz: 'Marte' })), { key: 'errTz', params: { v: 'Marte' } });
  assert.equal(validateTrip(form({ tz: 'tokyo', homeTz: 'Lisbon' })), null, 'o fuso pode ser só a cidade');
});

test('tripFields converte os campos: espaços, números, pessoas, orçamento e fuso', () => {
  assert.deepEqual(tripFields(form()), { name: 'Açores', start: '2027-07-01', end: '2027-07-10', dayStart: 8, dayEnd: 2, people: 3, currency: '€', budget: 0, tz: '' });
  assert.equal(tripFields(form({ people: '0' })).people, 1);
  assert.equal(tripFields(form({ people: 'muitas' })).people, 1);
  assert.equal(tripFields(form({ budget: '1500.5' })).budget, 1500.5);
  assert.equal(tripFields(form({ budget: '-3' })).budget, 0);
  assert.equal(tripFields(form({ tz: 'tokyo' })).tz, 'Asia/Tokyo');
});

test('newTrip: viagem vazia, com orçamento e fuso só quando os há', () => {
  const t = newTrip(tripFields(form()), newId);
  assert.match(t.id, /^tnovo/);
  assert.deepEqual({ ...t, id: 'x' }, { id: 'x', name: 'Açores', start: '2027-07-01', end: '2027-07-10', dayStart: 8, dayEnd: 2, people: 3, currency: '€', places: [], dayPlaces: {}, blocks: [], tray: [], costs: [] });
  const u = newTrip(tripFields(form({ budget: '900', tz: 'Asia/Tokyo' })), newId);
  assert.deepEqual([u.budget, u.tz], [900, 'Asia/Tokyo']);
  assert.notEqual(u.id, t.id);
});

test('applyTripEdit: o que fica fora das novas datas vai para "por agendar", passa a geral ou sai', () => {
  const t = normTrip({
    id: 't', name: 'Antiga', start: '2027-07-01', end: '2027-07-10', budget: 500, tz: 'Asia/Tokyo',
    places: [{ id: 'p', name: 'Lisboa', c: 1 }],
    dayPlaces: { '2027-07-02': ['p'], '2027-07-09': ['p'] },
    blocks: [
      { id: 'dentro', date: '2027-07-03', start: 600, len: 60, title: 'Dentro', cat: 'tour' },
      { id: 'fora1', date: '2027-07-01', start: 600, len: 60, title: 'Fora 1', cat: 'tour' },
      { id: 'fora2', date: '2027-07-09', start: 600, len: 60, title: 'Fora 2', cat: 'tour' },
    ],
    costs: [{ id: 'c1', label: 'Dentro', amount: 5, date: '2027-07-04' }, { id: 'c2', label: 'Fora', amount: 5, date: '2027-07-09' }, { id: 'c3', label: 'Geral', amount: 5 }],
  });
  const out = applyTripEdit(t, tripFields(form({ start: '2027-07-03', end: '2027-07-05', budget: '', tz: '' })));
  assert.equal(out, 2);
  assert.deepEqual([t.name, t.start, t.end, t.people, t.dayStart], ['Açores', '2027-07-03', '2027-07-05', 3, 8]);
  assert.equal('budget' in t || 'tz' in t, false, 'orçamento e fuso vazios saem');
  assert.deepEqual(t.blocks.map(b => b.id), ['dentro']);
  assert.deepEqual(t.tray.map(b => b.id), ['fora1', 'fora2']);
  assert.ok(t.tray.every(b => !('date' in b) && !('start' in b)));
  assert.deepEqual(t.costs.map(c => c.date), ['2027-07-04', undefined, undefined], 'o custo fora das datas passa a geral');
  assert.deepEqual(t.dayPlaces, {});
  assert.equal(applyTripEdit(t, tripFields(form({ start: '2027-07-03', end: '2027-07-05', budget: '20', tz: 'Asia/Tokyo' }))), 0);
  assert.deepEqual([t.budget, t.tz], [20, 'Asia/Tokyo']);
});
