// Browser check for the widget runtime (P24a): two charts live in two containers at once, and disposing or re-drawing
// one never touches the other; two worksheet views (createWorksheetView) draw two different sheets side by side, one
// interactive and one static (interactive: false). Drives the real chart.js (and ECharts) in headless Chromium — no ClickHouse needed.
// Env: APP_URL (default http://localhost:5193), SHOTS_DIR, CDP_PORT, CHROME_BIN.
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5193';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'runtime-ui-shots');
mkdirSync(SHOTS, { recursive: true });
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (c, m) => { if (!c) throw new Error(m); };
let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  const queries = [];
  await b.mock(({ path, body }) => {
    if (path === '/api/connection') return { json: { connected: false } };
    if (path !== '/api/query') return null;
    queries.push(body);
    const rd = body.rowDimensions ?? [], cd = body.columnDimensions ?? [];
    let combos = [[]];
    for (const d of [...rd, ...cd]) combos = combos.flatMap((c) => (d.column === 'channel' ? ['web', 'shop', 'app'] : ['APAC', 'EU', 'US']).map((v) => [...c, v]));
    return { json: { rowDimensions: rd.map((d) => d.column), columnDimensions: cd.map((d) => d.column), measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: combos.map((keys, r) => ({ keys, values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })), truncated: false } };
  });
  await b.goto(APP + '/');
  await b.waitFor(`!!document.getElementById('conn-connect')`, { label: 'app loaded' });
  await check('the default Data Model view loads with zero page errors (no uncaught exception, rejection or console.error)', async () => {
    await b.sleep(800); // sync() and the first render are async — give any rejection time to surface
    must(b.consoleErrors.length === 0, `page errors: ${b.consoleErrors.map((e) => String(e).split('\n')[0]).join(' | ')}`);
  });
  await b.evaluate(`(async () => {
    const chart = await import('/features/Dashboard/chart.js');
    window.__chart = chart;
    document.querySelector('.worksheet')?.remove();
    const host = document.createElement('div');
    host.id = 'rt-host'; host.style.cssText = 'position:fixed;inset:0;display:grid;grid-template-columns:1fr 1fr;gap:8px;background:var(--surface);z-index:9999';
    for (const id of ['rt-a', 'rt-b']) { const d = document.createElement('div'); d.id = id; d.style.cssText = 'position:relative;height:300px'; host.append(d); }
    document.body.append(host);
    return true; })()`);
  const spec = (name, data) => `({ type: 'bar', categories: ['a', 'b', 'c'], series: [{ name: ${JSON.stringify(name)}, data: ${JSON.stringify(data)} }], format: {} })`;
  await check('two containers each hold their own live chart', async () => {
    await b.evaluate(`(() => { __chart.renderChart(document.getElementById('rt-a'), ${spec('A', [1, 2, 3])}); __chart.renderChart(document.getElementById('rt-b'), ${spec('B', [3, 2, 1])}); return true; })()`);
    const n = await b.evaluate(`['rt-a', 'rt-b'].map((id) => document.querySelectorAll('#' + id + ' svg').length)`);
    must(n[0] === 1 && n[1] === 1, `svg counts ${n}`);
    must(await b.evaluate(`__chart.hasChartInstance(document.getElementById('rt-a')) && __chart.hasChartInstance(document.getElementById('rt-b'))`), 'instances');
    await b.screenshot(join(SHOTS, 'two-views.png'));
  });
  await check('re-drawing and disposing one container leaves the other alone', async () => {
    await b.evaluate(`(() => { const a = document.getElementById('rt-a'); __chart.disposeChart(a); a.replaceChildren(); __chart.renderChart(a, ${spec('A2', [9, 9, 9])}); return true; })()`);
    must(await b.evaluate(`document.querySelectorAll('#rt-b svg').length === 1 && __chart.hasChartInstance(document.getElementById('rt-b'))`), 'b was disturbed');
    await b.evaluate(`(() => { const a = document.getElementById('rt-a'); __chart.disposeChart(a); a.replaceChildren(); return true; })()`);
    must(await b.evaluate(`!__chart.hasChartInstance(document.getElementById('rt-a')) && __chart.hasChartInstance(document.getElementById('rt-b'))`), 'dispose crossed containers');
  });
  await check('sizing one chart does not resize the other', async () => {
    await b.evaluate(`(() => { __chart.renderChart(document.getElementById('rt-a'), ${spec('A', [1, 2, 3])}); __chart.sizeChart(document.getElementById('rt-a'), { width: 200, height: 120 }); return true; })()`);
    const w = await b.evaluate(`['rt-a', 'rt-b'].map((id) => Math.round(document.querySelector('#' + id + ' svg').getBoundingClientRect().width))`);
    must(w[0] === 200 && w[1] > 300, `widths ${w}`);
  });
  // ---- two worksheet views side by side (P24b precondition) ----
  await b.evaluate(`(async () => {
    const { createWorksheetView } = await import('/features/Dashboard/worksheet-view.js');
    const { createResultCache } = await import('/features/Dashboard/query-runner.js');
    const host = document.getElementById('rt-host');
    host.replaceChildren();
    for (const id of ['vw-a', 'vw-b']) { const d = document.createElement('div'); d.id = id; d.style.cssText = 'position:relative;height:320px;overflow:auto'; host.append(d); }
    const f = (column, category, extra = {}) => ({ db: 'shop', table: 'orders', column, category, ...extra });
    const sheet = (over) => ({ columns: [], rows: [], color: [], filters: [], chartType: 'bar', sort: null, selection: null, drill: null, pages: null, format: {}, period: null,
      marks: { size: null, label: null, detail: [], tooltip: [], shape: null, path: null, angle: null }, ...over });
    const entity = { id: 'e1', db: 'shop', table: 'orders', columns: [{ name: 'region', type: 'String', category: 'text' }, { name: 'channel', type: 'String', category: 'text' }, { name: 'amount', type: 'Float64', category: 'numeric' }] };
    const plan = { calculations: [], entities: new Map([['e1', entity]]), relationships: new Map(), sharedFilters: [], parameters: [], metaOf: () => ({}), nameOf: (x) => x.column, columnType: () => '' };
    const results = createResultCache();
    const sheets = {
      a: sheet({ chartType: 'bar', columns: [f('region', 'text')], rows: [f('amount', 'numeric', { agg: 'sum' })] }),
      b: sheet({ chartType: 'heatmap', columns: [f('channel', 'text')], rows: [f('region', 'text'), f('amount', 'numeric', { agg: 'sum' })] }),
    };
    const log = window.__views = { picks: [], status: [], legend: [], views: {}, sheets };
    const make = (key, interactive) => createWorksheetView(document.getElementById('vw-' + key), () => ({
      dash: { id: 'ws#' + key, sheet: sheets[key] }, noticeEl: null, results, plan, categoryOf: () => undefined, castOf: () => undefined,
    }), { interactive, onSelect: (field, raw) => log.picks.push([key, raw]), onLegend: (x) => log.legend.push([key, x.name]), legendFocus: () => null,
      statusBar: (s, r) => log.status.push([key, Boolean(r)]) });
    log.views.a = make('a', true); log.views.b = make('b', false);
    await Promise.all([log.views.a.run(), log.views.b.run()]);
    return true; })()`);
  await check('two worksheet views draw two different sheets (a bar and a heatmap) into their own containers', async () => {
    const info = await b.evaluate(`['vw-a', 'vw-b'].map((id) => ({ svgs: document.querySelectorAll('#' + id + ' svg').length, hasInst: !!window.echarts.getInstanceByDom(document.querySelector('#' + id + ' .ws-chart-canvas')) }))`);
    must(info[0].svgs >= 1 && info[1].svgs >= 1 && info[0].hasInst && info[1].hasInst, `views not drawn: ${JSON.stringify(info)}`);
    const types = await b.evaluate(`['vw-a', 'vw-b'].map((id) => window.echarts.getInstanceByDom(document.querySelector('#' + id + ' .ws-chart-canvas')).getOption().series[0].type)`);
    must(types[0] === 'bar' && types[1] === 'heatmap', `series types ${types}`);
    must(queries.length === 2, `expected one query per view, got ${queries.length}`);
    await b.screenshot(join(SHOTS, 'two-worksheet-views.png'));
  });
  const barPx = (id, cat) => b.evaluate(`(() => { const dom = document.querySelector('#${id} .ws-chart-canvas'); const i = window.echarts.getInstanceByDom(dom); const [x, y] = i.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [${JSON.stringify(cat)}, 5]); const r = dom.getBoundingClientRect(); return [r.left + x, r.top + y]; })()`);
  await check('a click selects in the interactive view only; the static view has no mark, drill or legend handlers', async () => {
    // the static view: a bar sheet in a third container so a real click can be tried on it
    await b.evaluate(`(async () => {
      const { createWorksheetView } = await import('/features/Dashboard/worksheet-view.js');
      const { createResultCache } = await import('/features/Dashboard/query-runner.js');
      const host = document.getElementById('rt-host'); const d = document.createElement('div'); d.id = 'vw-c'; d.style.cssText = 'position:relative;height:320px'; host.append(d);
      const log = window.__views, sheet = log.sheets.a;
      const entity = { id: 'e1', db: 'shop', table: 'orders', columns: [{ name: 'region', type: 'String', category: 'text' }, { name: 'amount', type: 'Float64', category: 'numeric' }] };
      const plan = { calculations: [], entities: new Map([['e1', entity]]), relationships: new Map(), sharedFilters: [], parameters: [], metaOf: () => ({}), nameOf: (x) => x.column, columnType: () => '' };
      log.views.c = createWorksheetView(d, () => ({ dash: { id: 'ws#c', sheet }, noticeEl: null, results: createResultCache(), plan, categoryOf: () => undefined, castOf: () => undefined }),
        { interactive: false, onSelect: (field, raw) => log.picks.push(['c', raw]), onLegend: (x) => log.legend.push(['c', x.name]), statusBar: (s, r) => log.status.push(['c', Boolean(r)]) });
      await log.views.c.run(); return true; })()`);
    const [ax, ay] = await barPx('vw-a', 'EU'); await b.click(ax, ay);
    await b.sleep(200);
    let picks = await b.evaluate(`__views.picks`);
    must(JSON.stringify(picks) === '[["a","EU"]]', `interactive click: ${JSON.stringify(picks)}`);
    const [cx, cy] = await barPx('vw-c', 'EU'); await b.click(cx, cy);
    await b.sleep(200);
    picks = await b.evaluate(`__views.picks`);
    must(picks.length === 1, `the static view selected something: ${JSON.stringify(picks)}`);
    must(await b.evaluate(`__views.status.some(([k]) => k === 'a') && !__views.status.some(([k]) => k === 'b' || k === 'c')`), 'the static views reported to the host status bar');
    must(await b.evaluate(`!document.querySelector('#vw-c .ws-select, #vw-c .ws-drill, #vw-c .ws-pages')`), 'editor chrome inside a static view');
  });
  await check('refreshing or cancelling one view leaves the other drawn', async () => {
    const before = await b.evaluate(`document.querySelectorAll('#vw-b svg').length`);
    await b.evaluate(`(async () => { __views.views.a.cancel(); await __views.views.a.refresh(); return true; })()`);
    await b.sleep(300);
    const after = await b.evaluate(`[document.querySelectorAll('#vw-a svg').length, document.querySelectorAll('#vw-b svg').length]`);
    must(after[0] >= 1 && after[1] === before, `a/b svgs ${after} (b was ${before})`);
    await b.evaluate(`(() => { __views.views.a.destroy(); return true; })()`);
    must(await b.evaluate(`!window.echarts.getInstanceByDom(document.querySelector('#vw-a .ws-chart-canvas') ?? document.body) && !!window.echarts.getInstanceByDom(document.querySelector('#vw-b .ws-chart-canvas'))`), 'destroying a disposed b');
  });
} catch (e) {
  console.log(`FAIL (setup): ${e.stack ?? e.message}`); failed++;
} finally { await b?.close(); }
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
