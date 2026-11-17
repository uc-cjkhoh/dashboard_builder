// Browser checks for the Data Source's data preview (Canvas/data-preview.js): the first rows of one card in a panel docked under the
// canvas, opened by a card's table button and by saving Edit SQL (D128). The real dev app (APP_URL, default http://localhost:5236) in
// headless Chromium over the DevTools protocol (tests/live/cdp.mjs), every /api/* call mocked.
// Run:  node tests/live/data-preview-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5236 ; stop it with fuser -k 5236/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT, CHROME_BIN.
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5236';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'data-preview-shots');
mkdirSync(SHOTS, { recursive: true });

const COLS = [['id', 'UInt64', 'numeric'], ['region', 'String', 'text'], ['amount', 'Float64', 'numeric']].map(([name, type, category]) => ({ name, type, category }));
const SQL_COLS = [{ name: 'region', type: 'String', category: 'text' }, { name: 'total', type: 'Float64', category: 'numeric' }];
const rowsBodies = [];
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/connection/ping') return { json: { connected: true, reachable: true } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders', 'customers'] };
  if (/^\/api\/databases\/shop\/tables\/\w+\/columns$/.test(path)) return { json: COLS };
  if (path === '/api/source/columns') return { json: { columns: body?.kind === 'union' ? COLS : SQL_COLS, truncated: false, lossy: [] } };
  if (path === '/api/source/syntax') return { json: { syntax: body?.sql ?? '' } };
  if (path === '/api/sql/translate') return { json: { sql: body.sql, warnings: [], changes: [] } };
  if (path === '/api/rows') {
    rowsBodies.push(body);
    if (body.source) return { json: { columns: SQL_COLS.map(({ name, type }) => ({ name, type })), rows: [['North', '120.5'], ['South', null]], truncated: false, limit: body.limit, columnsTruncated: false } };
    return { json: { columns: COLS.map(({ name, type }) => ({ name, type })), rows: Array.from({ length: body.limit }, (_, i) => [String(i + 1), i % 2 ? 'North' : 'South', String(i * 1.5)]), truncated: true, limit: body.limit, columnsTruncated: false } };
  }
  if (path === '/api/union') return { json: { columns: [{ name: 'Source table', type: 'String' }, ...COLS.map(({ name, type }) => ({ name, type }))], rows: [['orders', '1', 'North', '2'], ['customers', '7', 'South', '3']], truncated: false, limit: body.limit, columnsTruncated: false } };
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const shot = async (name) => writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders', 'customers']) await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: '${t}' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'both tables loaded');
  await b.sleep(1000); // entrance animation

  const card = (t) => `[...document.querySelectorAll('.entity')].find((e) => e.querySelector('.entity__table').textContent === '${t}')`;
  const panel = `document.getElementById('ds-preview')`;
  const state = () => ev(`(() => ({ hidden: ${panel}.hidden, title: document.getElementById('ds-preview-title').textContent,
    summary: document.getElementById('ds-preview-summary').textContent, rows: ${panel}.querySelectorAll('.rows-table tbody tr').length,
    ground: document.getElementById('model-view').clientHeight, panelH: ${panel}.getBoundingClientRect().height,
    previewed: [...document.querySelectorAll('.entity--previewed')].map((e) => e.querySelector('.entity__table').textContent),
    pageScroll: document.scrollingElement.scrollHeight - innerHeight }))()`);
  const groundFull = await ev(`document.getElementById('model-view').clientHeight`);

  await check('closed at first; every card has a table button', async () => {
    const s = await state();
    must(s.hidden, 'panel shows before any card is picked');
    must(await ev(`document.querySelectorAll('.entity .entity__peek').length`) === 2, 'table buttons');
  });

  await check('a card\'s table button opens the panel on that card; the ground shrinks above it, the page never scrolls', async () => {
    await ev(`${card('orders')}.querySelector('.entity__peek').click()`);
    await waitFor(`${panel}.querySelectorAll('.rows-table tbody tr').length > 0`, 'rows shown');
    const s = await state();
    must(!s.hidden && s.title === 'shop.orders', JSON.stringify(s));
    must(s.rows === 100 && /First 100 rows/.test(s.summary), s.summary);
    must(Math.abs(s.ground + s.panelH - groundFull) <= 1, `ground ${s.ground} + panel ${s.panelH} vs ${groundFull}`);
    must(s.pageScroll === 0, `page scrolls ${s.pageScroll}`);
    must(s.previewed.join() === 'orders', `outlined ${s.previewed}`);
    must(await ev(`${card('orders')}.querySelector('.entity__peek').getAttribute('aria-pressed')`) === 'true', 'button not pressed');
    must(JSON.stringify(rowsBodies.at(-1)) === JSON.stringify({ db: 'shop', table: 'orders', limit: 100 }), JSON.stringify(rowsBodies.at(-1)));
    await shot('open.png');
  });

  await check('the rows start on the 16px gutter under the title', async () => {
    const x = await ev(`(() => { const t = document.getElementById('ds-preview-title').getBoundingClientRect().left;
      const c = ${panel}.querySelector('.rows-table td'); const r = document.createRange(); r.selectNodeContents(c); return [t, r.getBoundingClientRect().left]; })()`);
    must(Math.abs(x[0] - x[1]) <= 1, `title ${x[0]} vs first cell text ${x[1]}`);
  });

  await check('the same button on another card switches; pressed again it closes and the ground is whole again', async () => {
    await ev(`${card('customers')}.querySelector('.entity__peek').click()`);
    await waitFor(`document.getElementById('ds-preview-title').textContent === 'shop.customers'`, 'switched');
    must((await state()).previewed.join() === 'customers', 'outline did not move');
    await ev(`${card('customers')}.querySelector('.entity__peek').click()`);
    const s = await state();
    must(s.hidden && s.previewed.length === 0 && s.ground === groundFull, JSON.stringify(s));
  });

  await check('saving Edit SQL opens the panel on that card with the query\'s rows (D128)', async () => {
    await ev(`${card('orders')}.querySelector('.entity__edit').click()`);
    await waitFor(`!!document.querySelector('.sql-dialog[open] .CodeMirror') || !!document.querySelector('.sql-dialog[open] textarea')`, 'SQL dialog open');
    await b.sleep(300);
    await ev(`(() => { const q = 'SELECT region, sum(amount) AS total FROM shop.orders GROUP BY region'; const cm = document.querySelector('.sql-dialog[open] .CodeMirror');
      if (cm) cm.CodeMirror.setValue(q); else { const t = document.querySelector('.sql-dialog[open] textarea'); t.value = q; t.dispatchEvent(new Event('input')); } return true; })()`);
    await b.sleep(1200); // the live check settles
    await ev(`[...document.querySelectorAll('.sql-dialog[open] button')].find((x) => x.textContent === 'Save').click()`);
    await waitFor(`!document.querySelector('.sql-dialog[open]') && !${panel}.hidden && ${panel}.querySelectorAll('.rows-table tbody tr').length === 2`, 'panel shows the query rows');
    const s = await state();
    must(s.title === 'shop.orders' && /^Custom SQL · 2 rows/.test(s.summary), JSON.stringify(s));
    must(rowsBodies.at(-1).source?.kind === 'sql' && /GROUP BY region/.test(rowsBodies.at(-1).source.sql), JSON.stringify(rowsBodies.at(-1)));
    must(await ev(`${panel}.querySelector('.rows-table__null')?.textContent`) === 'NULL', 'NULL cell');
    await shot('after-sql.png');
  });

  await check('Reset to default + Save goes back to the table and the panel re-reads it', async () => {
    const before = rowsBodies.length;
    await ev(`${card('orders')}.querySelector('.entity__edit').click()`);
    await waitFor(`!!document.querySelector('.sql-dialog[open]')`, 'SQL dialog open');
    await b.sleep(300);
    const reset = await ev(`(() => { const r = [...document.querySelectorAll('.sql-dialog[open] button')].find((x) => /^Reset/.test(x.textContent)); if (!r) return false; r.click(); return true; })()`);
    must(reset, 'no Reset button');
    await b.sleep(800);
    await ev(`[...document.querySelectorAll('.sql-dialog[open] button')].find((x) => x.textContent === 'Save').click()`);
    await waitFor(`!document.querySelector('.sql-dialog[open]') && ${panel}.querySelectorAll('.rows-table tbody tr').length === 100`, 'table rows again');
    must(rowsBodies.length === before + 1, `${rowsBodies.length - before} row reads, want 1`);
    must(!rowsBodies.at(-1).source, 'still sent a source');
    must(!/Custom SQL/.test((await state()).summary), 'summary still says Custom SQL');
  });

  await check('↑ grows the panel 16px from its top edge; the ground keeps at least 160px', async () => {
    const h0 = (await state()).panelH;
    await ev(`document.getElementById('ds-preview-grip').focus()`);
    await b.key('ArrowUp', { vk: 38 });
    const h1 = (await state()).panelH;
    must(Math.abs(h1 - h0 - 16) <= 1, `${h0} → ${h1}`);
    for (let i = 0; i < 60; i++) await b.key('ArrowUp', { vk: 38 });
    must((await state()).ground >= 160, `ground ${(await state()).ground}`);
  });

  await check('a union card reads /api/union and shows its stacked rows', async () => {
    await ev(`document.dispatchEvent(new CustomEvent('source:add', { detail: { source: { kind: 'union', db: 'shop', name: 'Union: orders + customers', tables: ['orders', 'customers'] } } }))`);
    await waitFor(`!!${card('Union: orders + customers')} && ${card('Union: orders + customers')}.querySelector('.entity__status').hidden`, 'union loaded');
    await ev(`${card('Union: orders + customers')}.querySelector('.entity__peek').click()`);
    await waitFor(`document.getElementById('ds-preview-title').textContent === 'Union: orders + customers' && ${panel}.querySelectorAll('.rows-table tbody tr').length === 2`, 'union rows');
  });

  await check('removing the card it shows closes the panel; another tab hides it', async () => {
    await ev(`${card('orders')}.querySelector('.entity__peek').click()`);
    await waitFor(`document.getElementById('ds-preview-title').textContent === 'shop.orders'`, 'on orders');
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    await b.sleep(400);
    const onSheet = await ev(`${panel}.hidden`);
    await ev(`(() => { const d = [...document.querySelectorAll('#tabs *')].find((x) => x.textContent.trim() === 'Data Source' && x.children.length === 0); (d?.closest('button,[role=tab]') ?? d)?.click(); return !!d; })()`);
    await b.sleep(400);
    must(onSheet, 'shown on a worksheet');
    must(!(await ev(`${panel}.hidden`)), 'not back on the Data Source');
    await ev(`${card('orders')}.querySelector('.iconbtn--danger').click()`);
    await b.sleep(300);
    const s = await state();
    must(s.hidden && s.ground === groundFull, JSON.stringify(s));
  });
} catch (e) {
  console.log(`FAIL setup: ${e.message}`); failed++;
} finally {
  await b?.close();
}
console.log(`\n${passed} passed, ${failed} failed — screenshots in ${SHOTS}`);
process.exit(failed ? 1 : 0);
