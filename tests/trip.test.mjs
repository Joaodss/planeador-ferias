// Testes de trip.js: dias, sítios, mover atividades e o quadro noutro fuso (sem DOM).
// Os avisos estão em warnings.test.mjs e os custos em costs.test.mjs.
import { store, clearStore } from './env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { I18N } from '../web/js/i18n.js';
import { normTrip, tripDates, rangeLabel, money, placeById, placeName, addPlace, findBlock, blocksOf, moveTo, toTray, boardFrame, toBoard, fromBoard,
  newBlock, duplicateBlock, removePlace, setDayPlaces, splitDayPlaces, dayEnds, routeSummary, dateRangeLabel,
  toZone, fromZone, editorTime, fromEditor, blockZoneTime } from '../web/js/trip.js';
import { tr } from '../web/js/i18n.js';

process.env.TZ = 'Europe/Lisbon';   // TZ.local(): o segundo fuso quando não há outro escolhido
const H = h => h * 60;
const D1 = '2027-07-05', D2 = '2027-07-06', D3 = '2027-07-07';
const trip = extra => normTrip({ id: 't', name: 'Teste', start: D1, end: D3, dayStart: 8, dayEnd: 2, people: 2, currency: '€', ...extra });
beforeEach(clearStore);

test('days: datas inclusive; início depois do fim → []; máximo 120; sem viagem → []', () => {
  assert.deepEqual(tripDates(trip()), [D1, D2, D3]);
  assert.deepEqual(tripDates(trip({ end: D1 })), [D1]);
  assert.deepEqual(tripDates(trip({ start: D3, end: D1 })), []);
  assert.deepEqual(tripDates({ start: '2027-12-30', end: '2028-01-02' }), ['2027-12-30', '2027-12-31', '2028-01-01', '2028-01-02']);
  const long = tripDates({ start: '2027-01-01', end: '2028-12-31' });
  assert.equal(long.length, 120);
  assert.equal(long.at(-1), '2027-04-30');
  assert.deepEqual(tripDates(null), []);
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
  const frame0 = boardFrame(t);
  assert.deepEqual(frame0, { dates: [D1, D2, D3], firstDate: D1, shiftMin: 0, offsetMin: 0 });
  for (const b of blocks) {
    assert.deepEqual(toBoard(t, frame0, b), { date: b.date, start: b.start });
    assert.deepEqual(fromBoard(t, frame0, b.date, b.start), { date: b.date, start: b.start });
  }

  // No fuso de Nova Iorque: as 09:00 de dia 5 em Lisboa são as 04:00, antes do início do quadro (08:00),
  // e ficam no fim da coluna de dia 4, que só aparece por isso.
  store['ferias-view-home'] = '1';
  const frame = boardFrame(t);
  assert.deepEqual(frame.dates, ['2027-07-04', D1, D2, D3]);
  assert.equal(frame.offsetMin, -300);
  assert.deepEqual(toBoard(t, frame, blocks[0]), { date: '2027-07-04', start: H(28) });
  assert.deepEqual(toBoard(t, frame, blocks[1]), { date: D2, start: H(20) });
  for (const b of blocks) {
    const v = toBoard(t, frame, b);
    assert.deepEqual(fromBoard(t, frame, v.date, v.start), { date: b.date, start: b.start }, b.id);
  }

  // Kiritimati (+14) visto de Pago Pago (−11): 25 h atrás, duas colunas antes da viagem.
  const far = trip({ tz: 'Pacific/Kiritimati', blocks: [{ id: 'cedo', date: D1, start: 0, len: 60, title: 'Cedo', cat: 'tour' }] });
  store['ferias-home-tz'] = 'Pacific/Pago_Pago';
  assert.deepEqual(boardFrame(far).dates, ['2027-07-03', '2027-07-04', D1, D2, D3]);
  far.blocks[0].start = -H(40);   // mais cedo ainda (só possível com dados à mão): continua a haver só duas
  assert.equal(boardFrame(far).dates[0], '2027-07-03');
  // dias fora da viagem não acrescentam colunas
  far.blocks[0] = { id: 'fora', date: '2027-06-01', start: 0, len: 60, title: 'Fora', cat: 'tour' };
  assert.deepEqual(boardFrame(far).dates, [D1, D2, D3]);
});

let ids = 0;
const newId = p => `${p}novo${++ids}`;

test('newBlock: os mesmos valores por omissão no quadro, no painel do dia e em "por agendar"', () => {
  const base = { len: 60, title: tr('newActivity'), cat: 'tour', status: 'ideia' };
  const tray = newBlock({}, newId);
  assert.match(tray.id, /^anovo/);
  assert.deepEqual({ ...tray, id: 'x' }, { id: 'x', ...base });
  assert.deepEqual({ ...newBlock({ date: D2, start: H(9) }, newId), id: 'x' }, { id: 'x', date: D2, start: H(9), ...base });
  assert.notEqual(newBlock({}, newId).id, tray.id);
});

test('duplicateBlock: na grelha fica logo a seguir, em "por agendar" fica lá, fora das datas também, e nunca bloqueada', () => {
  const t = trip({
    blocks: [{ id: 'a', date: D1, start: H(22), len: H(3), title: 'A', cat: 'tour', locked: true, pp: 5 }, { id: 'z', date: D3, start: H(10), len: H(24), title: 'Z', cat: 'tour' }],
    tray: [{ id: 'b', len: 30, title: 'B', cat: 'tour' }],
  });
  const c = duplicateBlock(t, 'a', newId);
  assert.deepEqual([c.date, c.start, c.len, c.pp, c.title], [D1, H(25), H(3), 5, 'A'], 'a A acaba à 01:00 dessa noite, que no quadro ainda é o dia 5');
  assert.equal('locked' in c, false);
  assert.equal(t.blocks[0].locked, true, 'a original continua bloqueada');
  assert.equal(t.blocks.at(-1), c);
  const d = duplicateBlock(t, 'b', newId);
  assert.equal(t.tray.at(-1), d);
  assert.equal('date' in d, false);
  const z = duplicateBlock(t, 'z', newId);
  assert.deepEqual([z.date, z.start], ['2027-07-08', H(10)], 'pode cair fora das datas (aí há um aviso)');
  assert.equal(duplicateBlock(t, 'nada', newId), null);
  t.blocks[0].pp = 9;
  assert.equal(c.pp, 5, 'é uma cópia, não a mesma atividade');
});

test('removePlace: sai dos sítios, dos dias e das atividades na grelha e em "por agendar"', () => {
  const t = trip({
    places: [{ id: 'lx', name: 'Lisboa', c: 1 }, { id: 'po', name: 'Porto', c: 2 }],
    dayPlaces: { [D1]: ['lx'], [D2]: ['lx', 'po'], [D3]: ['po'] },
    blocks: [{ id: 'a', date: D1, start: H(10), len: 60, title: 'A', cat: 'tour', place: 'lx' }, { id: 'b', date: D3, start: H(10), len: 60, title: 'B', cat: 'tour', place: 'po' }],
    tray: [{ id: 'c', len: 60, title: 'C', cat: 'tour', place: 'lx' }],
  });
  removePlace(t, 'lx');
  assert.deepEqual(t.places.map(p => p.id), ['po']);
  assert.deepEqual(t.dayPlaces, { [D2]: ['po'], [D3]: ['po'] });
  assert.deepEqual([t.blocks[0].place, t.blocks[1].place, t.tray[0].place], [undefined, 'po', undefined]);
  const u = trip({ places: [{ id: 'lx', name: 'Lisboa', c: 1 }, { id: 'si', name: 'Sintra', c: 2 }], dayPlaces: { [D1]: ['lx', 'si', 'lx'] } });
  removePlace(u, 'si');
  assert.deepEqual(u.dayPlaces, { [D1]: ['lx'] }, 'sem a paragem do meio, Lisboa não fica repetida');
});

test('setDayPlaces: um dia, um intervalo, segundo sítio só no último dia, e limpar', () => {
  const t = trip();
  assert.equal(setDayPlaces(t, D1, '', 'lx'), false);
  assert.deepEqual(t.dayPlaces, { [D1]: ['lx'] });
  assert.equal(setDayPlaces(t, D1, D3, 'lx', ['po']), true, 'o Porto só fica no último dia: a página avisa');
  assert.deepEqual(t.dayPlaces, { [D1]: ['lx'], [D2]: ['lx'], [D3]: ['lx', 'po'] });
  assert.equal(setDayPlaces(t, D2, '', 'lx', ['po']), false, 'num dia só não há aviso');
  assert.deepEqual(t.dayPlaces[D2], ['lx', 'po']);
  assert.equal(setDayPlaces(t, D1, D2, 'lx', ['lx']), false, 'o mesmo sítio duas vezes conta uma');
  assert.deepEqual(t.dayPlaces[D2], ['lx']);
  setDayPlaces(t, D3, '', '', ['po']);
  assert.deepEqual(t.dayPlaces[D3], ['po'], 'só o segundo sítio');
  setDayPlaces(t, D1, D3, '', ['']);
  assert.deepEqual(t.dayPlaces, {}, 'sem sítios limpa');
});

test('setDayPlaces com paragens: ficam pela ordem só no último dia, sem vazios nem repetidos seguidos (#41)', () => {
  const t = trip();
  assert.equal(setDayPlaces(t, D1, D2, 'lx', ['co', '', 'co', 'po']), true, 'paragens num intervalo: a página avisa');
  assert.deepEqual(t.dayPlaces, { [D1]: ['lx'], [D2]: ['lx', 'co', 'po'] });
  assert.equal(setDayPlaces(t, D3, '', 'po', ['co', 'po']), false);
  assert.deepEqual(t.dayPlaces[D3], ['po', 'co', 'po'], 'ida e volta no mesmo dia');
  setDayPlaces(t, D3, '', 'po', ['co', '']);
  assert.deepEqual(t.dayPlaces[D3], ['po', 'co'], 'sem sítio no fim, a última paragem é onde acabam');
});

test('splitDayPlaces e dayEnds: o painel separa início, paragens e fim; o cabeçalho só mostra início e fim (#41)', () => {
  assert.deepEqual(splitDayPlaces(undefined), { first: '', stops: [], last: '' });
  assert.deepEqual(splitDayPlaces(['lx']), { first: 'lx', stops: [], last: '' });
  assert.deepEqual(splitDayPlaces(['lx', 'po']), { first: 'lx', stops: [], last: 'po' });
  assert.deepEqual(splitDayPlaces(['lx', 'co', 'av', 'po']), { first: 'lx', stops: ['co', 'av'], last: 'po' });
  assert.deepEqual(dayEnds(undefined), []);
  assert.deepEqual(dayEnds(['lx']), ['lx']);
  assert.deepEqual(dayEnds(['lx', 'po']), ['lx', 'po']);
  assert.deepEqual(dayEnds(['lx', 'co', 'av', 'po']), ['lx', 'po']);
  assert.deepEqual(dayEnds(['lx', 'si', 'lx']), ['lx'], 'começam e acabam no mesmo sítio');
});

test('toZone e fromZone: dia e hora no fuso da atividade, ida e volta, e sem fuso → null (#42)', () => {
  const t = trip({ tz: 'Europe/Lisbon' });   // em julho Tóquio está 8 h à frente de Lisboa e Nova Iorque 5 h atrás
  const b = extra => ({ id: 'a', date: D1, start: H(10), len: 60, title: 'Voo', cat: 'transport', tz: 'Asia/Tokyo', ...extra });
  assert.deepEqual(toZone(t, b()), { date: D1, start: H(18), off: H(8) });
  assert.deepEqual(toZone(t, b({ start: H(20) })), { date: D2, start: H(4), off: H(8) }, 'passa para o dia seguinte em Tóquio');
  assert.deepEqual(toZone(t, b({ date: D2, start: H(2), tz: 'America/New_York' })), { date: D1, start: H(21), off: -H(5) });
  assert.deepEqual(toZone(t, b({ start: H(25), tz: 'Europe/Lisbon' })), { date: D2, start: H(1), off: 0 }, 'a 01:00 do quadro é a 01:00 do dia seguinte');
  assert.equal(toZone(t, b({ tz: undefined })), null);
  assert.equal(toZone(t, { id: 'x', len: 60, tz: 'Asia/Tokyo' }), null, 'por agendar');
  assert.equal(toZone(trip(), b()), null, 'viagem sem fuso');
  assert.deepEqual(fromZone(t, 'Asia/Tokyo', D2, H(4)), { date: D1, start: H(20) });
  assert.deepEqual(fromZone(t, 'Asia/Tokyo', D1, H(6)), { date: '2027-07-04', start: H(22) }, 'antes da viagem na hora da viagem');
  assert.deepEqual(fromZone(t, 'Europe/Lisbon', D2, H(1)), { date: D1, start: H(25) }, 'depois da meia-noite fica no dia do quadro');
  for (const s of [0, H(3), H(9.25), H(17), H(23.75)]) {
    const p = fromZone(t, 'Asia/Tokyo', D2, s);
    assert.deepEqual(toZone(t, b(p)), { date: D2, start: s, off: H(8) }, `ida e volta às ${s}`);
  }
});

test('fromZone numa mudança de hora: a diferença é a do dia da viagem a que se chega (#42)', () => {
  // Lisboa muda para a hora de inverno a 31 de outubro de 2027: Tóquio passa de 8 h para 9 h à frente
  const t = normTrip({ id: 't', name: 'Outono', start: '2027-10-29', end: '2027-11-02', dayStart: 8, dayEnd: 2, tz: 'Europe/Lisbon' });
  const p = fromZone(t, 'Asia/Tokyo', '2027-10-31', H(1));
  assert.deepEqual(p, { date: '2027-10-30', start: H(17) });
  assert.deepEqual(toZone(t, { ...p, len: 60, tz: 'Asia/Tokyo' }), { date: '2027-10-31', start: H(1), off: H(8) });
  assert.deepEqual(fromZone(t, 'Asia/Tokyo', '2027-11-01', H(18)), { date: '2027-11-01', start: H(9) });
});

test('editorTime e fromEditor: no fuso da atividade quando tem um, senão na hora do quadro (#42)', () => {
  const t = trip({ tz: 'Europe/Lisbon' }), frame = boardFrame(t);
  const b = { id: 'a', date: D1, start: H(20), len: 60, title: 'Voo', cat: 'transport', tz: 'Asia/Tokyo' };
  assert.deepEqual(editorTime(t, frame, b), { date: D2, start: H(4), off: H(8) });
  assert.deepEqual(fromEditor(t, frame, b, D2, H(5)), { date: D1, start: H(21) });
  const c = { ...b, tz: undefined };
  assert.deepEqual(editorTime(t, frame, c), { date: D1, start: H(20) });
  assert.deepEqual(fromEditor(t, frame, c, D2, H(5)), { date: D2, start: H(5) });
  const u = trip();   // sem fuso da viagem, o fuso da atividade não conta
  assert.deepEqual(editorTime(u, boardFrame(u), b), { date: D1, start: H(20) });
  assert.deepEqual(fromEditor(u, boardFrame(u), b, D2, H(5)), { date: D2, start: H(5) });
});

test('blockZoneTime: a hora local no bloco só quando o fuso da atividade não é o do quadro (#42)', () => {
  const t = trip({ tz: 'Europe/Lisbon' });
  const b = extra => ({ id: 'a', date: D1, start: H(20), len: 90, title: 'Voo', cat: 'transport', tz: 'Asia/Tokyo', ...extra });
  assert.deepEqual(blockZoneTime(t, boardFrame(t), b()), { tz: 'Asia/Tokyo', start: H(4), len: 90, days: 1 });
  assert.deepEqual(blockZoneTime(t, boardFrame(t), b({ tz: 'America/New_York', start: H(3) })), { tz: 'America/New_York', start: H(22), len: 90, days: -1 });
  assert.deepEqual(blockZoneTime(t, boardFrame(t), b({ start: H(25), tz: 'America/New_York' })), { tz: 'America/New_York', start: H(20), len: 90, days: -1 }, 'conta a partir do relógio do quadro, não da coluna');
  assert.equal(blockZoneTime(t, boardFrame(t), b({ tz: 'Europe/Lisbon' })), null, 'o fuso da viagem');
  assert.equal(blockZoneTime(t, boardFrame(t), b({ tz: undefined })), null);
  // quadro na hora do segundo fuso: Tóquio deixa de precisar da marca, Lisboa passa a precisar
  store['ferias-home-tz'] = 'Asia/Tokyo';
  store['ferias-view-home'] = '1';
  assert.equal(blockZoneTime(t, boardFrame(t), b()), null);
  assert.deepEqual(blockZoneTime(t, boardFrame(t), b({ tz: 'Europe/Lisbon' })), { tz: 'Europe/Lisbon', start: H(20), len: 90, days: -1 });
});

test('routeSummary e dateRangeLabel: sítios seguidos sem repetir; mesmo mês ou meses diferentes', () => {
  const t = trip({ dayPlaces: { [D1]: ['lx'], [D2]: ['lx', 'po'], [D3]: ['po', 'lx'] } });
  assert.deepEqual(routeSummary(t), ['lx', 'po', 'lx']);
  assert.deepEqual(routeSummary(trip()), []);
  assert.equal(dateRangeLabel(t), '5–7 jul 2027');
  assert.equal(dateRangeLabel(trip({ start: '2027-06-29', end: '2027-07-02' })), '29 jun – 2 jul 2027');
  assert.equal(dateRangeLabel(trip({ start: '2026-12-20', end: '2027-12-02' })), '20 dez – 2 dez 2027', 'mesmo mês noutro ano');
});
