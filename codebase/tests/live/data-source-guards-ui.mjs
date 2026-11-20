// Browser checks for the 2026-11-17 Data Source review fixes (D135–D137): Change connection to another server never writes the old
// model over that server's stored workbook (#4); the Edit SQL editor flags a quoted table function as you type (#1, mirrors CustomSql.cs);
// the connect form shows the server's host refusals (#2). Real dev app (APP_URL, default http://localhost:5183) started with
// ClickHouse__AllowedHosts__0=ch.internal; /api/connection POSTs are forwarded to it, every other /api/* call is mocked.
// Run: node tests/live/data-source-guards-ui.mjs
// (app first: cd src/DashboardBuilder && ClickHouse__AllowedHosts__0=ch.internal dotnet run --no-launch-profile --urls http://localhost:5183; stop it by port)
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5183';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'data-source-guards-shots');
mkdirSync(SHOTS, { recursive: true });
const COLUMNS = { orders: [['order_id', 'UInt64', 'numeric'], ['amount', 'Float64', 'numeric']], customers: [['id', 'Int32', 'numeric'], ['name', 'String', 'text']] };
let session = { connected: false };
let forward = false; // phase 3: the real server answers POST /api/connection
async function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: session };
  if (path === '/api/connection' && forward) {
    const r = await fetch(APP + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  }
  if (path === '/api/connection') { session = { connected: true, host: body.host, port: body.port, user: body.user, secure: body.secure, allowInvalidCert: false }; return { json: session }; }
  if (path === '/api/connection/ping') return { json: { connected: true, reachable: true } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: Object.keys(COLUMNS) };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/source/columns') return { json: { columns: COLUMNS.orders.map(([name, type, category]) => ({ name, type, category })), truncated: false, lossy: [] } };
  if (path === '/api/source/syntax') return { json: { syntax: body.sql } };
  if (path === '/api/sql/translate') return { json: { sql: body.sql, warnings: [] } };
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) { try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; } }
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;
const KEY = (host) => `dashboardbuilder.workbook.v2|${host}|8443|ann`;
let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined, width: 1280, height: 800 });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const shot = async (name) => writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const connect = (host) => ev(`(() => { const s = (id, v) => { document.getElementById(id).value = v; }; s('conn-host', ${J(host)}); s('conn-port', '8443'); s('conn-user', 'ann'); s('conn-password', 'pw');
    document.getElementById('conn-form').requestSubmit(); return 1; })()`);
  const pickDb = async () => { await waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, 'databases');
    await ev(`(() => { for (const r of document.querySelectorAll('.db-row[data-db]')) if ((r.dataset.db === 'shop') !== (r.getAttribute('aria-expanded') === 'true')) r.click(); return 1; })()`); await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables'); };
  const add = (t) => ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  const cards = () => ev(`[...document.querySelectorAll('.entity .entity__table')].map((e) => e.textContent).join(',')`);
  const stored = (host) => ev(`(() => { const v = localStorage.getItem(${J(KEY(host))}); return v ? JSON.parse(v).entities.map((e) => e.table).join(',') : '(none)'; })()`);
  const change = async (host) => { await ev(`document.getElementById('conn-change').click()`); await waitFor(`!document.getElementById('conn-form').hidden`, 'form'); await connect(host); };

  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`localStorage.clear(), 1`);

  await check('#4 a model built on server A is saved under A only', async () => {
    await connect('server-a'); await pickDb(); await add('orders');
    await waitFor(`document.querySelectorAll('.entity').length === 1`, 'card'); await b.sleep(900); // autosave is 500 ms after a change
    must(await stored('server-a') === 'orders', `A holds ${await stored('server-a')}`);
    await shot('guards-01-server-a.png');
  });
  await check('#4 Change connection to server B clears A\'s cards, says where they went, and writes nothing under B', async () => {
    await change('server-b');
    await waitFor(`document.querySelectorAll('.entity').length === 0`, 'A cleared');
    await waitFor(`/previous server is saved/.test(document.getElementById('toast')?.textContent ?? '')`, 'toast');
    await b.sleep(900);
    must(await stored('server-b') === '(none)', `B holds ${await stored('server-b')} — A's model leaked into B`);
    must(await stored('server-a') === 'orders', `A now holds ${await stored('server-a')}`);
    await shot('guards-02-switched-to-b.png');
  });
  await check('#4 B gets its own workbook; switching back to A restores A\'s, and neither overwrote the other', async () => {
    await pickDb(); await add('customers');
    await waitFor(`document.querySelectorAll('.entity').length === 1`, 'B card'); await b.sleep(900);
    await change('server-a');
    await waitFor(`[...document.querySelectorAll('.entity .entity__table')].map((e) => e.textContent).join(',') === 'orders'`, 'A restored');
    await b.sleep(900);
    must(await stored('server-b') === 'customers' && await stored('server-a') === 'orders', `A=${await stored('server-a')} B=${await stored('server-b')} cards=${await cards()}`);
    await shot('guards-03-back-to-a.png');
  });

  await check('#1 the Edit SQL editor flags a table function hidden in backticks as you type', async () => {
    await ev(`document.querySelector('.entity__menu').click(), 1`);
    await ev(`[...document.querySelectorAll('[role=menuitem]')].find((i) => /Edit SQL/.test(i.textContent)).click(), 1`);
    await waitFor(`!!document.querySelector('dialog[open] .CodeMirror')`, 'editor');
    await ev(`[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === 'ClickHouse')?.click(), 1`);
    await b.sleep(600);
    await ev(`document.querySelector('dialog[open] .CodeMirror').CodeMirror.setValue("SELECT *\\nFROM \`url\`('http://169.254.169.254/latest/meta-data/', 'LineAsString')"), 1`);
    await waitFor(`!!document.querySelector('dialog[open] .CodeMirror-lint-mark-error, dialog[open] .CodeMirror-lint-mark-warning')`, 'lint mark');
    await ev(`[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === 'Save').click(), 1`);
    await b.sleep(500);
    const text = await ev(`document.querySelector('dialog[open]').innerText`);
    must(/'url' reads outside/.test(text), `dialog says: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
    await shot('guards-04-edit-sql-quoted-url.png');
    await ev(`[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === 'Cancel').click(), 1`); // edited: asks before discarding
    for (let i = 0; i < 2; i++) { await b.sleep(400); await ev(`(() => { const d = [...document.querySelectorAll('dialog[open]')].find((x) => !x.querySelector('.CodeMirror')); d?.querySelector('.btn--danger, .btn--primary')?.click(); return 1; })()`); }
    await waitFor(`!document.querySelector('dialog[open]')`, 'dialogs closed');
  });

  forward = true;
  const refusal = async (host) => { await change(host); await waitFor(`!!document.querySelector('#conn-form .field-error')`, 'field error'); return ev(`document.querySelector('#conn-form .field-error').textContent`); };
  await check('#2 a link-local address is refused on the host field (real server)', async () => {
    const t = await refusal('169.254.169.254'); must(/can't be a ClickHouse server/.test(t), t);
    await shot('guards-05-connect-link-local.png');
  });
  await check('#2 a host outside ClickHouse:AllowedHosts is refused before it is tried (real server)', async () => {
    await ev(`document.getElementById('conn-cancel').hidden || document.getElementById('conn-cancel').click(), 1`);
    const t = await refusal('10.1.2.3'); must(/allowed ClickHouse hosts/.test(t), t);
    await shot('guards-06-connect-not-allowed.png');
  });
} catch (e) { console.log(`FAIL harness: ${e.stack}`); failed++; } finally { if (b) await b.close(); }
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
