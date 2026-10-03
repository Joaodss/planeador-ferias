// Testes da página: correm com "node --test tests/", sem dependências.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = p => readFileSync(new URL('../web/' + p, import.meta.url), 'utf8');

// Carrega i18n.js num ambiente mínimo de browser.
function loadI18n({ stored = null, language = 'pt-PT' } = {}) {
  const store = stored ? { 'ferias-lang': stored } : {};
  const ctx = {
    window: {},
    navigator: { language },
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    document: { querySelectorAll: () => [], documentElement: {} },
  };
  vm.runInNewContext(read('i18n.js'), ctx);
  return { I18N: ctx.window.I18N, store, doc: ctx.document };
}

const { I18N } = loadI18n();
const { pt, en } = I18N.dicts;
const kind = v => Array.isArray(v) ? 'array' : typeof v;
const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('app.js e i18n.js são JavaScript válido', () => {
  for (const f of ['app.js', 'i18n.js']) assert.doesNotThrow(() => new vm.Script(read(f), { filename: f }), f);
});

test('PT e EN têm exatamente as mesmas chaves', () => {
  const a = Object.keys(pt).sort(), b = Object.keys(en).sort();
  assert.deepEqual(a.filter(k => !(k in en)), [], 'chaves só em PT');
  assert.deepEqual(b.filter(k => !(k in pt)), [], 'chaves só em EN');
});

test('cada tradução tem o mesmo formato nas duas línguas', () => {
  for (const k of Object.keys(pt)) {
    const a = pt[k], b = en[k];
    assert.equal(kind(a), kind(b), `${k}: tipos diferentes`);
    if (Array.isArray(a)) assert.equal(a.length, b.length, `${k}: listas com tamanhos diferentes`);
    if (kind(a) === 'object') assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${k}: chaves internas diferentes`);
    if (typeof a === 'string') assert.deepEqual(placeholders(a), placeholders(b), `${k}: marcadores {…} diferentes`);
    if (typeof a === 'string') assert.ok(a.trim() && b.trim(), `${k}: texto vazio`);
  }
});

test('traduções com plural devolvem texto para 1 e para vários', () => {
  for (const dict of [pt, en]) for (const [k, fn] of Object.entries(dict)) {
    if (typeof fn !== 'function') continue;
    for (const n of [0, 1, 2]) {
      const out = fn({ n, w: n, added: n, replaced: n, x: '10 €', over: n === 1, d: 1, m: 'JAN', pct: 5 });
      assert.equal(typeof out, 'string', k);
      assert.doesNotMatch(out, /undefined|NaN/, `${k}(${n}) → ${out}`);
    }
  }
  assert.equal(pt.nToReview({ n: 1 }), '1 ponto a rever');
  assert.equal(pt.nToReview({ n: 3 }), '3 pontos a rever');
  assert.equal(en.nToReview({ n: 1 }), '1 thing to review');
  assert.equal(en.onDay({ w: 0 }), 'on Sunday');
  assert.equal(pt.onDay({ w: 0 }), 'ao domingo');
  assert.equal(pt.onDay({ w: 1 }), 'à segunda');
});

test('todas as chaves usadas em app.js existem', () => {
  const src = read('app.js');
  const used = new Set();
  for (const m of src.matchAll(/\btr\(([^()]*)/g)) for (const k of m[1].matchAll(/'(\w+)'/g)) used.add(k[1]);
  assert.ok(used.size > 100, `só encontrei ${used.size} chaves — a expressão regular deixou de funcionar?`);
  assert.deepEqual([...used].filter(k => !(k in pt)), [], 'chaves em falta no dicionário');
});

test('todas as chaves usadas em index.html existem', () => {
  const html = read('index.html');
  const used = [...html.matchAll(/data-i18n(?:-ph|-title|-aria)?="(\w+)"/g)].map(m => m[1]);
  assert.ok(used.length > 50);
  assert.deepEqual(used.filter(k => !(k in pt)), [], 'chaves em falta no dicionário');
});

test('index.html carrega i18n.js antes de app.js', () => {
  const html = read('index.html');
  const a = html.indexOf('src="i18n.js"'), b = html.indexOf('src="app.js"');
  assert.ok(a > 0 && b > a);
});

test('tr substitui marcadores e recorre ao PT ou à própria chave', () => {
  const { I18N } = loadI18n({ stored: 'en' });
  assert.equal(I18N.tr('totalFor', { n: 4 }), 'For 4');
  assert.equal(I18N.tr('wOverlap', { a: 'Jantar', b: '{b}' }), 'Jantar and {b} at the same time', 'valores não são reinterpretados');
  assert.equal(I18N.tr('totalFor'), 'For {n}');
  assert.equal(I18N.tr('chave-que-nao-existe'), 'chave-que-nao-existe');
});

test('língua por omissão segue o browser e a escolha fica guardada', () => {
  assert.equal(loadI18n({ language: 'pt-BR' }).I18N.lang, 'pt');
  assert.equal(loadI18n({ language: 'en-US' }).I18N.lang, 'en');
  assert.equal(loadI18n({ language: 'fr-FR' }).I18N.lang, 'en');
  assert.equal(loadI18n({ language: 'en-US', stored: 'pt' }).I18N.lang, 'pt');
  assert.equal(loadI18n({ language: 'pt-PT', stored: 'xx' }).I18N.lang, 'pt', 'valor guardado inválido é ignorado');

  const { I18N, store, doc } = loadI18n({ language: 'pt-PT' });
  I18N.set(I18N.other());
  assert.equal(I18N.lang, 'en');
  assert.equal(store['ferias-lang'], 'en');
  assert.equal(doc.documentElement.lang, 'en');
  assert.equal(I18N.locale, 'en-GB');
  I18N.set('xx');
  assert.equal(I18N.lang, 'en', 'língua desconhecida é ignorada');
});
