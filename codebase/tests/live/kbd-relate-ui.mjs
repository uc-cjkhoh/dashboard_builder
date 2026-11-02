// Browser checks for relating two columns from the keyboard (Enter picks a column row, Enter on a row of another table relates them). Real dev app (APP_URL, default
// http://localhost:5221) in headless Chromium over the DevTools protocol (tests/live/cdp.mjs); every /api/* call is mocked.
// Run: node tests/live/kbd-relate-ui.mjs  (start the app: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5221; stop it by port)
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5221';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'kbd-relate-shots');
mkdirSync(SHOTS, { recursive: true });
const LONG = 'order_line_items_with_a_deliberately_extremely_long_table_name_for_the_width_check';
const COLUMNS = {
  orders: [['cust_id', 'Int32', 'numeric'], ['amount', 'Float64', 'numeric'], ['created', 'DateTime', 'temporal'], ['note', 'String', 'text']],
  customers: [['id', 'Int32', 'numeric'], ['name', 'String', 'text']],
  [LONG]: [['id', 'Int32', 'numeric']],
};
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: Object.keys(COLUMNS) };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/query') return { json: { rowDimensions: [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])].map((d) => d.column), columnDimensions: [], measures: (body.measures ?? []).map((_, i) => `v${i}`),
    rows: ['2024-01', '2024-02', '2024-03'].map((k, r) => ({ keys: [k], values: (body.measures ?? []).map(() => 10 * (r + 1)) })), truncated: false } };
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) { try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; } }
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;
let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const shot = async (name) => writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await b.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 3`, 'tables listed');
  for (const t of ['orders', 'customers']) await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'tables loaded');
  const row = (t, c) => `[...document.querySelectorAll('.entity')].find((x) => x.querySelector('.entity__table').textContent === ${J(t)}).querySelector('.col-row[data-column=' + ${J(JSON.stringify(c))} + ']')`;
  const press = (t, c, key) => ev(`(() => { const r = ${row(t, c)}; r.focus(); r.dispatchEvent(new KeyboardEvent('keydown', { key: ${J(key)}, bubbles: true, cancelable: true })); return true; })()`);
  const hint = () => ev(`(() => { const h = document.querySelector('.rel-keyhint'); return h.hidden ? null : h.textContent; })()`);

  await check('rows are focusable buttons with an accessible name', async () => {
    must(await ev(`(() => { const r = ${row('orders', 'cust_id')}; return r.tabIndex === 0 && r.getAttribute('role') === 'button' && /^cust_id, Int32, in orders/.test(r.getAttribute('aria-label')); })()`), 'row not focusable / unlabelled');
  });
  await check('arrow keys move focus between rows of a card', async () => {
    await press('orders', 'cust_id', 'ArrowDown');
    must(await ev(`document.activeElement === ${row('orders', 'amount')}`), 'focus did not move to amount');
  });
  await check('Enter picks a source: marked (outline + word From), pressed, instruction shown', async () => {
    await press('orders', 'cust_id', 'Enter');
    must(await ev(`(() => { const r = ${row('orders', 'cust_id')}; return r.classList.contains('col-row--key-source') && r.getAttribute('aria-pressed') === 'true' && getComputedStyle(r, '::after').content === '"From"'; })()`), 'source not marked');
    must(/Relating orders\.cust_id/.test(await hint()), `hint: ${await hint()}`);
    await shot('kbd-pick.png');
  });
  await check('focusing a refused column explains why (same card), a fitting one says Enter relates', async () => {
    await ev(`${row('orders', 'amount')}.focus()`);
    must(/Can't relate to orders\.amount: /.test(await hint()), `hint: ${await hint()}`);
    await ev(`${row('customers', 'id')}.focus()`);
    must(/Press Enter to relate it to customers\.id/.test(await hint()), `hint: ${await hint()}`);
    await shot('kbd-target.png');
    await ev(`document.documentElement.dataset.theme = 'dark'`); await shot('kbd-target-dark.png'); await ev(`delete document.documentElement.dataset.theme`);
  });
  await check('Escape cancels the pick', async () => {
    await press('customers', 'id', 'Escape');
    must((await hint()) === null && await ev(`document.querySelector('.col-row--key-source') === null`), 'pick not cancelled');
  });
  await check('a refused pair (kind mismatch) opens the type warning, not the cardinality dialog', async () => {
    await press('orders', 'amount', 'Enter');
    await press('customers', 'name', 'Enter');
    await waitFor(`document.querySelector('dialog[open]') !== null`, 'dialog');
    must(await ev(`document.querySelector('dialog[open] .join-choice') === null`), 'cardinality dialog opened for a mismatch');
    await ev(`document.querySelector('dialog[open]').close()`);
    must(await ev(`document.querySelectorAll('.rel-link__line').length === 0`), 'link created for a mismatch');
  });
  await check('Enter on a column of another table opens the same dialog; N:1 draws the link', async () => {
    await press('orders', 'cust_id', 'Enter');
    await press('customers', 'id', 'Enter');
    await waitFor(`document.querySelector('dialog[open] .join-choice') !== null`, 'dialog open');
    await ev(`[...document.querySelectorAll('dialog[open] .card-choice')].find((x) => x.textContent === 'N:1').click()`);
    await waitFor(`document.querySelector('.rel-badge text')?.textContent === 'N:1'`, 'badge');
    must(await ev(`document.querySelectorAll('.entity__keys .col-row').length === 2`), 'both joined rows should be pinned');
    must((await hint()) === null, 'hint left visible');
    await shot('kbd-linked.png');
  });
  await check('relating the same pair again from the keyboard is refused with no dialog', async () => {
    await press('customers', 'id', 'Enter');
    await press('orders', 'cust_id', 'Enter');
    await b.sleep(300);
    must(await ev(`document.querySelector('dialog[open]') === null`), 'dialog opened for a duplicate');
    await press('orders', 'cust_id', 'Escape');
  });
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) { console.log(`FAIL harness: ${e.stack}`); failed++; } finally { if (b) await b.close(); }
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
