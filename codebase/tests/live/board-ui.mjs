// Browser check for the dashboard board (P24b stage 2): a dashboard tab renders worksheet widgets (non-interactive worksheet
// views, one query each with its own sheet's plan) and text widgets on a 12-column grid inside a scrolling panel; the side
// panel adds them; a failing widget shows its error inside itself; Remove / Edit; switching tabs disposes the views (no
// leaked chart instances); a worksheet edit re-runs only its widgets; a theme flip redraws from cache; a phone width stacks
// the widgets; a reload restores the dashboard from autosave. Real dev app (APP_URL, default http://localhost:5193) in
// headless Chromium, every /api/* call mocked; any page error fails the run. Screenshots (light + dark + phone) go to SHOTS_DIR.
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5193';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'board-ui-shots');
mkdirSync(SHOTS, { recursive: true });
const COLUMNS = { orders: [['amount', 'Float64', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text'], ['status', 'String', 'text'], ['qty_s', 'String', 'text']] };
const VALUES = { qty_s: ['1', '2', '3'], region: ['APAC', 'EU', 'US'], channel: ['web', 'shop', 'app'], status: ['open', 'paid', 'void'] };
const queries = [];
const dimsOf = (q) => [...(q.rowDimensions ?? []), ...(q.columnDimensions ?? [])].map((d) => d.column).join();
const countBy = (col) => queries.filter((q) => dimsOf(q) === col).length;
let slowMs = 0;
async function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders'] };
  if (path === '/api/databases/shop/tables/orders/columns') return { json: COLUMNS.orders.map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/query') {
    queries.push(body);
    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    if (dims.some((d) => d.column === 'status')) return { status: 400, json: { error: 'Query rejected: status is not available.' } };
    if (body.offset !== undefined) { // a table: pages of up to 500 of 1200 rows
      const rd = body.rowDimensions ?? [], total = 1200, n = Math.max(0, Math.min(body.limit ?? 500, total - body.offset));
      return { json: { rowDimensions: rd.map((d) => d.column), columnDimensions: [], measures: (body.measures ?? []).map((_, i) => `v${i}`), total,
        rows: Array.from({ length: n }, (_, r) => ({ keys: rd.map((d) => `${VALUES[d.column]?.[(body.offset + r) % 3] ?? 'x'}-${body.offset + r}`), values: (body.measures ?? []).map(() => body.offset + r) })), truncated: false } };
    }
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: Array.from({ length: dims.length ? 3 : 1 }, (_, r) => ({ keys: dims.map((d) => VALUES[d.column][r]), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })), truncated: false } };
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
  const waitFor = (s, label) => b.waitFor(s, { label });
  const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); ${code} })()`);
  const toastText = () => ev(`(document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent)`);
  const connect = async () => {
    await waitFor(`document.readyState === 'complete' && !!document.getElementById('conn-connect')`, 'app loaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  };
  const widgets = () => ev(`[...document.querySelectorAll('.board-widget')].map((w) => ({ id: w.dataset.widgetId, kind: w.classList.contains('board-widget--text') ? 'text' : 'sheet', title: w.querySelector('.board-widget__title').textContent,
    rect: (() => { const r = w.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })() }))`);
  const seriesType = (title) => ev(`(() => { const w = [...document.querySelectorAll('.board-widget')].find((x) => x.querySelector('.board-widget__title').textContent === ${J(title)});
    const dom = w?.querySelector('.ws-chart-canvas'); const i = dom && window.echarts.getInstanceByDom(dom); return i ? i.getOption().series[0].type : null; })()`);
  const addSheet = (name) => ev(`document.querySelector('.board-panel__item[data-sheet-id="' + [...document.querySelectorAll('.board-panel__item')].find((x) => x.querySelector('.board-panel__name').textContent === ${J(name)}).dataset.sheetId + '"] button').click()`);
  const hardClick = (sel) => ev(`document.querySelector(${J(sel)}).click()`);
  const shot = (name) => b.screenshot(join(SHOTS, name));

  await b.goto(APP + '/');
  await connect();
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 1`, 'tables listed');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'orders loaded');

  // Three worksheets: a bar, a pie, and one grouped by `status` (the mock rejects it).
  await store(`
    const f = (column, category, extra = {}) => ({ db: 'shop', table: 'orders', column, category, ...extra });
    const mk = (name, chartType, dim) => { const t = st.createWorksheet(name); t.sheet = { ...st.emptySheet(), chartType, columns: [f(dim, 'text')], rows: [f('amount', 'numeric', { agg: 'sum' })] }; return t; };
    mk('Revenue by region', 'bar', 'region'); mk('Share by channel', 'pie', 'channel'); mk('Orders by status', 'bar', 'status');
    st.createDashboard('Overview'); return true;`);
  await waitFor(`!document.getElementById('board-view').hidden`, 'board shown');

  await check('an empty dashboard: side panel lists the worksheets with Add buttons plus Add text; the empty message shows', async () => {
    const names = await ev(`[...document.querySelectorAll('.board-panel__item .board-panel__name')].map((x) => x.textContent)`);
    must(J(names) === J(['Revenue by region', 'Share by channel', 'Orders by status']), `panel: ${J(names)}`);
    must(await ev(`[...document.querySelectorAll('.board-panel__item button')].every((x) => /^Add the worksheet “.+” to the dashboard$/.test(x.getAttribute('aria-label')) && x.textContent.trim() === 'Add')`), 'Add buttons unlabelled');
    must(await ev(`!!document.querySelector('.board-panel__add-text') && document.querySelector('.board-panel__add-text').textContent.trim() === 'Add text'`), 'Add text');
    must(await ev(`!document.getElementById('board-empty').hidden`), 'empty message hidden');
    must(await ev(`document.getElementById('board-title').textContent === 'Overview' && document.getElementById('board-count').textContent === '0 of 12 widgets'`), 'bar');
    must(queries.length === 0, 'queried with nothing on the board');
  });

  await check('Add places worksheet widgets at the first free spot; each issues its own query with its own sheet and draws its own chart type', async () => {
    await addSheet('Revenue by region');
    await waitFor(`document.querySelectorAll('.board-widget .ws-chart-canvas svg').length === 1`, 'first widget drawn');
    await addSheet('Share by channel');
    await waitFor(`document.querySelectorAll('.board-widget .ws-chart-canvas svg').length === 2`, 'second widget drawn');
    const [a, c] = await widgets();
    must(a.title === 'Revenue by region' && c.title === 'Share by channel', `titles ${a.title} / ${c.title}`);
    must(await seriesType('Revenue by region') === 'bar' && await seriesType('Share by channel') === 'pie', 'chart types');
    must(queries.length === 2, `queries: ${queries.length} ${J(queries.map((q) => [q.rowDimensions?.map((d) => d.column), q.columnDimensions?.map((d) => d.column)]))}`);
    const dim = (q) => [...(q.rowDimensions ?? []), ...(q.columnDimensions ?? [])].map((d) => d.column).join();
    must(J(queries.map(dim).sort()) === J(['channel', 'region']), `plans: ${queries.map(dim)}`);
    must(queries.every((q) => q.measures.length === 1 && q.measures[0].column === 'amount' && q.measures[0].agg === 'sum'), 'measures');
    // 6 × 4 each: side by side, same top, no overlap, inside the grid
    must(a.rect[1] === c.rect[1] && c.rect[0] > a.rect[0] + a.rect[2], `not side by side: ${J(a.rect)} ${J(c.rect)}`);
    must(a.rect[3] === 4 * 64 + 3 * 12, `height ${a.rect[3]}`);
    must(J(await store(`return st.dashboards()[0].widgets.map((w) => [w.x, w.y, w.w, w.h]);`)) === J([[0, 0, 6, 4], [6, 0, 6, 4]]), 'cells');
  });

  await check('Add text: a full-width widget (heading in its header, body under it) under the others (text only, no markup)', async () => {
    await hardClick('.board-panel__add-text');
    await waitFor(`document.querySelectorAll('.board-widget--text').length === 1`, 'text widget');
    must(J(await store(`const w = st.dashboards()[0].widgets[2]; return [w.x, w.y, w.w, w.h, w.kind];`)) === J([0, 4, 12, 1, 'text']), 'text cell');
    // textContent only: markup in the stored text stays literal
    await store(`const d = st.dashboards()[0]; st.setWidgets(d.id, d.widgets.map((w) => w.kind === 'text' ? { ...w, heading: 'Q3 <b>review</b>', body: '*not bold*\\nsecond line <img src=x onerror=alert(1)>' } : w)); return true;`);
    must(await ev(`(() => { const t = document.querySelector('.board-widget--text'); return t.querySelector('b') === null && t.querySelector('img') === null && t.textContent.includes('<b>review</b>') && t.textContent.includes('*not bold*'); })()`), 'text widget interpreted markup');
    must(await ev(`document.querySelector('.board-widget--text .board-widget__title').textContent === 'Q3 <b>review</b>'`), 'header title');
    await store(`const d = st.dashboards()[0]; st.setWidgets(d.id, d.widgets.map((w) => w.kind === 'text' ? { ...w, heading: 'Notes', body: 'Revenue is by order date.' } : w)); return true;`);
  });

  await check('a failing widget shows its error inside itself; siblings stay drawn', async () => {
    await addSheet('Orders by status');
    await waitFor(`!!document.querySelector('.board-widget .ws-hint--warn')`, 'error shown');
    must(await ev(`document.querySelector('.board-widget .ws-hint--warn').closest('.board-widget').querySelector('.board-widget__title').textContent === 'Orders by status'`), 'error not inside its own widget');
    must(await ev(`document.querySelector('.board-widget .ws-hint--warn').textContent.includes('status is not available')`), 'error text');
    must(await ev(`document.querySelectorAll('.board-widget .ws-chart-canvas svg').length === 2`), 'a sibling lost its chart');
  });

  await check('light screenshot', async () => { await b.setScheme('light'); await b.sleep(400); await shot('board-canvas-light.png'); });

  await check('the 12-widget limit: Add text refuses with a toast; the page never scrolls, the canvas does', async () => {
    for (let i = 0; i < 12; i++) await hardClick('.board-panel__add-text');
    must(await store(`return st.dashboards()[0].widgets.length === 12;`), 'more than 12 widgets');
    must(/at most 12 widgets/.test(await toastText()), `toast: ${await toastText()}`);
    const s = await ev(`({ page: document.documentElement.scrollHeight - window.innerHeight, scroller: document.getElementById('board-scroll').scrollHeight - document.getElementById('board-scroll').clientHeight })`);
    must(s.page <= 0, `the page scrolls by ${s.page}`);
    must(s.scroller > 0, 'the canvas does not scroll inside its panel');
    for (const w of (await widgets()).filter((x) => x.kind === 'text').slice(1)) await ev(`document.querySelector('[data-widget-id="${w.id}"] .board-widget__remove').click()`);
    must(await store(`return st.dashboards()[0].widgets.length === 4;`), 'cleanup');
  });

  await check('Remove drops the widget, keeps the others drawn, moves focus on, and marks the workbook dirty (autosave)', async () => {
    const before = await ev(`localStorage.getItem('dashboardbuilder.workbook.v2|mock-ch|8443|default')`);
    const n = queries.length;
    await ev(`document.querySelector('.board-widget--text .board-widget__remove').click()`);
    await waitFor(`!document.querySelector('.board-widget--text')`, 'text removed');
    must(await ev(`document.activeElement?.classList.contains('board-widget__remove')`), 'focus lost after Remove');
    must(await ev(`document.querySelectorAll('.board-widget .ws-chart-canvas svg').length === 2`), 'siblings redrawn or lost');
    must(queries.length === n, 'Remove re-queried a sibling');
    await waitFor(`localStorage.getItem('dashboardbuilder.workbook.v2|mock-ch|8443|default') !== ${J(before)}`, 'autosave after Remove');
    await hardClick('.board-panel__add-text'); // text widget again for later checks
    await waitFor(`document.querySelectorAll('.board-widget--text').length === 1`, 'text re-added');
  });

  let held = [];
  await check('Edit switches to the worksheet tab; switching away disposes every view (no leaked chart instances)', async () => {
    held = await ev(`(() => { window.__held = [...document.querySelectorAll('.board-widget__body.ws-chart')]; return window.__held.length; })()`);
    must(held === 3, `${held} sheet widgets`);
    await ev(`document.querySelector('.board-widget[aria-label="Revenue by region"] .board-widget__edit').click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden && document.getElementById('board-view').hidden`, 'worksheet shown');
    must(await ev(`document.querySelector('.tab.is-active .tab__label').textContent === 'Revenue by region'`), 'wrong tab');
    must(await ev(`document.querySelectorAll('.board-widget').length === 0`), 'widgets stayed in the DOM');
    const live = await ev(`(async () => { const c = await import('/features/Dashboard/chart.js'); return window.__held.filter((el) => c.hasChartInstance(el)).length; })()`);
    must(live === 0, `${live} chart instances survived`);
    must(await ev(`window.__held.every((el) => !el.querySelector('.ws-chart-canvas') || !window.echarts.getInstanceByDom(el.querySelector('.ws-chart-canvas')))`), 'echarts instances survived');
  });

  await check('a worksheet edit shows in its widget when the dashboard is next shown, from the result the editor just fetched; unchanged widgets come from the cache', async () => {
    const c0 = countBy('channel'), r0 = countBy('region');
    await store(`const t = st.worksheets()[0]; st.updateSheet(t.id, { ...t.sheet, chartType: 'line' }); return true;`);
    await waitFor(`(() => { const d = document.querySelector('#ws-chart .ws-chart-canvas'); const i = d && window.echarts.getInstanceByDom(d); return i?.getOption().series[0].type === 'line'; })()`, 'the editor drew the line chart');
    await ev(`document.querySelector('.tab--dashboard .tab__label').click()`);
    await waitFor(`document.querySelectorAll('.board-widget').length === 4 && document.querySelectorAll('.board-widget .ws-chart-canvas svg').length === 2`, 'dashboard redrawn');
    must(await seriesType('Revenue by region') === 'line', 'the edited worksheet kept its old chart type');
    must(await seriesType('Share by channel') === 'pie', 'unchanged widget changed');
    // the editor ran the edited sheet and the widget reuses its cached result; the pie, unchanged, comes from the cache
    must(countBy('channel') === c0, `the unchanged widget re-queried (${countBy('channel') - c0})`);
    must(countBy('region') === r0 + 1, `the edited worksheet queried ${countBy('region') - r0} times (expected 1: the editor's, shared with the widget)`);
  });

  await check('a theme change redraws every live view from the cache (new chart instance, no query)', async () => {
    const r0 = countBy('region'), c0 = countBy('channel');
    const before = await ev(`[...document.querySelectorAll('.board-widget .ws-chart-canvas')].map((d) => window.echarts.getInstanceByDom(d).getId())`);
    await store(`st.setTheme({ accent: 'ocean', palette: 'default' }); return true;`);
    await waitFor(`document.querySelectorAll('.board-widget .ws-chart-canvas svg').length === 2`, 'redrawn');
    await b.sleep(300);
    const after = await ev(`[...document.querySelectorAll('.board-widget .ws-chart-canvas')].map((d) => window.echarts.getInstanceByDom(d)?.getId())`);
    must(after.length === 2 && after.every((id, i) => id && id !== before[i]), `instances not recreated: ${J(before)} -> ${J(after)}`);
    must(countBy('region') === r0 && countBy('channel') === c0, 'a theme change queried a drawn widget');
    await store(`st.setTheme({ accent: 'crimson', palette: 'default' }); return true;`);
  });

  await check('dark screenshot', async () => { await b.setScheme('dark'); await ev(`document.documentElement.setAttribute('data-theme', 'dark')`); await b.sleep(500); await shot('board-canvas-dark.png'); await ev(`document.documentElement.removeAttribute('data-theme')`); await b.setScheme('light'); });

  await b.sleep(500); // a late scheme / theme redraw from the previous checks must not count as a resize query
  await check('resize re-fits the charts without a query; a phone width stacks the widgets full width in reading order with no sideways scroll', async () => {
    const n = queries.length;
    await hardClick('#sidebar-toggle'); // the shell keeps its sidebar at any width: collapse it, as a phone user would
    await b.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
    await b.sleep(500);
    const info = await ev(`(() => { const g = document.getElementById('board-grid'); const sc = document.getElementById('board-scroll');
      return { stacked: g.classList.contains('is-stacked'), gw: g.clientWidth, widths: [...document.querySelectorAll('.board-widget')].map((w) => Math.round(w.getBoundingClientRect().width)),
        tops: [...document.querySelectorAll('.board-widget')].map((w) => Math.round(w.getBoundingClientRect().top)), side: sc.scrollWidth - sc.clientWidth,
        page: document.documentElement.scrollHeight - window.innerHeight, svgW: Math.round(document.querySelector('.board-widget .ws-chart-canvas svg').getBoundingClientRect().width) }; })()`);
    must(info.stacked, 'not stacked at 420px');
    must(info.widths.every((w) => w === info.gw), `widths ${J(info.widths)} vs ${info.gw}`);
    must(info.tops.every((t, i) => i === 0 || t > info.tops[i - 1]), `not in a column: ${J(info.tops)}`);
    must(info.side <= 0 && info.page <= 0, `sideways ${info.side}, page ${info.page}`);
    must(info.svgW <= info.gw && info.svgW > 100, `chart width ${info.svgW} in ${info.gw}`);
    await shot('board-canvas-phone.png');
    must(queries.length === n, `resize queried ${queries.length - n} times: ${J(queries.slice(n).map(dimsOf))}`);
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await b.sleep(500);
    must(await ev(`!document.getElementById('board-grid').classList.contains('is-stacked')`), 'still stacked at 1400px');
    must(queries.length === n, 'widening queried');
    await hardClick('#sidebar-toggle');
  });

  await check('Full screen applies to the whole canvas and exits again', async () => {
    await ev(`[...document.querySelectorAll('.board-bar__btn')].find((x) => /Full screen/.test(x.textContent)).click()`);
    await waitFor(`document.fullscreenElement === document.getElementById('board-main') || document.getElementById('board-main').classList.contains('is-presenting')`, 'full screen');
    await ev(`[...document.querySelectorAll('.board-bar__btn')].find((x) => /Exit full screen/.test(x.textContent)).click()`);
    await waitFor(`!document.fullscreenElement && !document.getElementById('board-main').classList.contains('is-presenting')`, 'exited');
  });

  await check('a reload restores the dashboard from autosave: the same widgets, drawn again', async () => {
    await waitFor(`localStorage.getItem('dashboardbuilder.workbook.v2|mock-ch|8443|default') !== null`, 'autosave written');
    await b.sleep(700);
    await b.send('Page.reload');
    await connect();
    await waitFor(`document.querySelectorAll('.board-widget').length === 4`, 'widgets restored');
    await waitFor(`document.querySelectorAll('.board-widget .ws-chart-canvas svg').length === 2 && !!document.querySelector('.board-widget .ws-hint--warn')`, 'widgets drawn after restore');
    const w = await widgets();
    must(J(w.map((x) => x.title)) === J(['Revenue by region', 'Share by channel', 'Text', 'Orders by status']), `titles ${J(w.map((x) => x.title))}`);
    must(await seriesType('Revenue by region') === 'line' && await seriesType('Share by channel') === 'pie', 'chart types after restore');
    must(await ev(`document.querySelector('.board-widget--text .board-widget__title').textContent === 'Text'`), 'text restored');
  });


  const until = async (fn, label) => { for (let i = 0; i < 80; i++) { if (fn()) return; await b.sleep(100); } throw new Error(`timed out: ${label}`); };
  const lastRegion = (from) => queries.slice(from).filter((q) => dimsOf(q) === 'region').pop();

  await check('a shared filter and a parameter reach the widget query; a worksheet change while the dashboard is visible re-runs it; removing the shared filter changes the next query', async () => {
    const n0 = queries.length;
    await store(`const t = st.worksheets()[0]; const p = st.addParameter({ name: 'Chan', type: 'text', value: 'web', allowed: { kind: 'any' } });
      st.setSharedFilters([{ db: 'shop', table: 'orders', column: 'region', category: 'text', op: '=', value: 'EU' }]);
      st.updateSheet(t.id, { ...t.sheet, filters: [{ db: 'shop', table: 'orders', column: 'channel', category: 'text', op: '=', param: p.id, value: '' }] }); return true;`);
    await until(() => lastRegion(n0), 'the widget re-queried');
    let f = J(lastRegion(n0).filters);
    must(f.includes('"EU"') && f.includes('"web"'), `shared filter / parameter missing from the query: ${f}`);
    const n1 = queries.length;
    await store(`st.setSharedFilters([]); const t = st.worksheets()[0]; st.updateSheet(t.id, { ...t.sheet }); return true;`);
    await until(() => lastRegion(n1), 'the widget re-queried after removing the shared filter');
    f = J(lastRegion(n1).filters);
    must(!f.includes('"EU"') && f.includes('"web"'), `next query: ${f}`);
    await store(`const t = st.worksheets()[0]; st.updateSheet(t.id, { ...t.sheet, filters: [] }); return true;`);
  });

  const addNew = async (name, make) => {
    await store(`const f = (column, category, extra = {}) => ({ db: 'shop', table: 'orders', column, category, ...extra }); ${make}
      st.switchTab(st.dashboards()[0].id); return true;`);
    await waitFor(`!document.getElementById('board-view').hidden && !!document.querySelector('.board-panel__item[data-sheet-id]') && [...document.querySelectorAll('.board-panel__name')].some((x) => x.textContent === ${J(name)})`, 'back on the dashboard');
    await addSheet(name);
  };

  await check('a calculated field, a data type cast, a tooltip template and a member colour all work inside a widget (query carries the calc tree and the cast; the chart draws)', async () => {
    const n0 = queries.length;
    await addNew('Calc sheet', `
      const calc = st.addCalculation({ name: 'Amount x2', formula: '[orders.amount] * 2' });
      st.setFieldMeta(f('qty_s', 'text'), { cast: 'number' });
      const t = st.createWorksheet('Calc sheet');
      t.sheet = { ...st.emptySheet(), chartType: 'bar', columns: [f('region', 'text')], color: [f('channel', 'text')],
        rows: [{ calc: calc.id, db: '', table: '', column: 'Amount x2', category: 'numeric', role: 'measure', agg: 'sum' }],
        filters: [f('qty_s', 'numeric', { op: '>', value: '0' })],
        tooltipText: 'Total for <orders.region>', memberColors: { 'orders.channel': { web: '#112233' } } };`);
    await until(() => queries.length > n0, 'the calc widget queried');
    await waitFor(`!!document.querySelector('.board-widget[aria-label="Calc sheet"] .ws-chart-canvas svg')`, 'calc widget drawn');
    const q = queries.slice(n0).pop();
    must(q.measures.some((m) => m.calc), `no calc tree in the measures: ${J(q.measures)}`);
    must(q.filters.some((f) => f.cast === 'number'), `no cast in the filters: ${J(q.filters)}`);
    must(await ev(`(() => { const d = document.querySelector('.board-widget[aria-label="Calc sheet"] .ws-chart-canvas'); const o = window.echarts.getInstanceByDom(d).getOption(); return JSON.stringify(o.series).toLowerCase().includes('#112233') && !!o.tooltip?.[0]?.formatter; })()`), `member colour or tooltip template missing: ${await ev(`(() => { const d = document.querySelector('.board-widget[aria-label="Calc sheet"] .ws-chart-canvas'); const o = window.echarts.getInstanceByDom(d).getOption(); return JSON.stringify({ s: o.series, t: typeof o.tooltip?.[0]?.formatter }).slice(0, 700); })()`)}`);
  });

  await check('a table widget pages by scrolling inside itself', async () => {
    const n0 = queries.length;
    await addNew('Table sheet', `const t = st.createWorksheet('Table sheet'); t.sheet = { ...st.emptySheet(), chartType: 'table', columns: [], rows: [f('region', 'text'), f('amount', 'numeric', { agg: 'sum' })] };`);
    await waitFor(`document.querySelectorAll('.board-widget[aria-label="Table sheet"] tbody tr').length >= 500`, 'first page');
    must(queries.slice(n0).some((q) => q.offset === 0), 'first page query');
    await ev(`(() => { const b = document.querySelector('.board-widget[aria-label="Table sheet"] .board-widget__body'); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event('scroll')); return true; })()`);
    await until(() => queries.slice(n0).some((q) => q.offset === 500), 'the next page was requested');
    await waitFor(`document.querySelectorAll('.board-widget[aria-label="Table sheet"] tbody tr').length > 500`, 'more rows drawn');
    must(await ev(`document.documentElement.scrollHeight <= window.innerHeight`), 'the page scrolled');
  });

  await check('a loading widget\'s Cancel names its worksheet; Add announced through the polite live region', async () => {
    slowMs = 1500;
    await store(`const t = st.worksheets()[1]; st.updateSheet(t.id, { ...t.sheet, filters: [{ db: 'shop', table: 'orders', column: 'region', category: 'text', op: '=', value: 'US' }] }); return true;`);
    await waitFor(`!!document.querySelector('.board-widget[aria-label="Share by channel"] .ws-loading__cancel')`, 'loading state');
    must(await ev(`document.querySelector('.board-widget[aria-label="Share by channel"] .ws-loading__cancel').getAttribute('aria-label')`) === 'Cancel loading Share by channel', 'Cancel label');
    slowMs = 0;
    await waitFor(`!!document.querySelector('.board-widget[aria-label="Share by channel"] .ws-chart-canvas svg')`, 'drawn after the delay');
    await hardClick('.board-panel__add-text');
    await b.sleep(150);
    must(/^Added “Text” to the dashboard\.$/.test(await ev(`document.getElementById('toast-live').textContent`)), `live region: ${await ev(`document.getElementById('toast-live').textContent`)}`);
    must(await ev(`document.getElementById('toast-live').getAttribute('aria-live') === 'polite'`), 'not polite');
  });

  await check('print: widgets stack in flow at the page width and every chart is sized to its own cell (not cropped)', async () => {
    await b.send('Emulation.setEmulatedMedia', { media: 'print' });
    await ev(`window.dispatchEvent(new Event('beforeprint'))`);
    await b.sleep(600);
    const info = await ev(`[...document.querySelectorAll('.board-widget')].map((w) => { const r = w.getBoundingClientRect(); const c = w.querySelector('.ws-chart-canvas svg, .ws-chart-canvas canvas'); const cr = c?.getBoundingClientRect();
      return { pos: getComputedStyle(w).position, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), chart: cr ? [Math.round(cr.left), Math.round(cr.top), Math.round(cr.right), Math.round(cr.bottom)] : null }; })`);
    must(info.length >= 6, `${info.length} widgets`);
    must(info.every((w) => w.pos === 'relative'), 'widgets are not in flow in print');
    must(info.every((w, i) => i === 0 || w.top >= info[i - 1].bottom), `widgets overlap: ${J(info.map((w) => [w.top, w.bottom]))}`);
    const charted = info.filter((w) => w.chart);
    must(charted.length >= 3, `${charted.length} charts`);
    must(charted.every((w) => w.chart[0] >= w.left && w.chart[2] <= w.right + 1 && w.chart[3] <= w.bottom + 1), `a chart is cropped or spills: ${J(charted)}`);
    must(charted.every((w) => w.chart[2] - w.chart[0] > (w.right - w.left) * 0.8), 'a chart is much narrower than its printed cell');
    await b.screenshot(join(SHOTS, 'board-canvas-print.png'));
    const { data } = await b.send('Page.printToPDF', { landscape: true, printBackground: true, preferCSSPageSize: true });
    (await import('node:fs')).writeFileSync(join(SHOTS, 'board-canvas-print.pdf'), Buffer.from(data, 'base64'));
    await ev(`window.dispatchEvent(new Event('afterprint'))`);
    await b.send('Emulation.setEmulatedMedia', { media: '' });
    await b.sleep(400);
    must(await ev(`getComputedStyle(document.querySelector('.board-widget')).position === 'absolute'`), 'the screen layout did not come back');
  });

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
