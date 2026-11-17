// Browser checks for pills: the real dev app (APP_URL, default http://localhost:5180) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/pills-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5180 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { PAGE_CHIP } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5180';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'pills-ui-shots');
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
  const toastText = () => ev(`(document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent)`);

  // page helpers: HTML5 drag-and-drop with a real DataTransfer, field-chip lookup, pill text
  const installHelpers = () => ev(`(() => {
    window.__t = {
      chip: ${PAGE_CHIP},
      drag(chip, target) {
        const dt = new DataTransfer();
        chip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        chip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      },
      zone: (kind) => document.querySelector('.ws-shelf--' + kind + ' .ws-shelf__zone'),
      pills: (kind) => [...document.querySelectorAll('.ws-shelf--' + kind + ' .ws-pill')].map((p) => p.querySelector('.ws-pill__text')?.textContent),
    };
    return true; })()`);
  const pills = (kind) => ev(`__t.pills(${J(kind)})`);

  // ---- setup: connect, add the two tables, open a worksheet -----------------------------------------------------
  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders'])
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'table loaded');
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await installHelpers();
  await waitFor(`!!__t.chip('region')`, 'field pane filled');

  await check('double-click places a dimension on Columns and a measure on Rows', async () => {
    await ev(`__t.chip('region').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await ev(`__t.chip('amount').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await b.sleep(300);
    must(J(await pills('columns')) === '["orders.region"]', 'columns ' + J(await pills('columns')));
    must(J(await pills('rows')) === '["orders.amount"]', 'rows ' + J(await pills('rows')));
    await ev(`__t.chip('region').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    must((await pills('columns')).length === 1, 'a second double-click must not duplicate');
  });
  const menu = async (shelf, item) => {
    await ev(`(() => { const p = document.querySelector('.ws-shelf--${shelf} .ws-pill'); p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); return true; })()`);
    return ev(`(() => { const items = [...document.querySelectorAll('.ctx-menu .menu__item')]; const it = items.find((x) => x.textContent.trim() === ${J(item)}); if (!it) return items.map((x) => x.textContent.trim()); it.click(); return 'clicked'; })()`);
  };
  await check('numeric pill: Discrete turns the measure into a dimension, Continuous back', async () => {
    must(await menu('rows', 'Discrete') === 'clicked', 'no Discrete item');
    await b.sleep(300);
    must(await ev(`[...document.querySelectorAll('.ws-pill--dimension .ws-pill__text')].some((e) => e.textContent === 'orders.amount')`), 'amount not a dimension');
    must(await menu('rows', 'Continuous') === 'clicked', 'no Continuous item');
    await b.sleep(300);
    must(await ev(`!!document.querySelector('.ws-shelf--rows .ws-pill--measure')`), 'amount not a measure again');
  });
  await check('plus button: click, click, dblclick leaves one pill', async () => {
    await ev(`document.querySelector('.ws-shelf--rows .ws-pill__remove, .ws-shelf--rows .ws-pill button')?.click?.()`);
    await b.sleep(200);
    const n0 = (await pills('rows')).length;
    await ev(`(() => { const c = __t.chip('qty'); const a = c.querySelector('.ws-field__add'); a.click(); a.click(); a.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
    await b.sleep(300);
    const r = await pills('rows');
    must(r.filter((t) => t === 'orders.qty').length === 1, 'qty pills: ' + J(r) + ' (was ' + n0 + ')');
  });
  await check('drag placement still works after the dblclick listener', async () => {
    await ev(`__t.drag(__t.chip('discount'), __t.zone('rows'))`);
    await b.sleep(300);
    must((await pills('rows')).includes('orders.discount'), 'drag did not place discount: ' + J(await pills('rows')));
  });
  // the Continuous / Discrete popup open, light and dark
  await ev(`document.querySelector('.ws-shelf--rows .ws-pill').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))`);
  await b.sleep(300);
  for (const scheme of ['light', 'dark']) {
    await ev(`import('/features/Core/scheme.js').then((m) => m.setSchemePref(${J(scheme)}))`);
    await b.sleep(300);
    await b.screenshot(join(SHOTS, `pills-popup-${scheme}.png`));
  }
} catch (e) { console.log('FAIL harness: ' + e.message); failed++; }
finally { if (b) await b.close(); }
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
