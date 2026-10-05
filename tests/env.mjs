// Ambiente mínimo de browser para os testes, sem DOM: o localStorage (lido por i18n.js, state.js e tz.js)
// e a língua do navegador (PT, para os textos virem em português). Tem de ser o primeiro import do ficheiro
// de teste, porque i18n.js e state.js leem o localStorage logo que são avaliados.
// Não é um *.test.mjs: o node --test só o corre através dos testes que o importam.
const def = (k, value) => Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });

/* localStorage: o conteúdo fica em store; com storage.fail = true todas as chamadas falham,
   como num separador privado com o armazenamento bloqueado. */
export const store = {};
export const storage = { fail: false };
const guard = f => (...a) => { if (storage.fail) throw new Error('localStorage indisponível'); return f(...a); };
def('localStorage', {
  getItem: guard(k => store[k] ?? null),
  setItem: guard((k, v) => { store[k] = String(v); }),
  removeItem: guard(k => { delete store[k]; }),
});
export const clearStore = () => { for (const k of Object.keys(store)) delete store[k]; };

def('navigator', { language: 'pt-PT' });
