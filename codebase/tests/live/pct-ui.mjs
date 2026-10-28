// Browser checks for the plain percentile measure (T04-07): the real dev app (APP_URL, default http://localhost:5204) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/pct-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5204 ; stop it with fuser -k 5204/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5204';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'pct-ui-shots');
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


  const pillAggs = () => ev(`(() => { const p = document.querySelector('.ws-shelf--rows .ws-pill'); return [...p.querySelector('.ws-pill__agg').options].map((o) => [o.value, o.textContent]); })()`);
  const setAgg = (v) => ev(`(() => { const s = document.querySelector('.ws-shelf--rows .ws-pill .ws-pill__agg'); s.value = ${J(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const pctInput = `document.querySelector('.ws-shelf--rows .ws-pill .ws-pill__pctin')`;
  const typePct = async (text) => {
    await ev(`(() => { const e = ${pctInput}; e.focus(); e.select(); return true; })()`);
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await b.type(text);
  };
  const commitPct = async () => { await b.key('Enter', { code: 'Enter', vk: 13 }); await ev(`${pctInput}?.blur()`); };

  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await waitFor(`__t.pills('rows').length === 1`, 'amount pill on Rows');

  await check('the aggregation menu offers "Percentile…" on a numeric field, and no other option is renamed', async () => {
    const opts = await pillAggs();
    const pct = opts.find(([v]) => v === 'percentile');
    must(pct && pct[1] === 'Percentile…', `menu: ${J(opts)}`);
    must(opts.filter(([v, t]) => v !== 'percentile' && t !== v).length === 0, `renamed options: ${J(opts)}`);
    must(!(await ev(`!!document.querySelector('.ws-shelf--rows .ws-pill .ws-pill__pctin')`)), 'percent box shown before choosing it');
  });
  await check('choosing Percentile… shows a labelled percent box at 90, and the request carries agg percentile with p 0.9', async () => {
    await settle();
    await setAgg('percentile');
    await waitFor(`!!${pctInput}`, 'percent box');
    await settle();
    must(await ev(`${pctInput}.value`) === '90', 'box should start at 90');
    must(/Percentile for .*0 to 100/.test(await ev(`${pctInput}.getAttribute('aria-label')`)), 'box has no accessible name');
    const m = lastQuery().measures[0];
    must(m.agg === 'percentile' && m.p === 0.9 && m.column === 'amount', `measure: ${J(m)}`);
    must(/p90/.test((await pills('rows'))[0]), `pill label: ${J(await pills('rows'))}`);
  });
  await check('typing 99.5 stores 0.995, labels the pill p99.5 and re-queries', async () => {
    await typePct('99.5'); await commitPct();
    await settle();
    must(lastQuery().measures[0].p === 0.995, `p: ${J(lastQuery().measures[0])}`);
    must(/p99\.5/.test((await pills('rows'))[0]), `pill label: ${J(await pills('rows'))}`);
    must(await ev(`${pctInput}.value`) === '99.5', 'box lost its value');
  });
  await check('an invalid value shows the message (icon + text, aria-invalid) and sends nothing new; the pill keeps the last good percentile', async () => {
    const before = queries.length;
    for (const bad of ['150', 'abc', '', '-5']) {
      await typePct(bad);
      must(await ev(`${pctInput}.getAttribute('aria-invalid')`) === 'true', `not flagged: ${bad}`);
      const msg = await ev(`(() => { const e = document.querySelector('.ws-shelf--rows .ws-pill__pcterr'); return e.hidden ? '' : e.textContent; })()`);
      must(/between 0 and 100/.test(msg), `message for ${J(bad)}: ${msg}`);
      must(await ev(`!!document.querySelector('.ws-shelf--rows .ws-pill__pcterr svg')`), 'message has no icon');
      await commitPct();
    }
    await settle();
    must(queries.length === before, `an invalid value re-queried (${queries.length - before})`);
    must(lastQuery().measures[0].p === 0.995, 'last good p lost');
  });
  await check('a valid value clears the message', async () => {
    await typePct('25'); await commitPct(); await settle();
    must(await ev(`document.querySelector('.ws-shelf--rows .ws-pill__pcterr') === null || document.querySelector('.ws-shelf--rows .ws-pill__pcterr').hidden`), 'message still shown');
    must(lastQuery().measures[0].p === 0.25, `p: ${J(lastQuery().measures[0])}`);
  });
  await check('leaving percentile drops p from the pill and the request', async () => {
    await setAgg('median'); await settle();
    const m = lastQuery().measures[0];
    must(m.agg === 'median' && !('p' in m), `measure: ${J(m)}`);
    must(!(await ev(`!!${pctInput}`)), 'percent box still shown');
  });
  await check('percentile is not in the field default-aggregation menu', async () => {
    await ev(`(() => { const c = __t.chip('amount'); c.querySelector('.ws-field__more').click(); return true; })()`);
    const items = await ev(`(() => { const c = __t.chip('amount'); return [...c.querySelectorAll('.menu__item')].map((x) => x.textContent.trim()); })()`);
    must(items.includes('median') && !items.includes('percentile'), `default menu: ${J(items)}`);
    await b.key('Escape', { code: 'Escape', vk: 27 });
  });
  await check('screenshots, light and dark', async () => {
    await setAgg('percentile'); await settle();
    await typePct('150');
    for (const scheme of ['light', 'dark']) {
      await b.setScheme(scheme);
      await ev(`document.documentElement.setAttribute('data-theme', ${J(scheme)})`);
      await b.sleep(300);
      await b.screenshot(join(SHOTS, `pct-invalid-${scheme}.png`));
    }
    await commitPct(); await typePct('90'); await commitPct(); await settle();
    for (const scheme of ['light', 'dark']) {
      await b.setScheme(scheme);
      await ev(`document.documentElement.setAttribute('data-theme', ${J(scheme)})`);
      await b.sleep(300);
      await b.screenshot(join(SHOTS, `pct-ok-${scheme}.png`));
    }
    await ev(`document.documentElement.removeAttribute('data-theme')`);
    console.log('screenshots in ' + SHOTS);
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
