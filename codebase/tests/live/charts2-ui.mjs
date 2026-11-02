// Browser checks for axis sync, right-axis mark type, marker size and mark borders (T03-16/17, T01-22, T03-34): the real dev app (APP_URL, default http://localhost:5191) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/charts2-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5191 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { relateTables } from './model.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5191';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'charts2-ui-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['discount', 'Float64', 'numeric'], ['channel', 'String', 'text'], ['placed', 'DateTime', 'temporal']],
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
  if (/\/columns\/\w+\/distinct/.test(path)) return { json: REGIONS };
  if (path === '/api/query') {
    queries.push(body);
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    const nd = dims.length;
    const combos = nd >= 2 ? REGIONS.flatMap((a) => REGIONS.map((c) => [a, c])) : dims.length ? REGIONS.map((a) => [a]) : [[]];
    return { json: {
      rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: combos.map((keys, r) => ({ keys, values: (body.measures ?? []).map((_, i) => (i === 0 ? 10 * (r + 1) : 15 * (r + 1) + 5)) })),
      truncated: false } };
  }
  return null;
}

// ---- tiny test runner ---------------------------------------------------------------------------------------
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; }
  catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; await globalThis.__failShot?.(name); }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const J = JSON.stringify;

let wbDir = null, b = null;
try {
  wbDir = mkdtempSync(join(tmpdir(), 'calc-wb-'));
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const toastText = () => ev(`(document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent)`);

  // page helpers: HTML5 drag-and-drop with a real DataTransfer, text lookup, dialog typing
  const installHelpers = () => ev(`(() => {
    window.__t = {
      chip: (name) => [...document.querySelectorAll('#ws-fields .ws-field')].find((c) => c.querySelector('.ws-field__name')?.textContent === name),
      drag(chip, target) {
        const dt = new DataTransfer();
        chip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        chip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      },
      zone: (kind) => document.querySelector('.ws-shelf--' + kind + ' .ws-shelf__zone'),
      pills: (kind) => [...document.querySelectorAll('.ws-shelf--' + kind + ' .ws-pill')].map((p) => p.querySelector('.ws-pill__text')?.textContent),
      btn: (text, root = document) => [...root.querySelectorAll('button')].find((x) => x.textContent.trim() === text || x.getAttribute('aria-label') === text),
    };
    return true; })()`);
  const dragChip = (name, target) => ev(`(() => { const c = __t.chip(${J(name)}); if (!c) throw new Error('no field chip ${name}'); __t.drag(c, ${target}); return true; })()`);
  const pills = (kind) => ev(`__t.pills(${J(kind)})`);
  const dlg = `document.querySelector('dialog.calc-dialog[open]')`;
  const focusAndType = async (sel, text) => {
    await ev(`(() => { const e = document.querySelector(${J(sel)}); e.focus(); e.select?.(); return true; })()`);
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await b.type(text);
  };
  const openNewDialog = async () => {
    await ev(`document.querySelector('.calc-group__new').click()`);
    await waitFor(`${dlg} !== null`, 'calc dialog open');
  };
  const fillDialog = async (name, formula) => {
    await focusAndType('.calc-dialog input.input', name);
    await focusAndType('.calc-dialog textarea.formula', formula);
    await ev(`document.querySelector('.calc-dialog textarea.formula').blur()`);
  };
  const saveDisabled = () => ev(`[...${dlg}.querySelectorAll('.dialog__foot button')].find((x) => x.textContent === 'Save').disabled`);
  const saveDialog = async () => {
    await ev(`[...${dlg}.querySelectorAll('.dialog__foot button')].find((x) => x.textContent === 'Save').click()`);
    await waitFor(`${dlg} === null`, 'dialog closed after save');
  };
  const newCalc = async (name, formula) => { await openNewDialog(); await fillDialog(name, formula); await saveDialog(); };
  const calcMenu = async (name, item) => {
    await ev(`(() => { const c = __t.chip(${J(name)}); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); return true; })()`);
    await ev(`(() => { const c = __t.chip(${J(name)}); [...document.querySelectorAll('.ctx-menu .menu__item')].find((x) => x.textContent.trim() === ${J(item)}).click(); return true; })()`);
  };
  const confirmOpen = `[...document.querySelectorAll('dialog[open]')].find((d) => !d.classList.contains('calc-dialog'))`;
  const chartText = () => ev(`document.getElementById('ws-chart').textContent`);
  const canvasDrawn = () => ev(`!!document.querySelector('#ws-chart canvas, #ws-chart svg')`);
  const until = async (fn, label, timeout = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for: ${label}`); await b.sleep(50); } };
  // Wait until no new /api/query has arrived for `quiet` ms (polling, not a fixed sleep).
  const settle = async (quiet = 300) => { let n = -1; for (let i = 0; i < 60 && n !== queries.length; i++) { n = queries.length; await b.sleep(quiet); } };
  const lastQuery = () => queries[queries.length - 1];
  const hasKey = (o, k) => J(o).includes(`"${k}"`);

  // ---- setup: connect, add the two tables, open a worksheet -----------------------------------------------------
  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders', 'customers'])
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'both tables loaded');
  await relateTables(ev, waitFor, ['orders', 'region', 'customers', 'country']); // an unrelated table is held out of the field pane
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await installHelpers();
  await waitFor(`!!__t.chip('region')`, 'field pane filled');

  const filterTool = `document.querySelector('.ws-tool[aria-label^="Filters"]')`;
  const opSelect = `document.querySelector('select[aria-label^="Filter operator for"]')`;
  const shot = async (name) => { try { writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } };

  const fmtTool = `document.querySelector('.ws-viewbar__btn[aria-label="Format"]')`;
  const setType = async (label) => {
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === ${J(label)}).click()`);
    await settle(400);
  };
  const opt = () => ev(`window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')).getOption()`);
  const openFormat = async () => {
    if (!(await ev(`!!document.querySelector('.ws-format')`))) await ev(`${fmtTool}.click()`);
    await waitFor(`!!document.querySelector('.ws-format')`, 'format panel');
  };
  const pick = async (label, value) => {
    await ev(`(() => { const s = [...document.querySelectorAll('.ws-fmt-field')].find((l) => l.querySelector('.ws-fmt-label').textContent === ${J(label)}).querySelector('select'); s.value = ${J(value)}; s.dispatchEvent(new Event('change')); return true; })()`);
    await settle(400);
  };
  const hasField = (label) => ev(`[...document.querySelectorAll('.ws-fmt-field')].some((l) => l.querySelector('.ws-fmt-label').textContent === ${J(label)})`);
  const theme = async (t) => { await ev(`import('/features/Core/scheme.js').then((m) => m.setSchemePref(${J(t)}))`); await settle(600); };
  const chartReady = () => waitFor(`!!document.querySelector('.ws-chart-canvas') && !!window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas'))`, 'chart drawn');

  const setNum = async (label, v) => {
    await ev(`(() => { const i = [...document.querySelectorAll('.ws-fmt-field')].find((l) => l.querySelector('.ws-fmt-label').textContent === ${J(label)}).querySelector('input'); i.value = ${J(v)}; i.dispatchEvent(new Event('change')); return true; })()`);
    await settle(400);
  };
  const tick = (id) => ev(`document.getElementById('toast') && !document.getElementById('toast').hidden ? document.getElementById('toast').textContent : ''`);
  const check1 = (id) => ev(`(() => { const l = [...document.querySelectorAll('.ws-fmt-field')].find((l) => l.querySelector('.ws-fmt-label').textContent === ${J(id)}); const c = l.querySelector('input'); c.checked = !c.checked; c.dispatchEvent(new Event('change')); return true; })()`);
  globalThis.__failShot = async (n) => shot('fail-' + n.slice(0, 12).replace(/\W/g, '_') + '.png');
  const axes = async () => { const o = await opt(); return [].concat(o.yAxis); };

  await check('Combo: Synchronise axes gives both value axes the same nice range; off leaves them independent', async () => {
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('amount', `__t.zone('columns')`);
    await dragChip('discount', `__t.zone('columns')`);
    await settle(400);
    await setType('Combo (dual-axis)'); await openFormat(); await chartReady();
    must(await hasField('Synchronise axes') && await hasField('Right-axis marks'), 'combo controls missing');
    let a = await axes();
    must(a.length === 2 && a[0].min == null && a[1].min == null, 'independent by default');
    await check1('Synchronise axes'); await settle(400); await chartReady();
    a = await axes();
    must(a[0].min === 0 && a[0].max === 50 && a[1].min === 0 && a[1].max === 50, `synced ${J(a.map((x) => [x.min, x.max]))}`);
    await shot('combo-sync-light.png');
    await theme('dark'); await shot('combo-sync-dark.png'); await theme('light');
    await check1('Synchronise axes'); await settle(400); await chartReady();
    a = await axes();
    must(a[0].min == null, 'off again -> independent');
  });

  await check('Combo: Right-axis marks switch the secondary series between line, bars and area', async () => {
    await openFormat();
    let o = await opt();
    must(o.series[1].type === 'line' && !o.series[1].areaStyle?.opacity ? true : o.series[1].type === 'line', 'default line');
    await pick('Right-axis marks', 'bar'); await chartReady();
    o = await opt();
    must(o.series[1].type === 'bar' && o.series[1].yAxisIndex === 1, `bar on right axis: ${o.series[1].type}/${o.series[1].yAxisIndex}`);
    await shot('combo-right-bars-light.png');
    await theme('dark'); await shot('combo-right-bars-dark.png'); await theme('light');
    await pick('Right-axis marks', 'area'); await chartReady();
    o = await opt();
    must(o.series[1].type === 'line' && o.series[1].areaStyle && o.series[1].areaStyle.opacity > 0, 'area = filled line');
    await pick('Right-axis marks', 'line'); await chartReady();
  });

  await check('Dual axis: a line / area chart draws its 2nd measure on a titled right axis; synchronise shares one range; off restores one axis', async () => {
    await setType('Line'); await openFormat(); await chartReady();
    must(await ev(`[...document.querySelectorAll('.ws-fmt-field')].find((l) => l.querySelector('.ws-fmt-label').textContent === 'Dual axis').querySelector('input').disabled`), 'a dimension on Rows (horizontal): Dual axis is disabled');
    await dragChip('region', `__t.zone('columns')`); await settle(400); await chartReady(); await openFormat();
    must(await hasField('Dual axis') && !(await hasField('Synchronise axes')) && !(await hasField('Right-axis marks')), 'line: Dual axis only');
    let o = await opt();
    must([].concat(o.yAxis).length === 1, 'one axis by default');
    await check1('Dual axis'); await settle(400); await chartReady();
    o = await opt();
    must(o.yAxis.length === 2 && o.yAxis[1].position === 'right' && o.yAxis[1].name, `right axis named ${J(o.yAxis[1])}`);
    must(o.series[1].yAxisIndex === 1 && o.series[0].yAxisIndex === 0 && o.series[1].type === 'line', 'series on their axes');
    must(await hasField('Synchronise axes') && !(await hasField('Right-axis marks')), 'sync shown, no mark choice');
    await shot('dual-line-light.png');
    await theme('dark'); await shot('dual-line-dark.png'); await theme('light');
    await check1('Synchronise axes'); await settle(400); await chartReady();
    const a = await axes();
    must(a[0].min != null && a[0].min === a[1].min && a[0].max === a[1].max, `synced ${J(a.map((x) => [x.min, x.max]))}`);
    await check1('Synchronise axes'); await settle(400);
    await setType('Area'); await chartReady();
    o = await opt();
    must(o.yAxis.length === 2 && o.series[1].yAxisIndex === 1 && o.series[1].areaStyle, 'area keeps the right axis');
    await shot('dual-area-light.png');
    await setType('Line'); await openFormat(); await check1('Dual axis'); await settle(400); await chartReady();
    must([].concat((await opt()).yAxis).length === 1, 'off -> one axis');
  });

  await check('Dual axis: a reference line over the right-axis measure is drawn on the right axis', async () => {
    await setType('Line'); await chartReady(); await openFormat();
    await check1('Dual axis'); await settle(400); await chartReady();
    await ev(`document.querySelector('.ws-viewbar__btn[aria-label="Analytics"]').click()`);
    await waitFor(`!!document.querySelector('.ws-analytics')`, 'analytics panel');
    const aPick = async (label, value) => {
      await ev(`(() => { const s = [...document.querySelectorAll('.ws-analytics .ws-fmt-field')].find((l) => l.querySelector('.ws-fmt-label').textContent === ${J(label)}).querySelector('select'); s.value = ${J(value)}; s.dispatchEvent(new Event('change')); return true; })()`);
      await settle(400); await chartReady();
    };
    await aPick('Reference line', 'average'); await aPick('of', '1');
    const o = await opt();
    must(o.series[0].markLine == null && o.series[1].markLine && o.series[1].yAxisIndex === 1, `reference line on series 1: ${J(o.series.map((s) => [s.yAxisIndex, !!s.markLine]))}`);
    await shot('dual-refline-light.png');
    await aPick('Reference line', 'none');
    await ev(`document.querySelector('.ws-viewbar__btn[aria-label="Analytics"]').click()`);
    await openFormat(); await check1('Dual axis'); await settle(300);
    await ev(`__t.zone('rows').querySelector('button[aria-label="Remove field"]').click()`); await settle(400); // region stays on Columns, as the later checks expect one dimension
    await chartReady();
  });

  await check('Mark border: bars and heatmap cells take thin / thick strokes in the muted theme ink; None keeps the old look', async () => {
    await setType('Bar'); await openFormat(); await chartReady();
    must(await hasField('Mark border') && !(await hasField('Marker size (px)')), 'bar has border but no marker size');
    let o = await opt();
    must(!o.series[0].itemStyle.borderWidth, `none: ${o.series[0].itemStyle.borderWidth}`);
    await pick('Mark border', 'thin'); await chartReady();
    o = await opt();
    const muted = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--chart-muted').trim()`);
    must(o.series[0].itemStyle.borderWidth === 1 && o.series[0].itemStyle.borderColor.length > 0, `thin ${J(o.series[0].itemStyle)}`);
    await shot('bar-thin-light.png');
    await pick('Mark border', 'thick'); await chartReady();
    o = await opt();
    must(o.series[0].itemStyle.borderWidth === 3, 'thick');
    const colLight = o.series[0].itemStyle.borderColor;
    await theme('dark'); await settle(400); await chartReady();
    const colDark = (await opt()).series[0].itemStyle.borderColor;
    must(colLight !== colDark, `border colour follows the theme: ${colLight} / ${colDark}`);
    await shot('bar-thick-dark.png'); await theme('light'); await settle(400);
    await pick('Mark border', 'none');
    await dragChip('channel', `__t.zone('columns')`); await settle(400);
    await setType('Heatmap'); await openFormat(); await chartReady();
    o = await opt();
    must(o.series[0].itemStyle.borderWidth === 1 && o.series[0].type === 'heatmap', 'heatmap keeps its hairline by default');
    await pick('Mark border', 'thick'); await chartReady();
    o = await opt();
    must(o.series[0].itemStyle.borderWidth === 3, `heatmap thick ${J(o.series[0].itemStyle)}`);
    await shot('heatmap-thick-light.png');
    await theme('dark'); await shot('heatmap-thick-dark.png'); await theme('light');
    await pick('Mark border', 'none');
  });

  await check('Marker size: scatter, line and circle heatmap use it; out of range is refused; blank is automatic', async () => {
    // circle heatmap
    await pick('Shape', 'circle'); await chartReady();
    must(await hasField('Marker size (px)'), 'marker size on a heatmap');
    const symSize = () => ev(`window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')).getModel().getSeriesByIndex(0).getData().getItemVisual(0, 'symbolSize')`);
    await setNum('Marker size (px)', '30'); await chartReady();
    must((await symSize()) === 30, `circle heatmap size ${await symSize()}`);
    await shot('heatmap-circle-30-light.png');
    await setNum('Marker size (px)', '99'); await settle(300);
    must((await tick()).includes('4'), `refusal toast: ${await tick()}`);
    must((await symSize()) === 30, 'refused value not applied');
    await setNum('Marker size (px)', ''); await chartReady();
    must((await symSize()) !== 30, 'blank returns to automatic');
    await pick('Shape', 'square');
    // line markers
    await setType('Line'); await openFormat(); await chartReady();
    let o = await opt();
    must(o.series[0].symbolSize === 8, `line default ${o.series[0].symbolSize}`);
    await setNum('Marker size (px)', '16'); await chartReady();
    o = await opt();
    must(o.series[0].symbolSize === 16 && o.series[0].showSymbol === true, `line 16: ${o.series[0].symbolSize}`);
    await shot('line-marker-16-light.png');
    await setNum('Marker size (px)', '');
    // scatter
    await setType('Scatter'); await openFormat(); await chartReady();
    o = await opt();
    must(o.series[0].type === 'scatter' && o.series[0].symbolSize === 14, `scatter default ${J(o.series[0].symbolSize)}`);
    await setNum('Marker size (px)', '28'); await chartReady();
    o = await opt();
    must(o.series[0].symbolSize === 28, `scatter 28: ${o.series[0].symbolSize}`);
    await pick('Mark border', 'thick'); await chartReady();
    o = await opt();
    must(o.series[0].itemStyle.borderWidth === 3, 'scatter border');
    await shot('scatter-28-thick-light.png');
    await theme('dark'); await shot('scatter-28-thick-dark.png'); await theme('light');
    await pick('Mark border', 'none'); await setNum('Marker size (px)', '');
  });

  await check('Marker shape: line charts offer four shapes; the symbol follows; bars do not offer it', async () => {
    await setType('Line'); await openFormat(); await chartReady();
    must(await hasField('Marker shape'), 'line has Marker shape');
    let o = await opt();
    must(o.series[0].symbol === 'circle', `default ${o.series[0].symbol}`);
    for (const [v, sym] of [['square', 'rect'], ['diamond', 'diamond'], ['triangle', 'triangle']]) {
      await pick('Marker shape', v); await chartReady();
      o = await opt();
      must(o.series[0].symbol === sym, `${v}: ${o.series[0].symbol}`);
    }
    await shot('line-diamond-light.png');
    await pick('Marker shape', 'circle');
    await setType('Bar'); await openFormat();
    must(!(await hasField('Marker shape')), 'bar has no Marker shape');
  });

  await check('Mark border on pie, treemap and funnel: none keeps the surface gap; thin / thick use the muted ink', async () => {
    // Part-to-whole charts take one measure and one dimension: keep amount and region only.
    for (const f of ['channel', 'discount']) {
      await ev(`[...document.querySelectorAll('.ws-shelf--columns .ws-pill')].find((p) => p.textContent.includes(${J(f)})).querySelector('button[aria-label="Remove field"]').click()`); await settle(300);
    }
    for (const [label, pathOf, dflt] of [['Pie', 'series[0].itemStyle', 2], ['Treemap', 'series[0].itemStyle', 2], ['Funnel', 'series[0].itemStyle', 1]]) {
      await setType(label); await openFormat();
      try { await chartReady(); } catch (e) { throw new Error(`${label}: ${e.message}; chart text: ${await chartText()}`); }
      must(await hasField('Mark border') && !(await hasField('Marker size (px)')), `${label}: border but no marker size`);
      let o = await opt();
      must(o.series[0].itemStyle.borderWidth === dflt, `${label} none: ${J(o.series[0].itemStyle)}`);
      const surface = o.series[0].itemStyle.borderColor;
      await pick('Mark border', 'thin'); await chartReady();
      o = await opt();
      must(o.series[0].itemStyle.borderWidth === 1 && o.series[0].itemStyle.borderColor !== surface, `${label} thin: ${J(o.series[0].itemStyle)}`);
      await pick('Mark border', 'thick'); await chartReady();
      o = await opt();
      must(o.series[0].itemStyle.borderWidth === 3, `${label} thick`);
      await shot(`${label.toLowerCase()}-thick-light.png`);
      await theme('dark'); await settle(400); await chartReady();
      await shot(`${label.toLowerCase()}-thick-dark.png`); await theme('light'); await settle(400);
      await pick('Mark border', 'none');
    }
  });

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
  if (wbDir) rmSync(wbDir, { recursive: true, force: true });
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
