// Browser checks for double-click placement (T01-15): a calculated field double-clicked in the Calculated fields dialog lands on its default
// shelf (measure -> Rows, dimension -> Columns), a hierarchy row double-clicked in the Hierarchies dialog is used as the drill levels,
// the buttons keep their own behaviour. Real dev app (APP_URL), /api/* mocked. Env: APP_URL, SHOTS_DIR, CDP_PORT, CHROME_BIN.
// Any page error fails the run (cdp.mjs).  Env: APP_URL, SHOTS_DIR, CDP_PORT, CHROME_BIN.
import { launch } from './cdp.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5193';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'dblclick-ui-shots');
mkdirSync(SHOTS, { recursive: true });

const COLUMNS = { orders: [['amount', 'Float64', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text'], ['placed', 'DateTime', 'temporal']] };
const REGIONS = ['APAC', 'EU', 'US'], CHANNELS = ['web', 'shop'];
const queries = [];
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders'] };
  if (path === '/api/databases/shop/tables/orders/columns') return { json: COLUMNS.orders.map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/query') {
    queries.push(body);
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    const keysFor = dims[0]?.column === 'channel' ? CHANNELS : REGIONS;
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: keysFor.map((k, r) => ({ keys: dims.map(() => k), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })), truncated: false } };
  }
  return null;
}

let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;

let b = null, wbDir = null;
try {
  wbDir = mkdtempSync(join(tmpdir(), 'dblclick-wb-'));
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label, timeout) => b.waitFor(s, { label, timeout });
  const settle = async (quiet = 250) => { let n = -1; for (let i = 0; i < 60 && n !== queries.length; i++) { n = queries.length; await b.sleep(quiet); } };
  const last = () => queries[queries.length - 1];
  const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); const d = st.activeWorksheet(); ${code}; return true; })()`);
  const sheetDrill = () => ev(`(async () => JSON.stringify((await import('/features/Core/store.js')).activeWorksheet().sheet.drill))()`).then((s) => JSON.parse(s));
  const hdlg = `document.querySelector('dialog.hier-dialog[open]')`;
  const clickIn = (root, text) => ev(`(() => { const e = [...${root}.querySelectorAll('button')].find((x) => x.textContent.trim() === ${J(text)} || x.getAttribute('aria-label') === ${J(text)}); if (!e) throw new Error('no button ${text}'); e.click(); return true; })()`);
  const setVal = (sel, v, evt = 'input') => ev(`(() => { const i = ${hdlg}.querySelector(${J(sel)}); i.value = ${J(v)}; i.dispatchEvent(new Event(${J(evt)}, { bubbles: true })); return true; })()`);
  const levelNames = () => ev(`[...${hdlg}.querySelectorAll('.hier-level__name')].map((x) => x.textContent)`);
  const formError = () => ev(`(() => { const e = ${hdlg}.querySelector('.field-error'); return e && !e.hidden ? e.textContent : ''; })()`);
  const addLevel = async (col) => { await setVal('.hier-add select', col, 'change'); await clickIn(hdlg, 'Add level'); };
  // Hierarchies live in a dialog opened from the sidebar's Hierarchies tool: a row per hierarchy with Use / Edit / Delete.
  const openHier = async () => { await ev(`document.querySelector('button[aria-label="Hierarchies"]').click()`); await waitFor(`${hdlg} !== null`, 'hierarchies dialog'); };
  const closeHier = async () => { await clickIn(hdlg, 'Done'); await waitFor(`${hdlg} === null`, 'dialog closed'); };
  const hierNames = () => ev(`[...${hdlg}.querySelectorAll('.bookmark__name')].map((x) => x.textContent)`);
  const useHier = async (name) => { await openHier(); await ev(`${hdlg}.querySelector(${J(`button[aria-label^="Use ${name} as"]`)}).click()`); await waitFor(`${hdlg} === null`, 'dialog closed by Use'); };
  const chartHost = `document.querySelector('#ws-chart .ws-chart-canvas')`;
  const instOf = `window.echarts.getInstanceByDom(${chartHost})`;
  const clickBar = async (cat) => {
    const p = await ev(`(() => { const i = ${instOf}; const horiz = i.getOption().yAxis[0].type === 'category'; const [x, y] = i.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, horiz ? [5, ${J(cat)}] : [${J(cat)}, 5]); const r = ${chartHost}.getBoundingClientRect(); return [r.left + x, r.top + y]; })()`);
    await b.click(p[0], p[1]);
  };

  // ---- setup ----
  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 1`, 'tables');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'orders loaded');
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await waitFor(`document.querySelectorAll('#ws-fields .ws-field').length >= 4`, 'fields');
  await store(`const s = d.sheet; const f = (c, category, extra = {}) => ({ db: 'shop', table: 'orders', column: c, category, ...extra }); s.chartType = 'bar'; s.columns = []; s.rows = [f('amount', 'numeric', { agg: 'sum' })]; s.drill = null; st.updateSheet(d.id, s)`);
  await settle();

  const dbl = (sel) => ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return false; e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); return true; })()`);
  const sheetShelves = () => ev(`(async () => { const s = (await import('/features/Core/store.js')).activeWorksheet().sheet; return JSON.stringify({ rows: s.rows.map((f) => f.column ?? f.name ?? f.calcId), columns: s.columns.map((f) => f.column ?? f.name ?? f.calcId) }); })()`).then((x) => JSON.parse(x));
  await store(`st.addCalculation({ name: 'Amount x2', formula: 'SUM([orders.amount]) * 2' }); st.addCalculation({ name: 'Region up', formula: 'UPPER([orders.region])' }); st.addHierarchy({ name: 'Geo', levels: [{ db: 'shop', table: 'orders', column: 'region', category: 'text' }, { db: 'shop', table: 'orders', column: 'channel', category: 'text' }] })`);
  const cdlg = `dialog.calc-manager[open]`;
  const openCalcs = async () => { await ev(`document.querySelector('button[aria-label="Calculated fields"]').click()`); await waitFor(`!!document.querySelector(${J(cdlg)})`, 'calc manager'); };
  const rowSel = (name) => ev(`(() => { const r = [...document.querySelectorAll('${cdlg} .calc-manager__row')].find((x) => x.querySelector('.ws-field__name').textContent === ${J(name)}); r.dataset.t = '1'; return true; })()`);
  const shots = [];

  await check('double-clicking an aggregate calculated field places it on Rows; a row-level one on Columns; the dialog stays open', async () => {
    await openCalcs();
    const before = await sheetShelves();
    await rowSel('Amount x2');
    must(await dbl(`${cdlg} [data-t="1"] .ws-field`), 'no row');
    await settle();
    const a = await sheetShelves();
    must(a.rows.length === before.rows.length + 1, `rows ${J(before)} -> ${J(a)}`);
    await ev(`document.querySelector('${cdlg} [data-t="1"]').removeAttribute('data-t')`);
    await rowSel('Region up');
    await dbl(`${cdlg} [data-t="1"] .ws-field`);
    await settle();
    const c = await sheetShelves();
    must(c.columns.length === a.columns.length + 1 && c.rows.length === a.rows.length, `after dimension: ${J(a)} -> ${J(c)}`);
    must(await ev(`!!document.querySelector(${J(cdlg)})`), 'dialog closed');
    for (const scheme of ['light', 'dark']) {
      await ev(`document.documentElement.dataset.scheme = ${J(scheme)}`);
      await b.sleep(150);
      const p = join(SHOTS, `dblclick-calcs-${scheme}.png`); await b.screenshot(p); shots.push(p);
    }
    await ev(`document.documentElement.dataset.scheme = 'light'`);
    await clickIn(`document.querySelector(${J(cdlg)})`, 'Done');
    await waitFor(`!document.querySelector(${J(cdlg)})`, 'closed');
  });

  await check('double-clicking the pencil (a button) does not place the field', async () => {
    await openCalcs();
    const before = await sheetShelves();
    await ev(`(() => { const e = document.querySelector('${cdlg} .calc-manager__edit'); e.addEventListener('click', (ev) => ev.stopImmediatePropagation(), true); e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
    await settle();
    must(J(await sheetShelves()) === J(before), 'pencil double-click placed a field');
    await clickIn(`document.querySelector(${J(cdlg)})`, 'Done');
  });

  await check('double-clicking a hierarchy row uses it as the drill levels and closes the dialog; Use stays the keyboard path', async () => {
    await openHier();
    must(await ev(`!!${hdlg}.querySelector('button[aria-label^="Use Geo as"]')`), 'Use button missing');
    await ev(`${hdlg}.querySelector('li.bookmark').dataset.t = '1'`);
    await dbl(`dialog.hier-dialog[open] li[data-t="1"]`);
    await waitFor(`${hdlg} === null`, 'dialog closed by double-click');
    const d = await sheetDrill();
    must(d && d.levels.length === 2 && d.levels[0].column === 'region', `drill: ${J(d)}`);
    await settle();
    await openHier();
    for (const scheme of ['light', 'dark']) {
      await ev(`document.documentElement.dataset.scheme = ${J(scheme)}`);
      await b.sleep(150);
      const p = join(SHOTS, `dblclick-hier-${scheme}.png`); await b.screenshot(p); shots.push(p);
    }
    await ev(`document.documentElement.dataset.scheme = 'light'`);
    await closeHier();
  });

  console.log('screenshots:\n  ' + shots.join('\n  '));
  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
  if (wbDir) rmSync(wbDir, { recursive: true, force: true });
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
