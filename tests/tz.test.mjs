// Testes de tz.js: contas de fusos e mudança de hora, o segundo fuso e reconhecer o fuso escrito pelo utilizador.
import { store, storage, clearStore } from './env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTz, TZ, tzOptions, gmtLabel, countryName, tzMatch, tzFilter, setServerHomeTz, defaultHomeTz, ownHomeTz, homeTz, saveHomeTz, secondTz, viewingHome, setViewingHome, viewOffset } from '../web/js/tz.js';

process.env.TZ = 'Europe/Lisbon';   // o fuso do "browser" (TZ.local); o Node aplica-o logo
const noon = date => Date.parse(date + 'T12:00:00Z');
beforeEach(() => { clearStore(); setServerHomeTz(''); });

test('TZ.valid: válido, inválido, vazio', () => {
  assert.equal(TZ.valid('Europe/Lisbon'), true);
  assert.equal(TZ.valid('UTC'), true);
  assert.equal(TZ.valid('Marte/Base'), false);
  assert.equal(TZ.valid(''), false);
  assert.equal(TZ.valid(undefined), false);
});

test('offsetAt: UTC 0, Lisboa +60 no verão e 0 no inverno, Índia +330, Katmandu +345', () => {
  assert.equal(TZ.offsetAt('UTC', noon('2027-07-01')), 0);
  assert.equal(TZ.offsetAt('Europe/Lisbon', noon('2027-07-01')), 60);
  assert.equal(TZ.offsetAt('Europe/Lisbon', noon('2027-01-15')), 0);
  assert.equal(TZ.offsetAt('Asia/Kolkata', noon('2027-07-01')), 330);
  assert.equal(TZ.offsetAt('Asia/Kathmandu', noon('2027-07-01')), 345);
  assert.equal(TZ.offsetAt('America/New_York', noon('2027-07-01')), -240);
  // a hora muda em Lisboa às 01:00 UTC de 28 de março de 2027
  assert.equal(TZ.offsetAt('Europe/Lisbon', Date.parse('2027-03-28T00:59:59.900Z')), 0);
  assert.equal(TZ.offsetAt('Europe/Lisbon', Date.parse('2027-03-28T01:00:00Z')), 60);
});

test('diff: Tóquio menos Lisboa ao meio-dia UTC; null com um fuso inválido', () => {
  assert.equal(TZ.diff('Europe/Lisbon', 'Asia/Tokyo', '2027-07-01'), 480);
  assert.equal(TZ.diff('Europe/Lisbon', 'Asia/Tokyo', '2027-01-15'), 540);
  assert.equal(TZ.diff('Asia/Tokyo', 'Europe/Lisbon', '2027-01-15'), -540);
  assert.equal(TZ.diff('Europe/Lisbon', 'Europe/Lisbon', '2027-07-01'), 0);
  assert.equal(TZ.diff('Europe/Lisbon', 'Marte/Base', '2027-07-01'), null);
  assert.equal(TZ.diff('', 'Asia/Tokyo', '2027-07-01'), null);
});

test('city e diffLabel: "Buenos Aires"; 0 → ""; −90 → "−1:30h"; 60 → "+1h"', () => {
  assert.equal(TZ.city('America/Argentina/Buenos_Aires'), 'Buenos Aires');
  assert.equal(TZ.city('Asia/Tokyo'), 'Tokyo');
  assert.equal(TZ.city('UTC'), 'UTC');
  assert.equal(TZ.city(''), '');
  assert.equal(TZ.city(undefined), '');
  assert.equal(TZ.diffLabel(0), '');
  assert.equal(TZ.diffLabel(null), '');
  assert.equal(TZ.diffLabel(-90), '−1:30h');
  assert.equal(TZ.diffLabel(60), '+1h');
  assert.equal(TZ.diffLabel(345), '+5:45h');
  assert.equal(TZ.diffLabel(-600), '−10h');
});

test('homeTz: escolha do dispositivo > servidor > browser; saveHomeTz apaga quando é igual à omissão', () => {
  assert.equal(TZ.local(), 'Europe/Lisbon');
  assert.equal(homeTz(), 'Europe/Lisbon', 'sem mais nada, o fuso do browser');
  setServerHomeTz('Marte/Base');
  assert.equal(defaultHomeTz(), 'Europe/Lisbon', 'um PLANNER_HOME_TZ inválido é ignorado');
  setServerHomeTz('Asia/Tokyo');
  assert.equal(defaultHomeTz(), 'Asia/Tokyo');
  assert.equal(homeTz(), 'Asia/Tokyo', 'o do servidor ganha ao do browser');

  store['ferias-home-tz'] = 'America/New_York';
  assert.equal(ownHomeTz(), 'America/New_York');
  assert.equal(homeTz(), 'America/New_York', 'o deste dispositivo ganha a todos');
  store['ferias-home-tz'] = 'Marte/Base';
  assert.equal(ownHomeTz(), '');
  assert.equal(homeTz(), 'Asia/Tokyo', 'uma escolha guardada inválida é ignorada');

  saveHomeTz('Europe/Paris');
  assert.equal(store['ferias-home-tz'], 'Europe/Paris');
  saveHomeTz('Asia/Tokyo');
  assert.equal('ferias-home-tz' in store, false, 'igual ao valor por omissão: não guarda nada');
  saveHomeTz('Europe/Paris'); saveHomeTz('');
  assert.equal('ferias-home-tz' in store, false);

  storage.fail = true;
  try {
    assert.equal(ownHomeTz(), '');
    assert.equal(homeTz(), 'Asia/Tokyo');
    assert.doesNotThrow(() => saveHomeTz('Europe/Paris'));
  } finally { storage.fail = false; }
});

test('secondTz: null sem fuso ou com o mesmo fuso; um só desvio por viagem, calculado no dia de início, mesmo com mudança de hora a meio', () => {
  // Lisboa é o segundo fuso (o do browser)
  assert.equal(secondTz(null), null);
  assert.equal(secondTz({ start: '2027-07-01' }), null, 'viagem sem fuso');
  assert.equal(secondTz({ tz: 'Marte/Base', start: '2027-07-01' }), null);
  assert.equal(secondTz({ tz: 'Europe/Lisbon', start: '2027-07-01' }), null, 'o mesmo fuso');
  assert.equal(secondTz({ tz: 'Europe/London', start: '2027-07-01' }), null, 'outro nome com a mesma hora');
  assert.deepEqual(secondTz({ tz: 'Asia/Tokyo', start: '2027-07-01' }), { tz: 'Europe/Lisbon', diff: -480 });
  // Nova Iorque muda a hora a 14 de março e Lisboa a 28: a meio da viagem a diferença passa de 5 h para 4 h,
  // mas a grelha usa sempre a do primeiro dia
  const ny = { tz: 'America/New_York', start: '2027-03-10', end: '2027-03-20' };
  assert.deepEqual(secondTz(ny), { tz: 'Europe/Lisbon', diff: 300 });
  assert.equal(TZ.diff(ny.tz, 'Europe/Lisbon', ny.end), 240);
  assert.deepEqual(secondTz({ ...ny, start: '2027-03-20' }), { tz: 'Europe/Lisbon', diff: 240 });
});

test('viewingHome, setViewingHome e viewOffset', () => {
  const t = { tz: 'Asia/Tokyo', start: '2027-07-01' };
  assert.equal(viewingHome(), false);
  assert.equal(viewOffset(t), 0, 'na hora da viagem não há desvio');
  setViewingHome(true);
  assert.equal(store['ferias-view-home'], '1');
  assert.equal(viewingHome(), true);
  assert.equal(viewOffset(t), -480);
  assert.equal(viewOffset({ start: '2027-07-01' }), 0, 'viagem sem fuso: não há segundo fuso');
  setViewingHome(false);
  assert.equal('ferias-view-home' in store, false);
  assert.equal(viewOffset(t), 0);
  storage.fail = true;
  try {
    assert.equal(viewingHome(), false);
    assert.doesNotThrow(() => setViewingHome(true));
  } finally { storage.fail = false; }
});

test('resolveTz aceita o nome completo ou só a cidade', () => {
  assert.equal(resolveTz('Asia/Tokyo'), 'Asia/Tokyo');
  assert.equal(resolveTz('asia/tokyo'), 'Asia/Tokyo');
  assert.equal(resolveTz('Tokyo'), 'Asia/Tokyo');
  assert.equal(resolveTz('  tokyo '), 'Asia/Tokyo');
  assert.equal(resolveTz('New York'), 'America/New_York');
});

test('resolveTz reconhece os nomes atuais e os antigos das cidades renomeadas', () => {
  assert.equal(resolveTz('Kolkata'), 'Asia/Kolkata');
  assert.equal(resolveTz('kyiv'), 'Europe/Kyiv');
  assert.equal(resolveTz('Ho Chi Minh'), 'Asia/Ho_Chi_Minh');
  assert.equal(resolveTz('Kathmandu'), 'Asia/Kathmandu');
  assert.equal(resolveTz('Yangon'), 'Asia/Yangon');
  assert.equal(resolveTz('Nuuk'), 'America/Nuuk');
  assert.equal(resolveTz('Faroe'), 'Atlantic/Faroe');
  assert.ok(TZ.valid(resolveTz('Calcutta')));
  assert.ok(TZ.valid(resolveTz('Kiev')));
});

test('resolveTz devolve "" para vazio e null para um nome inventado', () => {
  assert.equal(resolveTz(''), '');
  assert.equal(resolveTz('   '), '');
  assert.equal(resolveTz('Atlantida'), null);
  assert.equal(resolveTz('Asia/Atlantida'), null);
});

test('a lista de sugestões mostra os nomes atuais, sem repetidos', () => {
  assert.ok(TZ.all.includes('Asia/Kolkata'));
  assert.ok(TZ.all.includes('Europe/Kyiv'));
  assert.ok(!TZ.all.includes('Asia/Calcutta'));
  assert.equal(new Set(TZ.all).size, TZ.all.length);
});

test('gmtLabel: sinal, horas e minutos sempre com dois algarismos', () => {
  assert.equal(gmtLabel(0), 'GMT+00:00');
  assert.equal(gmtLabel(60), 'GMT+01:00');
  assert.equal(gmtLabel(345), 'GMT+05:45');
  assert.equal(gmtLabel(-210), 'GMT−03:30');
  assert.equal(gmtLabel(-600), 'GMT−10:00');
});

test('tzOptions: pela diferença para GMT, depois pela cidade, com o país e a sub-região quando não é o país', () => {
  const o = tzOptions('', '2027-07-01');
  assert.equal(o.length, TZ.all.length, 'todos os fusos, uma vez');
  assert.deepEqual(new Set(o.map(z => z.tz)), new Set(TZ.all));
  const byOffset = (a, b) => a.offset - b.offset || TZ.city(a.tz).localeCompare(TZ.city(b.tz));
  assert.deepEqual(o, [...o].sort(byOffset), 'por diferença e, com a mesma, pela cidade');
  assert.ok(o[0].offset < 0 && o.at(-1).offset > 0);
  const lisbon = o.find(z => z.tz === 'Europe/Lisbon');
  assert.deepEqual([lisbon.offset, lisbon.label], [60, '(GMT+01:00) Lisbon, Portugal']);
  const label = tz => o.find(z => z.tz === tz).label;
  assert.equal(label('Asia/Kathmandu'), '(GMT+05:45) Kathmandu, Nepal');
  assert.equal(label('America/Argentina/Salta'), '(GMT−03:00) Salta, Argentina', 'a sub-região é o país: não se repete');
  assert.equal(label('America/Indiana/Knox'), '(GMT−05:00) Knox (Indiana), United States');
  assert.equal(label('America/North_Dakota/New_Salem'), '(GMT−05:00) New Salem (North Dakota), United States');
  // Lisboa e Londres têm a mesma diferença: ficam juntas, pela cidade
  const i = o.findIndex(z => z.tz === 'Europe/Lisbon'), j = o.findIndex(z => z.tz === 'Europe/London');
  assert.ok(o[j].offset === o[i].offset && j > i);
});

test('tzOptions: o país vem na língua pedida', () => {
  const pt = tzOptions('', '2027-07-01', 'pt');
  assert.equal(pt.find(z => z.tz === 'Europe/Berlin').label, '(GMT+02:00) Berlin, Alemanha');
  assert.equal(pt.find(z => z.tz === 'America/New_York').label, '(GMT−04:00) New York, Estados Unidos');
});

test('tzOptions: a diferença é a da data dada (hora de verão); sem data válida, a de agora', () => {
  const lisbon = date => tzOptions('', date).find(z => z.tz === 'Europe/Lisbon');
  assert.equal(lisbon('2027-01-15').label, '(GMT+00:00) Lisbon, Portugal');
  assert.equal(lisbon('2027-07-01').label, '(GMT+01:00) Lisbon, Portugal');
  // no inverno do norte, Sydney está 11 h à frente; no verão do norte, 10 h
  assert.equal(tzOptions('', '2027-01-15').find(z => z.tz === 'Australia/Sydney').offset, 660);
  assert.equal(tzOptions('', '2027-07-01').find(z => z.tz === 'Australia/Sydney').offset, 600);
  const now = TZ.offsetAt('Europe/Lisbon', Date.now());
  assert.equal(lisbon('').offset, now);
  assert.equal(lisbon(undefined).offset, now);
  assert.equal(lisbon('nada').offset, now);
});

test('tzOptions: um nome antigo guardado entra na lista; um inválido não (#43)', () => {
  // o Node lista Asia/Calcutta, mas TZ.all troca-o por Asia/Kolkata; o nome antigo fica sem país
  assert.equal(TZ.all.includes('Asia/Calcutta'), false);
  const o = tzOptions('Asia/Calcutta', '2027-07-01');
  assert.deepEqual(o.filter(z => /Calcutta|Kolkata/.test(z.tz)).map(z => z.label), ['(GMT+05:30) Calcutta', '(GMT+05:30) Kolkata, India']);
  assert.equal(tzOptions('Marte/Base', '2027-07-01').length, TZ.all.length, 'um inválido não entra');
  // um fuso sem região (UTC, quando o motor não o lista) também entra
  if (!TZ.all.includes('UTC')) assert.equal(tzOptions('UTC', '2027-07-01').find(z => z.tz === 'UTC').label, '(GMT+00:00) UTC');
});

test('countryName: na língua pedida; o código se a língua não servir; vazio sem código', () => {
  assert.equal(countryName('PT', 'pt'), 'Portugal');
  assert.equal(countryName('DE', 'pt'), 'Alemanha');
  assert.equal(countryName('DE', 'en'), 'Germany');
  assert.equal(countryName('', 'en'), '');
  assert.equal(countryName('DE', '!!'), 'DE', 'língua inválida');
});

test('tzMatch: por cidade, país (na língua da página, em inglês ou o código), GMT ou nome do fuso, sem acentos', () => {
  const o = tzOptions('', '2027-07-01', 'pt');
  const find = q => o.filter(z => tzMatch(z, q)).map(z => z.tz);
  assert.deepEqual(find('lisbon'), ['Europe/Lisbon']);
  assert.deepEqual(find('NEW YORK'), ['America/New_York']);
  assert.deepEqual(find('new_york'), ['America/New_York'], 'o _ do nome do fuso conta como espaço');
  assert.deepEqual(find('alemanha').sort(), ['Europe/Berlin', 'Europe/Busingen']);
  assert.deepEqual(find('germany').sort(), ['Europe/Berlin', 'Europe/Busingen']);
  assert.ok(find('portugal').includes('Atlantic/Azores'));
  assert.ok(find('BR').includes('America/Sao_Paulo'), 'o código do país');
  assert.deepEqual(find('são paulo'), ['America/Sao_Paulo'], 'sem acentos');
  assert.ok(find('Japão').includes('Asia/Tokyo'));
  assert.deepEqual(find('gmt+05:45'), ['Asia/Kathmandu']);
  assert.deepEqual(find('indiana knox'), ['America/Indiana/Knox'], 'todas as palavras, por qualquer ordem');
  assert.deepEqual(find('europe/lis'), ['Europe/Lisbon']);
  assert.deepEqual(find('atlantida'), []);
  assert.equal(find('').length, o.length, 'vazia: todas');
  assert.equal(find('  ').length, o.length);
});

test('tzFilter: as que servem, por ordem, e a escolhida mesmo que não sirva', () => {
  const o = tzOptions('', '2027-07-01');
  assert.deepEqual(tzFilter(o, 'germany', '').map(z => z.tz), ['Europe/Berlin', 'Europe/Busingen']);
  assert.deepEqual(tzFilter(o, 'germany', 'Asia/Tokyo').map(z => z.tz).sort(), ['Asia/Tokyo', 'Europe/Berlin', 'Europe/Busingen']);
  assert.deepEqual(tzFilter(o, 'atlantida', 'Asia/Tokyo').map(z => z.tz), ['Asia/Tokyo']);
  assert.equal(tzFilter(o, '', '').length, o.length);
});
