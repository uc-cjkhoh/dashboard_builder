// Browser check for the four reads a custom SQL card now supports (D105 follow-up) and the key-kind guard of Edit SQL:
// View data, the column profile, the histogram and "Check this join" all send the card's query as `source`; a new query that changes
// the kind of a relationship's key column is refused, naming the column and both kinds. Real dev app (APP_URL, default
// http://localhost:5194) in headless Chromium, every /api/* call mocked. Run:  node tests/live/card-gaps-ui.mjs
// (start the app first: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5194 ; stop it by port).
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5194';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'card-gaps-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['cust_id', 'Int32', 'numeric'], ['amount', 'Float64', 'numeric']],
  customers: [['id', 'Int32', 'numeric'], ['name', 'String', 'text']],
};
const SQL = 'SELECT cust_id, amount, extra FROM shop.orders WHERE amount > 0';
const calls = { rows: [], profile: [], histogram: [], preview: [], queries: [] };
const side = (o) => ({ rows: 1000, nullRows: 0, keys: 1000, matchedKeys: 1000, matchedRows: 1000, maxDuplicates: 1, avgDuplicates: 1, ...o });
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders', 'customers'] };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/sql/translate') return { json: { sql: body.sql, warnings: [], changes: [] } }; // the translator itself is covered elsewhere
  if (path === '/api/source/syntax') return { json: { syntax: body.sql.replace(/\s+/g, ' ').trim() } };
  if (path === '/api/source/columns') {
    if (/CAST/.test(body.sql)) return { json: { columns: [{ name: 'cust_id', type: 'String', category: 'text' }, { name: 'amount', type: 'Float64', category: 'numeric' }], truncated: false, lossy: [] } };
    return { json: { columns: [{ name: 'cust_id', type: 'Int32', category: 'numeric' }, { name: 'amount', type: 'Float64', category: 'numeric' }, { name: 'extra', type: 'String', category: 'text' }], truncated: false, lossy: [] } };
  }
  if (path === '/api/rows') {
    calls.rows.push(body);
    return { json: { columns: [{ name: 'cust_id', type: 'Int32' }, { name: 'amount', type: 'Float64' }, { name: 'extra', type: 'String' }], rows: [['1', '10.5', 'a'], ['2', '20', 'b']], truncated: false, limit: 100, columnsTruncated: false } };
  }
  if (path === '/api/databases/shop/tables/orders/profile') {
    calls.profile.push(body);
    return { json: { column: body.column, type: 'Float64', category: 'numeric', rows: 6, nulls: 0, distinct: 4, min: '5', max: '20', sampled: false, sampleLimit: 1000000,
      top: [{ value: '5', count: 2, cut: false }, { value: '7', count: 2, cut: false }] } };
  }
  if (path === '/api/databases/shop/tables/orders/histogram') {
    calls.histogram.push(body);
    return { json: { bins: [{ x0: 0, x1: 10, count: 4 }, { x0: 10, x1: 20, count: 2 }], whole: false } };
  }
  if (path === '/api/relationships/preview') {
    calls.preview.push(body);
    return { json: { from: side({ keys: 200, matchedKeys: 190, matchedRows: 940, maxDuplicates: 14, avgDuplicates: 5 }), to: side({ rows: 200, keys: 200, matchedKeys: 190, matchedRows: 190 }), sampleLimit: 1000000, sampled: false } };
  }
  if (path === '/api/query') {
    calls.queries.push(body);
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: [], measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: ['Ann', 'Bo'].map((k, r) => ({ keys: dims.map(() => k), values: (body.measures ?? []).map(() => 10 * (r + 1)) })), truncated: false } };
  }
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const J = JSON.stringify;
const wire = { kind: 'sql', db: 'shop', name: 'orders', sql: SQL };

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const shot = async (name) => writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const settle = async (quiet = 300) => { let n = -1; for (let i = 0; i < 60 && n !== calls.queries.length; i++) { n = calls.queries.length; await b.sleep(quiet); } };

  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders', 'customers'])
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'both tables loaded');
  const dragRow = (fromT, fromC, toT, toC) => ev(`(() => { const row = (t, c) => [...document.querySelectorAll('.entity')].find((x) => x.textContent.includes(t)).querySelector('.col-row[data-column=' + JSON.stringify(c) + ']');
    const a = row(${J(fromT)}, ${J(fromC)}), z = row(${J(toT)}, ${J(toC)}); const dt = new DataTransfer();
    a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); z.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    z.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return true; })()`);
  await dragRow('orders', 'cust_id', 'customers', 'id');
  await waitFor(`document.querySelector('dialog[open] .join-choice') !== null`, 'relationship dialog open');
  await ev(`document.querySelector('dialog[open] .rel-dialog__foot .btn--primary').click()`);
  await waitFor(`document.querySelectorAll('.rel-badge').length === 1`, 'relationship drawn');

  const card = (t) => `([...document.querySelectorAll('.entity')].find((x) => x.querySelector('.entity__table').textContent === '${t}'))`;
  const cols = (t) => ev(`[...${card(t)}.querySelectorAll('.col-row')].map((r) => r.dataset.column)`);
  const cmOf = `document.querySelector('dialog[open] .CodeMirror').CodeMirror`;
  const setSql = (v) => ev(`(() => { ${cmOf}.setValue(${J(v)}); return true; })()`);
  const press = (label) => ev(`[...document.querySelectorAll('dialog[open] .dialog__foot .btn')].find((b) => b.textContent.trim() === ${J(label)}).click()`);
  const statusText = () => ev(`document.querySelector('dialog[open] .sql-dialog__status')?.textContent.trim() ?? ''`);
  const act = (c, label) => `(() => { ${c}.querySelector('.entity__menu').click(); const it = [...document.querySelectorAll('.ctx-menu [role^="menuitem"]')].find((x) => x.textContent.trim() === '${label}'); if (!it) throw new Error('no menu item ${label}'); it.click(); return true; })()`; // the card's ☰ menu (D129)
  const openEdit = async (t) => { await ev(act(card(t), 'Edit SQL')); await waitFor(`!!document.querySelector('dialog[open] .CodeMirror')`, 'dialog'); };
  const text = (sel) => ev(`document.querySelector(${J(sel)})?.textContent ?? ''`);
  const closeDialog = async () => { await b.key('Escape', { vk: 27 }); await waitFor(`!document.querySelector('dialog[open]')`, 'dialog closed'); };

  await check('a new query that changes a key column from a number to text is refused, naming the column and both kinds', async () => {
    await openEdit('orders');
    await setSql('SELECT CAST(cust_id AS String) AS cust_id, amount FROM shop.orders'); await press('Save');
    await waitFor(`/same kind/.test(document.querySelector('dialog[open] .sql-dialog__status')?.textContent ?? '')`, 'kind error');
    const t = await statusText();
    must(/“cust_id”/.test(t) && /customers\.id \(number\)/.test(t) && /make it text/.test(t), `error: ${t}`);
    must(J(await cols('orders')) === J(['cust_id', 'amount']), 'the card changed');
    must(!(await ev(`${card('orders')}.classList.contains('entity--sql')`)), 'the card was marked');
    await shot('card-gaps-kind-refused.png');
  });
  await check('a query that keeps every key kind is saved', async () => {
    await setSql(SQL); await press('Save');
    await waitFor(`!document.querySelector('dialog[open]')`, 'dialog closed');
    await waitFor(`${card('orders')}.classList.contains('entity--sql')`, 'card marked');
    must(J(await cols('orders')) === J(['cust_id', 'amount', 'extra']), `columns: ${J(await cols('orders'))}`);
  });

  await check('a custom SQL card shows the profile button on every column and the dialog sends the query as `source`', async () => {
    must(await ev(`${card('orders')}.querySelectorAll('.col-row__profile').length === 3`), 'profile buttons missing');
    await ev(`${card('orders')}.querySelector('.col-row[data-column=amount] .col-row__profile').click()`);
    await waitFor(`document.querySelector('dialog[open] .col-profile__cell--top') !== null`, 'profile loaded');
    must(J(calls.profile.at(-1)) === J({ column: 'amount', limit: 10, source: wire }), `request: ${J(calls.profile.at(-1))}`);
    must(/amount/.test(await text('dialog[open] .col-profile__title')), 'title');
    await shot('card-gaps-profile.png');
    await closeDialog();
  });

  await check('The relationship suggestion sends the SQL end as `from.source` and a plain table end without one, and shows the reading', async () => {
    await ev(`document.querySelector('.rel-badge').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await waitFor(`document.querySelector('dialog[open] .join-check') !== null`, 'dialog with the check');
    await waitFor(`/have a match in customers/.test(document.querySelector('dialog[open] .join-check__out')?.textContent ?? '')`, 'result');
    must(J(calls.preview.at(-1)) === J({ from: { db: 'shop', table: 'orders', column: 'cust_id', source: wire }, to: { db: 'shop', table: 'customers', column: 'id' } }), `request: ${J(calls.preview.at(-1))}`);
    must(!/custom SQL yet/.test(await text('dialog[open] .join-check__out')), 'the old refusal');
    await shot('card-gaps-join-check.png');
    await closeDialog();
  });

  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet');
  await waitFor(`[...document.querySelectorAll('#ws-fields .ws-field__name')].some((n) => n.textContent === 'extra')`, 'query column listed');
  const dragField = (name, zone) => ev(`(() => { const c = [...document.querySelectorAll('#ws-fields .ws-field')].find((c) => c.querySelector('.ws-field__name')?.textContent === ${J(name)});
    const t = document.querySelector('.ws-shelf--${zone} .ws-shelf__zone'); const dt = new DataTransfer();
    c.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    t.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); c.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return true; })()`);
  const pickType = async (label) => {
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === ${J(label)}).click()`);
  };

  await check('View data over a custom SQL card opens and sends the query as `source`', async () => {
    await dragField('extra', 'rows'); await dragField('amount', 'columns');
    await settle(500);
    await ev(`(() => { document.querySelector('.ws-export .iconbtn').click(); [...document.querySelectorAll('.ws-export .menu__item')].find((m) => m.textContent.trim() === 'View data').click(); return true; })()`);
    await waitFor(`document.querySelector('dialog.rows-dialog[open] tbody tr') !== null`, 'rows dialog with rows');
    const q = calls.rows.at(-1);
    must(q.db === 'shop' && q.table === 'orders' && J(q.source) === J(wire), `request: ${J(q)}`);
    must((await ev(`document.querySelectorAll('dialog.rows-dialog[open] tbody tr').length`)) === 2, 'rows');
    must(!(await ev(`!document.getElementById('toast').hidden && /custom SQL/.test(document.getElementById('toast').textContent)`)), 'the old refusal toast');
    await shot('card-gaps-view-data.png');
    await closeDialog();
  });

  await check('a histogram over a custom SQL card plans: the request carries `source` and the chart draws', async () => {
    await pickType('Histogram');
    await waitFor(`document.querySelector('#ws-chart canvas, #ws-chart svg') !== null`, 'histogram drawn');
    for (let i = 0; i < 40 && !calls.histogram.length; i++) await b.sleep(50);
    const h = calls.histogram.at(-1);
    must(h && h.column === 'amount' && J(h.source) === J(wire), `request: ${J(h)}`);
    must(!/custom SQL yet/.test(await ev(`document.getElementById('ws-chart').textContent`)), 'the old refusal hint');
    await shot('card-gaps-histogram.png');
  });

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log('ERROR: ' + e.message); failed++;
} finally {
  await b?.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
