// Todos os módulos da página (menos main.js) importam-se em Node sem DOM: nenhum faz nada quando é carregado.
// Este ficheiro não importa env.mjs nem simula nada do browser. Também faz o sync.js entrar na cobertura.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const JS = fileURLToPath(new URL('../web/js/', import.meta.url));
const modules = (function walk(dir) {
  return readdirSync(dir).flatMap(f => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') && f !== 'main.js' ? [p] : [];
  });
})(JS);

test('todos os módulos de web/js/ (menos main.js) se importam em Node sem DOM', async () => {
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof window, 'undefined');
  assert.ok(modules.length > 20, `só encontrei ${modules.length} módulos`);
  const failed = [];
  for (const f of modules) {
    try { await import(pathToFileURL(f)); } catch (e) { failed.push(`${path.relative(JS, f)}: ${e.message}`); }
  }
  assert.deepEqual(failed, []);
});

test('cada módulo de ui/ (menos dom.js) liga os eventos numa função init…() que main.js chama', async () => {
  const ui = modules.filter(f => path.basename(path.dirname(f)) === 'ui' && path.basename(f) !== 'dom.js');
  for (const f of ui) {
    const inits = Object.keys(await import(pathToFileURL(f))).filter(n => /^init[A-Z]/.test(n));
    assert.equal(inits.length, 1, `${path.basename(f)}: ${inits.join(', ') || 'sem init…()'}`);
  }
});
