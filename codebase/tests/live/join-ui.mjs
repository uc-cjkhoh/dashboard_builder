// Browser checks for the relationship join types (T02-12/13): the real dev app (APP_URL, default http://localhost:5180) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/join-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5180 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5180';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'join-ui-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['cust_id', 'Int32', 'numeric'], ['amount', 'Float64', 'numeric']],
  customers: [['id', 'Int32', 'numeric'], ['name', 'String', 'text']],
};
const queries = [];
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders', 'customers'] };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/query') {
    queries.push(body);
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: [], measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: ['Ann', 'Bo', null].map((k, r) => ({ keys: dims.map(() => k), values: (body.measures ?? []).map(() => 10 * (r + 1)) })), truncated: false } };
  }
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const J = JSON.stringify;

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const settle = async (quiet = 300) => { let n = -1; for (let i = 0; i < 60 && n !== queries.length; i++) { n = queries.length; await b.sleep(quiet); } };
  const shot = async (name) => writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders', 'customers'])
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'both tables loaded');
  const tick = (tbl, col) => ev(`(() => { const e = [...document.querySelectorAll('.entity')].find((x) => x.textContent.includes(${J(tbl)})); e.querySelector('.col-row[data-column=${J(col)}] .col-row__key').click(); return true; })()`);
  const connector = (tbl, col) => ev(`(() => { const e = [...document.querySelectorAll('.entity')].find((x) => x.textContent.includes(${J(tbl)})); e.querySelector('.col-row[data-column=${J(col)}] .rel-connector').click(); return true; })()`);
  await tick('orders', 'cust_id'); await tick('customers', 'id');
  await connector('orders', 'cust_id'); await connector('customers', 'id');
  await waitFor(`document.querySelector('dialog[open] .join-choice') !== null`, 'relationship dialog open');

  await check('dialog offers inner, left, right, full in plain words naming the tables', async () => {
    const labels = await ev(`[...document.querySelectorAll('dialog[open] .join-choice label')].map((l) => l.textContent.trim())`);
    must(J(labels) === J(['Inner — only rows that match', 'Keep all rows of orders', 'Keep all rows of customers', 'Keep all rows of both']), `labels: ${J(labels)}`);
    await shot('join-dialog.png');
  });
  await check('picking "Keep all rows of customers" + N:1 draws a "· right" badge', async () => {
    await ev(`document.querySelector('dialog[open] input[value=right]').click()`);
    await ev(`[...document.querySelectorAll('dialog[open] .card-choice')].find((x) => x.textContent === 'N:1').click()`);
    await waitFor(`document.querySelector('.rel-badge text')?.textContent === 'N:1 · right'`, 'badge');
  });
  await ev(`document.querySelector('.tab-add').click()`);
  await waitFor(`!document.getElementById('dashboard-view').hidden`, 'worksheet open');
  const chipDrag = (name, zone) => ev(`(() => { const c = [...document.querySelectorAll('#ws-fields .ws-field')].find((c) => c.querySelector('.ws-field__name')?.textContent === ${J(name)});
    const t = document.querySelector('.ws-shelf--${zone} .ws-shelf__zone'); const dt = new DataTransfer();
    c.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    t.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); c.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return true; })()`);
  await waitFor(`document.querySelectorAll('#ws-fields .ws-field').length >= 4`, 'fields listed');
  await chipDrag('amount', 'rows'); await chipDrag('name', 'columns');
  await settle(500);
  await check('the request keeps all rows of customers whichever table is the base (sides swap when crossed in reverse)', async () => {
    const q = queries.findLast((x) => x.joins?.length);
    must(q, 'no query with a join: ' + J(queries.at(-1)));
    // The relationship keeps all of customers (TO side). With base customers that reads LEFT JOIN orders; with base orders, RIGHT JOIN customers.
    const preserved = q.joins[0].type === 'left' ? q.from.table : q.joins[0].type === 'right' ? q.joins[0].right.table : null;
    must(preserved === 'customers', `customers not the preserved side: ${J(q.joins)} from ${q.from.table}`);
    console.log('  request joins:', J({ from: q.from.table, joins: q.joins.map((j) => ({ l: j.left.table, r: j.right.table, type: j.type })) }));
  });
  await ev(`document.querySelector('.tab--model .tab__label').click()`);
  await waitFor(`document.getElementById('dashboard-view').hidden`, 'model tab');
  await ev(`document.querySelector('.rel-badge').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await check('editing the link: Full is saved and the request switches to "full"', async () => {
    await waitFor(`document.querySelector('dialog[open] .join-choice') !== null`, 'edit dialog');
    must(await ev(`document.querySelector('dialog[open] input[value=right]').checked`), 'current join not preselected');
    await ev(`document.querySelector('dialog[open] input[value=full]').click()`);
    await ev(`[...document.querySelectorAll('dialog[open] .card-choice')].find((x) => x.textContent === 'N:1').click()`);
    await waitFor(`document.querySelector('.rel-badge text')?.textContent === 'N:1 · full'`, 'badge full');
    queries.length = 0;
    await ev(`document.querySelectorAll('.tab:not(.tab--model) .tab__label')[0].click()`);
    await waitFor(`!document.getElementById('dashboard-view').hidden`, 'worksheet');
    await settle(500);
    const q = queries.findLast((x) => x.joins?.length);
    must(q?.joins[0].type === 'full', `request after edit: ${J(q?.joins)}`);
    await shot('join-full.png');
  });
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
