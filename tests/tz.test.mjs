// Testes de tz.js: reconhecer o fuso escrito pelo utilizador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTz, TZ } from '../web/js/tz.js';

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
