// Browser check: a workbook whose pill names a column the table lacks (import). Mocked /api.
// Original header of tabs-ui.mjs follows.
// Browser checks for the two tab kinds (P24b stage 1): the [+] menu, worksheet / dashboard tabs, the empty board body,
// closing a worksheet used by a dashboard, workbook format v2 (export, autosave, v1 file + v1 autosave open with zero issues),
// and the 50-tab limit. The real dev app (APP_URL, default http://localhost:5193) in headless Chromium; every /api/* call is
// mocked. Any page error fails the run (cdp.mjs). Screenshots (light + dark) go to SHOTS_DIR.
import { launch } from './cdp.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = process.env.APP_URL ?? 'http://localhost:5193';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'import-missing-ui-shots');
mkdirSync(SHOTS, { recursive: true });
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'workbook-v1-full.json');
const BAD = join(SHOTS, 'wb-bad-column.json');
const queries = [];

const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['status', 'String', 'text'], ['created', 'DateTime', 'temporal'], ['customer_id', 'Int64', 'numeric']],
  customers: [['id', 'Int64', 'numeric'], ['name', 'String', 'text']],
};
const REGIONS = ['APAC', 'EU', 'US'];
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
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: Array.from({ length: dims.length ? 3 : 1 }, (_, r) => ({ keys: dims.map(() => REGIONS[r]), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })), truncated: false } };
  }
  return null;
}

let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;
const wbJson = JSON.parse(readFileSync(FIXTURE, 'utf8'));
wbJson.dashboards[0].sheet.rows[0].column = 'amount_typo'; // the "Revenue" sheet's measure
writeFileSync(BAD, J(wbJson));

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const connect = async () => {
    await waitFor(`document.readyState === 'complete' && !!document.getElementById('conn-connect')`, 'app loaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  };
  await b.goto(APP + '/');
  await connect();
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');

  await check('importing a workbook with a missing column reports it as the one issue, singular', async () => {
    const { root } = await b.send('DOM.getDocument');
    const { nodeId } = await b.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#wb-file' });
    await b.send('DOM.setFileInputFiles', { nodeId, files: [BAD] });
    await waitFor(`!!document.querySelector('dialog[open]')`, 'issues dialog');
    const text = await ev(`document.querySelector('dialog[open]').textContent`);
    must(/with 1 issue(?!s)/.test(text) && !/issue\(s\)/.test(text), `title: ${text}`);
    must(text.includes('Sheet "Revenue": orders.amount_typo isn\'t in shop.orders — left out.'), `issue line: ${text}`);
    await ev(`[...document.querySelectorAll('dialog[open] button')].find((x) => /^(close|ok|done)$/i.test(x.textContent.trim()))?.click()`);
  });

  await check('the pill is marked invalid with the reason, and the query leaves it out', async () => {
    await ev(`[...document.querySelectorAll('.tab:not(.tab--model) .tab__label')].find((x) => x.textContent === 'Revenue').click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden && document.querySelector('.ws-pill--invalid')`, 'invalid pill');
    must(await ev(`document.querySelector('.ws-pill--invalid').title`) === "orders.amount_typo isn't in shop.orders — left out.", 'tooltip');
    must(await ev(`!!document.querySelector('.ws-pill--invalid svg')`), 'no warning icon');
    must(await ev(`getComputedStyle(document.querySelector('.ws-pill--invalid')).borderTopStyle`) === 'dashed', 'not dashed');
    await waitFor(`/amount_typo/.test(document.getElementById('ws-chart-notice')?.textContent ?? document.querySelector('.ws-chart-notice')?.textContent ?? '')`, 'notice names the column');
    await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'tables loaded');
    await ev(`window.__ready = 1`);
    await new Promise((r) => setTimeout(r, 600));
    must(queries.length > 0 && !J(queries.at(-1)).includes('amount_typo'), `the last query still carries the missing column: ${J(queries.at(-1))}`);
    await b.screenshot(join(SHOTS, 'import-missing.png'), { x: 0, y: 0, width: 1400, height: 600 });
  });

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
