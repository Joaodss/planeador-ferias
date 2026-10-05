// Testes de warnings.js: as regras dos "pontos a rever", sem DOM.
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tr } from '../web/js/i18n.js';
import { normTrip, days, boardLayout } from '../web/js/trip.js';
import { computeWarnings, sortWarnings } from '../web/js/warnings.js';
import { dayLabel } from '../web/js/util.js';

// 5 a 8 de julho de 2027 (segunda a quinta), quadro das 08:00 às 02:00. Lisboa nos dois primeiros dias, Porto depois.
const H = h => h * 60;
function trip() {
  return normTrip({
    id: 't', name: 'Teste', start: '2027-07-05', end: '2027-07-08', dayStart: 8, dayEnd: 2, people: 2, currency: '€',
    places: [{ id: 'lx', name: 'Lisboa', c: 1 }, { id: 'po', name: 'Porto', c: 2 }],
    dayPlaces: { '2027-07-05': ['lx'], '2027-07-06': ['lx'], '2027-07-07': ['po'], '2027-07-08': ['po'] },
    blocks: [
      { id: 'museu', date: '2027-07-05', start: H(10), len: H(2), title: 'Museu', cat: 'tour', pp: 10 },
      { id: 'almoco', date: '2027-07-05', start: H(11), len: H(1), title: 'Almoço', cat: 'food', total: 30 },
      { id: 'feira', date: '2027-07-05', start: H(15), len: H(1), title: 'Feira', cat: 'tour', weekdays: [3], place: 'lx' },
      { id: 'mercado', date: '2027-07-05', start: H(17), len: H(1), title: 'Mercado', cat: 'tour', weekdays: [3] },
      { id: 'sono', date: '2027-07-06', start: H(23), len: H(8), title: 'Dormir', cat: 'sleep' },
      { id: 'jantar', date: '2027-07-06', start: H(23.5), len: H(1), title: 'Jantar tarde', cat: 'food' },
      { id: 'cedo', date: '2027-07-06', start: H(4), len: H(1), title: 'Nascer do sol', cat: 'tour' },
      { id: 'torre', date: '2027-07-07', start: H(9), len: H(1), title: 'Torre', cat: 'tour', place: 'lx' },
      { id: 'festa', date: '2027-07-07', start: H(21), len: H(2.5), title: 'Festa', cat: 'party' },
      { id: 'barco', date: '2027-07-08', start: H(9), len: H(1), title: 'Barco', cat: 'transport' },
      { id: 'fora', date: '2027-07-20', start: H(10), len: H(1), title: 'Fora', cat: 'tour' },
    ],
    tray: [], costs: [{ id: 'c1', label: 'Hotel', amount: 100, per: 'total', date: '2027-07-05' }, { id: 'c2', label: 'Seguro', amount: 5, per: 'pp' }],
  });
}
const brief = W => W.map(w => [w.sev, w.ids.join('+'), w.date]);

test('cada regra dos pontos a rever aparece com as atividades e o dia certos', () => {
  const t = trip();
  assert.deepEqual(brief(computeWarnings(t)), [
    ['bad', 'museu+almoco', '2027-07-05'],      // ao mesmo tempo
    ['warn', 'sono+jantar', '2027-07-06'],      // entra no sono
    ['bad', 'feira', '2027-07-05'],             // só acontece à quarta
    ['bad', 'mercado', '2027-07-05'],
    ['warn', 'cedo', '2027-07-06'],             // às 04:00, fora do horário do quadro
    ['bad', 'torre', '2027-07-07'],             // é em Lisboa e nesse dia estão no Porto
    ['warn', 'festa+barco', '2027-07-08'],      // festa até tarde e barco cedo no dia seguinte
    ['bad', 'fora', '2027-07-20'],              // fora das datas da viagem
  ]);
});

test('com o layout de render() os avisos são os mesmos', () => {
  const t = trip();
  assert.deepEqual(computeWarnings(t, boardLayout(t, days(t))), computeWarnings(t));
});

test('os dias possíveis dependem dos dias da semana e do sítio de cada atividade', () => {
  const t = trip();
  const W = computeWarnings(t), d = id => W.find(w => w.ids[0] === id && w.sev === 'bad').d;
  // a feira é em Lisboa e a única quarta é no Porto; o mercado não tem sítio
  assert.ok(d('feira').endsWith(': ' + tr('none') + '.'), d('feira'));
  assert.ok(d('mercado').endsWith(': ' + dayLabel('2027-07-07') + '.'), d('mercado'));
});


// 5 a 7 de julho de 2027, quadro das 08:00 às 02:00, sem sítios.
const small = blocks => normTrip({ id: 'w', name: 'W', start: '2027-07-05', end: '2027-07-07', dayStart: 8, dayEnd: 2, people: 1, blocks });
const act = (id, date, start, len, cat) => ({ id, date, start, len, cat, title: id });

test('festa que acaba às 23:00 em ponto conta; atividade às 10:00 do dia seguinte não; no último dia não há dia seguinte', () => {
  const next = [
    act('cedo', '2027-07-06', H(8), 30, 'tour'),
    act('comer', '2027-07-06', H(9), 30, 'food'),         // refeição: não conta
    act('barco', '2027-07-06', H(9.5), 30, 'transport'),  // às 09:30, ainda antes das 10:00
    act('tarde', '2027-07-06', H(10), H(1), 'tour'),       // às 10:00 já não é cedo
  ];
  let t = small([act('festa', '2027-07-05', H(21), H(2), 'party'), ...next]);
  assert.deepEqual(brief(computeWarnings(t)), [['warn', 'festa+cedo', '2027-07-06'], ['warn', 'festa+barco', '2027-07-06']]);
  t = small([act('festa', '2027-07-05', H(21), H(2) - 1, 'party'), ...next]);
  assert.deepEqual(computeWarnings(t), [], 'acaba às 22:59: não é até tarde');
  t = small([act('festa', '2027-07-07', H(22), H(3), 'party')]);
  assert.deepEqual(computeWarnings(t), [], 'festa no último dia');
});

test('sobreposição que passa da meia-noite (dia 1 às 25:00 e dia 2 à 01:00)', () => {
  const t = small([
    act('antes', '2027-07-05', H(23), H(2), 'tour'),   // 23:00–01:00: acaba quando a noite começa
    act('noite', '2027-07-05', H(25), H(1), 'tour'),   // 01:00–02:00 da noite de dia 5
    act('cedo', '2027-07-06', H(1), H(1), 'tour'),     // o mesmo instante, guardado no dia 6
  ]);
  const W = computeWarnings(t);
  assert.deepEqual(brief(W), [['bad', 'noite+cedo', '2027-07-06']]);
  assert.equal(W[0].d, `${dayLabel('2027-07-06', true)} · 01:00–02:00`);
  assert.equal(W[0].t, tr('wOverlap', { a: 'noite', b: 'cedo' }));
});

test('sem viagem → []; atividade fora das datas → só o aviso das datas', () => {
  assert.deepEqual(computeWarnings(null), []);
  // fora das datas, a horas escondidas, num dia da semana errado e sobrepostas: só conta estar fora das datas
  const fora = { ...act('fora', '2027-08-01', H(3), H(2), 'tour'), weekdays: [3] };
  const t = small([fora, act('outra', '2027-08-01', H(4), H(1), 'tour')]);
  assert.deepEqual(brief(computeWarnings(t)), [['bad', 'fora', '2027-08-01'], ['bad', 'outra', '2027-08-01']]);
  assert.equal(computeWarnings(t)[0].t, tr('wDates', { a: 'fora' }));
});

test('sortWarnings: por data e, no mesmo dia, os graves primeiro, sem mudar a lista recebida', () => {
  const ws = [{ date: '2027-07-06', sev: 'warn', t: '1' }, { date: '2027-07-05', sev: 'warn', t: '2' }, { date: '2027-07-06', sev: 'bad', t: '3' }, { date: '2027-07-05', sev: 'bad', t: '4' }, { date: '2027-07-05', sev: 'warn', t: '5' }];
  assert.deepEqual(sortWarnings(ws).map(w => w.t), ['4', '2', '5', '3', '1']);
  assert.deepEqual(ws.map(w => w.t), ['1', '2', '3', '4', '5']);
  assert.deepEqual(sortWarnings(computeWarnings(trip())).map(w => w.date), [...computeWarnings(trip()).map(w => w.date)].sort());
});
