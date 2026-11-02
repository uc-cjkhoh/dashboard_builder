// Browser checks for the performance timings dialog (top-bar gauge button: recent query/render timings, Copy, Clear): the real dev app (APP_URL, default http://localhost:5180) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/perf-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5180 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { PAGE_CHIP } from './model.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5180';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'perf-ui-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['discount', 'Float64', 'numeric'], ['placed', 'DateTime', 'temporal']],
  customers: [['country', 'String', 'text']],
};
const REGIONS = ['APAC', 'EU', 'US'];
const queries = [];     // every /api/query body, in order
let tables = ['orders', 'customers'];
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: tables };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/query') {
    queries.push(body);
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    const n = dims.length ? REGIONS.length : 1;
    return { json: {
      rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: Array.from({ length: n }, (_, r) => ({ keys: dims.map(() => REGIONS[r]), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })),
      truncated: false } };
  }
  return null;
}


// ---- tiny test runner ---------------------------------------------------------------------------------------
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; }
  catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const J = JSON.stringify;

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const dlg = `document.querySelector('dialog.perf-dialog[open]')`;
  const rowsText = () => ev(`[...document.querySelectorAll('.perf-table tbody tr')].map((r) => [...r.children].map((c) => c.textContent).join('|'))`);

  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'orders loaded');

  await check('top bar: perf and appearance buttons do not overlap; the right-most glyph meets the gutter', async () => {
    const g = await ev(`(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); const bar = document.querySelector('.canvas__bar').getBoundingClientRect(); const p = r('perf-btn'), s = r('scheme-btn'); const pad = parseFloat(getComputedStyle(document.querySelector('.canvas__bar')).paddingRight); return { pRight: p.right, sLeft: s.left, sRight: s.right, barRight: bar.right, pad }; })()`);
    must(g.pRight <= g.sLeft + 0.5, `overlap: ${J(g)}`);
    // the glyph (16px in a 32px box: 8px slack) sits on the bar's inner right edge: box overhangs by 8px
    must(Math.abs((g.sRight - 8) - (g.barRight - g.pad)) <= 1, `glyph not on the gutter: ${J(g)}`);
  });

  await check('empty before any worksheet: dialog opens with the empty message and closes on Escape, focus returns', async () => {
    await ev(`document.getElementById('perf-btn').click()`);
    await waitFor(`${dlg} !== null`, 'dialog open');
    must((await ev(`document.querySelector('.perf-empty')?.textContent ?? ''`)).includes('No timings yet'), 'no empty message');
    await b.key('Escape', { vk: 27 });
    await waitFor(`${dlg} === null`, 'dialog closed');
    must(await ev(`document.activeElement.id`) === 'perf-btn', 'focus not returned to the button');
  });

  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await ev(`window.__t = { chip: ${PAGE_CHIP}, drag(chip, target) { const dt = new DataTransfer();
    chip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); chip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); } }; true`);
  await waitFor(`!!__t.chip('region')`, 'field pane filled');
  await ev(`__t.drag(__t.chip('region'), document.querySelector('.ws-shelf--rows .ws-shelf__zone'))`);
  await ev(`__t.drag(__t.chip('amount'), document.querySelector('.ws-shelf--columns .ws-shelf__zone'))`);
  const t0 = Date.now();
  while (!queries.length && Date.now() - t0 < 8000) await b.sleep(50);
  await b.sleep(500);

  await check('a query is recorded: kind, ms, rows, miss, render ms; no data values or SQL leak', async () => {
    await ev(`document.getElementById('perf-btn').click()`);
    await waitFor(`${dlg} !== null && document.querySelectorAll('.perf-table tbody tr').length > 0`, 'rows listed');
    const rows = await rowsText();
    must(rows.some((r) => /\|query\|\d+\|3\|Miss\|\d+$/.test(r)), `rows: ${J(rows)}`);
    const text = await ev(`document.querySelector('.perf-dialog').textContent`);
    must(!/APAC|SELECT|mock-ch|orders|amount/.test(text), `leaked: ${text}`);
  });

  await check('Copy as text is reachable by keyboard and does not throw', async () => {
    await ev(`[...document.querySelectorAll('.perf-dialog button')].find((x) => x.textContent === 'Copy as text').focus()`);
    must(await ev(`document.activeElement.textContent`) === 'Copy as text', 'not focusable');
    await ev(`document.activeElement.click()`);
    await waitFor(`!document.getElementById('toast').hidden`, 'toast shown');
  });

  await check('returning to the worksheet re-serves the same request from the cache: logged as a Hit', async () => {
    await b.key('Escape', { vk: 27 });
    await waitFor(`${dlg} === null`, 'closed');
    await ev(`document.querySelector('.tab--model .tab__label').click()`); // Data Source tab
    await waitFor(`document.getElementById('worksheet-view').hidden`, 'left the worksheet');
    await ev(`document.querySelector('.tab__label[data-kind=worksheet]').click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden`, 'back on the worksheet');
    await b.sleep(500);
    await ev(`document.getElementById('perf-btn').click()`);
    await waitFor(`${dlg} !== null`, 'open');
    const rows = await rowsText();
    await b.screenshot(join(SHOTS, 'perf-populated.png'));
    must(rows.some((r) => /\|query\|0\|3\|Hit\|\d+$/.test(r)), `rows: ${J(rows)}`);
  });

  await check('Clear empties the list and shows the empty message', async () => {
    await ev(`document.getElementById('perf-btn').click()`);
    await waitFor(`${dlg} !== null`, 'open');
    await ev(`[...document.querySelectorAll('.perf-dialog button')].find((x) => x.textContent === 'Clear').click()`);
    await waitFor(`!!document.querySelector('.perf-empty')`, 'empty message');
  });

  const shots = [];
  for (const scheme of ['light', 'dark']) await check(`screenshot ${scheme}`, async () => {
    await b.setScheme(scheme);
    await ev(`document.documentElement.dataset.scheme = ${J(scheme)}`);
    const p = join(SHOTS, `perf-${scheme}.png`);
    await b.screenshot(p); shots.push(p);
  });
  console.log('screenshots:\n  ' + shots.join('\n  '));
} finally {
  if (b) await b.close();
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
