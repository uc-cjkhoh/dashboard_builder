// Browser check for per-widget notes: a worksheet widget's Note button + inline form (count, over-limit rejected, Esc cancels), text shown via textContent
// (a <b> stays literal), autosave + reload, the note in the printed header, clearing; light and dark screenshots. Real dev app (APP_URL), /api/* mocked.
// Screenshots go to SHOTS_DIR.
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5245';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'widget-note-shots');
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

  const NOTE = 'Revenue excludes <b>void</b> orders.';
  const btn = `document.querySelector('.board-widget--sheet .board-widget__note-btn')`;
  const field = `document.querySelector('.board-widget__note-form textarea')`;
  const type = (v) => ev(`(() => { const i = ${field}; i.value = ${J(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const submit = () => ev(`document.querySelector('.board-widget__note-form').requestSubmit()`);
  await check('only the worksheet widget has a Note button; no note: area hidden', async () => {
    must(await ev(`document.querySelectorAll('.board-widget__note-btn:not([hidden])').length`) === 1, 'buttons');
    must(await ev(`document.querySelector('.board-widget--sheet .board-widget__note').hidden`), 'shown');
    must(/Add a note/.test(await ev(`${btn}.getAttribute('aria-label')`)), 'label');
  });
  await check('Note opens a labelled form with a count; focus in it', async () => {
    await ev(`${btn}.click()`);
    await waitFor(`!!${field}`, 'form');
    must(await ev(`document.activeElement === ${field}`), 'focus');
    must(await ev(`document.querySelector('.board-widget__note-form .board-text-edit__count').textContent`) === '0 / 300', 'count');
  });
  await check('over 300 is refused in place, nothing cut or saved', async () => {
    await type('x'.repeat(301)); await submit();
    must(/at most 300/.test(await ev(`document.querySelector('.board-widget__note-form .board-text-edit__error').textContent`)), 'no error');
    must(await ev(`${field}.getAttribute('aria-invalid')`) === 'true', 'aria-invalid');
    must(await ev(`${field}.value.length`) === 301, 'cut');
  });
  await check('Esc cancels', async () => {
    await ev(`${field}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`!document.querySelector('.board-widget__note-form') && document.querySelector('.board-widget--sheet .board-widget__note').hidden`, 'closed');
  });
  await check('Save shows the note as plain text under the title', async () => {
    await ev(`${btn}.click()`); await waitFor(`!!${field}`, 'form');
    await type(NOTE); await submit();
    await waitFor(`!!document.querySelector('.board-widget__note-text')`, 'shown');
    must(await ev(`document.querySelector('.board-widget__note-text').textContent`) === NOTE, 'text');
    must(await ev(`document.querySelector('.board-widget__note-text b') === null`), 'html parsed');
    must(/Edit the note/.test(await ev(`${btn}.getAttribute('aria-label')`)), 'label');
    await waitFor(`document.querySelectorAll('.board-widget .ws-chart-canvas svg').length === 1`, 'chart still drawn');
    await b.sleep(300); await shot('widget-note-light.png');
  });
  await check('autosaves into the workbook and survives a reload', async () => {
    await waitFor(`(() => { const v = localStorage.getItem(${J(KEY)}); return v && JSON.parse(v).dashboards[0].widgets[0].note === ${J(NOTE)}; })()`, 'autosaved');
    await b.sleep(700);
    await b.send('Page.reload'); await connect();
    await waitFor(`document.querySelector('.board-widget__note-text')?.textContent === ${J(NOTE)}`, 'after reload');
  });
  await check('print header lists the note on the worksheet; the on-widget note is hidden in print', async () => {
    await b.send('Emulation.setEmulatedMedia', { media: 'print' });
    await ev(`window.dispatchEvent(new Event('beforeprint'))`);
    await b.sleep(300);
    const lines = await ev(`[...document.querySelectorAll('.ws-print-head p')].map((p) => p.textContent)`);
    must(lines.includes('Note on Revenue: ' + NOTE), `lines ${J(lines)}`);
    must(await ev(`getComputedStyle(document.querySelector('.board-widget__note-text')).display === 'none' || getComputedStyle(document.querySelector('.board-widget__note')).display === 'none'`), 'shown in print');
    await ev(`window.dispatchEvent(new Event('afterprint'))`);
    await b.send('Emulation.setEmulatedMedia', { media: '' });
  });
  await check('clearing removes the note from the save', async () => {
    await ev(`${btn}.click()`); await waitFor(`!!${field}`, 'form');
    await type('  '); await submit();
    await waitFor(`document.querySelector('.board-widget--sheet .board-widget__note').hidden`, 'hidden');
    await waitFor(`!('note' in JSON.parse(localStorage.getItem(${J(KEY)})).dashboards[0].widgets[0])`, 'dropped');
  });
  await check('screenshot: dark, form open', async () => {
    await ev(`${btn}.click()`); await waitFor(`!!${field}`, 'form'); await type(NOTE);
    await b.setScheme('dark'); await b.sleep(400); await shot('widget-note-dark.png');
  });
  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
