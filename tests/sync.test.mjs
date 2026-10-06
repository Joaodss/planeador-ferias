// Testes de sync.js: gravação, conflitos, sessão e refresh, sem browser.
// O fetch é um servidor falso em memória (com as regras do servidor Go), os temporizadores são os do
// mock.timers do node:test e a interface são espiões ligados com connectUI.
import './env.mjs';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { S, T, pushHistory } from '../web/js/state.js';
import { tr } from '../web/js/i18n.js';
import { connectUI, boot, commit, commitTyping, undo, signIn, signOut, computeDirty, onVisibilityChange, initSync, isAuthError,
  pendingOps, applyPutResponse, sameRevisions } from '../web/js/sync.js';

/* ---------- servidor falso ---------- */
let server, calls;
const trip = (id, extra) => ({ id, name: 'Viagem ' + id, start: '2027-07-01', end: '2027-07-03', ...extra });
function resetServer(trips = []) {
  server = { trips: new Map(trips.map(([t, rev]) => [t.id, { rev, trip: t }])), version: 1, authed: true, down: false, hook: null, loginStatus: 200 };
  calls = [];
}
const reply = (status, body, headers) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
async function handle(path, o) {
  const m = o.method;
  if (path === '/api/login') { if (server.loginStatus === 200) server.authed = true; return reply(server.loginStatus, {}); }
  if (!server.authed) return reply(401, { error: 'sessão em falta' });
  if (path === '/api/logout') { server.authed = false; return reply(200, { ok: true }); }
  if (path === '/api/trips') {
    const etag = `"v${server.version}"`;
    if (o.headers['If-None-Match'] === etag) return reply(304);
    return reply(200, { user: 'eu', homeTz: '', trips: [...server.trips.values()] }, { ETag: etag });
  }
  const id = decodeURIComponent(path.split('/').pop()), cur = server.trips.get(id);
  if (m === 'DELETE') { server.trips.delete(id); server.version++; return reply(200, { ok: true }); }
  const { baseRev, trip: t } = JSON.parse(o.body);
  if (cur ? cur.rev !== baseRev : baseRev !== 0) return reply(409, cur || { deleted: true });
  server.trips.set(id, { rev: baseRev + 1, trip: t }); server.version++;
  return reply(200, { rev: baseRev + 1 });
}
mock.method(globalThis, 'fetch', async (path, o) => {
  calls.push({ method: o.method, path, body: o.body, headers: o.headers });
  if (server.down) throw new TypeError('fetch failed');
  return server.hook ? server.hook(path, o, () => handle(path, o)) : handle(path, o);
});
const sent = method => calls.filter(c => c.method === method && c.path.startsWith('/api/trips/'));

/* ---------- interface falsa ---------- */
const ui = {};
for (const k of ['render', 'closeSheets', 'toast', 'announce', 'saveState', 'showLogin', 'showApp', 'showOffline']) ui[k] = mock.fn();
connectUI(ui);
const toasts = () => ui.toast.mock.calls.map(c => c.arguments[0]);
const lastSave = () => ui.saveState.mock.calls.at(-1)?.arguments[0];

/* As promessas dos pedidos resolvem-se sozinhas; setImmediate não está no mock.timers. */
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
const tick = async ms => { mock.timers.tick(ms); await settle(); };
/* Arranque com estas viagens no servidor: [[viagem, rev], …]. */
/* Antes, corre os temporizadores que outros testes deixaram (sem sessão, as gravações pendentes não fazem nada). */
async function drain() { S.authed = false; mock.timers.runAll(); await settle(); }
async function start(trips) { await drain(); resetServer(trips); await boot(); calls = []; for (const f of Object.values(ui)) f.mock.resetCalls(); }

/* Ligados uma vez para o ficheiro todo: ao reiniciar, o mock.timers volta aos mesmos ids, e um clearTimeout de um
   temporizador antigo (de outro teste) cancelava um novo com o mesmo id, o que num browser não acontece. */
mock.timers.enable({ apis: ['setTimeout'] });

/* ---------- funções puras ---------- */
test('pendingOps: DELETE das viagens que já não estão na página, PUT das que mudaram ou são novas', () => {
  const synced = new Map([['a', '{"a":1}'], ['b', '{"b":1}'], ['c', '{"c":1}']]);
  const snapshot = new Map([['a', '{"a":1}'], ['b', '{"b":2}'], ['d', '{"d":1}']]);
  assert.deepEqual(pendingOps(snapshot, synced), { deletes: ['c'], puts: ['b', 'd'] });
  assert.deepEqual(pendingOps(new Map(synced), synced), { deletes: [], puts: [] });
});

test('applyPutResponse: 200, 409 com a versão do servidor, 409 {deleted}, 413 e erros', () => {
  const t = trip('a'), js = JSON.stringify(t);
  const st = () => ({ trips: [t, trip('b')], revs: new Map([['a', 1]]), synced: new Map(), snapshot: new Map([['a', js]]) });

  let s = st();
  assert.equal(applyPutResponse(s, t, js, 200, { rev: 2 }), 'ok');
  assert.deepEqual([s.revs.get('a'), s.synced.get('a')], [2, js]);

  s = st();
  assert.equal(applyPutResponse(s, t, js, 409, { rev: 5, trip: { id: 'a', name: 'Do servidor', start: '2027-07-01', end: '2027-07-02' } }), 'conflict');
  assert.equal(s.trips[0].name, 'Do servidor', 'fica a versão do servidor, já limpa por normTrip');
  assert.deepEqual(s.trips[0].blocks, []);
  assert.equal(s.revs.get('a'), 5);
  assert.equal(s.synced.get('a'), JSON.stringify(s.trips[0]));
  assert.equal(s.snapshot.get('a'), s.synced.get('a'), 'snapshot acompanha, para o estado final não a dar como por gravar');

  s = st();
  assert.equal(applyPutResponse(s, t, js, 409, { deleted: true }), 'conflict');
  assert.deepEqual(s.trips.map(x => x.id), ['b']);
  assert.deepEqual([s.revs.has('a'), s.synced.has('a'), s.snapshot.has('a')], [false, false, false]);

  s = st();
  assert.equal(applyPutResponse(s, t, js, 413, null), 'tooBig');
  assert.equal(s.synced.get('a'), js, 'fica como gravada, para não tentar para sempre');
  assert.equal(s.revs.get('a'), 1);

  s = st();
  assert.equal(applyPutResponse(s, t, js, 500, null), 'error');
  assert.equal(s.synced.size, 0);
});

test('sameRevisions compara as viagens e revisões, sem olhar à ordem', () => {
  const trips = [trip('a'), trip('b')], revs = new Map([['a', 1], ['b', 2]]);
  assert.equal(sameRevisions(trips, revs, [{ rev: 2, trip: { id: 'b' } }, { rev: 1, trip: { id: 'a' } }]), true);
  assert.equal(sameRevisions(trips, revs, [{ rev: 2, trip: { id: 'b' } }, { rev: 2, trip: { id: 'a' } }]), false);
  assert.equal(sameRevisions(trips, revs, [{ rev: 1, trip: { id: 'a' } }]), false);
});

/* ---------- arranque ---------- */
test('boot: carrega e ordena as viagens; sem ligação mostra o aviso e tenta de novo 5 s depois; 401 mostra o login', async () => {
  await drain();
  resetServer([[trip('b', { start: '2027-08-01', end: '2027-08-02' }), 1], [trip('a'), 3]]);
  server.down = true;
  await boot();
  assert.equal(ui.showOffline.mock.callCount(), 1);
  server.down = false;
  await tick(5000);
  assert.deepEqual(S.store.trips.map(t => t.id), ['a', 'b'], 'por data de início');
  assert.equal(S.authed, true);
  assert.equal(ui.showApp.mock.callCount(), 1);
  assert.equal(T().id, 'a');
  assert.equal(lastSave(), 'saved');

  resetServer(); server.authed = false;
  const before = ui.showOffline.mock.callCount();
  await boot();
  assert.equal(S.authed, false);
  assert.ok(ui.showLogin.mock.callCount() >= 1);
  assert.equal(ui.showOffline.mock.callCount(), before, 'sessão acabada não é falta de ligação');
});

/* ---------- gravar ---------- */
test('grava só as viagens que mudaram, com baseRev, 1,2 s depois da última alteração', async () => {
  await start([[trip('a'), 3], [trip('b'), 1]]);
  T().name = 'Primeira';
  commit();
  assert.equal(S.dirty, true);
  assert.equal(lastSave(), 'dirty');
  assert.equal(ui.render.mock.callCount(), 1, 'commit redesenha logo');
  await tick(1000);
  T().name = 'Segunda'; commit();          // a contagem recomeça
  await tick(1199);
  assert.equal(sent('PUT').length, 0);
  await tick(1);
  assert.equal(sent('PUT').length, 1);
  const put = sent('PUT')[0];
  assert.equal(put.path, '/api/trips/a');
  assert.equal(put.headers['X-Requested-With'], 'planner');
  assert.equal(JSON.parse(put.body).baseRev, 3);
  assert.equal(JSON.parse(put.body).trip.name, 'Segunda');
  assert.equal(put.body, `{"baseRev":3,"trip":${JSON.stringify(T())}}`, 'leva o JSON da viagem tal e qual');
  assert.deepEqual([S.dirty, S.saving, lastSave()], [false, false, 'saved']);
  assert.equal(server.trips.get('a').rev, 4);

  T().name = 'Terceira'; commit();
  await tick(1200);
  assert.equal(JSON.parse(sent('PUT')[1].body).baseRev, 4, 'parte da revisão que o servidor devolveu');
});

test('commitTyping só redesenha numa pausa de 150 ms; sem alterações a gravação não faz pedidos', async () => {
  await start([[trip('a'), 1]]);
  commitTyping(); commitTyping();
  await tick(149);
  assert.equal(ui.render.mock.callCount(), 0);
  await tick(1);
  assert.equal(ui.render.mock.callCount(), 1);
  // um commit() a seguir redesenha logo e a pausa pendente já não redesenha outra vez
  commitTyping(); commit();
  assert.equal(ui.render.mock.callCount(), 2);
  await tick(150);
  assert.equal(ui.render.mock.callCount(), 2);
  await tick(1200);
  assert.equal(calls.length, 0, 'commit sem mudar nada não grava');
  assert.equal(S.dirty, false);
});

test('apaga no servidor as viagens que já não existem na página', async () => {
  await start([[trip('a'), 1], [trip('b'), 1]]);
  S.store.trips = S.store.trips.filter(t => t.id !== 'b');
  commit();
  await tick(1200);
  assert.deepEqual(calls.map(c => c.method + ' ' + c.path), ['DELETE /api/trips/b']);
  assert.equal(server.trips.has('b'), false);
  assert.equal(computeDirty(), false);
});

test('409: fica a versão do servidor, o Desfazer é limpo e aparece o aviso; 409 {deleted}: a viagem sai', async () => {
  await start([[trip('a'), 1], [trip('b'), 1]]);
  server.trips.get('a').rev = 2; server.trips.get('a').trip = trip('a', { name: 'Do outro dispositivo' });
  server.trips.delete('b');
  pushHistory();
  S.store.trips.forEach(t => { t.name += ' (aqui)'; });
  commit();
  await tick(1200);
  assert.deepEqual(S.store.trips.map(t => t.name), ['Do outro dispositivo']);
  assert.deepEqual(S.history, []);
  assert.equal(ui.closeSheets.mock.callCount(), 1);
  assert.deepEqual(toasts(), [tr('tConflict')]);
  assert.equal(S.dirty, false);
  // a próxima gravação parte da revisão do servidor
  T().name = 'Depois'; commit();
  await tick(1200);
  assert.equal(JSON.parse(sent('PUT').at(-1).body).baseRev, 2);
  assert.equal(server.trips.get('a').trip.name, 'Depois');
});

test('413: fica marcada como gravada e o aviso aparece uma vez', async () => {
  await start([[trip('a'), 1]]);
  server.hook = (path, o, next) => o.method === 'PUT' ? reply(413, { error: 'viagem demasiado grande' }) : next();
  T().name = 'Enorme'; commit();
  await tick(1200);
  assert.deepEqual(toasts(), [tr('tTooBig')]);
  assert.equal(S.dirty, false);
  await tick(10000);
  assert.equal(sent('PUT').length, 1, 'não volta a tentar');
});

test('sem rede: online=false e nova tentativa 8 s depois; um erro do servidor também', async () => {
  await start([[trip('a'), 1]]);
  server.down = true;
  T().name = 'Sem rede'; commit();
  await tick(1200);
  assert.deepEqual([S.online, S.dirty, lastSave()], [false, true, 'error']);
  await tick(7999);
  assert.equal(sent('PUT').length, 1);
  server.down = false;
  server.hook = (path, o, next) => o.method === 'PUT' ? reply(500, {}) : next();
  await tick(1);
  assert.equal(sent('PUT').length, 2);
  assert.equal(S.online, false, 'um 500 conta como sem ligação');
  server.hook = null;
  await tick(8000);
  assert.deepEqual([S.online, S.dirty, lastSave()], [true, false, 'saved']);
});

test('401 ao gravar: a sessão termina, aparece o login e não volta a tentar', async () => {
  await start([[trip('a'), 1]]);
  server.authed = false;
  T().name = 'Sessão acabada'; commit();
  await tick(1200);
  assert.equal(S.authed, false);
  assert.equal(ui.showLogin.mock.callCount(), 1);
  assert.equal(S.online, true, 'não é falta de ligação');
  assert.equal(S.dirty, true, 'a alteração fica na página');
  await tick(20000);
  assert.equal(sent('PUT').length, 1);
});

test('uma alteração durante a gravação fica por gravar e agenda outra', async () => {
  await start([[trip('a'), 1]]);
  let open; const gate = new Promise(r => { open = r; });
  server.hook = async (path, o, next) => { if (o.method === 'PUT') await gate; return next(); };
  T().name = 'Durante 1'; commit();
  await tick(1200);
  assert.equal(S.saving, true);
  assert.equal(lastSave(), 'saving');
  T().name = 'Durante 2'; commit();
  await tick(1200);                       // o temporizador desta alteração encontra a gravação a meio
  assert.equal(sent('PUT').length, 1);
  server.hook = null; open();
  await settle();
  assert.deepEqual([S.saving, S.dirty], [false, true]);
  assert.equal(server.trips.get('a').trip.name, 'Durante 1', 'gravou o que era quando começou');
  await tick(1200);
  assert.equal(sent('PUT').length, 2);
  assert.equal(server.trips.get('a').trip.name, 'Durante 2');
  assert.equal(S.dirty, false);
});

test('undo repõe a viagem, fecha os painéis, anuncia e grava', async () => {
  await start([[trip('a'), 1]]);
  undo();
  assert.equal(ui.announce.mock.callCount(), 0, 'sem pontos não faz nada');
  pushHistory(); T().name = 'Alterada'; commit();
  undo();
  assert.equal(T().name, 'Viagem a');
  assert.equal(ui.closeSheets.mock.callCount(), 1);
  assert.deepEqual(ui.announce.mock.calls.map(c => c.arguments[0]), [tr('undone')]);
  await tick(1200);
  assert.equal(sent('PUT').length, 0, 'voltou ao que o servidor tem: não há nada a gravar');
});

/* ---------- refresh ---------- */
test('refresh: 304 não faz nada; mesmas revisões só guardam o ETag; outras revisões aplicam a lista e avisam; com alterações por gravar, ignora e não guarda o ETag', async () => {
  await start([[trip('a'), 1]]);
  const tag = () => calls.at(-1).headers['If-None-Match'];

  await onVisibilityChange(false);
  assert.equal(tag(), '"v1"', 'pergunta com o ETag da lista aplicada');
  assert.equal(ui.render.mock.callCount(), 0, '304: nada a fazer');

  server.version++;                       // ETag novo, mas as mesmas viagens e revisões
  await onVisibilityChange(false);
  assert.equal(ui.render.mock.callCount(), 0);
  await onVisibilityChange(false);
  assert.equal(tag(), '"v2"', 'guardou o ETag novo');

  // com alterações por gravar: a lista fica por aplicar e o ETag por guardar
  server.trips.set('b', { rev: 1, trip: trip('b') }); server.version++;
  T().name = 'Local'; S.dirty = true;
  await onVisibilityChange(false);
  assert.equal(calls.length, 3, 'nem pergunta ao servidor');
  T().name = 'Viagem a';                  // volta ao que o servidor tem
  await onVisibilityChange(false);
  assert.deepEqual(S.store.trips.map(t => t.id), ['a', 'b']);
  assert.deepEqual(toasts(), [tr('tRefreshed')]);
  assert.equal(ui.closeSheets.mock.callCount(), 1);
  await onVisibilityChange(false);
  assert.equal(tag(), '"v3"');

  // a meio de um arrasto ou de uma gravação não vai buscar nada
  S.drag = { active: true };
  const n = calls.length;
  await onVisibilityChange(false);
  S.drag = null;
  assert.equal(calls.length, n);
});

test('separador escondido: grava logo o que falta, sem esperar 1,2 s', async () => {
  await start([[trip('a'), 1]]);
  onVisibilityChange(true);
  await settle();
  assert.equal(calls.length, 0, 'sem alterações não faz nada');
  T().name = 'Escondida'; commit();
  onVisibilityChange(true);
  await settle();
  assert.equal(sent('PUT').length, 1);
  await tick(1200);
  assert.equal(sent('PUT').length, 1, 'a gravação agendada já não tem nada a fazer');
  S.authed = false;
  T().name = 'Sem sessão'; commit();
  onVisibilityChange(true);
  await settle();
  assert.equal(sent('PUT').length, 1, 'sem sessão não grava');
  S.authed = true;
});

/* ---------- entrar e sair ---------- */
test('signIn: 200 com alterações por gravar grava em vez de recarregar; devolve 401 e 429', async () => {
  await start([[trip('a'), 1]]);
  server.loginStatus = 401;
  assert.equal(await signIn('eu', 'errada'), 401);
  server.loginStatus = 429;
  assert.equal(await signIn('eu', 'errada'), 429);
  assert.equal(JSON.parse(calls[0].body).user, 'eu');

  // a sessão acabou com uma alteração por gravar
  server.authed = false;
  T().name = 'Por gravar'; commit();
  await tick(1200);
  assert.equal(S.authed, false);
  server.loginStatus = 200; calls = [];
  assert.equal(await signIn('eu', 'certa-certa'), 200);
  await settle();
  assert.deepEqual(calls.map(c => c.method + ' ' + c.path), ['POST /api/login', 'PUT /api/trips/a'], 'grava sem ir buscar a lista');
  assert.equal(T().name, 'Por gravar');
  assert.equal(server.trips.get('a').trip.name, 'Por gravar');

  // sem nada por gravar: vai buscar a lista
  server.authed = false; S.authed = false; calls = [];
  assert.equal(await signIn('eu', 'certa-certa'), 200);
  assert.deepEqual(calls.map(c => c.method + ' ' + c.path), ['POST /api/login', 'GET /api/trips']);
  assert.equal(S.authed, true);
});

test('signOut: grava primeiro; se não conseguir, devolve false e a sessão continua', async () => {
  await start([[trip('a'), 1]]);
  T().name = 'Antes de sair'; commit();
  server.down = true;
  assert.equal(await signOut(), false);
  assert.equal(S.authed, true);
  assert.equal(T().name, 'Antes de sair');

  server.down = false; calls = [];
  assert.equal(await signOut(), true);
  assert.deepEqual(calls.map(c => c.method + ' ' + c.path), ['PUT /api/trips/a', 'POST /api/logout']);
  assert.deepEqual([S.authed, S.store.trips.length, S.history.length], [false, 0, 0]);
  assert.equal(ui.showLogin.mock.callCount(), 1);

  // sem ligação no logout: sai na mesma (o cookie fica, mas a página volta ao login)
  await start([[trip('a'), 1]]);
  server.down = true;
  assert.equal(await signOut(), true);
  assert.equal(S.authed, false);
});

test('initSync liga o separador escondido e o aviso ao fechar com alterações por gravar', async () => {
  const on = {};
  const target = () => ({ addEventListener: (type, fn) => { on[type] = fn; } });
  globalThis.document = { ...target(), hidden: true };
  globalThis.window = target();
  try {
    initSync();
    await start([[trip('a'), 1]]);
    const ev = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
    let e = ev(); on.beforeunload(e);
    assert.equal(e.prevented, false, 'sem alterações fecha sem perguntar');
    T().name = 'Por gravar'; commit();
    e = ev(); on.beforeunload(e);
    assert.deepEqual([e.prevented, e.returnValue], [true, '']);
    on.visibilitychange();
    await settle();
    assert.equal(sent('PUT').length, 1, 'separador escondido: grava');
  } finally { delete globalThis.document; delete globalThis.window; }
});

test('isAuthError só reconhece o fim da sessão', async () => {
  assert.equal(isAuthError(new Error('x')), false);
  await start([[trip('a'), 1]]);
  server.authed = false;
  // signIn com 401 é credenciais erradas, não fim de sessão: não lança
  server.loginStatus = 401;
  assert.equal(await signIn('eu', 'x'), 401);
  assert.equal(ui.showLogin.mock.callCount(), 0);
});
