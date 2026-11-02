// Browser check for cross-widget filtering on a dashboard (P24c): a click on a mark in one worksheet widget filters the OTHER
// worksheet widgets to that value, with real mouse clicks on the real chart. Source widget (A) fades the other marks and carries
// a text badge; the bar's chip shows and clears the filter; a widget whose tables lack the selected column re-queries nothing
// and says why; the selection is never saved, ends with the dashboard being shown and with its source widget, and each widget
// keeps its own latest-wins. Real dev app (APP_URL, default http://localhost:5193) in headless Chromium, every /api/* call
// mocked; any page error fails the run. Screenshots (light + dark) go to SHOTS_DIR.
import { launch } from './cdp.mjs';
import { relateTables } from './model.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5193';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'crossfilter-ui-shots');
mkdirSync(SHOTS, { recursive: true });
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text']],
  stock: [['units', 'Float64', 'numeric'], ['sku', 'String', 'text']],
};
const VALUES = { region: ['APAC', 'EU', 'US'], channel: ['web', 'shop', 'app'], sku: ['s1', 's2', 's3'] };
const queries = [];
const dimsOf = (q) => [...(q.rowDimensions ?? []), ...(q.columnDimensions ?? [])].map((d) => d.column).join();
const since = (from, col) => queries.slice(from).filter((q) => dimsOf(q) === col);
const regionFilter = (q) => (q.filters ?? []).find((f) => f.column === 'region');
let slowChannelMs = 0, failChannel = false;
async function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders', 'stock'] };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/query') {
    queries.push(body);
    const col = dimsOf(body);
    if (col === 'channel') {
      if (slowChannelMs && regionFilter(body)?.value === 'EU') await new Promise((r) => setTimeout(r, slowChannelMs));
      if (failChannel && regionFilter(body)) return { status: 502, json: { error: 'ClickHouse is unreachable.' } };
    }
    const rf = regionFilter(body);
    const base = (r) => (rf ? (rf.value === 'EU' ? 7 : 9) : 10 * (r + 1)); // a filtered result is visibly different
    if (body.offset !== undefined) {
      return { json: { rowDimensions: ['region'], columnDimensions: [], measures: ['v0'], total: 3, rows: [0, 1, 2].map((r) => ({ keys: [VALUES.region[r]], values: [base(r)] })), truncated: false } };
    }
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column), measures: ['v0'],
      rows: [0, 1, 2].map((r) => ({ keys: [VALUES[col][r]], values: [base(r)] })), truncated: false } };
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
  const connect = async () => {
    await waitFor(`document.readyState === 'complete' && !!document.getElementById('conn-connect')`, 'app loaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  };
  const W = (title) => `[...document.querySelectorAll('.board-widget')].find((x) => x.querySelector('.board-widget__title').textContent === ${J(title)})`;
  const opts = (title, which = 0) => ev(`(() => { const w = ${W(title)}; const ws = [...document.querySelectorAll('.board-widget')].filter((x) => x.querySelector('.board-widget__title').textContent === ${J(title)});
    const d = (ws[${which}] ?? w)?.querySelector('.ws-chart-canvas'); const i = d && window.echarts.getInstanceByDom(d); return i ? i.getOption() : null; })()`);
  // each datum's opacity (1 = not styled) and value on the first series
  const marks = async (title, which = 0) => { const o = await opts(title, which); return (o?.series?.[0]?.data ?? []).map((d) => ({ v: typeof d === 'object' && d ? d.value : d, o: typeof d === 'object' && d?.itemStyle?.opacity != null ? d.itemStyle.opacity : 1 })); };
  const values = async (title, which = 0) => (await marks(title, which)).map((m) => m.v);
  const addSheet = (name) => ev(`document.querySelector('.board-panel__item[data-sheet-id="' + [...document.querySelectorAll('.board-panel__item')].find((x) => x.querySelector('.board-panel__name').textContent === ${J(name)}).dataset.sheetId + '"] button').click()`);
  const chip = () => ev(`(() => { const c = document.getElementById('board-filter'); return c.hidden ? null : c.textContent; })()`);
  const noticeOf = (title) => ev(`(() => { const n = ${W(title)}?.querySelector('.board-widget__notice'); return !n || n.hidden ? '' : n.textContent; })()`);
  const drawn = (title) => ev(`!!${W(title)}?.querySelector('.ws-chart-canvas svg')`);
  const shot = (name) => b.screenshot(join(SHOTS, name));
  // a REAL mouse click on the bar of category `cat` in the which-th widget titled `title`
  const clickBar = async (title, cat, which = 0) => {
    const p = await ev(`(() => { const ws = [...document.querySelectorAll('.board-widget')].filter((x) => x.querySelector('.board-widget__title').textContent === ${J(title)}); const w = ws[${which}];
      w.scrollIntoView({ block: 'center' }); const d = w.querySelector('.ws-chart-canvas'); const i = window.echarts.getInstanceByDom(d); const r = d.getBoundingClientRect();
      return { x: r.left + i.convertToPixel({ xAxisIndex: 0 }, ${J(cat)}), y: r.top + i.convertToPixel({ yAxisIndex: 0 }, 1) - 3 }; })()`);
    await b.sleep(80);
    const p2 = await ev(`(() => { const ws = [...document.querySelectorAll('.board-widget')].filter((x) => x.querySelector('.board-widget__title').textContent === ${J(title)}); const w = ws[${which}];
      const d = w.querySelector('.ws-chart-canvas'); const i = window.echarts.getInstanceByDom(d); const r = d.getBoundingClientRect();
      return { x: r.left + i.convertToPixel({ xAxisIndex: 0 }, ${J(cat)}), y: r.top + i.convertToPixel({ yAxisIndex: 0 }, 1) - 3 }; })()`);
    await b.click(p2.x, p2.y);
    return p;
  };
  const settle = () => b.sleep(350);

  await b.goto(APP + '/');
  await connect();
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders', 'stock']) await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'tables loaded');
  await relateTables(ev, waitFor, ['orders', 'region', 'stock', 'sku']); // an unrelated table is held out of worksheets
  await store(`
    const f = (table, column, category, extra = {}) => ({ db: 'shop', table, column, category, ...extra });
    const mk = (name, chartType, table, dim, meas) => { const t = st.createWorksheet(name); t.sheet = { ...st.emptySheet(), chartType, columns: [f(table, dim, 'text')], rows: [f(table, meas, 'numeric', { agg: 'sum' })] }; return t; };
    mk('Revenue by region', 'bar', 'orders', 'region', 'amount'); mk('Share by channel', 'pie', 'orders', 'channel', 'amount'); mk('Stock by sku', 'bar', 'stock', 'sku', 'units');
    const tb = st.createWorksheet('Orders table'); tb.sheet = { ...st.emptySheet(), chartType: 'table', columns: [], rows: [f('orders', 'region', 'text'), f('orders', 'amount', 'numeric', { agg: 'sum' })] };
    st.createDashboard('Overview'); return true;`);
  await waitFor(`!document.getElementById('board-view').hidden`, 'board shown');
  for (const n of ['Revenue by region', 'Share by channel', 'Stock by sku']) await addSheet(n);
  await waitFor(`document.querySelectorAll('.board-widget .ws-chart-canvas svg').length === 3`, 'three widgets drawn');
  await b.sleep(400);

  await check('a click on a bar in A filters B (a bound `=` on the clicked value) and nothing else queries; A fades the other marks and wears a text badge; the chip shows', async () => {
    const n0 = queries.length;
    const base = await values('Share by channel');
    await clickBar('Revenue by region', 'EU');
    await waitFor(`document.getElementById('board-filter').hidden === false`, 'chip');
    await settle();
    const q = queries.slice(n0);
    must(q.length === 1, `${q.length} queries: ${J(q.map(dimsOf))}`);
    must(dimsOf(q[0]) === 'channel', `queried ${dimsOf(q[0])}`);
    must(J(regionFilter(q[0])) === J({ db: 'shop', table: 'orders', column: 'region', op: '=', value: 'EU', values: null }), `filter: ${J(q[0].filters)}`);
    must(await chip() === 'Filtering by orders.region = EU', `chip: ${await chip()}`);
    const m = await marks('Revenue by region');
    must(J(m.map((x) => x.o)) === J([0.35, 1, 0.35]), `A opacities ${J(m)}`);
    must(J(m.map((x) => x.v)) === J([10, 20, 30]), `A was re-filtered: ${J(m)}`);
    must(J(await values('Share by channel')) === J([7, 7, 7]) && J(base) === J([10, 20, 30]), `B values ${J(await values('Share by channel'))}`);
    must(await ev(`(() => { const s = ${W('Revenue by region')}.querySelector('.board-widget__source'); return !s.hidden && s.textContent.includes('Selected: orders.region = EU'); })()`), 'no text badge on the source');
    must(await ev(`${W('Revenue by region')}.classList.contains('is-source') && !${W('Share by channel')}.classList.contains('is-source')`), 'source outline');
    must(await ev(`document.getElementById('board-status').textContent`) === 'Filtering the other widgets by orders.region = EU.', `status: ${await ev(`document.getElementById('board-status').textContent`)}`);
    must(await ev(`document.getElementById('board-status').getAttribute('aria-live')`) === 'polite', 'status not polite');
  });

  await check('a widget whose tables lack the selected column re-queried nothing, keeps its data and says why', async () => {
    must(await drawn('Stock by sku'), 'unrelated widget lost its chart');
    must(J(await values('Stock by sku')) === J([10, 20, 30]), 'its data changed');
    const t = await noticeOf('Stock by sku');
    must(t === "orders.region: selected on another sheet, not applied here — its table isn't in this view.", `note: ${t}`);
    must(since(0, 'sku').length === 1, `the unrelated widget queried ${since(0, 'sku').length} times in all`);
  });

  await check('light + dark screenshots with a selection', async () => {
    await b.setScheme('light'); await b.sleep(400); await shot('crossfilter-light.png');
    await b.setScheme('dark'); await ev(`document.documentElement.setAttribute('data-theme', 'dark')`); await b.sleep(600); await shot('crossfilter-dark.png');
    must(J((await marks('Revenue by region')).map((x) => x.o)) === J([0.35, 1, 0.35]), 'the dimming did not survive the scheme redraw');
    await ev(`document.documentElement.removeAttribute('data-theme')`); await b.setScheme('light'); await b.sleep(400);
  });

  await check('a second click replaces the selection (A is a target of nothing; B queries the new value); the same mark again clears and the targets come back from cache', async () => {
    const n0 = queries.length;
    await clickBar('Revenue by region', 'US');
    await waitFor(`document.getElementById('board-filter').textContent.includes('US')`, 'chip replaced');
    await settle();
    must(since(n0, 'channel').length === 1 && regionFilter(since(n0, 'channel')[0]).value === 'US', `B: ${J(since(n0, 'channel').map(regionFilter))}`);
    must(since(n0, 'region').length === 0, 'the source re-queried');
    must(J(await values('Share by channel')) === J([9, 9, 9]), 'B not on US');
    const n1 = queries.length;
    await clickBar('Revenue by region', 'US');
    await waitFor(`document.getElementById('board-filter').hidden`, 'chip cleared by the same mark');
    await settle();
    must(queries.length === n1, `clearing queried ${queries.length - n1} times (the unfiltered result is still cached)`);
    must(J(await values('Share by channel')) === J([10, 20, 30]), 'B not restored');
    must((await marks('Revenue by region')).every((x) => x.o === 1), 'A still dimmed');
    must((await noticeOf('Stock by sku')) === '', 'the note stayed');
    must(await ev(`document.querySelectorAll('.board-widget__source:not([hidden])').length === 0 && !document.querySelector('.is-source')`), 'a source badge stayed');
  });

  await check('the chip clears too, by its labelled button (keyboard reachable); focus returns to the source widget', async () => {
    await clickBar('Revenue by region', 'APAC');
    await waitFor(`!document.getElementById('board-filter').hidden`, 'chip');
    const btn = await ev(`(() => { const x = document.querySelector('#board-filter button'); return { label: x.getAttribute('aria-label'), tag: x.tagName, tab: x.tabIndex }; })()`);
    must(btn.tag === 'BUTTON' && btn.tab >= 0 && btn.label === 'Clear the dashboard filter orders.region = APAC', `clear button: ${J(btn)}`);
    await ev(`document.querySelector('#board-filter button').focus()`);
    await ev(`document.querySelector('#board-filter button').click()`); // a native button: Enter / Space activate it
    await waitFor(`document.getElementById('board-filter').hidden`, 'chip cleared by keyboard');
    await settle();
    must(await ev(`document.activeElement === ${W('Revenue by region')}`), `focus: ${await ev(`document.activeElement?.className`)}`);
    must(J(await values('Share by channel')) === J([10, 20, 30]), 'B not restored');
    must(/cleared/.test(await ev(`document.getElementById('board-status').textContent`)), 'no cleared announcement');
  });

  await check('a failing target shows its own error while the others still react; clearing recovers it', async () => {
    failChannel = true;
    await ev(`(async () => { const st = await import('/features/Core/store.js'); const d = await import('/features/Dashboard/dashboards.js');
      d.sharedResults.clear(st.worksheets().find((x) => x.name === 'Share by channel').id); return true; })()`); // earlier selections cached these results
    await clickBar('Revenue by region', 'EU');
    await waitFor(`!!${W('Share by channel')}.querySelector('.ws-hint--warn')`, 'B error');
    must(await ev(`${W('Share by channel')}.querySelector('.ws-hint--warn').textContent.includes('unreachable')`), 'error text');
    must(await drawn('Revenue by region') && await drawn('Stock by sku'), 'a sibling lost its chart');
    failChannel = false;
    await ev(`document.querySelector('#board-filter button').click()`);
    await waitFor(`!!${W('Share by channel')}.querySelector('.ws-chart-canvas svg')`, 'B recovered');
    must(J(await values('Share by channel')) === J([10, 20, 30]), 'B not restored');
  });

  await check('two clicks in quick succession: each target draws only the second selection (per-widget latest-wins)', async () => {
    slowChannelMs = 900;
    await clickBar('Revenue by region', 'EU');
    await b.sleep(60);
    await clickBar('Revenue by region', 'US');
    await waitFor(`document.getElementById('board-filter').textContent.includes('US')`, 'second chip');
    await b.sleep(1400);
    slowChannelMs = 0;
    must(J(await values('Share by channel')) === J([9, 9, 9]), `B shows ${J(await values('Share by channel'))}`);
    await ev(`document.querySelector('#board-filter button').click()`);
    await settle();
  });

  await check('the selection is never saved to the workbook', async () => {
    await clickBar('Revenue by region', 'EU');
    await waitFor(`!document.getElementById('board-filter').hidden`, 'chip');
    await b.sleep(1200); // autosave is debounced
    const saved = await ev(`localStorage.getItem('dashboardbuilder.workbook.v2|mock-ch|8443|default')`);
    must(saved && saved.includes('Revenue by region'), 'nothing autosaved');
    must(!saved.includes('sourceWidgetId') && !saved.includes('Filtering by') && !/"selection":\{/.test(saved) && !saved.includes('orders.region = EU'), 'the selection reached the saved workbook');
  });

  await check('leaving the dashboard ends the selection: the worksheet tab is unchanged, and coming back shows no chip and unfiltered widgets (from cache)', async () => {
    await ev(`${W('Revenue by region')}.querySelector('.board-widget__edit').click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden && document.getElementById('board-view').hidden`, 'worksheet shown');
    must(await ev(`!document.querySelector('.ws-select')`), 'the worksheet shows a selection chip');
    const n0 = queries.length;
    await ev(`document.querySelector('.tab--dashboard .tab__label').click()`);
    await waitFor(`!document.getElementById('board-view').hidden && document.querySelectorAll('.board-widget .ws-chart-canvas svg').length === 3`, 'back on the dashboard');
    must(await chip() === null, 'the chip came back');
    must(J(await values('Share by channel')) === J([10, 20, 30]), 'B still filtered');
    must((await marks('Revenue by region')).every((x) => x.o === 1), 'A still dimmed');
    must(queries.slice(n0).every((q) => !regionFilter(q)), 'a filtered query after returning');
  });

  await check('a non-selectable widget (a table) and the legend never select', async () => {
    await store(`st.switchTab(st.dashboards()[0].id); return true;`);
    await addSheet('Orders table');
    await waitFor(`document.querySelectorAll('.board-widget[aria-label="Orders table"] tbody tr').length >= 3`, 'table drawn');
    await ev(`${W('Orders table')}.querySelector('tbody tr td').click()`);
    await b.sleep(150);
    must(await chip() === null, 'a table cell selected');
    await ev(`${W('Orders table')}.querySelector('.board-widget__remove').click()`);
    await waitFor(`!document.querySelector('.board-widget[aria-label="Orders table"]')`, 'table removed');
  });

  await check('the same worksheet twice: a click in one copy filters the other copy, never itself', async () => {
    await addSheet('Revenue by region');
    await waitFor(`[...document.querySelectorAll('.board-widget')].filter((x) => x.getAttribute('aria-label') === 'Revenue by region' && x.querySelector('.ws-chart-canvas svg')).length === 2`, 'copy drawn');
    await b.sleep(300);
    const n0 = queries.length;
    await clickBar('Revenue by region', 'EU', 0);
    await waitFor(`!document.getElementById('board-filter').hidden`, 'chip');
    await settle();
    const reg = since(n0, 'region');
    must(reg.length === 1 && regionFilter(reg[0])?.value === 'EU', `region queries: ${J(reg.map(regionFilter))}`);
    must(J((await marks('Revenue by region', 0)).map((x) => x.v)) === J([10, 20, 30]), 'the source copy was filtered');
    must(J((await marks('Revenue by region', 1)).map((x) => x.v)) === J([7, 7, 7]), 'the other copy was not filtered');
  });

  await check('removing the source widget clears the selection and the targets show their own data again', async () => {
    const srcId = await ev(`document.querySelector('.is-source').dataset.widgetId`);
    await ev(`document.querySelector('.is-source .board-widget__remove').click()`);
    await waitFor(`document.getElementById('board-filter').hidden`, 'chip cleared');
    await settle();
    must(await ev(`!document.querySelector('[data-widget-id="${srcId}"]')`), 'source still there');
    must(J(await values('Share by channel')) === J([10, 20, 30]), 'B still filtered');
    must(J((await marks('Revenue by region', 0)).map((x) => x.v)) === J([10, 20, 30]), 'the copy still filtered');
  });

  await check('changing the source worksheet\'s primary dimension clears the selection', async () => {
    await clickBar('Revenue by region', 'EU');
    await waitFor(`!document.getElementById('board-filter').hidden`, 'chip');
    await store(`const t = st.worksheets().find((x) => x.name === 'Revenue by region'); st.updateSheet(t.id, { ...t.sheet, columns: [{ db: 'shop', table: 'orders', column: 'channel', category: 'text' }] }); return true;`);
    await waitFor(`document.getElementById('board-filter').hidden`, 'chip cleared');
    await settle();
    must(J(await values('Share by channel')) === J([10, 20, 30]), 'B still filtered');
  });

  await check('a reload ends the selection too (nothing is restored)', async () => {
    await clickBar('Revenue by region', 'web', 0); // the first copy is now a bar by channel
    await waitFor(`!document.getElementById('board-filter').hidden`, 'a chip before the reload');
    await b.sleep(900);
    await b.send('Page.reload');
    await connect();
    await waitFor(`document.querySelectorAll('.board-widget').length >= 2`, 'widgets restored');
    must(await chip() === null, 'a chip after reload');
  });

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
