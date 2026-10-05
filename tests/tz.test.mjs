// Testes dos fusos horários (web/js/tz.js): nomes de cidade escritos no painel "Datas e sítios".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTz, TZ } from '../web/js/tz.js';

test('resolveTz aceita o nome completo ou só a cidade', () => {
  assert.equal(resolveTz('Tokyo'), 'Asia/Tokyo');
  assert.equal(resolveTz('tokyo'), 'Asia/Tokyo');
  assert.equal(resolveTz('Asia/Tokyo'), 'Asia/Tokyo');
  assert.equal(resolveTz('  New York '), 'America/New_York');
});

test('resolveTz aceita os nomes atuais que faltam na lista do Chrome e do Node', () => {
  assert.equal(resolveTz('Kolkata'), 'Asia/Kolkata');
  assert.equal(resolveTz('kyiv'), 'Europe/Kyiv');
  assert.equal(resolveTz('Ho Chi Minh'), 'Asia/Ho_Chi_Minh');
  assert.equal(resolveTz('Kathmandu'), 'Asia/Kathmandu');
  assert.equal(resolveTz('Yangon'), 'Asia/Yangon');
  assert.equal(resolveTz('Nuuk'), 'America/Nuuk');
  assert.equal(resolveTz('Faroe'), 'Atlantic/Faroe');
});

test('resolveTz continua a aceitar os nomes antigos', () => {
  assert.ok(['Asia/Calcutta', 'Asia/Kolkata'].includes(resolveTz('Calcutta')));
  assert.ok(TZ.valid(resolveTz('Asia/Calcutta')));
});

test('resolveTz devolve vazio ou null quando não há fuso', () => {
  assert.equal(resolveTz('   '), '');
  assert.equal(resolveTz('Cidade Inventada'), null);
  assert.equal(resolveTz('Asia/Inventada'), null);
});

test('as sugestões incluem os nomes atuais', () => {
  for (const z of ['Asia/Kolkata', 'Europe/Kyiv', 'Asia/Tokyo']) assert.ok(TZ.all.includes(z), z);
  assert.equal(new Set(TZ.all).size, TZ.all.length);
});
