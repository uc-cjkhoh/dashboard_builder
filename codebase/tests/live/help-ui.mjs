// Browser checks for the function help (autocomplete of function names + the Functions panel): the real dev app (APP_URL, default http://localhost:5180) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/help-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5180 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC } from './model.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5180';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'help-ui-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['discount', 'Float64', 'numeric'], ['placed', 'DateTime', 'temporal']],
  customers: [['country', 'String', 'text']],
};
const REGIONS = ['APAC', 'EU', 'US'];
const queries = [];     // every /api/query body, in order
let tables = ['orders', 'customers'];
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: tables };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/query') {
    queries.push(body);
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    const n = dims.length ? REGIONS.length : 1;
    return { json: {
      rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: Array.from({ length: n }, (_, r) => ({ keys: dims.map(() => REGIONS[r]), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })),
      truncated: false } };
  }
  return null;
}


// ---- tiny test runner ---------------------------------------------------------------------------------------
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; }
  catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const J = JSON.stringify;

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const dlg = `document.querySelector('dialog.calc-dialog[open]')`;
  const focusAndType = async (sel, text) => {
    await ev(`(() => { const e = document.querySelector(${J(sel)}); e.focus(); e.select?.(); return true; })()`);
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await b.type(text);
  };
  const formula = () => ev(`document.querySelector('.calc-dialog textarea.formula').value`);
  const optionTexts = () => ev(`[...document.querySelectorAll('.calc-dialog .suggest li')].map((l) => l.textContent)`);
  const listHidden = () => ev(`document.querySelector('.calc-dialog .suggest').hidden`);
  const panelHidden = () => ev(`document.querySelector('.calc-dialog .calc-fn').hidden`);

  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'orders loaded');
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await waitFor(`!!document.querySelector('button[aria-label="Calculated fields"]')`, 'field pane filled');
  await ev(NEW_CALC);
  await waitFor(`${dlg} !== null`, 'calc dialog open');

  await check('typing LO offers LOWER with its signature; choosing inserts LOWER(', async () => {
    await focusAndType('.calc-dialog textarea.formula', 'LO');
    await waitFor(`!document.querySelector('.calc-dialog .suggest').hidden`, 'listbox open');
    const t = await optionTexts();
    must(t.length === 1 && t[0].includes('LOWER') && t[0].includes('LOWER(text)'), `options: ${J(t)}`);
    await b.key('Enter', { vk: 13 });
    must(await formula() === 'LOWER(', `formula: ${await formula()}`);
    must(await listHidden(), 'list still open');
  });

  await check('[ still offers fields', async () => {
    await focusAndType('.calc-dialog textarea.formula', 'LOWER([orders.re');
    await waitFor(`!document.querySelector('.calc-dialog .suggest').hidden`, 'listbox open');
    const t = await optionTexts();
    must(t.length === 1 && t[0].includes('orders.region') && t[0].includes('field'), `options: ${J(t)}`);
    await b.key('Enter', { vk: 13 });
    must(await formula() === 'LOWER([orders.region]', `formula: ${await formula()}`);
  });

  await check('Functions panel: always shown right of the editor (two panels), no toggle button, labelled', async () => {
    must(await ev(`!document.querySelector('.calc-fn__btn')`), 'a Functions toggle button still exists');
    must(!(await panelHidden()), 'panel hidden');
    const lay = await ev(`(() => { const e = document.querySelector('.calc-dialog__edit').getBoundingClientRect(), p = document.querySelector('.calc-fn').getBoundingClientRect(); return { editRight: e.right, panelLeft: p.left, sameTop: Math.abs(e.top - p.top) < 2, label: document.querySelector('.calc-fn').getAttribute('aria-label') }; })()`);
    must(lay.editRight <= lay.panelLeft + 0.5 && lay.sameTop && lay.label === 'Functions', `layout: ${J(lay)}`);
    const groups = await ev(`[...document.querySelectorAll('.calc-fn__group')].map((h) => h.textContent)`);
    must(J(groups) === J(['Aggregate', 'Logic', 'Text', 'Date']), `groups: ${J(groups)}`);
    must(await ev(`document.querySelector('.calc-fn__item .sig').textContent.startsWith('(')`), 'signature repeats the name');
  });

  await check('search "date" narrows; hover shows detail; click inserts the signature at the caret', async () => {
    await focusAndType('.calc-fn__search', 'date');
    const names = await ev(`[...document.querySelectorAll('.calc-fn__item .name')].map((n) => n.textContent)`);
    must(names.includes('DATEADD') && names.includes('DATEDIFF') && !names.includes('SUM'), `names: ${J(names)}`);
    await ev(`(() => { const b = [...document.querySelectorAll('.calc-fn__item')].find((x) => x.querySelector('.name').textContent === 'DATEADD'); b.dispatchEvent(new MouseEvent('mouseenter')); return true; })()`);
    const d = await ev(`document.querySelector('.calc-fn__detail').textContent`);
    must(d.includes("DATEADD('month', 1, [orders.placed])") && d.includes('Gives'), `detail: ${d}`);
    await ev(`(() => { const t = document.querySelector('.calc-dialog textarea.formula'); t.value = 'x + y'; t.setSelectionRange(1, 1); return true; })()`);
    await ev(`[...document.querySelectorAll('.calc-fn__item')].find((x) => x.querySelector('.name').textContent === 'DATEADD').click()`);
    const f = await formula();
    must(f === 'xDATEADD(unit, amount, date) + y', `formula: ${f}`);
    must(await ev(`document.activeElement.classList.contains('formula')`), 'focus not back in the formula');
  });

  await check('Insert example button; no-match message', async () => {
    await focusAndType('.calc-fn__search', 'zzzz');
    must((await ev(`document.querySelector('.calc-fn__list').textContent`)).includes('No function matches'), 'no empty message');
    await focusAndType('.calc-fn__search', 'iif');
    await ev(`document.querySelector('.calc-fn__item').focus()`);
    await ev(`document.querySelector('.calc-fn > .btn').click()`);
    must(await ev(`document.querySelector('.calc-fn > .btn').getAttribute('aria-label')`) === 'Insert example for IIF', 'aria-label');
    must((await formula()).includes("IIF([orders.qty] > 1, 'many', 'one')"), `formula: ${await formula()}`);
  });

  const shots = [];
  for (const scheme of ['light', 'dark']) {
    await check(`${scheme} screenshot`, async () => {
      await b.setScheme(scheme);
      await ev(`document.documentElement.setAttribute('data-theme', ${J(scheme)})`);
      await ev(`(() => { const t = document.querySelector('.calc-dialog textarea.formula'); t.value = 'SUM([orders.amount]) / '; return true; })()`);
      await focusAndType('.calc-fn__search', 'e');
      await ev(`[...document.querySelectorAll('.calc-fn__item')].find((x) => x.querySelector('.name').textContent === 'PERCENTILE').dispatchEvent(new MouseEvent('mouseenter'))`);
      await b.sleep(400);
      const p = join(SHOTS, `help-${scheme}.png`);
      await b.screenshot(p); shots.push(p);
    });
  }
  console.log('screenshots:\n  ' + shots.join('\n  '));
} finally {
  if (b) await b.close();
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
