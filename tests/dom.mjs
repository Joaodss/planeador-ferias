// DOM mínimo para carregar em Node os módulos da página que ainda tocam no browser
// (util.js, state.js, tz.js, i18n.js). Tem de ser o primeiro import do ficheiro de teste:
// os módulos leem o localStorage e o CSS logo que são avaliados.
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

/* Um elemento falso por seletor ($('#undo'), $('#toast'), …), criado no primeiro uso. */
export const els = {};
export const el = sel => (els[sel] ||= { hidden: true, disabled: false, textContent: '', dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
export const media = { mobile: false };
export const css = { slot: '24' };
def('document', { documentElement: {}, querySelector: el, querySelectorAll: () => [] });
def('getComputedStyle', () => ({ getPropertyValue: k => (k === '--slot' ? css.slot : '') }));
def('matchMedia', q => ({ media: q, matches: media.mobile }));
