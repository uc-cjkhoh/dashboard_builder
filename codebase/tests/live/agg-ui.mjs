// Browser checks for aggregate-before-join on a relationship (P43): the dialog's Totals choice, the request it makes, the saved state: the real dev app (APP_URL, default http://localhost:5231) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/agg-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5231 ; stop it with fuser -k 5231/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5231';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'agg-ui-shots');
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
  const dragRow = (fromT, fromC, toT, toC) => ev(`(() => { const row = (t, c) => [...document.querySelectorAll('.entity')].find((x) => x.textContent.includes(t)).querySelector('.col-row[data-column=' + JSON.stringify(c) + ']');
    const a = row(${J(fromT)}, ${J(fromC)}), z = row(${J(toT)}, ${J(toC)}); const dt = new DataTransfer();
    a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); z.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    z.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return true; })()`);
  await dragRow('orders', 'cust_id', 'customers', 'id'); // relationships are made by dragging one column onto another
  await waitFor(`document.querySelector('dialog[open] .join-choice') !== null`, 'relationship dialog open');

  const dlg = `document.querySelector('dialog[open]')`;
  await check('the dialog offers "Total each table by the key", with the filter choice hidden until it is ticked', async () => {
    must(await ev(`!!${dlg}.querySelector('.join-aggregate input[type=checkbox]')`), 'no checkbox');
    must(!(await ev(`${dlg}.querySelector('.join-aggregate input[type=checkbox]').checked`)), 'should start off');
    must(await ev(`${dlg}.querySelector('.join-aggregate__dir').hidden`), 'direction should be hidden');
  });
  await check('ticking it shows both filter choices, "either table" selected', async () => {
    await ev(`${dlg}.querySelector('.join-aggregate input[type=checkbox]').click()`);
    must(await ev(`!${dlg}.querySelector('.join-aggregate__dir').hidden`), 'direction should show');
    const l = await ev(`[...${dlg}.querySelectorAll('.join-aggregate__dir label')].map((x) => x.textContent.trim())`);
    must(J(l) === J(['A filter on either table also limits the other', 'A filter changes only its own table']), `labels: ${J(l)}`);
    must(await ev(`${dlg}.querySelector('input[value=both]').checked`), 'both should be selected');
    await shot('agg-dialog.png');
    await ev(`document.documentElement.dataset.scheme = 'dark'`); await b.sleep(500); await shot('agg-dialog-dark.png'); await ev(`delete document.documentElement.dataset.scheme`);
  });
  await check('single + N:M saves; the Relationships card says totals are not repeated', async () => {
    await ev(`${dlg}.querySelector('input[value=single]').click()`);
    await ev(`[...${dlg}.querySelectorAll('.card-choice')].find((x) => x.textContent === 'N:M').click(); ${dlg}.querySelector('.rel-dialog__foot .btn--primary').click()`);
    await waitFor(`document.querySelector('.rel-badge text')?.textContent === 'N:M'`, 'badge');
    const t = await ev(`document.querySelector('.rel-notes').textContent`);
    must(/added up by this match first/.test(t) && /does not change the other/.test(t), `card: ${t}`);
    must(!/counted more than once/.test(t), 'the fan-out warning should go');
    await shot('agg-linked.png');
  });
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  const chipDrag = (name, zone) => ev(`(() => { const c = [...document.querySelectorAll('#ws-fields .ws-field')].find((c) => c.querySelector('.ws-field__name')?.textContent === ${J(name)});
    const t = document.querySelector('.ws-shelf--${zone} .ws-shelf__zone'); const dt = new DataTransfer();
    c.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    t.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); c.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return true; })()`);
  await waitFor(`document.querySelectorAll('#ws-fields .ws-field').length >= 4`, 'fields listed');
  await chipDrag('amount', 'rows'); await chipDrag('name', 'columns');
  await settle(500);
  await check('the worksheet request marks the join: aggregate, single-way filters', async () => {
    const q = queries.findLast((x) => x.joins?.length);
    must(q, 'no query with a join');
    must(q.joins[0].aggregate === true && q.joins[0].filterDirection === 'single', `joins: ${J(q.joins)}`);
  });
  await ev(`document.querySelector('.tab--model .tab__label').click()`);
  await waitFor(`document.getElementById('worksheet-view').hidden`, 'model tab');
  await ev(`document.querySelector('.rel-badge').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await check('editing shows the saved choice; unticking it sends the plain join again', async () => {
    await waitFor(`document.querySelector('dialog[open] .join-aggregate') !== null`, 'edit dialog');
    must(await ev(`${dlg}.querySelector('.join-aggregate input[type=checkbox]').checked`), 'flag not preselected');
    must(await ev(`${dlg}.querySelector('input[value=single]').checked`), 'single not preselected');
    await ev(`${dlg}.querySelector('.join-aggregate input[type=checkbox]').click()`);
    await ev(`[...${dlg}.querySelectorAll('.card-choice')].find((x) => x.textContent === 'N:M').click(); ${dlg}.querySelector('.rel-dialog__foot .btn--primary').click()`);
    await waitFor(`!document.querySelector('.rel-notes').textContent.includes('added up by this match')`, 'card updated');
    queries.length = 0;
    await ev(`document.querySelectorAll('.tab:not(.tab--model) .tab__label')[0].click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet');
    await settle(500);
    const q = queries.findLast((x) => x.joins?.length);
    must(q && !('aggregate' in q.joins[0]) && !('filterDirection' in q.joins[0]), `request after edit: ${J(q?.joins)}`);
  });
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
