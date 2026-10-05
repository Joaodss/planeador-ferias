// Testes de state.js: viagem ativa e pilha do Desfazer (num DOM mínimo, com um botão #undo falso).
import { store, storage, el } from './dom.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

store['ferias-active-trip'] = 'b';   // a viagem aberta da última vez: state.js lê-a quando é carregado
const { S, T, ensureActive, setActive, pushHistory, dropHistory, clearHistory, SLEEP_KEY } = await import('../web/js/state.js');

const trip = id => ({ id, name: 'Viagem ' + id, blocks: [] });
const undo = el('#undo');

test('a viagem ativa vem do localStorage', () => {
  assert.equal(S.activeId, 'b');
  assert.equal(SLEEP_KEY, 'ferias-hide-sleep');
});

test('T, ensureActive e setActive: escolhe a primeira, guarda no localStorage, aguenta um localStorage que falha', () => {
  S.store = { version: 2, trips: [] };
  assert.equal(T(), null);
  ensureActive();
  assert.equal(S.activeId, null, 'sem viagens não há nenhuma ativa');

  S.store.trips = [trip('a'), trip('b')];
  S.activeId = 'b';
  ensureActive();
  assert.equal(T().id, 'b', 'a viagem guardada continua aberta');

  S.activeId = 'apagada';
  assert.equal(T(), null);
  ensureActive();
  assert.equal(T().id, 'a', 'se a viagem guardada já não existe, abre a primeira');

  setActive('b');
  assert.equal(T().id, 'b');
  assert.equal(store['ferias-active-trip'], 'b');

  storage.fail = true;
  try { assert.doesNotThrow(() => setActive('a')); } finally { storage.fail = false; }
  assert.equal(T().id, 'a', 'sem localStorage a viagem muda na mesma');
  assert.equal(store['ferias-active-trip'], 'b');
});

test('pushHistory guarda só a viagem ativa; com whole guarda a store', () => {
  S.store = { version: 2, trips: [trip('a'), trip('b')] };
  setActive('a');
  clearHistory();
  assert.equal(undo.disabled, true);

  pushHistory();
  assert.equal(undo.disabled, false);
  assert.deepEqual(S.history.at(-1), { id: 'a', trip: JSON.stringify(trip('a')) });

  pushHistory(true);
  assert.deepEqual(S.history.at(-1), { store: JSON.stringify(S.store), id: 'a' });

  // sem viagem ativa (por exemplo, antes de criar a primeira) guarda a store
  S.activeId = null; S.store.trips = [];
  pushHistory();
  assert.deepEqual(S.history.at(-1), { store: JSON.stringify({ version: 2, trips: [] }), id: null });
});

test('o histórico fica com os 60 pontos mais recentes; dropHistory e clearHistory', () => {
  S.store = { version: 2, trips: [trip('a')] };
  setActive('a');
  clearHistory();
  for (let i = 0; i < 70; i++) { T().name = 'v' + i; pushHistory(); }
  assert.equal(S.history.length, 60);
  assert.equal(JSON.parse(S.history[0].trip).name, 'v10', 'os 10 mais antigos saíram');
  assert.equal(JSON.parse(S.history.at(-1).trip).name, 'v69');

  dropHistory();
  assert.equal(S.history.length, 59);
  assert.equal(undo.disabled, false);

  clearHistory();
  pushHistory();
  dropHistory();
  assert.equal(S.history.length, 0);
  assert.equal(undo.disabled, true, 'sem pontos o Desfazer fica desligado');
});
