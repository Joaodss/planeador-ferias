// Testes dos módulos com estado mas sem interface (trip.js, costs.js, warnings.js), num DOM mínimo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const def = (k, value) => Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
const store = {};
def('navigator', { language: 'pt-PT' });
def('localStorage', { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } });
def('document', { documentElement: {}, querySelector: () => ({}), querySelectorAll: () => [] });
def('getComputedStyle', () => ({ getPropertyValue: () => '24' }));

const { S } = await import('../web/js/state.js');
const { I18N, tr } = await import('../web/js/i18n.js');
const { normTrip, days, boardLayout, fmt } = await import('../web/js/trip.js');
const { dayTotalsPP } = await import('../web/js/costs.js');
const { computeWarnings } = await import('../web/js/warnings.js');
const { dayLabel } = await import('../web/js/util.js');

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
const use = t => { S.store = { version: 2, trips: [t] }; S.activeId = t.id; return t; };
const brief = W => W.map(w => [w.sev, w.ids.join('+'), w.date]);

test('cada regra dos pontos a rever aparece com as atividades e o dia certos', () => {
  use(trip());
  assert.deepEqual(brief(computeWarnings()), [
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
  const t = use(trip());
  assert.deepEqual(computeWarnings(boardLayout(t, days(t))), computeWarnings());
});

test('os dias possíveis dependem dos dias da semana e do sítio de cada atividade', () => {
  use(trip());
  const W = computeWarnings(), d = id => W.find(w => w.ids[0] === id && w.sev === 'bad').d;
  // a feira é em Lisboa e a única quarta é no Porto; o mercado não tem sítio
  assert.ok(d('feira').endsWith(': ' + tr('none') + '.'), d('feira'));
  assert.ok(d('mercado').endsWith(': ' + dayLabel('2027-07-07') + '.'), d('mercado'));
});

test('fmt dá o mesmo que toLocaleString, nas duas línguas', () => {
  use(trip());
  for (const v of [0, 7, 1234.5, 0.005, 98765.4321]) {
    I18N.set('pt'); assert.equal(fmt(v), (Math.round(v * 100) / 100).toLocaleString('pt-PT', { maximumFractionDigits: 2 }) + ' €');
    I18N.set('en'); assert.equal(fmt(v), '€' + (Math.round(v * 100) / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 }));
  }
  I18N.set('pt');
});

test('dayTotalsPP soma por pessoa as atividades e os custos de cada dia', () => {
  const m = dayTotalsPP(use(trip()));
  assert.equal(m.get('2027-07-05'), 10 + 30 / 2 + 100 / 2);   // museu pp + almoço total + hotel do dia
  assert.equal(m.get('2027-07-06'), 0);
  assert.equal(m.has('2027-07-09'), false);                   // o seguro não tem dia
});
