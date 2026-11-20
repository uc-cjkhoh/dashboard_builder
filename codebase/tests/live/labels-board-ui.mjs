// Browser check for member labels on a dashboard (T02-29): the cross-widget selection chip names the clicked member by its label while
// the filter every other widget gets stays the RAW value; widgets draw the labels. Same harness and mock as crossfilter-ui.mjs.
import { launch } from './cdp.mjs';
import { relateTables } from './model.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5193';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'labels-board-ui-shots');
mkdirSync(SHOTS, { recursive: true });
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text']],
  stock: [['units', 'Float64', 'numeric'], ['sku', 'String', 'text']],
};
const VALUES = { region: ['APAC', 'EU', 'US'], channel: ['web', 'shop', 'app'], sku: ['s1', 's2', 's3'] };
const queries = [];
const dimsOf = (q) => [...(q.rowDimensions ?? []), ...(q.columnDimensions ?? [])].map((d) => d.column).join();
const since = (from, col) => queries.slice(from).filter((q) => dimsOf(q) === col);
const regionFilter = (q) => (q.filters ?? []).find((f) => f.column === 'region');
let slowChannelMs = 0, failChannel = false;
async function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders', 'stock'] };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/query') {
    queries.push(body);
    const col = dimsOf(body);
    if (col === 'channel') {
      if (slowChannelMs && regionFilter(body)?.value === 'EU') await new Promise((r) => setTimeout(r, slowChannelMs));
      if (failChannel && regionFilter(body)) return { status: 502, json: { error: 'ClickHouse is unreachable.' } };
    }
    const rf = regionFilter(body);
    const base = (r) => (rf ? (rf.value === 'EU' ? 7 : 9) : 10 * (r + 1)); // a filtered result is visibly different
    if (body.offset !== undefined) {
      return { json: { rowDimensions: ['region'], columnDimensions: [], measures: ['v0'], total: 3, rows: [0, 1, 2].map((r) => ({ keys: [VALUES.region[r]], values: [base(r)] })), truncated: false } };
    }
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column), measures: ['v0'],
      rows: [0, 1, 2].map((r) => ({ keys: [VALUES[col][r]], values: [base(r)] })), truncated: false } };
  }
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); ${code} })()`);
  const connect = async () => {
    await waitFor(`document.readyState === 'complete' && !!document.getElementById('conn-connect')`, 'app loaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, 'databases listed');
  };
  const W = (title) => `[...document.querySelectorAll('.board-widget')].find((x) => x.querySelector('.board-widget__title').textContent === ${J(title)})`;
  const opts = (title, which = 0) => ev(`(() => { const w = ${W(title)}; const ws = [...document.querySelectorAll('.board-widget')].filter((x) => x.querySelector('.board-widget__title').textContent === ${J(title)});
    const d = (ws[${which}] ?? w)?.querySelector('.ws-chart-canvas'); const i = d && window.echarts.getInstanceByDom(d); return i ? i.getOption() : null; })()`);
  // each datum's opacity (1 = not styled) and value on the first series
  const marks = async (title, which = 0) => { const o = await opts(title, which); return (o?.series?.[0]?.data ?? []).map((d) => ({ v: typeof d === 'object' && d ? d.value : d, o: typeof d === 'object' && d?.itemStyle?.opacity != null ? d.itemStyle.opacity : 1 })); };
  const values = async (title, which = 0) => (await marks(title, which)).map((m) => m.v);
  const addSheet = (name) => ev(`document.querySelector('.board-panel__item[data-sheet-id="' + [...document.querySelectorAll('.board-panel__item')].find((x) => x.querySelector('.board-panel__name').textContent === ${J(name)}).dataset.sheetId + '"] button').click()`);
  const chip = () => ev(`(() => { const c = document.getElementById('board-filter'); return c.hidden ? null : c.textContent; })()`);
  const noticeOf = (title) => ev(`(() => { const n = ${W(title)}?.querySelector('.board-widget__notice'); return !n || n.hidden ? '' : n.textContent; })()`);
  const drawn = (title) => ev(`!!${W(title)}?.querySelector('.ws-chart-canvas svg')`);
  const shot = (name) => b.screenshot(join(SHOTS, name));
  // a REAL mouse click on the bar of category `cat` in the which-th widget titled `title`
  const clickBar = async (title, cat, which = 0) => {
    const p = await ev(`(() => { const ws = [...document.querySelectorAll('.board-widget')].filter((x) => x.querySelector('.board-widget__title').textContent === ${J(title)}); const w = ws[${which}];
      w.scrollIntoView({ block: 'center' }); const d = w.querySelector('.ws-chart-canvas'); const i = window.echarts.getInstanceByDom(d); const r = d.getBoundingClientRect();
      return { x: r.left + i.convertToPixel({ xAxisIndex: 0 }, ${J(cat)}), y: r.top + i.convertToPixel({ yAxisIndex: 0 }, 1) - 3 }; })()`);
    await b.sleep(80);
    const p2 = await ev(`(() => { const ws = [...document.querySelectorAll('.board-widget')].filter((x) => x.querySelector('.board-widget__title').textContent === ${J(title)}); const w = ws[${which}];
      const d = w.querySelector('.ws-chart-canvas'); const i = window.echarts.getInstanceByDom(d); const r = d.getBoundingClientRect();
      return { x: r.left + i.convertToPixel({ xAxisIndex: 0 }, ${J(cat)}), y: r.top + i.convertToPixel({ yAxisIndex: 0 }, 1) - 3 }; })()`);
    await b.click(p2.x, p2.y);
    return p;
  };
  const settle = () => b.sleep(350);

  await b.goto(APP + '/');
  await connect();
  await ev(`(() => { for (const r of document.querySelectorAll('.db-row[data-db]')) if ((r.dataset.db === 'shop') !== (r.getAttribute('aria-expanded') === 'true')) r.click(); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders', 'stock']) await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'tables loaded');
  await relateTables(ev, waitFor, ['orders', 'region', 'stock', 'sku']); // an unrelated table is held out of worksheets
  await store(`
    const f = (table, column, category, extra = {}) => ({ db: 'shop', table, column, category, ...extra });
    const mk = (name, chartType, table, dim, meas) => { const t = st.createWorksheet(name); t.sheet = { ...st.emptySheet(), chartType, columns: [f(table, dim, 'text')], rows: [f(table, meas, 'numeric', { agg: 'sum' })] }; return t; };
    mk('Revenue by region', 'bar', 'orders', 'region', 'amount'); mk('Share by channel', 'pie', 'orders', 'channel', 'amount'); mk('Stock by sku', 'bar', 'stock', 'sku', 'units');
    const tb = st.createWorksheet('Orders table'); tb.sheet = { ...st.emptySheet(), chartType: 'table', columns: [], rows: [f('orders', 'region', 'text'), f('orders', 'amount', 'numeric', { agg: 'sum' })] };
    st.createDashboard('Overview'); return true;`);
  await waitFor(`!document.getElementById('board-view').hidden`, 'board shown');
  await store(`st.setFieldMeta({ db: 'shop', table: 'orders', column: 'region' }, { memberAliases: { EU: 'Europe', APAC: 'Asia <b>' } }); return true;`); // before the widgets draw: a board redraws when shown
  for (const n of ['Revenue by region', 'Share by channel', 'Stock by sku']) await addSheet(n);
  await waitFor(`document.querySelectorAll('.board-widget .ws-chart-canvas svg').length === 3`, 'three widgets drawn');
  await b.sleep(400);

  await check('widgets draw labels; the selection chip names the member by its label; the cross-filter carries the RAW value', async () => {
    const cats = await ev(`(() => { const w = ${W('Revenue by region')}; const i = window.echarts.getInstanceByDom(w.querySelector('.ws-chart-canvas')); return JSON.stringify(i.getOption().xAxis[0].data); })()`);
    must(cats === J(['Asia <b>', 'Europe', 'US']), `categories: ${cats}`);
    const n0 = queries.length;
    await clickBar('Revenue by region', 'Europe');
    await waitFor(`document.getElementById('board-filter').hidden === false`, 'chip');
    await settle();
    must(await chip() === 'Filtering by orders.region = Europe', `chip: ${await chip()}`);
    const q = queries.slice(n0).filter((x) => dimsOf(x) === 'channel');
    must(q.length === 1 && regionFilter(q[0])?.value === 'EU', `the other widget's filter: ${J(q.map((x) => x.filters))}`);
    await shot('chip-labels-light.png');
  });

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
