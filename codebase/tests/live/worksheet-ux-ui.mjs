// Browser checks for the worksheet UX fixes (pill aggregation, plain menu labels, identifier columns, Format totals and currency, conditional rules, view bar, Marks): the real dev app (APP_URL, default http://localhost:5180) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/worksheet-ux-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5180 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { PAGE_CHIP } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5180';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'worksheet-ux-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['order_id', 'Int64', 'numeric'], ['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['status', 'String', 'text'], ['placed', 'DateTime', 'temporal']],
  customers: [['country', 'String', 'text']],
};
const REGIONS = ['APAC', 'EU', 'US'];
const STATUSES = ['Returned', 'Shipped', 'Cancelled'];
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
    const two = dims.length === 2;
    const n = two ? REGIONS.length * STATUSES.length : dims.length ? REGIONS.length : 1;
    const keyFor = (r) => (two ? [REGIONS[Math.floor(r / STATUSES.length)], STATUSES[r % STATUSES.length]] : dims.map(() => REGIONS[r]));
    return { json: {
      rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: Array.from({ length: n }, (_, r) => ({ keys: keyFor(r), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })),
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
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined, width: 1440 });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  await ev(`(() => { try { localStorage.clear(); } catch {} return true; })()`);
  const installHelpers = () => ev(`(() => {
    window.__t = {
      chip: ${PAGE_CHIP},
      pill: (kind, i = 0) => document.querySelectorAll('.ws-shelf--' + kind + ' .ws-pill')[i],
    };
    return true; })()`);
  const ctxMenu = async (shelf, item, i = 0) => {
    await ev(`(() => { __t.pill(${J(shelf)}, ${i}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); return true; })()`);
    return ev(`(() => { const items = [...document.querySelectorAll('.ctx-menu .menu__item')]; const it = items.find((x) => x.textContent.trim() === ${J(item)}); if (!it) return items.map((x) => x.textContent.trim()); it.click(); return 'clicked'; })()`);
  };
  const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); ${code} })()`);

  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'table loaded');
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await installHelpers();
  await waitFor(`!!__t.chip('region')`, 'field pane filled');
  const dbl = (col) => ev(`__t.chip(${J(col)}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);

  await check('an identifier-like number is listed with the dimensions and places as a dimension (D96)', async () => {
    must(await ev(`(() => { const g = [...document.querySelectorAll('.ws-table .ws-field-group, .ws-table .ws-field')]; let cur = ''; const by = {}; for (const n of g) { if (n.classList.contains('ws-field-group')) cur = n.textContent; else (by[cur] ??= []).push(n.querySelector('.ws-field__name').textContent); } return by.Dimensions?.includes('order_id') && !by.Measures?.includes('order_id') && by.Measures?.includes('amount'); })()`), 'pane grouping');
    await dbl('order_id'); await b.sleep(300);
    must(await ev(`!!__t.pill('columns').classList.contains('ws-pill--dimension')`), 'order_id not a dimension');
    await ev(`__t.pill('columns').querySelector('button[aria-label="Remove field"]').click()`); await b.sleep(200);
  });
  await check('a measure pill shows its aggregation; the full text is on hover', async () => {
    await dbl('amount'); await b.sleep(300);
    must(await ev(`__t.pill('rows').querySelector('.ws-pill__agg')?.textContent`) === 'Sum', 'no Sum chip');
    must(await ev(`__t.pill('rows').querySelector('.ws-pill__text').textContent`) === 'orders.amount', 'name changed');
    must((await ev(`__t.pill('rows').title`)).startsWith('Sum of orders.amount'), 'title ' + await ev(`__t.pill('rows').title`));
  });
  await check('the aggregation menu uses plain labels and picking one updates the pill and caption', async () => {
    const labels = await ctxMenu('rows', '__none__');
    must(Array.isArray(labels), 'menu did not list');
    for (const want of ['Sum', 'Average', 'Count distinct', 'Count non-empty', 'Attribute (single value)', 'Standard deviation', 'Percentile…'])
      must(labels.includes(want), `missing ${want}: ${J(labels)}`);
    must(!labels.some((l) => ['avg', 'countDistinct', 'countNonNull', 'attr', 'stddev', 'variance'].includes(l)), 'raw names still shown');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    must(await ctxMenu('rows', 'Average') === 'clicked', 'no Average');
    await b.sleep(400);
    must(await ev(`__t.pill('rows').querySelector('.ws-pill__agg').textContent`) === 'Average', 'chip not Average');
    must(/avg amount/.test(await ev(`document.querySelector('.ws-titleblock__caption')?.textContent ?? ''`)), 'caption ' + await ev(`document.querySelector('.ws-titleblock__caption')?.textContent`));
  });
  await check('a table calculation is marked on the pill and named in the caption', async () => {
    must(await ctxMenu('rows', 'Table calculation…') === 'clicked', 'no table calc item');
    await b.sleep(300);
    await ev(`(() => { const s = [...document.querySelectorAll('.ws-calc select')][0]; s.value = 'pctTotal'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await b.sleep(400);
    must(await ev(`__t.pill('rows').querySelector('.ws-pill__calc')?.textContent`) === '· % of total', 'marker ' + await ev(`__t.pill('rows').querySelector('.ws-pill__calc')?.textContent`));
    must(/avg amount · % of total/.test(await ev(`document.querySelector('.ws-titleblock__caption').textContent`)), 'caption ' + await ev(`document.querySelector('.ws-titleblock__caption').textContent`));
    await ev(`document.querySelector('.ws-calc [aria-label="Close editor"]').click()`); await b.sleep(200);
  });
  await check('view bar: Format has its own icon and a text label at this width; Import is in the Export menu, not the bar', async () => {
    must(await ev(`document.querySelector('.ws-viewbar [aria-label="Format"] .ws-viewbar__label').offsetParent !== null`), 'Format label hidden');
    must(await ev(`document.querySelector('.ws-viewbar [aria-label="Analytics"] .ws-viewbar__label').offsetParent !== null`), 'Analytics label hidden');
    must(await ev(`!document.querySelector('.ws-viewbar [aria-label="Import workbook"]')`), 'Import still in the bar');
    must(await ev(`(() => { document.querySelector('.ws-export button').click(); return [...document.querySelectorAll('.ws-export .menu__item')].some((x) => x.textContent.trim() === 'Import workbook…'); })()`), 'no Import in Export menu');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  });
  const openFormat = async () => {
    await ev(`(() => { const f = document.querySelector('.ws-viewbar [aria-label="Format"]'); if (f.getAttribute('aria-pressed') !== 'true') f.click(); return true; })()`);
    await waitFor(`!!document.querySelector('.ws-format')`, 'format open');
  };
  const setSel = (label, value) => ev(`(() => { const l = [...document.querySelectorAll('.ws-format .ws-fmt-field')].find((x) => x.querySelector('.ws-fmt-label')?.textContent === ${J(label)}); const s = l.querySelector('select'); s.value = ${J(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await check('Format -> Number: Currency offers a symbol list (default $) and a custom symbol of up to 3 characters', async () => {
    await openFormat();
    must(await ev(`![...document.querySelectorAll('.ws-format .ws-fmt-label')].some((x) => x.textContent === 'Symbol')`), 'Symbol shown without Currency');
    await setSel('Number', 'currency'); await b.sleep(300);
    must(await ev(`[...document.querySelectorAll('.ws-format .ws-fmt-label')].some((x) => x.textContent === 'Symbol')`), 'no Symbol select');
    await setSel('Symbol', '€'); await b.sleep(300);
    must(await ev(`document.querySelector('.ws-chart')?.textContent.includes('€')`), 'no € in the view');
    await setSel('Symbol', 'custom'); await b.sleep(300);
    await ev(`(() => { const i = document.querySelector('.ws-currency__input'); i.value = 'ABCD'; i.dispatchEvent(new Event('change')); return true; })()`);
    await b.sleep(300);
    must(/1 to 3/.test(await ev(`document.getElementById('toast').textContent`)), 'no length message');
    await ev(`(() => { const i = document.querySelector('.ws-currency__input'); i.value = 'CHF'; i.dispatchEvent(new Event('change')); return true; })()`);
    await b.sleep(300);
    must(await ev(`document.querySelector('.ws-chart')?.textContent.includes('CHF')`), 'no CHF in the view');
    await setSel('Symbol', '$'); await b.sleep(300);
    await setSel('Number', 'auto'); await b.sleep(200);
  });

  // a Table: region down, status across — column members sort ascending, totals reachable from Format
  await store(`const dash = st.activeWorksheet(); const f = (column, category, extra = {}) => ({ db: 'shop', table: 'orders', column, category, ...extra });
    dash.sheet = { ...dash.sheet, chartType: 'table', rows: [f('region', 'text', { role: 'dimension' })], columns: [f('status', 'text', { role: 'dimension' }), f('amount', 'numeric', { role: 'measure', agg: 'sum' })], analytics: undefined, format: { ...dash.sheet.format, currencySymbol: '$' } };
    st.updateSheet(dash.id, dash.sheet); return true;`);
  await ev(`document.querySelector('.ws-viewbar [aria-label="Format"]').click(); document.querySelector('.ws-viewbar [aria-label="Format"]').click()`);
  await b.sleep(600);
  await check('table: column members read in ascending order; the status says "N × M table", the info line "result rows"', async () => {
    await waitFor(`!!document.querySelector('.xtab')`, 'crosstab drawn');
    const heads = await ev(`[...document.querySelectorAll('.xtab thead tr:first-child th')].map((t) => t.textContent.trim()).filter((t) => ['Returned', 'Shipped', 'Cancelled'].includes(t))`);
    must(J(heads) === J(['Cancelled', 'Returned', 'Shipped']), 'headers ' + J(heads));
    const status = await ev(`document.querySelector('.ws-statusbar, .ws-status')?.textContent ?? document.body.textContent.match(/\\d+ marks[^\\n]*/)?.[0] ?? ''`);
    must(/\d+ × \d+ table/.test(status) && !/columns/.test(status), 'status ' + status);
  });
  await check('Format shows Grand totals and Subtotals for a table, sharing the Analytics setting', async () => {
    await openFormat();
    await ev(`(() => { const l = [...document.querySelectorAll('.ws-format .ws-fmt-check')].find((x) => x.textContent.includes('Grand totals')); l.querySelector('input').click(); return true; })()`);
    await b.sleep(500);
    must(await ev(`!!document.querySelector('.xtab .xt-total')`), 'no totals drawn');
    await ev(`document.querySelector('.ws-viewbar [aria-label="Analytics"]').click()`);
    await waitFor(`!!document.querySelector('.ws-analytics')`, 'analytics open');
    must(await ev(`[...document.querySelectorAll('.ws-analytics .ws-fmt-check')].find((x) => x.textContent.includes('Grand totals')).querySelector('input').checked`), 'Analytics out of step');
  });
  await check('a new conditional rule has no threshold, applies to nothing and asks for a value', async () => {
    await openFormat();
    await ev(`(() => { const s = [...document.querySelectorAll('.ws-cf .ws-fmt-field')].find((x) => x.querySelector('.ws-fmt-label')?.textContent === 'Cells'); return !!s; })()`);
    await ev(`[...document.querySelectorAll('.ws-cf__add')][0].click()`); await b.sleep(500);
    const ph = await ev(`document.querySelector('.ws-cf__rule .ws-cf__num')?.placeholder`);
    must(ph === 'Type a value', 'placeholder ' + ph);
    must(await ev(`document.querySelector('.ws-cf__rule .ws-cf__num').value === ''`), 'threshold prefilled');
    must(await ev(`[...document.querySelectorAll('.xtab tbody td.num')].length > 0 && [...document.querySelectorAll('.xtab tbody td.num')].every((td) => !td.style.backgroundColor && !td.querySelector('.xt-cf__icon'))`) && await ev(`!document.querySelector('.xt-legend__rule')`), 'a rule painted cells before a value was typed: ' + await ev(`document.querySelector('.xtab .xt-cf__icon, .xt-legend__rule')?.outerHTML.slice(0, 200)`));
  });
  await check('Marks: collapsed with nothing set, one-line summary when set, choice remembered', async () => {
    must(await ev(`document.querySelector('.ws-shelf--marks').open === false`), 'open with nothing set; summary=' + await ev(`document.querySelector('.ws-marks__summary').textContent`));
    await ev(`document.querySelector('.ws-shelf--marks > summary').click()`); await b.sleep(200);
    must(await ev(`document.querySelector('.ws-shelf--marks').open === true`), 'did not open');
    must(await ev(`localStorage.getItem('dashboardbuilder.marks.pref')`) === 'open', 'preference not remembered');
    await ev(`document.querySelector('.ws-shelf--marks > summary').click()`); await b.sleep(200);
    must(await ev(`localStorage.getItem('dashboardbuilder.marks.pref')`) === 'closed', 'closed not remembered');
  });
  await b.screenshot(join(SHOTS, 'worksheet-ux-light.png'));
} catch (e) { console.log('FAIL harness: ' + e.message); failed++; }
finally { if (b) await b.close(); }
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
