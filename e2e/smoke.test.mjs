/* Teste de fumo da página num Chromium a sério (#33): o servidor verdadeiro, compilado do código do repositório,
   e a página tal como o browser a corre, com a CSP. Cobre o que os testes de tests/ não alcançam: os módulos de ui/.
   Corre com "npm test" nesta pasta (precisa de "npm ci" e "npx playwright install chromium" antes).
   No fim escreve a cobertura de funções de cada módulo de ui/, sem mínimo. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'planner-e2e-'));
const dataDir = join(tmp, 'data');
const USER = 'e2e';
const PASS = randomBytes(16).toString('hex');   // descartável, gerada em cada execução
const MCP_TOKEN = randomBytes(24).toString('hex');   // idem, para o /mcp (PLANNER_MCP_TOKEN)
// Datas fixas, longe de hoje: o teste não depende do dia em que corre.
const D1 = '2027-06-01', D2 = '2027-06-02', D3 = '2027-06-03';

let server, browser, context, page, base;
const problems = [];   // erros da consola e exceções da página (uma violação da CSP aparece aqui)

/* Uma porta livre: o servidor só aceita a porta pelo ambiente. */
function freePort(){
  return new Promise((res, rej)=>{
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', ()=>{ const { port } = s.address(); s.close(()=>res(port)); });
  });
}
async function waitHealthy(url){
  for(let i = 0; i < 100; i++){
    try{ if((await fetch(url + '/healthz')).ok) return; }catch{}
    await new Promise(r=>setTimeout(r, 100));
  }
  throw new Error('o servidor não arrancou');
}

before(async ()=>{
  const bin = join(tmp, process.platform === 'win32' ? 'planner.exe' : 'planner');
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: root, stdio: 'inherit' });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(bin, [], {
    env: { ...process.env, PLANNER_USER: USER, PLANNER_PASSWORD: PASS, PLANNER_MCP_TOKEN: MCP_TOKEN, PLANNER_PUBLIC_URL: base, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitHealthy(base);

  browser = await chromium.launch();
  // pt-PT e Lisboa fixos: a língua vem do navigator.language e as datas do fuso local
  context = await browser.newContext({ locale: 'pt-PT', timezoneId: 'Europe/Lisbon', viewport: { width: 1280, height: 800 } });
  // As fontes do Google ficam de fora: o teste não depende da rede (e um pedido falhado sujaria a consola).
  await context.route(/fonts\.(googleapis|gstatic)\.com/, r=>r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  page = await context.newPage();
  page.on('console', m=>{ if(m.type() === 'error' && !/401 \(Unauthorized\)/.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', e=>problems.push(String(e)));
  await page.coverage.startJSCoverage();
});

/* Os scripts de uma página desaparecem da cobertura do V8 quando ela é recarregada:
   antes de cada page.reload() guarda-se o que já correu, e no fim juntam-se as cópias de cada módulo. */
const coverage = [];
async function keepCoverage(){
  coverage.push(...await page.coverage.stopJSCoverage());
  await page.coverage.startJSCoverage();
}

after(async ()=>{
  if(page){
    try{ await keepCoverage(); report(coverage); }catch(e){ console.error(e); }
  }
  await browser?.close();
  server?.kill();
  if(server && server.exitCode === null) await new Promise(r=>server.once('exit', r));
  rmSync(tmp, { recursive: true, force: true });
});

/* Cobertura de funções por módulo, como a do Node nos testes de tests/ (sem o corpo de topo de cada módulo).
   Só informativa: vai para a consola e, no CI, para o resumo do job. */
function report(entries){
  // módulo → (posição de cada função no código → correu em alguma das cargas?)
  const mods = new Map();
  for(const e of entries){
    const m = /\/js\/(.+\.js)$/.exec(new URL(e.url).pathname); if(!m) continue;
    if(!mods.has(m[1])) mods.set(m[1], new Map());
    const fns = mods.get(m[1]);
    for(const f of e.functions){
      const r = f.ranges[0];
      if(r.startOffset === 0 && !f.functionName) continue;   // o corpo de topo do módulo
      fns.set(r.startOffset, fns.get(r.startOffset) || r.count > 0);
    }
  }
  // só ui/: os outros módulos já são medidos, com mínimo, pelos testes de tests/
  const rows = [...mods].filter(([f])=>f.startsWith('ui/')).map(([f, fns])=>[f, [...fns.values()].filter(Boolean).length, fns.size]);
  rows.sort((a, b)=>a[0].localeCompare(b[0]));
  const pct = (h, n)=>n ? (100 * h / n).toFixed(1) : '100.0';
  const sum = k=>rows.reduce((s, r)=>s + r[k], 0);
  // O V8 só lista as funções que chegou a compilar: uma função dentro de outra que nunca correu não conta,
  // por isso estes valores são um máximo, não a cobertura exata.
  const lines = ['| módulo | funções | % |', '|---|---:|---:|', ...rows.map(([f, h, n])=>`| ${f} | ${h}/${n} | ${pct(h, n)} |`),
    `| **ui/** | ${sum(1)}/${sum(2)} | **${pct(sum(1), sum(2))}** |`];
  const note = 'Sem mínimo. Só conta as funções que o V8 compilou, por isso é um valor por excesso.';
  console.log('\nCobertura de funções de ui/ no browser\n' + note + '\n' + lines.join('\n'));
  if(process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### E2E: cobertura de funções de ui/\n\n${note}\n\n${lines.join('\n')}\n`);
}

const col = d=>page.locator(`.day-col[data-date="${d}"]`);
const block = d=>col(d).locator('.blk');
/* Espera que a gravação acabe (commit() põe logo o indicador em "dirty"). */
const saved = ()=>page.waitForSelector('#save[data-s="saved"]');
const tripsOnDisk = ()=>readdirSync(join(dataDir, 'trips')).filter(f=>f.endsWith('.json'));

test('login: palavra-passe errada mostra o erro; a certa abre o quadro vazio', async ()=>{
  await page.goto(base);
  await page.waitForSelector('#login:not([hidden])');
  assert.equal(await page.getAttribute('html', 'lang'), 'pt-PT');
  await page.fill('#l-user', USER);
  await page.fill('#l-pass', 'errada-' + PASS);
  await page.click('#l-submit');
  await page.waitForSelector('#l-err:not([hidden])');
  assert.match(await page.textContent('#l-err'), /errados/);
  await page.fill('#l-pass', PASS);
  await page.click('#l-submit');
  await page.waitForSelector('.app:not([hidden])');
  assert.equal(await page.isHidden('#login'), true);
  await page.waitForSelector('#empty-new');
  assert.equal(await page.inputValue('#l-pass'), '', 'a palavra-passe sai do formulário');
});

test('criar uma viagem com três dias', async ()=>{
  await page.click('#empty-new');
  await page.waitForSelector('#tripsheet:not([hidden])');
  await page.fill('#t-name', 'Açores E2E');
  await page.fill('#t-start', D1);
  await page.fill('#t-end', D3);
  await page.click('#t-submit');
  await page.waitForSelector('#tripsheet', { state: 'hidden' });
  assert.equal(await page.textContent('#trip-name'), 'Açores E2E');
  assert.equal(await page.locator('.day-col').count(), 3);
  await saved();
  assert.equal(tripsOnDisk().length, 1);
});

test('nova atividade: fica em "por agendar" e o editor põe-na no dia 1 às 10:00', async ()=>{
  await page.click('#add');
  await page.waitForSelector('#editor:not([hidden])');
  assert.equal(await page.evaluate(()=>document.activeElement.id), 'f-title');
  await page.keyboard.type('Museu');
  assert.equal(await page.locator('#tray-list .blk').count(), 1);
  await page.selectOption('#f-day', D1);
  await page.selectOption('#f-start', '600');
  await page.click('#editor [data-close]');
  await page.waitForSelector('#editor', { state: 'hidden' });
  assert.equal(await page.locator('#tray-list .blk').count(), 0);
  assert.equal(await block(D1).count(), 1);
  assert.match(await block(D1).textContent(), /Museu.*10:00/);
});

test('arrastar a atividade para o dia 2 e desfazer', async ()=>{
  const from = await block(D1).boundingBox(), to = await col(D2).boundingBox();
  const y = from.y + from.height / 2;
  await page.mouse.move(from.x + from.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, y, { steps: 12 });
  await page.waitForSelector(`.day-col[data-date="${D2}"].drop-target`);
  await page.mouse.up();
  assert.equal(await block(D1).count(), 0);
  assert.equal(await block(D2).count(), 1, 'a atividade passou para o dia 2');
  assert.match(await block(D2).textContent(), /10:00/, 'à mesma hora');
  assert.equal(await page.isEnabled('#undo'), true);

  await page.click('#undo');
  assert.equal(await block(D2).count(), 0);
  assert.equal(await block(D1).count(), 1, 'o Desfazer volta a pô-la no dia 1');
  await saved();
});

test('painéis: sítio do dia, custo geral e pontos a rever', async ()=>{
  await page.click(`button.dh[data-date="${D1}"]`);
  await page.waitForSelector('#daysheet:not([hidden])');
  await page.fill('#d-newplace', 'Ponta Delgada');
  await page.press('#d-newplace', 'Enter');
  await page.click('#d-apply');
  assert.match(await page.textContent(`button.dh[data-date="${D1}"] .loc`), /Ponta Delgada/);
  assert.match(await page.textContent('#route'), /Ponta Delgada/);

  await page.click('#costs-btn');
  await page.waitForSelector('#costsheet:not([hidden])');
  await page.click('#c-add-general');
  await page.locator('#c-general .c-label').fill('Seguro');
  await page.locator('#c-general .c-amt').fill('120');
  await page.waitForFunction(()=>/120/.test(document.querySelector('#tot-n').textContent));
  await page.keyboard.press('Escape');   // o painel de custos tapa o botão dos avisos
  await page.waitForSelector('#costsheet', { state: 'hidden' });

  await page.click('#warn-btn');
  await page.waitForSelector('#warnings:not([hidden])');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#warnings', { state: 'hidden' });
  await saved();
});

test('recarregar: a sessão continua e tudo foi gravado no servidor', async ()=>{
  await keepCoverage();
  await page.reload();
  await page.waitForSelector('.app:not([hidden])');
  assert.equal(await page.textContent('#trip-name'), 'Açores E2E');
  assert.equal(await block(D1).count(), 1);
  assert.match(await block(D1).textContent(), /Museu.*10:00/);
  assert.match(await page.textContent('#route'), /Ponta Delgada/);
  const rec = JSON.parse(readFileSync(join(dataDir, 'trips', tripsOnDisk()[0]), 'utf8'));
  assert.equal(rec.trip.blocks[0].date, D1);
  assert.equal(rec.trip.costs[0].amount, 120);
});

/* Uma ferramenta do MCP, como um assistente de IA a chamaria. Devolve o structuredContent, ou {error} com o texto. */
let rpcId = 0;
async function mcpTool(name, args){
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + MCP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const { result } = await r.json();
  return result.isError ? { error: result.content[0].text } : result.structuredContent;
}
const tripId = ()=>tripsOnDisk()[0].replace(/\.json$/, '');
async function reloadPage(){ await keepCoverage(); await page.reload(); await page.waitForSelector('.app:not([hidden])'); }

test('IA pelo MCP: ✨ no bloco e no painel, desfazer a última alteração e marcar como visto', async ()=>{
  const add = await mcpTool('add_activities', { trip_id: tripId(), activities: [{ title: 'Baleias', date: D2, start: '09:00', duration: 180 }] });
  assert.equal(add.added.length, 1, JSON.stringify(add));
  await reloadPage();
  assert.equal(await block(D2).count(), 1);
  assert.equal(await page.locator('.blk.ai-mark .ai-badge').count(), 1);
  assert.match(await page.textContent('#ai-btn'), /1 da IA/);
  await page.click('#ai-btn');
  await page.waitForSelector('#aisheet:not([hidden])');
  assert.equal(await page.locator('#ai-list .ai-item').count(), 1);
  assert.match(await page.textContent('#ai-list'), /Baleias/);

  // desfazer no servidor: a atividade sai e o botão da IA desaparece
  await page.click('#ai-undo');
  await page.waitForFunction(()=>!document.querySelector('.day-col[data-date="2027-06-02"] .blk'));
  await page.waitForSelector('#ai-btn', { state: 'hidden' });
  assert.match(await page.textContent('#toast'), /desfeita/);

  // outra vez, agora vista no editor
  await mcpTool('add_activities', { trip_id: tripId(), activities: [{ title: 'Termas', date: D2, start: '15:00' }] });
  await reloadPage();
  await block(D2).click();
  await page.waitForSelector('#editor:not([hidden])');
  assert.match(await page.textContent('#f-ai'), /Alterada pela IA/);
  await page.click('#f-ai-seen');
  await page.waitForSelector('#f-ai', { state: 'hidden' });
  await page.click('#editor [data-close]');
  assert.equal(await page.locator('.blk.ai-mark').count(), 0);
  assert.equal(await page.isHidden('#ai-btn'), true);
  await saved();
});

test('só de leitura e arquivada: nem a página nem a IA mudam a viagem até a desbloquear', async ()=>{
  await page.click('#trip-settings');
  await page.waitForSelector('#tripsheet:not([hidden])');
  await page.click('#t-ro');
  assert.equal(await page.isDisabled('#t-name'), true);
  assert.equal(await page.isDisabled('#t-del'), true);
  await page.click('#t-x');
  await page.waitForSelector('#lock-chip:not([hidden])');
  assert.match(await page.textContent('#lock-chip'), /Só de leitura/);
  assert.equal(await page.isDisabled('#add'), true);
  await saved();
  const r = await mcpTool('add_activities', { trip_id: tripId(), activities: [{ title: 'Não pode' }] });
  assert.match(r.error, /só de leitura/);

  // o editor abre, mas só para ver
  await block(D1).click();
  await page.waitForSelector('#editor:not([hidden])');
  assert.equal(await page.isDisabled('#f-title'), true);
  await page.click('#editor [data-close]');

  await page.click('#lock-chip');
  await page.waitForSelector('#lock-chip', { state: 'hidden' });
  assert.equal(await page.isEnabled('#add'), true);

  // arquivar: só de leitura e num grupo à parte no seletor de viagens
  await page.click('#trip-settings');
  await page.click('#t-archive');
  await page.click('#t-x');
  assert.match(await page.textContent('#lock-chip'), /Arquivada/);
  assert.equal(await page.locator('#trip-sel optgroup').count(), 1);
  await saved();
  assert.match((await mcpTool('update_trip', { trip_id: tripId(), name: 'x' })).error, /arquivada/);
  await page.click('#lock-chip');
  await page.waitForSelector('#lock-chip', { state: 'hidden' });
  assert.equal(await page.locator('#trip-sel optgroup').count(), 0);
  await saved();
});

test('Sair, mudar para inglês e voltar a entrar', async ()=>{
  await page.click('#logout');
  await page.waitForSelector('#login:not([hidden])');
  await page.click('[data-lang-toggle]');
  assert.equal(await page.getAttribute('html', 'lang'), 'en');
  assert.equal(await page.textContent('#l-submit'), 'Sign in');
  await page.fill('#l-user', USER);
  await page.fill('#l-pass', PASS);
  await page.click('#l-submit');
  await page.waitForSelector('.app:not([hidden])');
  assert.equal(await page.textContent('#add span'), 'New activity');
  assert.match(await page.textContent('#route'), /3 days/);
  assert.equal(await block(D1).count(), 1);
});

/* OAuth, como o claude.ai o faz: registo, consentimento no browser, troca do código e /mcp com o token.
   O redirect vai para localhost (outra origem que 127.0.0.1): só passa se a CSP da página de consentimento
   tiver essa origem no form-action (senão o Chrome recusa e mostra a violação na consola). O page.route não
   apanha um pedido que vem de um redirect, por isso ele chega ao servidor, que responde 404 a /cb-test. */
test('OAuth: registar, permitir no browser e usar o /mcp com o token de acesso', async ()=>{
  const redirect = base.replace('127.0.0.1', 'localhost') + '/cb-test';
  const reg = await fetch(base + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect] }) });
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ client_id, redirect_uri: redirect, response_type: 'code', state: 'st-1',
    code_challenge: challenge, code_challenge_method: 'S256', resource: base + '/mcp' });

  const p = await context.newPage();
  p.on('console', m=>{ if(m.type() === 'error' && !/404 \(Not Found\)/.test(m.text())) problems.push(m.text()); });
  p.on('pageerror', e=>problems.push(String(e)));
  await p.goto(base + '/oauth/authorize?' + q);
  assert.match(await p.textContent('h1'), /Ligar ao Planeador de Férias/);
  await p.fill('#user', USER);
  await p.fill('#password', PASS);
  const [req] = await Promise.all([p.waitForRequest(r=>r.url().startsWith(redirect)), p.click('button[value=allow]')]);
  const back = new URL(req.url());
  await p.close();
  assert.equal(back.searchParams.get('state'), 'st-1');
  assert.equal(back.searchParams.get('iss'), base);

  const tok = await fetch(base + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: redirect, client_id, code_verifier: verifier }) });
  assert.equal(tok.status, 200);
  const { access_token } = await tok.json();
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).result.tools.some(t=>t.name === 'list_trips'));
});

test('sem erros na consola nem exceções (inclui violações da CSP)', ()=>{
  assert.deepEqual(problems, []);
});
