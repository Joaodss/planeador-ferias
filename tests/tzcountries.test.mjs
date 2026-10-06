import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tzCountry } from '../web/js/tzcountries.js';
import { TZ } from '../web/js/tz.js';

test('tzCountry: o país (ISO 3166) de cada fuso, pela cidade', () => {
  assert.equal(tzCountry('Europe/Lisbon'), 'PT');
  assert.equal(tzCountry('Atlantic/Azores'), 'PT');
  assert.equal(tzCountry('America/Argentina/Salta'), 'AR');
  assert.equal(tzCountry('America/Indiana/Knox'), 'US');
  assert.equal(tzCountry('Antarctica/Troll'), 'AQ');
});

test('tzCountry: os nomes antigos que o Chrome e o Node listam também têm país', () => {
  assert.equal(tzCountry('America/Buenos_Aires'), 'AR');
  assert.equal(tzCountry('America/Indianapolis'), 'US');
  assert.equal(tzCountry('America/Louisville'), 'US');
});

test('tzCountry: vazio para um fuso sem país, um desconhecido ou nada', () => {
  assert.equal(tzCountry('UTC'), '');
  assert.equal(tzCountry('Marte/Base'), '');
  assert.equal(tzCountry(''), '');
  assert.equal(tzCountry(undefined), '');
});

test('tzCountry: todos os fusos que o motor lista têm país', () => {
  assert.deepEqual(TZ.all.filter(z => !tzCountry(z)), []);
});
