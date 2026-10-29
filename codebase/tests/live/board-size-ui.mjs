// Browser check for the dashboard size mode: the Size select (Automatic / presets), a fixed board is exactly its box and scrolls inside the
// panel, rows stretch to the height, the size autosaves and survives a reload, print lays out the scaled box, Automatic restores fill.
// Real dev app (APP_URL), every /api/* mocked; any page error fails the run. Screenshots go to SHOTS_DIR.
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5193';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'board-size-shots');
mkdirSync(SHOTS, { recursive: true });
const COLUMNS = { orders: [['amount', 'Float64', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text'], ['status', 'String', 'text'], ['qty_s', 'String', 'text']] };
const VALUES = { qty_s: ['1', '2', '3'], region: ['APAC', 'EU', 'US'], channel: ['web', 'shop', 'app'], status: ['open', 'paid', 'void'] };
const queries = [];
const dimsOf = (q) => [...(q.rowDimensions ?? []), ...(q.columnDimensions ?? [])].map((d) => d.column).join();
const countBy = (col) => queries.filter((q) => dimsOf(q) === col).length;
let slowMs = 0;
async function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders'] };
  if (path === '/api/databases/shop/tables/orders/columns') return { json: COLUMNS.orders.map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/query') {
    queries.push(body);
    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    if (dims.some((d) => d.column === 'status')) return { status: 400, json: { error: 'Query rejected: status is not available.' } };
    if (body.offset !== undefined) { // a table: pages of up to 500 of 1200 rows
      const rd = body.rowDimensions ?? [], total = 1200, n = Math.max(0, Math.min(body.limit ?? 500, total - body.offset));
      return { json: { rowDimensions: rd.map((d) => d.column), columnDimensions: [], measures: (body.measures ?? []).map((_, i) => `v${i}`), total,
        rows: Array.from({ length: n }, (_, r) => ({ keys: rd.map((d) => `${VALUES[d.column]?.[(body.offset + r) % 3] ?? 'x'}-${body.offset + r}`), values: (body.measures ?? []).map(() => body.offset + r) })), truncated: false } };
    }
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: Array.from({ length: dims.length ? 3 : 1 }, (_, r) => ({ keys: dims.map((d) => VALUES[d.column][r]), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })), truncated: false } };
  }
  return null;
}

let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;
const KEY = 'dashboardbuilder.workbook.v2|mock-ch|8443|default';

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); ${code} })()`);
  const shot = (name) => b.screenshot(join(SHOTS, name));
  const connect = async () => {
    await waitFor(`document.readyState === 'complete' && !!document.getElementById('conn-connect')`, 'app loaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  };
  const box = (sel) => ev(`(() => { const r = document.querySelector(${J(sel)}).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), l: r.left, t: r.top }; })()`);
  const pick = (value) => ev(`(() => { const s = document.querySelector('.board-bar__size'); s.value = ${J(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

  await b.goto(APP + '/');
  await connect();
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 1`, 'tables listed');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'orders loaded');
  await store(`
    const f = (column, category, extra = {}) => ({ db: 'shop', table: 'orders', column, category, ...extra });
    const t = st.createWorksheet('Revenue'); t.sheet = { ...st.emptySheet(), chartType: 'bar', columns: [f('region', 'text')], rows: [f('amount', 'numeric', { agg: 'sum' })] };
    const d = st.createDashboard('Overview');
    st.setWidgets(d.id, [{ id: st.nextWidgetId(), kind: 'sheet', sheetId: t.id, x: 0, y: 0, w: 6, h: 3 }, { id: st.nextWidgetId(), kind: 'text', heading: 'Notes', body: 'n', x: 6, y: 0, w: 6, h: 3 }]);
    return true;`);
  await waitFor(`document.querySelectorAll('.board-widget .ws-chart-canvas svg').length === 1`, 'widget drawn');

  await check('Automatic by default: the board fills its panel', async () => {
    must(await ev(`document.querySelector('.board-bar__size').value`) === 'auto', 'select not Automatic');
    must(await ev(`!document.getElementById('board-grid').classList.contains('is-fixed')`), 'is-fixed set');
  });

  await check('a fixed size makes the board exactly that box; rows stretch to the height', async () => {
    await pick('800x600');
    await waitFor(`document.getElementById('board-grid').classList.contains('is-fixed')`, 'fixed class');
    const g = await box('#board-grid');
    must(g.w === 800 && g.h === 600, `grid ${J(g)}`);
    const w = await ev(`[...document.querySelectorAll('.board-widget')].map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.bottom - document.getElementById('board-grid').getBoundingClientRect().top); })`);
    must(w.every((v) => v === 600), `widgets end at the box bottom: ${J(w)}`);
    await b.sleep(300);
    await shot('board-size-fixed-light.png');
  });

  await check('a fixed 1920 x 1080 board scrolls inside the panel; the page does not scroll', async () => {
    await pick('1920x1080');
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().width === 1920`, 'width 1920');
    must(await ev(`(() => { const s = document.getElementById('board-scroll'); return s.scrollWidth > s.clientWidth && s.scrollHeight > s.clientHeight; })()`), 'panel does not scroll');
    must(await ev(`document.documentElement.scrollHeight <= window.innerHeight + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1`), 'page scrolls');
  });

  await check('the size autosaves into workbook v2 and survives a reload', async () => {
    await waitFor(`(() => { const v = localStorage.getItem(${J(KEY)}); return v && JSON.parse(v).dashboards[0].size?.width === 1920; })()`, 'autosaved');
    await b.sleep(700);
    await b.send('Page.reload');
    await connect();
    await waitFor(`document.querySelectorAll('.board-widget').length === 2`, 'widgets restored');
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().width === 1920`, 'fixed after reload');
    must(await ev(`document.querySelector('.board-bar__size').value`) === '1920x1080', 'select value');
  });

  await check('print lays the fixed box out scaled to the page width, widgets in place', async () => {
    await ev(`window.dispatchEvent(new Event('beforeprint'))`);
    await b.sleep(200);
    const g = await box('#board-grid');
    must(g.w === 1000 && g.h === Math.round(1080 * 1000 / 1920), `print grid ${J(g)}`);
    await ev(`window.dispatchEvent(new Event('afterprint'))`);
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().width === 1920`, 'back to fixed');
  });

  await check('Automatic restores the fill layout and drops the saved size', async () => {
    await pick('auto');
    await waitFor(`!document.getElementById('board-grid').classList.contains('is-fixed')`, 'automatic');
    await waitFor(`(() => { const v = JSON.parse(localStorage.getItem(${J(KEY)})); return !('size' in v.dashboards[0]); })()`, 'size dropped from the save');
  });

  await check('screenshot: dark, fixed', async () => {
    await pick('1280x720'); await b.setScheme('dark'); await b.sleep(400);
    await shot('board-size-fixed-dark.png');
    await b.setScheme('light');
  });

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
