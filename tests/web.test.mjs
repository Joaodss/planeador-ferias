// Testes da página: correm com "node --test tests/", sem dependências.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const read = p => readFileSync(path.join(WEB, p), 'utf8');

// Todos os módulos da página (caminhos relativos a web/, com "/").
const modules = (function walk(dir) {
  return readdirSync(path.join(WEB, dir)).flatMap(f => {
    const p = dir + '/' + f;
    return statSync(path.join(WEB, p)).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
})('js');

// Carrega js/i18n.js num ambiente mínimo de browser. Cada chamada importa uma cópia nova
// do módulo (o ?n= no URL), porque a língua é escolhida quando o módulo é avaliado.
let loads = 0;
async function loadI18n({ stored = null, language = 'pt-PT' } = {}) {
  const store = stored ? { 'ferias-lang': stored } : {};
  const doc = { querySelectorAll: () => [], documentElement: {} };
  const set = (k, value) => Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
  set('navigator', { language });
  set('localStorage', { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } });
  set('document', doc);
  const { I18N } = await import(new URL('../web/js/i18n.js?n=' + (++loads), import.meta.url));
  return { I18N, store, doc };
}

const { I18N } = await loadI18n();
const { pt, en } = I18N.dicts;
const kind = v => Array.isArray(v) ? 'array' : typeof v;
const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('todos os módulos em js/ são JavaScript válido', () => {
  assert.ok(modules.length > 10, `só encontrei ${modules.length} módulos`);
  for (const f of modules) {
    const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: read(f), encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('cada import aponta para um ficheiro e um nome exportado', () => {
  const exportsOf = {};
  for (const f of modules) {
    const ex = new Set();
    for (const line of read(f).split('\n')) {
      let m;
      if ((m = line.match(/^export\s+(?:async\s+)?function\s+([\w$]+)/))) ex.add(m[1]);
      else if ((m = line.match(/^export\s+(?:const|let)\s+(.*)$/))) {
        // export const A = …, B = …  (só os nomes ao nível de topo)
        ex.add(m[1].match(/^([\w$]+)/)[1]);
        let depth = 0, cur = '';
        for (const ch of m[1]) {
          if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--;
          else if (ch === ',' && depth === 0) { cur = ''; continue; }
          cur += ch; const n = depth === 0 && cur.match(/^\s*([\w$]+)\s*=$/); if (n) ex.add(n[1]);
        }
      }
      else if ((m = line.match(/^export\s*\{([^}]*)\}/))) m[1].split(',').map(x => x.trim()).filter(Boolean).forEach(n => ex.add(n));
    }
    exportsOf[f] = ex;
  }
  const problems = [];
  for (const f of modules) for (const m of read(f).matchAll(/^import\s*(?:\{([^}]*)\}\s*from\s*)?'([^']+)'/gm)) {
    const target = path.posix.join(path.posix.dirname(f), m[2]);
    if (!exportsOf[target]) { problems.push(`${f}: ${m[2]} não existe`); continue; }
    for (const n of (m[1] || '').split(',').map(x => x.trim()).filter(Boolean))
      if (!exportsOf[target].has(n)) problems.push(`${f}: ${m[2]} não exporta ${n}`);
  }
  assert.deepEqual(problems, []);
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

test('todas as chaves usadas nos módulos existem', () => {
  const used = new Set();
  for (const f of modules.filter(f => f !== 'js/i18n.js'))
    for (const m of read(f).matchAll(/\btr\(([^()]*)/g)) for (const k of m[1].matchAll(/'(\w+)'/g)) used.add(k[1]);
  assert.ok(used.size > 100, `só encontrei ${used.size} chaves — a expressão regular deixou de funcionar?`);
  assert.deepEqual([...used].filter(k => !(k in pt)), [], 'chaves em falta no dicionário');
});

test('todas as chaves usadas em index.html existem', () => {
  const html = read('index.html');
  const used = [...html.matchAll(/data-i18n(?:-ph|-title|-aria)?="(\w+)"/g)].map(m => m[1]);
  assert.ok(used.length > 50);
  assert.deepEqual(used.filter(k => !(k in pt)), [], 'chaves em falta no dicionário');
});

test('index.html carrega js/main.js como módulo e o CSS de css/', () => {
  const html = read('index.html');
  assert.match(html, /<script type="module" src="js\/main\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="css\/app\.css">/);
  assert.doesNotMatch(html, /<script(?![^>]*type="module")[^>]*src="(?!https:)/, 'scripts locais devem ser módulos');
});

test('tr substitui marcadores e recorre ao PT ou à própria chave', async () => {
  const { I18N } = await loadI18n({ stored: 'en' });
  assert.equal(I18N.tr('totalFor', { n: 4 }), 'For 4');
  assert.equal(I18N.tr('wOverlap', { a: 'Jantar', b: '{b}' }), 'Jantar and {b} at the same time', 'valores não são reinterpretados');
  assert.equal(I18N.tr('totalFor'), 'For {n}');
  assert.equal(I18N.tr('chave-que-nao-existe'), 'chave-que-nao-existe');
});

test('língua por omissão segue o browser e a escolha fica guardada', async () => {
  assert.equal((await loadI18n({ language: 'pt-BR' })).I18N.lang, 'pt');
  assert.equal((await loadI18n({ language: 'en-US' })).I18N.lang, 'en');
  assert.equal((await loadI18n({ language: 'fr-FR' })).I18N.lang, 'en');
  assert.equal((await loadI18n({ language: 'en-US', stored: 'pt' })).I18N.lang, 'pt');
  assert.equal((await loadI18n({ language: 'pt-PT', stored: 'xx' })).I18N.lang, 'pt', 'valor guardado inválido é ignorado');

  const { I18N, store, doc } = await loadI18n({ language: 'pt-PT' });
  I18N.set(I18N.other());
  assert.equal(I18N.lang, 'en');
  assert.equal(store['ferias-lang'], 'en');
  assert.equal(doc.documentElement.lang, 'en');
  assert.equal(I18N.locale, 'en-GB');
  I18N.set('xx');
  assert.equal(I18N.lang, 'en', 'língua desconhecida é ignorada');
});

test('mudar o quadro de fuso desloca as atividades e volta ao mesmo sítio', async () => {
  const { shiftTime } = await import(new URL('../web/js/tz.js', import.meta.url));
  const v = { T0: 8 * 60, T1: 25 * 60 };   // quadro das 8h à 1h do dia seguinte
  const off = -8 * 60;                      // Lisboa está 8h atrás de Tóquio
  assert.deepEqual(shiftTime('2026-10-10', 20 * 60, off, v), { date: '2026-10-10', start: 12 * 60 }, '20h em Tóquio = 12h em Lisboa');
  assert.deepEqual(shiftTime('2026-10-10', 8 * 60, off, v), { date: '2026-10-09', start: 24 * 60 }, 'meia-noite fica no fim do dia anterior');
  assert.deepEqual(shiftTime('2026-10-10', 10 * 60, off, v), { date: '2026-10-10', start: 2 * 60 }, 'fora do quadro fica como hora normal');
  assert.deepEqual(shiftTime('2026-11-01', 8 * 60, off, v), { date: '2026-10-31', start: 24 * 60 }, 'muda de mês');
  assert.deepEqual(shiftTime('2026-10-10', 1470, 0, v), { date: '2026-10-10', start: 1470 }, 'sem diferença não mexe');
  for (const start of [8 * 60, 12 * 60 + 15, 23 * 60 + 45, 24 * 60 + 30]) {
    const there = shiftTime('2026-10-10', start, -off, v);
    assert.deepEqual(shiftTime(there.date, there.start, off, v), { date: '2026-10-10', start }, `ida e volta às ${start} min`);
  }
});
