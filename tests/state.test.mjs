// Testes de state.js: viagem ativa e pilha do Desfazer (sem DOM).
import { store, storage } from './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

store['ferias-active-trip'] = 'b';   // a viagem aberta da última vez: state.js lê-a quando é carregado
const { S, T, ensureActive, setActive, pushHistory, pushStoreHistory, dropHistory, clearHistory, restoreLast, SLEEP_KEY } = await import('../web/js/state.js');

const trip = id => ({ id, name: 'Viagem ' + id, blocks: [] });

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

test('pushHistory guarda só a viagem ativa; pushStoreHistory guarda a store', () => {
  S.store = { version: 2, trips: [trip('a'), trip('b')] };
  setActive('a');
  clearHistory();
  assert.deepEqual(S.history, []);

  pushHistory();
  assert.deepEqual(S.history.at(-1), { id: 'a', trip: JSON.stringify(trip('a')) });

  pushStoreHistory();
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
  clearHistory();
  assert.equal(S.history.length, 0);
});

test('restoreLast repõe só a viagem do ponto e volta a abri-la; um ponto da store repõe tudo', () => {
  S.store = { version: 2, trips: [trip('a'), trip('b')] };
  clearHistory();
  assert.equal(restoreLast(), false, 'sem pontos não faz nada');

  // altera a viagem a, depois muda para b e altera-a sem guardar ponto
  setActive('a'); pushHistory(); T().name = 'A alterada';
  setActive('b'); T().name = 'B alterada';
  assert.equal(restoreLast(), true);
  assert.equal(S.store.trips[0].name, 'Viagem a', 'a viagem do ponto volta ao que era');
  assert.equal(S.store.trips[1].name, 'B alterada', 'as outras viagens ficam como estão');
  assert.equal(T().id, 'a', 'e fica aberta a viagem que foi desfeita');
  assert.equal(store['ferias-active-trip'], 'a');

  // a viagem do ponto já não existe (apagada noutro dispositivo): volta a entrar na store
  setActive('a'); pushHistory(); S.store.trips = S.store.trips.filter(t => t.id !== 'a');
  restoreLast();
  assert.deepEqual(S.store.trips.map(t => t.id), ['b', 'a']);

  // ponto da store inteira (criar, duplicar, apagar, importar)
  pushStoreHistory(); const before = JSON.stringify(S.store);
  S.store.trips.push(trip('c')); setActive('c');
  restoreLast();
  assert.equal(JSON.stringify(S.store), before);
  assert.equal(T().id, 'a', 'volta a abrir a viagem que estava aberta no ponto');

  // ponto guardado antes de haver viagens: volta a não haver nenhuma
  S.activeId = null; S.store.trips = []; pushHistory();
  S.store.trips = [trip('z')];
  restoreLast();
  assert.deepEqual(S.store.trips, []);
  assert.equal(T(), null);
});
