// Browser checks for the worksheet editor's chart interactions (P24a refactor safety net): click selection Keep / Exclude,
// legend click, drill down / up, Pages stepping, SVG / PNG export, print sizing, undo / redo, the Table pager with a theme
// flip, Refresh and Cancel on a slow query, and leaving for the Data Source mid-query. The real dev app (APP_URL, default
// http://localhost:5193) in headless Chromium; every /api/* call is mocked. Any page error fails the run (cdp.mjs).
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5193';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'editor-ui-shots');
mkdirSync(SHOTS, { recursive: true });

const COLUMNS = { orders: [['amount', 'Float64', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text'], ['placed', 'DateTime', 'temporal']] };
const REGIONS = ['APAC', 'EU', 'US'], CHANNELS = ['web', 'shop'];
const TABLE_TOTAL = 150, MOCK_PAGE = 60; // the mock serves short pages, so there is always a next one to load
const queries = [];
let slowMs = 0;
async function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders'] };
  if (path === '/api/databases/shop/tables/orders/columns') return { json: COLUMNS.orders.map(([name, type, category]) => ({ name, type, category })) };
  if (/\/columns\/region\/distinct$/.test(path)) return { json: REGIONS };
  if (path === '/api/query') {
    queries.push(body);
    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    const first = dims[0]?.column;
    const pageRows = body.offset !== undefined || body.withTotal !== undefined;
    let keysFor;
    if (pageRows) { const off = body.offset ?? 0, n = Math.max(0, Math.min(MOCK_PAGE, TABLE_TOTAL - off)); keysFor = Array.from({ length: n }, (_, i) => `row${off + i}`); }
    else keysFor = first === 'channel' ? CHANNELS : REGIONS;
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: keysFor.map((k, r) => ({ keys: dims.map(() => k), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })),
      truncated: false, ...(pageRows && body.withTotal !== false ? { total: TABLE_TOTAL } : {}) } };
  }
  return null;
}

let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label, timeout) => b.waitFor(s, { label, timeout });
  const settle = async (quiet = 250) => { let n = -1; for (let i = 0; i < 60 && n !== queries.length; i++) { n = queries.length; await b.sleep(quiet); } };
  const last = () => queries[queries.length - 1];
  const btn = (text) => `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${J(text)} || x.getAttribute('aria-label') === ${J(text)})`;
  const click = (text) => ev(`(() => { const e = ${btn(text)}; if (!e) throw new Error('no button ${text}'); e.click(); return true; })()`);
  const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); const d = st.activeWorksheet(); ${code}; return true; })()`);
  const chartHost = `document.querySelector('#ws-chart .ws-chart-canvas')`;
  const drawn = () => ev(`!!document.querySelector('#ws-chart svg, #ws-chart canvas')`);
  const instOf = `window.echarts.getInstanceByDom(${chartHost})`;
  // click a category's bar for real, at its pixel position
  const clickBar = async (cat) => {
    const p = await ev(`(() => { const i = ${instOf}; const horiz = i.getOption().yAxis[0].type === 'category'; const [x, y] = i.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, horiz ? [5, ${J(cat)}] : [${J(cat)}, 5]); const r = ${chartHost}.getBoundingClientRect(); return [r.left + x, r.top + y]; })()`);
    await b.click(p[0], p[1]);
  };
  const setSheet = (code) => store(`const s = d.sheet; const f = (c, category, extra = {}) => ({ db: 'shop', table: 'orders', column: c, category, ...extra }); ${code}; st.updateSheet(d.id, s)`);

  // ---- setup ----
  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 1`, 'tables');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'orders loaded');
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await waitFor(`document.querySelectorAll('#ws-fields .ws-field').length >= 4`, 'fields');
  const base = `s.chartType = 'bar'; s.columns = [f('region', 'text')]; s.rows = [f('amount', 'numeric', { agg: 'sum' })]; s.selection = null; s.drill = null; s.pages = null; s.filters = [];`;
  await setSheet(base);
  await waitFor(`!!${chartHost}`, 'bar chart drawn');
  await settle();

  await check('click a bar selects it; Keep only and Exclude send bound = / != filters; Clear removes it', async () => {
    await clickBar('APAC');
    await waitFor(`!!document.querySelector('.ws-select')`, 'selection chip');
    must(/APAC/.test(await ev(`document.querySelector('.ws-select').textContent`)), 'chip lacks the member');
    await click('Keep only'); await settle();
    const has = (op) => (last().filters ?? []).some((f) => f.column === 'region' && f.op === op && f.value === 'APAC');
    must(has('='), `no = filter: ${J(last().filters)}`);
    await click('Exclude'); await settle();
    must(has('!='), `no != filter: ${J(last().filters)}`);
    await click('Clear selection');
    await waitFor(`!document.querySelector('.ws-select')`, 'chip cleared');
    await settle();
    must(await ev(`(async () => (await import('/features/Core/store.js')).activeWorksheet().sheet.selection === null)()`), 'selection kept in the sheet');
  });

  await check('a pie legend click highlights and selects that member', async () => {
    await setSheet(`s.chartType = 'pie'; s.selection = null`); await settle();
    await waitFor(`!!${chartHost}`, 'pie drawn');
    await ev(`(() => { ${instOf}.dispatchAction({ type: 'legendToggleSelect', name: 'EU' }); return true; })()`);
    await waitFor(`!!document.querySelector('.ws-select')`, 'selection chip from legend');
    must(/EU/.test(await ev(`document.querySelector('.ws-select').textContent`)), 'chip lacks EU');
    await b.screenshot(join(SHOTS, 'pie-legend.png'));
  });

  await check('drill: a bar click descends (bound ancestor filter), Up ascends', async () => {
    await setSheet(`s.chartType = 'bar'; s.selection = null; s.columns = []; s.drill = { levels: [f('region', 'text'), f('channel', 'text')], depth: 0, path: [] }`); await settle();
    await waitFor(`!!${chartHost}`, 'drill chart');
    await clickBar('EU');
    await waitFor(`/Showing: channel/.test(document.querySelector('.ws-drill')?.textContent ?? '')`, 'drilled to channel');
    await settle();
    must((last().filters ?? []).some((f) => f.column === 'region' && f.op === '=' && f.value === 'EU'), `no ancestor filter: ${J(last().filters)}`);
    await ev(`document.querySelector('.ws-drill__up').click()`);
    await waitFor(`/Showing: region/.test(document.querySelector('.ws-drill')?.textContent ?? '')`, 'back up');
    await settle();
    must(await ev(`(async () => { const d = (await import('/features/Core/store.js')).activeWorksheet().sheet.drill; return d.depth === 0 && d.path.length === 0; })()`), 'drill path stayed after Up');
  });

  await check('Pages: next / previous step through the members, each a bound = filter', async () => {
    await setSheet(`${base.replace(/s\.drill = null; /, '')} s.pages = { db: 'shop', table: 'orders', column: 'region', index: 0 }`); await settle();
    await waitFor(`!!document.querySelector('.ws-pages__member')`, 'pages control');
    await waitFor(`/1\\/3/.test(document.querySelector('.ws-pages__member').textContent)`, 'members loaded');
    await settle();
    await click('Next page'); await settle();
    must(/2\/3/.test(await ev(`document.querySelector('.ws-pages__member').textContent`)), 'did not step');
    must((last().filters ?? []).some((f) => f.column === 'region' && f.value === 'EU'), `page filter: ${J(last().filters)}`);
    await click('Previous page'); await settle();
    must(/1\/3/.test(await ev(`document.querySelector('.ws-pages__member').textContent`)), 'did not step back');
    await setSheet(`s.pages = null`); await settle();
  });

  await check('export: SVG is a real <svg>, PNG a non-empty image/png', async () => {
    await ev(`(() => { window.__out = []; const o = URL.createObjectURL; URL.createObjectURL = (x) => { x.text().then((t) => window.__out.push({ type: x.type, size: x.size, head: t.slice(0, 5) })); return o.call(URL, x); }; return true; })()`);
    for (const label of ['SVG image', 'PNG image']) {
      await click('Export');
      await ev(`[...document.querySelectorAll('.ws-export .menu__item')].find((x) => x.textContent.trim() === ${J(label)}).click()`);
    }
    await waitFor(`window.__out.length === 2`, 'two exports', 15000);
    const out = await ev(`window.__out`);
    const svg = out.find((o) => /svg/.test(o.type)), png = out.find((o) => o.type === 'image/png');
    must(svg && svg.head === '<svg ' && svg.size > 500, `svg: ${J(svg)}`);
    must(png && png.size > 500, `png: ${J(png)}`);
  });

  await check('print sizes the chart to the page and restores the pane size afterwards', async () => {
    const w = () => ev(`${instOf}.getWidth()`);
    const before = await w();
    await ev(`(() => { window.dispatchEvent(new Event('beforeprint')); return true; })()`);
    await waitFor(`${instOf}.getWidth() === 1000`, 'print width');
    await ev(`(() => { window.dispatchEvent(new Event('afterprint')); return true; })()`);
    await waitFor(`${instOf}.getWidth() !== 1000`, 'width restored');
    must(Math.abs((await w()) - before) < 40, `width ${await w()} vs ${before}`);
  });

  await check('undo and redo restore and replay a shelf edit', async () => {
    await ev(`document.querySelector('.ws-shelf--rows .ws-pill .ws-pill__remove, .ws-shelf--rows .ws-pill [aria-label^="Remove"]')?.click()`);
    await waitFor(`document.querySelectorAll('.ws-shelf--rows .ws-pill').length === 0`, 'measure removed');
    await settle();
    await click('Undo (Ctrl+Z)');
    await waitFor(`document.querySelectorAll('.ws-shelf--rows .ws-pill').length === 1`, 'measure back');
    await settle();
    await click('Redo (Ctrl+Shift+Z)');
    await waitFor(`document.querySelectorAll('.ws-shelf--rows .ws-pill').length === 0`, 'redone');
    await click('Undo (Ctrl+Z)');
    await waitFor(`document.querySelectorAll('.ws-shelf--rows .ws-pill').length === 1`, 'measure back again');
    await settle();
  });

  await check('Table pager loads the next page on scroll; a theme flip redraws from cache without re-querying', async () => {
    await setSheet(`s.chartType = 'table'`); await settle();
    await waitFor(`document.querySelectorAll('#ws-chart tbody tr').length > 0`, 'table rows');
    const rows = () => ev(`document.querySelectorAll('#ws-chart tbody tr').length`);
    const r0 = await rows();
    must(r0 > 0 && r0 < TABLE_TOTAL, `first page rows ${r0}`);
    const q0 = queries.length;
    await ev(`(() => { const c = document.getElementById('ws-chart'); c.scrollTop = c.scrollHeight; c.dispatchEvent(new Event('scroll')); return true; })()`);
    await waitFor(`document.querySelectorAll('#ws-chart tbody tr').length > ${r0}`, 'second page appended', 10000);
    must(queries.slice(q0).some((q) => q.offset > 0 && q.withTotal === false), 'no offset query');
    const r1 = await rows(), q1 = queries.length;
    await ev(`(async () => { const { bus } = await import('/features/Core/store.js'); window.__flips = 0; bus.addEventListener('scheme:changed', () => { window.__flips++; }); return true; })()`);
    await b.setScheme('dark');
    await waitFor(`window.__flips > 0`, 'scheme:changed after the OS scheme flipped', 5000);
    await b.sleep(600);
    must(queries.length === q1, `theme flip re-queried (${queries.length - q1})`);
    must((await rows()) === r1, `rows changed after theme flip: ${r1} -> ${await rows()}`);
  });

  // ---- legends, colour split, shape scatter, point click, sort + paging, percent cells, comparison, export after re-render ----
  const noMarks = `s.color = []; s.marks = { size: null, label: null, detail: [], tooltip: [], shape: null, path: null, angle: null }; s.selection = null; s.analytics = undefined; s.period = null; s.filters = []; s.drill = null; s.pages = null; s.sort = null;`;
  const legendToggle = (name) => ev(`(() => { ${instOf}.dispatchAction({ type: 'legendToggleSelect', name: ${J(name)} }); return true; })()`);
  const chipText = () => ev(`document.querySelector('.ws-select')?.textContent ?? ''`);
  const selection = () => ev(`(async () => JSON.stringify((await import('/features/Core/store.js')).activeWorksheet().sheet.selection))()`).then((x) => (typeof x === 'string' ? JSON.parse(x) : x));

  await check('pie legend: select, a second click clears, then Keep only / Exclude send bound filters', async () => {
    await setSheet(`${base} ${noMarks} s.chartType = 'pie'`); await settle();
    await waitFor(`!!${chartHost}`, 'pie');
    await legendToggle('APAC');
    await waitFor(`/APAC/.test(document.querySelector('.ws-select')?.textContent ?? '')`, 'chip for APAC');
    await legendToggle('APAC');
    await waitFor(`!document.querySelector('.ws-select')`, 'chip cleared by the second legend click');
    must((await selection()) === null, 'selection stayed after clearing');
    await legendToggle('US');
    await waitFor(`/US/.test(document.querySelector('.ws-select')?.textContent ?? '')`, 'chip for US');
    await click('Keep only'); await settle();
    must((last().filters ?? []).some((f) => f.column === 'region' && f.op === '=' && f.value === 'US'), `Keep only: ${J(last().filters)}`);
    await click('Exclude'); await settle();
    must((last().filters ?? []).some((f) => f.column === 'region' && f.op === '!=' && f.value === 'US'), `Exclude: ${J(last().filters)}`);
    await click('Clear selection'); await settle();
  });

  await check('colour-split legend: a click highlights the series and selects the Colour member', async () => {
    await setSheet(`${base} ${noMarks} s.chartType = 'stacked'; s.color = [f('channel', 'text')]`); await settle();
    await waitFor(`!!${chartHost}`, 'colour split');
    await legendToggle('EU');
    await waitFor(`!!document.querySelector('.ws-select')`, 'chip');
    const sel = await selection();
    must(sel && sel.column === 'channel' && sel.value === 'EU', `selection ${J(sel)}`);
    must(await ev(`${instOf}.getOption().series.length >= 2`), 'series were hidden');
    await legendToggle('EU');
    await waitFor(`!document.querySelector('.ws-select')`, 'cleared');
  });

  await check('shape scatter: draws one series per text Shape member; a legend click selects that member', async () => {
    await setSheet(`${base} ${noMarks} s.chartType = 'scatter'; s.columns = [f('amount', 'numeric', { agg: 'avg' })]; s.rows = [f('amount', 'numeric', { agg: 'sum' })]; s.marks.shape = f('channel', 'text')`); await settle();
    await waitFor(`!!${chartHost}`, 'shape scatter drawn (no page error)');
    must(await ev(`${instOf}.getOption().series.length === 2`), 'expected one series per Shape member');
    await legendToggle('shop');
    await waitFor(`!!document.querySelector('.ws-select')`, 'chip');
    const sel = await selection();
    must(sel && sel.column === 'channel' && sel.value === 'shop', `selection ${J(sel)}`);
    await ev(`document.querySelector('.ws-select button[aria-label="Clear selection"], .ws-select__clear')?.click()`);
    await setSheet(`s.selection = null`);
  });

  await check('a scatter point click selects the primary dimension member', async () => {
    await setSheet(`${base} ${noMarks} s.chartType = 'scatter'; s.columns = [f('region', 'text'), f('amount', 'numeric', { agg: 'avg' })]; s.rows = [f('amount', 'numeric', { agg: 'sum' })]`); await settle();
    await waitFor(`!!${chartHost}`, 'scatter');
    const p = await ev(`(() => { const i = ${instOf}; const d = i.getOption().series[0].data[1]; const v = d.value ?? d; const [x, y] = i.convertToPixel({ seriesIndex: 0 }, v); const r = ${chartHost}.getBoundingClientRect(); return [r.left + x, r.top + y]; })()`);
    await b.click(p[0], p[1]);
    await waitFor(`!!document.querySelector('.ws-select')`, 'selection chip after a point click');
    must(/EU/.test(await chipText()), `chip: ${await chipText()}`);
    await setSheet(`s.selection = null`);
  });

  await check('Table: Sort Descending re-queries, and the paged queries keep the sort', async () => {
    await setSheet(`${base} ${noMarks} s.chartType = 'table'; s.columns = []; s.rows = [f('region', 'text'), f('amount', 'numeric', { agg: 'sum' })]`); await settle();
    await waitFor(`document.querySelectorAll('#ws-chart tbody tr').length > 0`, 'table rows');
    await ev(`document.querySelector('.ws-pick--sort .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-pick--sort .menu__item')].find((x) => x.textContent.trim() === 'Descending').click()`);
    await settle();
    must(last().sort?.desc === true, `sort: ${J(last().sort)}`);
    await waitFor(`document.querySelectorAll('#ws-chart tbody tr').length > 0`, 'rows again');
    const q0 = queries.length;
    must((await ev(`document.querySelectorAll('#ws-chart tbody tr').length`)) === MOCK_PAGE, `first page rows ${await ev(`document.querySelectorAll('#ws-chart tbody tr').length`)}`);
    await ev(`(() => { const c = document.getElementById('ws-chart'); c.scrollTop = c.scrollHeight; c.dispatchEvent(new Event('scroll')); return true; })()`);
    await waitFor(`document.querySelectorAll('#ws-chart tbody tr').length > ${MOCK_PAGE}`, 'second page appended', 10000);
    await settle();
    const paged = queries.slice(q0).find((q) => q.offset > 0);
    must(paged && paged.sort?.desc === true, `paged query lost the sort: ${J(paged?.sort)}`);
  });

  await check('a percent table calculation writes "%" in the cells', async () => {
    await setSheet(`${base} ${noMarks} s.chartType = 'table'; s.columns = []; s.rows = [f('region', 'text'), f('amount', 'numeric', { agg: 'sum', tableCalc: { type: 'pctTotal', along: 'auto' } })]`); await settle();
    await waitFor(`document.querySelectorAll('#ws-chart td.num').length > 0`, 'cells');
    const cells = await ev(`[...document.querySelectorAll('#ws-chart td.num')].map((x) => x.textContent)`);
    must(cells.length > 0 && cells.every((t) => /%$/.test(t.trim())), `cells: ${J(cells.slice(0, 4))}`);
  });

  await check('table calculation editor: compound growth shows percent cells', async () => {
    await setSheet(`${base} ${noMarks} s.chartType = 'table'; s.columns = []; s.rows = [f('region', 'text'), f('amount', 'numeric', { agg: 'sum' })]`); await settle();
    await waitFor(`document.querySelectorAll('#ws-chart td.num').length > 0`, 'cells');
    await ev(`[...document.querySelectorAll('.ws-shelf--rows .ws-pill')].at(-1).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))`);
    await ev(`[...document.querySelectorAll('.ctx-menu [role^=menuitem]')].find((x) => x.textContent.trim() === 'Table calculation…').click()`);
    await waitFor(`!!document.querySelector('.ws-calc')`, 'calc panel');
    await ev(`(() => { const sel = [...document.querySelectorAll('.ws-calc .ws-fmt-field')].find((x) => x.textContent.startsWith('Calculation')).querySelector('select'); sel.value = 'compound'; sel.dispatchEvent(new Event('change')); return true; })()`); await settle();
    await waitFor(`[...document.querySelectorAll('#ws-chart td.num')].some((x) => /%$/.test(x.textContent.trim()))`, 'percent cells');
    await ev(`document.querySelector('button[aria-label="Close editor"]').click()`);
  });
  await check('table calculation editor: percentile rank, and compute-using picks dimensions that persist', async () => {
    await setSheet(`${base} ${noMarks} s.chartType = 'table'; s.columns = []; s.rows = [f('region', 'text'), f('channel', 'text'), f('amount', 'numeric', { agg: 'sum' })]`); await settle();
    await waitFor(`document.querySelectorAll('#ws-chart td.num').length > 0`, 'cells');
    await ev(`[...document.querySelectorAll('.ws-shelf--rows .ws-pill')].at(-1).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))`);
    await ev(`[...document.querySelectorAll('.ctx-menu [role^=menuitem]')].find((x) => x.textContent.trim() === 'Table calculation…').click()`);
    await waitFor(`!!document.querySelector('.ws-calc')`, 'calc panel');
    const pick = (label, value) => ev(`(() => { const sel = [...document.querySelectorAll('.ws-calc .ws-fmt-field')].find((x) => x.textContent.startsWith(${J(label)})).querySelector('select'); sel.value = ${J(value)}; sel.dispatchEvent(new Event('change')); return true; })()`);
    await pick('Calculation', 'pctRank'); await settle();
    await waitFor(`/%$/.test(document.querySelector('#ws-chart td.num').textContent.trim())`, 'percentile cells');
    await pick('Along', 'custom');
    await waitFor(`document.querySelectorAll('.ws-calc__dim input').length === 2`, 'one checkbox per dimension');
    await ev(`document.querySelectorAll('.ws-calc__dim input')[0].click()`);
    await waitFor(`document.querySelectorAll('.ws-calc__dim input')[0].checked === false`, 'region unchecked');
    const tc = await ev(`(async () => { const st = await import('/features/Core/store.js'); return JSON.stringify(st.activeWorksheet().sheet.rows[2].tableCalc); })()`);
    must(tc === J({ type: 'pctRank', along: 'custom', using: [1] }), `stored: ${tc}`);
    must(await ev(`[...document.querySelectorAll('.ws-calc__dim span')].map((x) => x.textContent).join() === 'region,channel'`), 'plain labels without duplicates');
    await b.setScheme('light'); await b.sleep(300);
    await b.screenshot(join(SHOTS, 'calc-dims-light.png'));
    await b.setScheme('dark'); await b.sleep(300);
    await b.screenshot(join(SHOTS, 'calc-dims-dark.png'));
    await b.setScheme('light');
    await setSheet(`${base} ${noMarks} s.chartType = 'table'; s.columns = [f('region', 'text')]; s.rows = [f('region', 'text'), f('amount', 'numeric', { agg: 'sum', tableCalc: { type: 'running', along: 'custom', using: [0] } })]`); await settle();
    await ev(`[...document.querySelectorAll('.ws-shelf--rows .ws-pill')].at(-1).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))`);
    await ev(`[...document.querySelectorAll('.ctx-menu [role^=menuitem]')].find((x) => x.textContent.trim() === 'Table calculation…').click()`);
    await waitFor(`document.querySelectorAll('.ws-calc__dim span').length === 2`, 'duplicate panel');
    must(await ev(`[...document.querySelectorAll('.ws-calc__dim span')].map((x) => x.textContent).join() === 'region (Rows),region (Columns)'`), 'duplicate labels');
    await ev(`document.querySelector('button[aria-label="Close editor"]').click()`);
  });
  await check('table calculation editor: rank order and tie rule persist and rename the measure', async () => {
    await setSheet(`${base} ${noMarks} s.chartType = 'table'; s.columns = []; s.rows = [f('region', 'text'), f('amount', 'numeric', { agg: 'sum' })]`); await settle();
    await waitFor(`document.querySelectorAll('#ws-chart td.num').length > 0`, 'cells');
    await ev(`[...document.querySelectorAll('.ws-shelf--rows .ws-pill')].at(-1).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))`);
    await ev(`[...document.querySelectorAll('.ctx-menu [role^=menuitem]')].find((x) => x.textContent.trim() === 'Table calculation…').click()`);
    await waitFor(`!!document.querySelector('.ws-calc')`, 'calc panel');
    const pick = (label, value) => ev(`(() => { const sel = [...document.querySelectorAll('.ws-calc .ws-fmt-field')].find((x) => x.textContent.startsWith(${J(label)})).querySelector('select'); sel.value = ${J(value)}; sel.dispatchEvent(new Event('change')); return true; })()`);
    must(!(await ev(`[...document.querySelectorAll('.ws-calc .ws-fmt-field')].some((x) => x.textContent.startsWith('Ties'))`)), 'no Ties field before Rank');
    await pick('Calculation', 'rank'); await settle();
    await pick('Order', 'asc'); await pick('Ties', 'dense'); await settle();
    const tc = await ev(`(async () => { const st = await import('/features/Core/store.js'); return JSON.stringify(st.activeWorksheet().sheet.rows[1].tableCalc); })()`);
    must(tc === J({ type: 'rank', along: 'auto', order: 'asc', ties: 'dense' }), `stored: ${tc}`);
    must(await ev(`document.body.textContent.includes('rank (lowest first, dense)')`), 'measure renamed');
    await ev(`document.querySelector('button[aria-label="Close editor"]').click()`);
  });

  await check('comparison range: a KPI shows the change vs the previous period, a bar draws a second series', async () => {
    const period = `s.period = { db: 'shop', table: 'orders', column: 'placed', category: 'temporal', preset: 'last30', from: null, to: null, compare: 'previous', compareFrom: null, compareTo: null }`;
    await setSheet(`${base} ${noMarks} s.chartType = 'kpi'; s.columns = []; ${period}`); await settle();
    await waitFor(`!!document.querySelector('#ws-chart .ws-kpi__change')`, 'KPI change line');
    must(/vs/.test(await ev(`document.querySelector('#ws-chart .ws-kpi__change').textContent`)), 'no "vs" text');
    await setSheet(`${base} ${noMarks} s.chartType = 'bar'; ${period}`); await settle();
    await waitFor(`!!${chartHost}`, 'bar');
    must(await ev(`${instOf}.getOption().series.length === 2 && /\\(/.test(${instOf}.getOption().series[1].name)`), 'no comparison series');
  });

  await check('Export SVG after a re-render still produces a real SVG of the new chart', async () => {
    await setSheet(`${base} ${noMarks} s.chartType = 'bar'`); await settle();
    await setSheet(`s.chartType = 'line'`); await settle();
    await waitFor(`!!${chartHost}`, 'line');
    await ev(`window.__out = []`);
    await click('Export');
    await ev(`[...document.querySelectorAll('.ws-export .menu__item')].find((x) => x.textContent.trim() === 'SVG image').click()`);
    await waitFor(`window.__out.length === 1`, 'svg export', 15000);
    const o = (await ev(`window.__out`))[0];
    must(o.head === '<svg ' && o.size > 500, `svg: ${J(o)}`);
    await setSheet(`${base} ${noMarks}`); await settle();
  });

  await check('Refresh runs fresh; Cancel on a slow query aborts it and leaves a note', async () => {
    await setSheet(`s.chartType = 'bar'`); await settle();
    slowMs = 2500;
    const q0 = queries.length;
    await click('Refresh');
    await waitFor(`!!document.querySelector('#ws-chart .ws-loading')`, 'loading view');
    await ev(`document.querySelector('.ws-loading__cancel').click()`);
    await waitFor(`/Query cancelled/.test(document.getElementById('ws-chart').textContent)`, 'cancel note');
    must(queries.length === q0 + 1, 'slow query not sent once');
    slowMs = 0;
    await click('Refresh'); await settle();
    must(last().fresh === true, `fresh flag missing: ${J(Object.keys(last()))}`);
    await waitFor(`!!${chartHost}`, 'chart drawn after refresh');
  });

  await check('leaving for the Data Source mid-query neither errors nor draws; coming back draws', async () => {
    slowMs = 1500;
    await click('Refresh');
    await waitFor(`!!document.querySelector('#ws-chart .ws-loading')`, 'loading');
    await ev(`document.querySelector('.tab--model .tab__label').click()`);
    await waitFor(`document.getElementById('worksheet-view').hidden`, 'model view');
    await b.sleep(2200); // the slow answer lands while the Data Source is up
    slowMs = 0;
    must(b.consoleErrors.length === 0, `page errors: ${b.consoleErrors}`);
    await ev(`document.querySelector('.tab:not(.tab--model) .tab__label').click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet back');
    await waitFor(`!!${chartHost}`, 'chart drawn on return', 10000);
  });
} catch (e) {
  console.log(`FAIL (setup): ${e.stack ?? e.message}`); failed++;
} finally { await b?.close(); }
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
