// Testes da limpeza das viagens (web/js/clean.js): dados malformados vindos de uma cópia importada
// ou do servidor não podem partir o quadro nem meter HTML na página.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanTrip, STATUSES, KINDS, MAX_DAY_PLACES } from '../web/js/clean.js';
import { segments } from '../web/js/span.js';

let n = 0;
const newId = p => `${p}novo${++n}`;
const trip = extra => ({ id: 't1', name: 'Viagem', start: '2026-08-01', end: '2026-08-05', ...extra });

test('uma viagem antiga sem nada recebe os valores por omissão', () => {
  const t = cleanTrip(trip(), newId);
  assert.deepEqual(t.places, []);
  assert.deepEqual(t.dayPlaces, {});
  assert.deepEqual(t.blocks, []);
  assert.deepEqual(t.tray, []);
  assert.deepEqual(t.costs, []);
  assert.equal(t.people, 1);
  assert.equal(t.currency, '€');
  assert.equal(t.dayStart, 7);
  assert.equal(t.dayEnd, 1);
});

test('uma viagem válida fica igual', () => {
  const ok = () => trip({
    dayStart: 8, dayEnd: 2, people: 3, currency: 'R$', budget: 1500, tz: 'Asia/Bangkok',
    places: [{ id: 'p1', name: 'Lisboa', c: 2 }], dayPlaces: { '2026-08-01': ['p1'] },
    blocks: [{ id: 'a1', date: '2026-08-01', start: 600, len: 90, title: 'Museu', cat: 'tour', status: 'pago', locked: true, pp: 12, weekdays: [1, 2], place: 'p1', link: 'https://x.pt', tz: 'Asia/Tokyo' }],
    tray: [{ id: 'a2', len: 60, title: 'Jantar', cat: 'food' }],
    costs: [{ id: 'c1', label: 'Hotel', amount: 300, per: 'total', cat: 'alojamento', date: '2026-08-02', paid: true }],
    costCats: [{ id: 'alojamento', name: 'Casa' }],
  });
  assert.deepEqual(cleanTrip(ok(), newId), ok());
});

test('atividade sem date vai para "por agendar" e o quadro desenha-se', () => {
  const t = cleanTrip(trip({ dayStart: 7, dayEnd: 1, blocks: [{ id: 'a1', start: 600, len: 60, title: 'Sem dia' }, { id: 'a2', date: 'amanhã', start: 60, len: 60 }] }), newId);
  assert.deepEqual(t.blocks, []);
  assert.deepEqual(t.tray.map(b => b.id), ['a1', 'a2']);
  for (const b of t.tray) { assert.equal('date' in b, false); assert.equal('start' in b, false); }
});

test('start e len em texto passam a números; negativos e lixo vão para valores seguros', () => {
  const t = cleanTrip(trip({ blocks: [
    { id: 'a1', date: '2026-08-01', start: '600', len: '90' },
    { id: 'a2', date: '2026-08-01', start: -30, len: -5 },
    { id: 'a3', date: '2026-08-01', start: 'xx', len: null },
    { id: 'a4', date: '2026-08-01', start: [], len: {} },
  ] }), newId);
  assert.deepEqual(t.blocks.map(b => [b.start, b.len]), [[600, 90], [0, 15], [0, 60], [0, 60]]);
  // 10h de dia 1 cai na 1.ª coluna (antes: '600' dava 1440600 e a atividade desaparecia)
  assert.equal(segments(t, t.blocks[0], 5)[0].i, 0);
});

test('estado e tipo fora do enum não passam (nada de HTML na página)', () => {
  const t = cleanTrip(trip({ blocks: [
    { id: 'a1', date: '2026-08-01', start: 600, len: 60, status: 'x"><form action=/>', cat: '"><img>' },
    { id: 'a2', date: '2026-08-01', start: 600, len: 60, status: 'constructor', cat: 'toString' },
  ] }), newId);
  for (const b of t.blocks) { assert.equal('status' in b, false); assert.equal(b.cat, 'tour'); }
});

test('ids de atividade inválidos ou repetidos são trocados', () => {
  const t = cleanTrip(trip({
    blocks: [{ id: 'a"]x', date: '2026-08-01', start: 0, len: 60 }, { id: 'a1', date: '2026-08-01', start: 0, len: 60 }],
    tray: [{ id: 'a1', len: 60 }, { len: 60 }, 'lixo', null],
  }), newId);
  const ids = t.blocks.concat(t.tray).map(b => b.id);
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(t.blocks[1].id, 'a1');
});

test('campos opcionais malformados são removidos ou corrigidos', () => {
  const [b] = cleanTrip(trip({ blocks: [{ id: 'a1', date: '2026-08-01', start: 0, len: 60, title: 5, locked: 'false', pp: 'abc', total: -3, weekdays: 'seg', place: {}, note: 7 }] }), newId).blocks;
  assert.equal(b.title, '5');
  assert.equal(b.note, '7');
  for (const k of ['locked', 'pp', 'total', 'weekdays', 'place']) assert.equal(k in b, false, k);
  const [w] = cleanTrip(trip({ blocks: [{ id: 'a1', date: '2026-08-01', start: 0, len: 60, weekdays: [1, '2', 1, 9] }] }), newId).blocks;
  assert.deepEqual(w.weekdays, [1, 2]);
});

test('moeda com HTML, horário e pessoas malformados voltam aos valores por omissão', () => {
  const t = cleanTrip(trip({ currency: '<b>€', dayStart: '25', dayEnd: 'x', people: 'muitos', budget: 'mil', dayPlaces: { '2026-08-01': 'p1', x: ['p1'] }, costs: [{ id: 'c"', amount: '"><img>', per: 'outro' }] }), newId);
  assert.equal(t.currency, '€');
  assert.equal(t.dayStart, 7);
  assert.equal(t.dayEnd, 1);
  assert.equal(t.people, 1);
  assert.equal('budget' in t, false);
  assert.deepEqual(t.dayPlaces, {});
  assert.match(t.costs[0].id, /^[A-Za-z0-9_-]+$/);
  assert.equal(t.costs[0].amount, 0);
  assert.equal(t.costs[0].per, 'total');
});

test('os enums da limpeza são os mesmos que as traduções', () => {
  const src = readFileSync(new URL('../web/js/i18n.js', import.meta.url), 'utf8');
  const keys = name => [...src.matchAll(new RegExp(`^\\s*${name}:\\{([^}]*)\\}`, 'gm'))].map(m => [...m[1].matchAll(/(\w+):/g)].map(x => x[1]));
  for (const k of keys('status')) assert.deepEqual(k, STATUSES);
  for (const k of keys('cats')) assert.deepEqual(k, KINDS);
  assert.equal(keys('status').length, 2);
  assert.equal(keys('cats').length, 2);
});

test('sítios do dia: as paragens ficam, até MAX_DAY_PLACES, e o que não é texto sai (#41)', () => {
  const many = Array.from({ length: MAX_DAY_PLACES + 3 }, (_, i) => 'p' + i);
  const t = cleanTrip(trip({ dayPlaces: { '2026-08-01': ['lx', 'co', 7, '', 'av', 'po'], '2026-08-02': many } }), newId);
  assert.deepEqual(t.dayPlaces['2026-08-01'], ['lx', 'co', 'av', 'po']);
  assert.deepEqual(t.dayPlaces['2026-08-02'], many.slice(0, MAX_DAY_PLACES));
});

test('fuso da atividade: fica um que o browser reconheça, sai o resto (#42)', () => {
  const t = cleanTrip(trip({
    blocks: [{ id: 'a1', date: '2026-08-01', start: 0, tz: 'Asia/Tokyo' }, { id: 'a2', date: '2026-08-01', start: 0, tz: 'Marte/Base' }, { id: 'a3', date: '2026-08-01', start: 0, tz: 9 }],
    tray: [{ id: 'a4', tz: 'Europe/Lisbon' }, { id: 'a5', tz: '' }],
  }), newId);
  assert.deepEqual(t.blocks.map(b => b.tz), ['Asia/Tokyo', undefined, undefined]);
  assert.deepEqual(t.tray.map(b => b.tz), ['Europe/Lisbon', undefined]);
});
