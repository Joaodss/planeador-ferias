// A viagem que o MCP do servidor grava (testdata/mcp-trip.json, escrita por TestMCPGolden em mcptools_test.go)
// tem de passar pelo cleanTrip da página sem mudar nada: senão as regras de tripedit.go e as de clean.js
// afastaram-se e a página estaria a reparar o que a IA escreve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanTrip } from '../web/js/clean.js';
import { segments } from '../web/js/span.js';

const golden = () => JSON.parse(readFileSync(new URL('../testdata/mcp-trip.json', import.meta.url), 'utf8'));
const noNewIds = p => { throw new Error('cleanTrip pediu um id novo ('+p+'): a viagem tinha um id inválido ou repetido'); };

test('a viagem escrita pelo MCP passa pelo cleanTrip sem mudar', () => {
  const t = golden();
  assert.deepEqual(cleanTrip(golden(), noNewIds), t);
});

test('a viagem escrita pelo MCP tem atividades no quadro, por agendar, custos e sítios', () => {
  // se o teste do Go deixar de usar alguma ferramenta, este teste deixa de verificar essa parte
  const t = golden();
  assert.ok(t.blocks.length >= 2 && t.tray.length >= 1 && t.costs.length >= 2 && t.places.length >= 2);
  assert.ok(Object.keys(t.dayPlaces).length >= 1);
  for (const b of [...t.blocks, ...t.tray, ...t.costs]) assert.match(b.ai, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  // as atividades do quadro aparecem pelo menos num dia (o voo das 23:30 continua no dia seguinte)
  const n = Math.round((Date.parse(t.end) - Date.parse(t.start)) / 864e5) + 1;
  for (const b of t.blocks) assert.ok(segments(t, b, n).length >= 1, b.title);
});
