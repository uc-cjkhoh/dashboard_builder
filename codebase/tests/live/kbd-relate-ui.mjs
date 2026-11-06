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
  orders: [['cust_id', 'Int32', 'numeric'], ['amount', 'Float64', 'numeric'], ['created', 'DateTime', 'temporal'], ['note', 'String', 'text'], ['region', 'String', 'text']],
  customers: [['id', 'Int32', 'numeric'], ['name', 'String', 'text'], ['Region', 'String', 'text']],
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
  const hint = () => ev(`document.querySelector('.rel-keyhint').textContent`);

  const card = (t) => `[...document.querySelectorAll('.entity')].find((x) => x.querySelector('.entity__table').textContent === ${J(t)})`;
  const stops = (t) => ev(`[...${card(t)}.querySelectorAll('.col-row')].filter((r) => r.tabIndex === 0).length`);
  await check('roving tabindex: one tab stop per card; rows are named groups (not buttons) and Profile stays a reachable button', async () => {
    must((await stops('orders')) === 1 && (await stops('customers')) === 1, 'not exactly one tab stop per card');
    must(await ev(`(() => { const r = ${row('orders', 'cust_id')}; return r.getAttribute('role') === 'group' && /^cust_id, Int32, in orders$/.test(r.getAttribute('aria-label')) && !!document.getElementById(r.getAttribute('aria-describedby')) && r.querySelector('button.col-row__profile').tabIndex === 0; })()`), 'row not a labelled group / profile not reachable');
    must(await ev(`(() => { const h = document.querySelector('.rel-keyhint'); return h.getAttribute('role') === 'status' && !h.hidden && h.textContent === ''; })()`), 'status node not always rendered and empty');
  });
  await check('arrows, Home, End move within a card; the tab stop follows focus', async () => {
    await press('orders', 'cust_id', 'ArrowDown');
    must(await ev(`document.activeElement === ${row('orders', 'amount')}`), 'focus did not move to amount');
    await press('orders', 'amount', 'End');
    must(await ev(`document.activeElement === ${row('orders', 'region')}`), 'End');
    await press('orders', 'region', 'Home');
    must(await ev(`document.activeElement === ${row('orders', 'cust_id')}`), 'Home');
    await press('orders', 'region', 'End');
    must((await stops('orders')) === 1 && await ev(`${row('orders', 'region')}.tabIndex === 0`), 'tab stop did not follow focus');
    await press('orders', 'region', 'Home');
  });
  await check('] and [ jump between cards, landing on each card\'s tab stop', async () => {
    await press('orders', 'cust_id', ']');
    must(await ev(`${card('customers')}.contains(document.activeElement)`), '] did not reach customers');
    await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true }))`);
    must(await ev(`document.activeElement === ${row('orders', 'cust_id')}`), '[ did not return to orders (tab stop is cust_id)');
  });
  await check('Enter picks a source: marked (outline + word From), pressed, instruction shown', async () => {
    await press('orders', 'cust_id', 'Enter');
    must(await ev(`(() => { const r = ${row('orders', 'cust_id')}; return r.classList.contains('col-row--key-source') && getComputedStyle(r, '::after').content === '"From"'; })()`), 'source not marked');
    must(/Relating orders\.cust_id.*\[ and \]/.test(await hint()), `hint: ${await hint()}`);
    must(await ev(`${row('orders', 'cust_id')}.getAttribute('aria-current') === 'true'`), 'aria-current missing');
    await shot('kbd-pick.png');
  });
  await check('focusing a refused column explains why (same card), a fitting one says Enter relates', async () => {
    await ev(`${row('orders', 'amount')}.focus()`);
    must(/^Can't relate to orders\.amount: /.test(await hint()), `hint: ${await hint()}`);
    await ev(`${row('customers', 'id')}.focus()`);
    must(/Press Enter to relate it to customers\.id/.test(await hint()), `hint: ${await hint()}`);
    await shot('kbd-target.png');
    await ev(`document.documentElement.dataset.scheme = 'dark'`); await b.sleep(600); await shot('kbd-target-dark.png'); await ev(`delete document.documentElement.dataset.scheme`);
  });
  await check('Escape cancels the pick', async () => {
    await press('customers', 'id', 'Escape');
    must((await hint()) === '' && await ev(`document.querySelector('.col-row--key-source') === null`), 'pick not cancelled');
  });
  await check('moving focus out of the rows (toolbar) drops a pending pick; Esc then does nothing harmful', async () => {
    await press('orders', 'cust_id', 'Enter');
    must((await hint()) !== '', 'pick not made');
    await ev(`document.getElementById('db-select').focus()`);
    must((await hint()) === '' && await ev(`document.querySelector('.col-row--key-source') === null`), 'pick survived focus loss');
  });
  await check('Esc pressed on the page (not on a row) cancels a pick', async () => {
    await press('orders', 'cust_id', 'Enter');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    must((await hint()) === '', 'document-level Esc did not cancel');
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
    await ev(`[...document.querySelectorAll('dialog[open] .card-choice')].find((x) => x.textContent === 'N:1').click(); document.querySelector('dialog[open]').querySelector('.rel-dialog__foot .btn--primary').click()`);
    await waitFor(`document.querySelector('.rel-badge text')?.textContent === 'N:1'`, 'badge');
    must(await ev(`document.querySelectorAll('.entity__keys .col-row').length === 2`), 'both joined rows should be pinned');
    must((await hint()) === '', 'hint left set');
    must(await ev(`document.activeElement === ${row('customers', 'id')} && document.activeElement.closest('.entity__keys') !== null`), 'focus not on the linked row after linking');
    must((await stops('customers')) === 1, 'tab stop count after linking');
    await shot('kbd-linked.png');
  });
  await check('relating the same pair again from the keyboard is refused with no dialog', async () => {
    await press('customers', 'id', 'Enter');
    await press('orders', 'cust_id', 'Enter');
    await b.sleep(300);
    must(await ev(`document.querySelector('dialog[open]') === null`), 'dialog opened for a duplicate');
    await press('orders', 'cust_id', 'Escape');
  });
  const sug = () => ev(`[...document.querySelectorAll('.col-row--suggest')].map((r) => r.closest('.entity').querySelector('.entity__table').textContent + '.' + r.dataset.column)`);
  await check('picking a column flags the best-matching column of the other table (word Match + dotted outline + label); Escape clears it', async () => {
    await press('orders', 'region', 'Enter');
    must(J(await sug()) === J(['customers.Region']), 'suggestion: ' + J(await sug()));
    must(await ev(`(() => { const r = ${row('customers', 'Region')}; return /suggested match$/.test(r.getAttribute('aria-label')) && getComputedStyle(r, '::after').content === '"Match"'; })()`), 'label / word missing');
    await shot('kbd-suggest.png');
    await ev(`document.documentElement.dataset.scheme = 'dark'`); await b.sleep(300); await shot('kbd-suggest-dark.png');
    await ev(`document.documentElement.dataset.scheme = 'light'`);
    await press('orders', 'region', 'Escape');
    must((await sug()).length === 0, 'suggestion not cleared');
  });
  await check('a column with no same-name partner flags nothing; Enter on the suggested row still relates via the usual dialog', async () => {
    await press('orders', 'note', 'Enter');
    must((await sug()).length === 0, 'unexpected suggestion');
    await press('orders', 'note', 'Escape');
    await press('orders', 'region', 'Enter');
    await press('customers', 'Region', 'Enter');
    await waitFor(`document.querySelector('dialog[open]') !== null`, 'cardinality dialog');
    await ev(`document.querySelector('dialog[open]').close()`);
  });
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) { console.log(`FAIL harness: ${e.stack}`); failed++; } finally { if (b) await b.close(); }
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
