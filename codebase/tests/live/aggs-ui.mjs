// Browser checks for the added aggregations (median, stddev, variance, percentile, attr): the real dev app (APP_URL, default http://localhost:5187) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/aggs-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5187 ; stop it with fuser -k 5187/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5187';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'aggs-ui-shots');
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

let wbDir = null, b = null;
try {
  wbDir = mkdtempSync(join(tmpdir(), 'calc-wb-'));
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const toastText = () => ev(`(document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent)`);

  // page helpers: HTML5 drag-and-drop with a real DataTransfer, text lookup, dialog typing
  const installHelpers = () => ev(`(() => {
    window.__t = {
      chip: (name) => [...document.querySelectorAll('#ws-fields .ws-field')].find((c) => c.querySelector('.ws-field__name')?.textContent === name),
      drag(chip, target) {
        const dt = new DataTransfer();
        chip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        chip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      },
      zone: (kind) => document.querySelector('.ws-shelf--' + kind + ' .ws-shelf__zone'),
      pills: (kind) => [...document.querySelectorAll('.ws-shelf--' + kind + ' .ws-pill')].map((p) => p.querySelector('.ws-pill__text')?.textContent),
      btn: (text, root = document) => [...root.querySelectorAll('button')].find((x) => x.textContent.trim() === text || x.getAttribute('aria-label') === text),
    };
    return true; })()`);
  const dragChip = (name, target) => ev(`(() => { const c = __t.chip(${J(name)}); if (!c) throw new Error('no field chip ${name}'); __t.drag(c, ${target}); return true; })()`);
  const pills = (kind) => ev(`__t.pills(${J(kind)})`);
  const dlg = `document.querySelector('dialog.calc-dialog[open]')`;
  const focusAndType = async (sel, text) => {
    await ev(`(() => { const e = document.querySelector(${J(sel)}); e.focus(); e.select?.(); return true; })()`);
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await b.type(text);
  };
  const openNewDialog = async () => {
    await ev(`document.querySelector('.calc-group__new').click()`);
    await waitFor(`${dlg} !== null`, 'calc dialog open');
  };
  const fillDialog = async (name, formula) => {
    await focusAndType('.calc-dialog input.input', name);
    await focusAndType('.calc-dialog textarea.formula', formula);
    await ev(`document.querySelector('.calc-dialog textarea.formula').blur()`);
  };
  const saveDisabled = () => ev(`[...${dlg}.querySelectorAll('.dialog__foot button')].find((x) => x.textContent === 'Save').disabled`);
  const saveDialog = async () => {
    await ev(`[...${dlg}.querySelectorAll('.dialog__foot button')].find((x) => x.textContent === 'Save').click()`);
    await waitFor(`${dlg} === null`, 'dialog closed after save');
  };
  const newCalc = async (name, formula) => { await openNewDialog(); await fillDialog(name, formula); await saveDialog(); };
  const calcMenu = async (name, item) => {
    await ev(`(() => { const c = __t.chip(${J(name)}); c.querySelector('.ws-field__more').click(); return true; })()`);
    await ev(`(() => { const c = __t.chip(${J(name)}); [...c.querySelectorAll('.menu__item')].find((x) => x.textContent.trim() === ${J(item)}).click(); return true; })()`);
  };
  const confirmOpen = `[...document.querySelectorAll('dialog[open]')].find((d) => !d.classList.contains('calc-dialog'))`;
  const chartText = () => ev(`document.getElementById('ws-chart').textContent`);
  const canvasDrawn = () => ev(`!!document.querySelector('#ws-chart canvas, #ws-chart svg')`);
  const until = async (fn, label, timeout = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for: ${label}`); await b.sleep(50); } };
  // Wait until no new /api/query has arrived for `quiet` ms (polling, not a fixed sleep).
  const settle = async (quiet = 300) => { let n = -1; for (let i = 0; i < 60 && n !== queries.length; i++) { n = queries.length; await b.sleep(quiet); } };
  const lastQuery = () => queries[queries.length - 1];
  const hasKey = (o, k) => J(o).includes(`"${k}"`);

  // ---- setup: connect, add the two tables, open a worksheet -----------------------------------------------------
  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders', 'customers'])
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'both tables loaded');
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await installHelpers();
  await waitFor(`!!__t.chip('region')`, 'field pane filled');


  const pillAggs = () => ev(`(() => { const p = document.querySelector('.ws-shelf--rows .ws-pill'); return [...p.querySelector('.ws-pill__agg').options].map((o) => o.value); })()`);
  const setAgg = (v) => ev(`(() => { const s = document.querySelector('.ws-shelf--rows .ws-pill .ws-pill__agg'); s.value = ${J(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const fmsg = () => ev(`${dlg}.querySelector('[id^=calc-fmsg]').textContent.trim()`);

  await check('pill menu: a numeric measure offers median, stddev, variance and attr; percentile is not a plain-measure option', async () => {
    await dragChip('region', `__t.zone('columns')`);
    await dragChip('amount', `__t.zone('rows')`);
    await waitFor(`__t.pills('rows').length === 1`, 'amount pill on Rows');
    const opts = await pillAggs();
    for (const a of ['median', 'stddev', 'variance', 'attr']) must(opts.includes(a), `${a} missing from ${J(opts)}`);
    must(!opts.includes('percentile'), `percentile offered on a plain measure: ${J(opts)}`);
    await b.screenshot(join(SHOTS, 'pill-menu.png'));
  });
  await check('choosing median sends agg "median" and names the measure', async () => {
    await settle();
    await setAgg('median');
    await settle();
    const m = lastQuery().measures[0];
    must(m.agg === 'median' && m.column === 'amount', `measure: ${J(m)}`);
    must(await canvasDrawn(), 'no chart drawn');
    for (const a of ['stddev', 'variance', 'attr']) { await setAgg(a); await settle(); must(lastQuery().measures[0].agg === a, `${a} not sent: ${J(lastQuery().measures[0])}`); }
  });
  await check('formula dialog: MEDIAN accepted; PERCENTILE needs a fraction in 0..1', async () => {
    await openNewDialog();
    await fillDialog('Mid', 'MEDIAN([orders.amount])');
    must((await fmsg()) === '' || !(/error|Unknown|Expected/.test(await fmsg())), `MEDIAN refused: ${await fmsg()}`);
    must(!(await saveDisabled()), 'Save disabled for MEDIAN([orders.amount])');
    await focusAndType('.calc-dialog textarea.formula', 'PERCENTILE([orders.amount])');
    must(await saveDisabled() && /PERCENTILE/.test(await fmsg()), `missing fraction not refused: ${await fmsg()}`);
    await focusAndType('.calc-dialog textarea.formula', 'PERCENTILE([orders.amount], 1.5)');
    must(await saveDisabled() && /between 0 and 1/.test(await fmsg()), `fraction 1.5 not refused: ${await fmsg()}`);
    await focusAndType('.calc-dialog textarea.formula', 'PERCENTILE([orders.amount], 0.9)');
    must(!(await saveDisabled()), `PERCENTILE(…, 0.9) refused: ${await fmsg()}`);
    await b.screenshot(join(SHOTS, 'dialog-percentile.png'));
    await saveDialog();
    await waitFor(`!!__t.chip('Mid')`, 'chip in the field pane');
  });
  await check('a saved PERCENTILE reaches /api/query as an agg node with a numeric p', async () => {
    await dragChip('Mid', `__t.zone('rows')`);
    await waitFor(`__t.pills('rows').length === 2`, 'calc pill on Rows');
    await settle();
    const m = lastQuery().measures.find((x) => x.calc);
    must(m.calc.k === 'agg' && m.calc.fn === 'percentile' && m.calc.p === 0.9 && m.calc.arg.k === 'field', `tree: ${J(m.calc)}`);
    must(!('agg' in m) || m.agg == null, `aggregate calc carries agg: ${J(m)}`);
  });
} catch (e) {
  console.log(`FAIL (setup): ${e.stack ?? e.message}`);
  failed++;
} finally {
  await b?.close();
  if (wbDir) rmSync(wbDir, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
