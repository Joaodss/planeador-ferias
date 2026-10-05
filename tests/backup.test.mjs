// Testes de backup.js: o ficheiro da cópia de segurança e importar (sem DOM).
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupName, backupJSON, parseBackup, mergeTrips } from '../web/js/backup.js';

let n = 0;
const newId = p => `${p}novo${++n}`;
const trip = (id, extra) => ({ id, name: 'Viagem ' + id, start: '2027-07-01', end: '2027-07-03', ...extra });

test('backupName e backupJSON: o nome tem a data do dia e o conteúdo é {version:2, savedAt, trips}', () => {
  assert.equal(backupName(new Date(2027, 0, 5)), 'planeador-ferias-2027-01-05.json');
  const trips = [trip('a')];
  assert.deepEqual(JSON.parse(backupJSON(trips, 123)), { version: 2, savedAt: 123, trips });
});

test('parseBackup: ficheiro que não é JSON, sem trips, nenhuma viagem válida', () => {
  assert.throws(() => parseBackup('isto não é JSON'), SyntaxError);
  assert.throws(() => parseBackup('null'), /formato/);
  assert.throws(() => parseBackup('{"version":2}'), /formato/);
  assert.throws(() => parseBackup('{"trips":{}}'), /formato/);
  assert.throws(() => parseBackup('{"trips":[]}'), /vazio/);
  assert.throws(() => parseBackup(JSON.stringify({ trips: [null, 3, trip('a', { name: '' }), trip('b', { start: '1/7/2027' }), trip('c', { end: undefined })] })), /vazio/);
});

test('parseBackup fica só com as viagens com nome e datas AAAA-MM-DD', () => {
  const ok = parseBackup(JSON.stringify({ version: 2, trips: [trip('a'), trip('b', { name: '' }), 'x', trip('c', { end: '2027-7-3' }), trip('d')] }));
  assert.deepEqual(ok.map(t => t.id), ['a', 'd']);
});

test('mergeTrips: substitui pelo id, junta as outras no fim, id inválido recebe um novo, e conta', () => {
  const store = { version: 2, trips: [trip('a'), trip('b')] };
  const res = mergeTrips(store, [trip('x', { name: 'Nova' }), trip('b', { name: 'B importada' }), trip('a.b'), trip(undefined)], newId);
  assert.deepEqual([res.added, res.replaced, res.first], [3, 1, 'x']);
  assert.deepEqual(store.trips.map(t => t.name), ['Viagem a', 'B importada', 'Nova', 'Viagem a.b', 'Viagem undefined']);
  assert.match(store.trips[3].id, /^tnovo\d+$/, '"a.b" não é um id válido');
  assert.match(store.trips[4].id, /^tnovo\d+$/);
  assert.notEqual(store.trips[3].id, store.trips[4].id);
  assert.deepEqual(store.trips[1].blocks, [], 'as viagens importadas passam por normTrip');
});

test('mergeTrips sem viagens não muda nada', () => {
  const store = { version: 2, trips: [trip('a')] };
  assert.deepEqual(mergeTrips(store, [], newId), { added: 0, replaced: 0, first: null });
  assert.equal(store.trips.length, 1);
});
