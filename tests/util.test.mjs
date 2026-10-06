// Testes de util.js: texto, datas e horas (sem DOM).
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { I18N } from '../web/js/i18n.js';
import { pad, esc, newId, shortPlaceName, SNAP, weekdayNames, monthNames, kindLabels, statusLabels, statusLabel, onWeekday, daysPhrase,
  parseISO, iso, addDays, clockLabel, durationLabel, dayLabel } from '../web/js/util.js';

// as datas locais têm de atravessar a mudança de hora; o Node aplica o TZ novo logo, e as datas só se leem dentro dos testes
process.env.TZ = 'Europe/Lisbon';

const inLang = (l, f) => { I18N.set(l); try { f(); } finally { I18N.set('pt'); } };

test('esc escapa & < > " e deixa \' (os atributos usam sempre aspas duplas)', () => {
  assert.equal(esc('<a href="x">Tom & Jerry\'s</a>'), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry\'s&lt;/a&gt;');
  assert.equal(esc(42), '42');
  assert.equal(esc('&amp;'), '&amp;amp;', 'escapa outra vez o que já vinha escapado');
});

test('newId: prefixo, só [A-Za-z0-9_-] (passa no ID do clean.js) e 10 000 ids sem repetidos', () => {
  assert.match(newId('a'), /^a/);
  assert.match(newId(), /^n/);
  const ids = new Set();
  for (let i = 0; i < 10000; i++) {
    const id = newId('t');
    assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 10000);
});

test('parseISO, iso e addDays atravessam a mudança de hora (process.env.TZ = Europe/Lisbon)', () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/Lisbon');
  const d = parseISO('2027-03-27');
  assert.equal(d.getDate(), 27);
  assert.equal(iso(d), '2027-03-27');
  // a hora muda a 28 de março e a 31 de outubro de 2027: cada dia continua a dar o seguinte
  assert.equal(iso(addDays(d, 1)), '2027-03-28');
  assert.equal(iso(addDays(d, 2)), '2027-03-29');
  assert.equal(iso(addDays(parseISO('2027-10-30'), 1)), '2027-10-31');
  assert.equal(iso(addDays(parseISO('2027-10-30'), 2)), '2027-11-01');
  assert.equal(iso(addDays(parseISO('2027-01-01'), -1)), '2026-12-31');
  assert.equal(iso(addDays(parseISO('2028-02-28'), 1)), '2028-02-29');
  assert.equal(iso(d), '2027-03-27', 'addDays não mexe na data que recebe');
});

test('clockLabel: negativos e ≥ 1440 dão a hora do relógio; durationLabel: 15 min, 1h, 1h30', () => {
  assert.equal(clockLabel(0), '00:00');
  assert.equal(clockLabel(9 * 60 + 5), '09:05');
  assert.equal(clockLabel(-30), '23:30');
  assert.equal(clockLabel(1440), '00:00');
  assert.equal(clockLabel(1500), '01:00');
  assert.equal(clockLabel(3000), '02:00');
  assert.equal(durationLabel(15), '15 min');
  assert.equal(durationLabel(60), '1h');
  assert.equal(durationLabel(90), '1h30');
  assert.equal(durationLabel(125), '2h05');
  assert.equal(pad(7), '07');
  assert.equal(pad(12), '12');
});

test('dayLabel com e sem mês, em PT e EN', () => {
  assert.equal(dayLabel('2027-07-05'), '2ª 5');
  assert.equal(dayLabel('2027-07-05', true), '2ª 5 jul');
  assert.equal(dayLabel('2027-07-04', true), 'Dom 4 jul');
  inLang('en', () => {
    assert.equal(dayLabel('2027-07-05'), 'Mon 5');
    assert.equal(dayLabel('2027-07-05', true), 'Mon 5 Jul');
    assert.equal(weekdayNames()[6], 'Sat');
    assert.equal(monthNames()[0], 'Jan');
    assert.equal(kindLabels().food, 'Meal');
  });
});

test('statusLabel: estados conhecidos; desconhecidos e chaves do protótipo dão ""', () => {
  assert.equal(statusLabel('pago'), 'pago');
  assert.equal(statusLabel('reservar'), 'por reservar');
  inLang('en', () => assert.equal(statusLabel('reservado'), 'booked'));
  for (const s of ['xpto', '', 'toString', '__proto__', 'constructor', 1, null, undefined, {}])
    assert.equal(statusLabel(s), '', String(s));
  assert.deepEqual(Object.keys(statusLabels()), ['ideia', 'reservar', 'reservado', 'pago']);
});

test('daysPhrase: domingo no fim, e "e"/"and" antes do último', () => {
  assert.equal(onWeekday(0), 'ao domingo');
  assert.equal(daysPhrase([3]), 'à quarta');
  assert.equal(daysPhrase([0, 3, 1]), 'à segunda, à quarta e ao domingo');
  assert.equal(daysPhrase([6, 0]), 'ao sábado e ao domingo');
  const ws = [0, 3, 1];
  daysPhrase(ws);
  assert.deepEqual(ws, [0, 3, 1], 'não reordena a lista que recebe');
  inLang('en', () => assert.equal(daysPhrase([0, 5, 2]), 'on Tuesday, on Friday and on Sunday'));
});

test('short corta o que vem depois de " ·"; SNAP é 15 min', () => {
  assert.equal(SNAP, 15);
  assert.equal(shortPlaceName('Lisboa · centro'), 'Lisboa');
  assert.equal(shortPlaceName('Porto'), 'Porto');
});
