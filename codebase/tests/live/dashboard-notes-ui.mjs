// Browser check for dashboard data notes: Notes button + editor (count, over-limit rejected, Esc cancels), text shown via textContent (a <b> stays literal),
// autosave + reload, print header (title, worksheets, filter, printed time, notes), light and dark screenshots. Real dev app (APP_URL), /api/* mocked.
// Screenshots go to SHOTS_DIR.
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5240';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'board-notes-shots');
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
    await waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, 'databases listed');
  };
  const box = (sel) => ev(`(() => { const r = document.querySelector(${J(sel)}).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), l: r.left, t: r.top }; })()`);
  const pick = (value) => ev(`(() => { const s = document.querySelector('.board-bar__size'); s.value = ${J(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

  await b.goto(APP + '/');
  await connect();
  await ev(`(() => { for (const r of document.querySelectorAll('.db-row[data-db]')) if ((r.dataset.db === 'shop') !== (r.getAttribute('aria-expanded') === 'true')) r.click(); return true; })()`);
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

  const open = () => ev(`[...document.querySelectorAll('.board-bar__btn')].find((x) => x.textContent === 'Notes').click()`);
  const field = () => `document.querySelector('.board-notes__input')`;
  const type = (v) => ev(`(() => { const i = ${field()}; i.value = ${J(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const submit = () => ev(`document.querySelector('.board-notes__form').requestSubmit()`);

  await check('no notes: the notes area is hidden', async () => {
    must(await ev(`document.getElementById('board-notes').hidden`), 'shown');
  });
  await check('Notes opens a labelled editor with a count; focus is in it', async () => {
    await open();
    await waitFor(`!!${field()}`, 'editor');
    must(await ev(`document.activeElement === ${field()}`), 'not focused');
    must(await ev(`document.querySelector('.board-notes__meta span').textContent`) === '0 / 1000', 'count');
    must(await ev(`document.querySelector('.board-notes__label').htmlFor === ${field()}.id`), 'label');
  });
  await check('over the limit is rejected in place (alert + aria-invalid), nothing saved or cut', async () => {
    await type('x'.repeat(1001));
    await submit();
    must(/at most 1000/.test(await ev(`document.querySelector('.board-notes__error').textContent`)), 'no error');
    must(await ev(`${field()}.getAttribute('aria-invalid')`) === 'true', 'aria-invalid');
    must(await ev(`${field()}.value.length`) === 1001, 'value was cut');
    must(await ev(`!JSON.parse(localStorage.getItem(${J(KEY)}) ?? '{"dashboards":[{}]}').dashboards[0].notes`), 'saved');
  });
  await check('Esc cancels and keeps the old (empty) note', async () => {
    await ev(`${field()}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`!document.querySelector('.board-notes__form') && document.getElementById('board-notes').hidden`, 'closed');
  });
  const NOTE = 'Source: orders table.\nExcludes <b>void</b> orders.';
  await check('Save stores the note; it shows as plain text (no HTML parsed), multi-line', async () => {
    await open(); await waitFor(`!!${field()}`, 'editor');
    await type(NOTE); await submit();
    await waitFor(`!document.getElementById('board-notes').hidden && !!document.querySelector('.board-notes__text')`, 'note shown');
    must(await ev(`document.querySelector('.board-notes__text').textContent`) === NOTE, 'text differs');
    must(await ev(`document.querySelector('.board-notes__text b') === null`), 'HTML was parsed');
    must(/saved/.test(await ev(`document.getElementById('board-status').textContent`)), 'status');
    await b.sleep(300);
    await shot('board-notes-light.png');
  });
  await check('the note autosaves into the workbook and survives a reload', async () => {
    await waitFor(`(() => { const v = localStorage.getItem(${J(KEY)}); return v && JSON.parse(v).dashboards[0].notes === ${J(NOTE)}; })()`, 'autosaved');
    await b.sleep(700);
    await b.send('Page.reload');
    await connect();
    await waitFor(`document.querySelectorAll('.board-widget').length === 2`, 'widgets restored');
    await waitFor(`document.querySelector('.board-notes__text')?.textContent === ${J(NOTE)}`, 'note after reload');
  });
  await check('print header: title, worksheets, printed time, notes; screen notes and bar title hidden under print media', async () => {
    await b.send('Emulation.setEmulatedMedia', { media: 'print' });
    await ev(`window.dispatchEvent(new Event('beforeprint'))`);
    await b.sleep(300);
    const head = await ev(`(() => { const h = document.querySelector('.ws-print-head'); return h ? { t: h.querySelector('h1').textContent, lines: [...h.querySelectorAll('p')].map((p) => p.textContent), disp: getComputedStyle(h).display } : null; })()`);
    must(head && head.t === 'Overview', `head ${J(head)}`);
    must(head.disp === 'block', 'head not displayed in print');
    must(head.lines[0] === 'Worksheets: Revenue', `lines ${J(head.lines)}`);
    must(head.lines.some((l) => /^Printed /.test(l)), 'printed time');
    must(head.lines.includes(NOTE), 'notes line');
    must(await ev(`getComputedStyle(document.getElementById('board-notes')).display === 'none'`), 'screen notes shown in print');
    await ev(`window.dispatchEvent(new Event('afterprint'))`);
    await b.send('Emulation.setEmulatedMedia', { media: '' });
    must(await ev(`!document.querySelector('.ws-print-head')`), 'head not removed');
  });
  await check('clearing the note hides the area and drops notes from the save', async () => {
    await open(); await waitFor(`!!${field()}`, 'editor');
    await type('   '); await submit();
    await waitFor(`document.getElementById('board-notes').hidden`, 'hidden');
    await waitFor(`!('notes' in JSON.parse(localStorage.getItem(${J(KEY)})).dashboards[0])`, 'dropped from save');
  });
  await check('screenshot: dark, editor open with a note', async () => {
    await open(); await waitFor(`!!${field()}`, 'editor'); await type(NOTE);
    await b.setScheme('dark'); await b.sleep(400);
    await shot('board-notes-dark.png');
  });
  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
