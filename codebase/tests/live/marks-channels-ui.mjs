// Browser checks for the Marks channels beyond scatter (colour measure on bar / line / area / pie / treemap, Size on bar / line / treemap, Colour dimension on scatter): the real dev app (APP_URL, default http://localhost:5260) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/marks-channels-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5260 ; stop it with fuser -k 5260/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5260';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'marks-channels-ui-shots');
mkdirSync(SHOTS, { recursive: true });
const SCHEME = process.env.SCHEME === 'dark' ? 'dark' : 'light'; // SCHEME=dark loads the page in the dark scheme (set before load)

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text'], ['discount', 'Float64', 'numeric'], ['placed', 'DateTime', 'temporal']],
  customers: [['country', 'String', 'text']],
};
const REGIONS = ['APAC', 'EU', 'US', 'LATAM', 'MEA', 'CA', 'UK', 'JP'];
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

  // page helpers: HTML5 drag-and-drop with a real DataTransfer, text lookup, dialog typing
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
    await ev(NEW_CALC);
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
  const confirmOpen = `[...document.querySelectorAll('dialog[open]')].find((d) => !d.classList.contains('calc-dialog') && !d.classList.contains('calc-manager'))`;
  const chartText = () => ev(`document.getElementById('ws-chart').textContent`);
  const canvasDrawn = () => ev(`!!document.querySelector('#ws-chart canvas, #ws-chart svg')`);
  const until = async (fn, label, timeout = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for: ${label}`); await b.sleep(50); } };
  // Wait until no new /api/query has arrived for `quiet` ms (polling, not a fixed sleep).
  const settle = async (quiet = 300) => { let n = -1; for (let i = 0; i < 60 && n !== queries.length; i++) { n = queries.length; await b.sleep(quiet); } };
  const lastQuery = () => queries[queries.length - 1];
  const hasKey = (o, k) => J(o).includes(`"${k}"`);

  // ---- setup: connect, add the two tables, open a worksheet -----------------------------------------------------
  if (SCHEME === 'dark') await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "new MutationObserver((_, o) => { if (document.documentElement) { document.documentElement.setAttribute('data-scheme', 'dark'); o.disconnect(); } }).observe(document, { childList: true })" }); // read at load
  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, 'databases listed');
  await ev(`(() => { for (const r of document.querySelectorAll('.db-row[data-db]')) if ((r.dataset.db === 'shop') !== (r.getAttribute('aria-expanded') === 'true')) r.click(); return true; })()`);
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
  const shot = async (name) => { try { writeFileSync(join(SHOTS, `${name}-${SCHEME}.png`), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } };
  const fmtTool = `document.querySelector('.ws-viewbar__btn[aria-label="Format"]')`;
  const fmtField = (label) => `[...document.querySelectorAll('.ws-fmt-field')].find((l) => l.textContent.includes(${J(label)}))`;
  const setSelect = (label, v) => ev(`(() => { const s = ${fmtField(label)}.querySelector('select'); s.value = ${J(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const inst = `window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas'))`;
  const opt = () => ev(`${inst}.getOption()`);
  const hints = () => ev(`[...document.querySelectorAll('#ws-chart .ws-hint')].map((h) => h.textContent)`);
  const chartType = async (name) => {
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === ${J(name)}).click()`);
    await settle(500);
  };
  const toolEl = (name) => `document.querySelector('.ws-tool[aria-label^="${name}"]')`;
  const newSheet = async () => {
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden && !!__t.chip('region') && !document.querySelector('.ws-shelf--columns .ws-pill')`, 'a fresh worksheet');
    await ev(`document.documentElement.${SCHEME === 'dark' ? "setAttribute('data-scheme', 'dark')" : "removeAttribute('data-scheme')"}`); // the boot script may have reset it
  };
  // The drawn marks, read from the live chart: per-item fill, graphic bounds, symbol size.
  const per = (expr) => ev(`(() => { const d = ${inst}.getModel().getSeriesByIndex(0).getData(); return Array.from({ length: d.count() }, (_, k) => (${expr})); })()`);
  const fills = () => per(`d.getItemVisual(k, 'style').fill`);
  const extent = (dim) => per(`Math.round(d.getItemGraphicEl(k).getBoundingRect().${dim})`);
  const symbolSizes = () => per(`(() => { const s = d.getItemVisual(k, 'symbolSize'); return Array.isArray(s) ? s[0] : s; })()`);
  const sizeText = async () => J((await opt()).graphic ?? []).match(/Size: [^"]*/)?.[0] ?? '';
  const distinct = (a) => new Set(a).size;
  const hex = (c) => ev(`'#' + echarts.color.parse(${J(c)}).slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')`);
  const tipText = async (si, di) => {
    await ev(`${inst}.dispatchAction({ type: 'showTip', seriesIndex: ${si}, dataIndex: ${di} })`); await b.sleep(200);
    return ev(`[...document.querySelectorAll('.ws-chart-canvas div')].map((d) => d.innerText).filter((t) => t && t.includes('\\n')).pop() ?? ''`);
  };

  // ---- bar: a measure on Colour -----------------------------------------------------------------------------------------
  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(400);
  await chartType('Bar');
  await check('bar + a measure on Colour: every bar takes its value\'s colour; the gradient legend names the measure; the ramp ends are the bar ends', async () => {
    await dragChip('qty', toolEl('Color'));
    await settle(500);
    must((await hints()).length === 0, 'no hint: ' + J(await hints()));
    const f = await fills();
    must(f.length === 8 && distinct(f) === 8, 'eight different bar colours: ' + J(f));
    const vm = (await opt()).visualMap?.[0];
    must(vm && vm.type === 'continuous' && vm.inRange.color.length === 2, 'gradient legend ' + J(vm));
    must(/v1|qty/.test(J(vm.text)), 'legend names the measure: ' + J(vm.text));
    must(f[0] === await hex(vm.inRange.color[0]) && f[7] === await hex(vm.inRange.color[1]), 'lowest and highest bar take the ramp ends: ' + J([f[0], f[7], vm.inRange.color]));
    const tip = await tipText(0, 2);
    must(/v1|qty/.test(tip), 'the tooltip carries the colour value: ' + tip);
    await shot('bar-colour');
  });
  await check('bar + colour: Format drops Colour by category, keeps the scale controls; Steps gives a stepped legend and four colours; Diverging gives three stops and a centre', async () => {
    await ev(`${fmtTool}.click()`);
    await waitFor(`!!(${fmtField('Colour ramp')})`, 'ramp control');
    must(await ev(`!(${fmtField('Colour by category')})`), 'no Colour by category while a measure is on Colour');
    await setSelect('Steps', '4'); await settle(500);
    const vm = (await opt()).visualMap?.[0];
    must(vm.type === 'piecewise' && vm.pieces.length === 4 && vm.pieces.every((p) => / to /.test(p.label)), 'stepped legend in words: ' + J(vm.pieces?.map((p) => p.label)));
    must(distinct(await fills()) === 4, 'four step colours');
    await setSelect('Steps', '0'); await settle(300);
    await setSelect('Colour scale', 'diverging'); await settle(500);
    const d = (await opt()).visualMap[0];
    must(d.inRange.color.length === 3 && /centre/.test(J(d.text)), 'diverging: three stops, centre named: ' + J(d.text));
    await setSelect('Colour scale', 'sequential'); await settle(300);
    await ev(`${fmtTool}.click()`); await settle(300);
  });
  await check('bar + Size: bars become variable-width (readable minimum, grow with the value); the Size legend names the field and its range; colour stays', async () => {
    await dragChip('discount', toolEl('Size'));
    await settle(500);
    must((await hints()).length === 0, 'no hint: ' + J(await hints()));
    must((await opt()).series[0].type === 'custom', 'a custom series draws the bars');
    const w = await extent('width');
    must(distinct(w) === 8 && w[0] < w[7] && w.every((x) => x >= 6), 'widths grow with the Size value, none under the minimum: ' + J(w));
    const t = await sizeText();
    must(/^Size: .*\(\d+ to \d+\)/.test(t), 'size legend in words: ' + t);
    must(distinct(await fills()) === 8, 'the colour measure is kept');
    must(/discount|v2/.test(await tipText(0, 2)), 'the tooltip carries the size value');
    await shot('bar-size');
  });
  await check('bar + Size + Data labels: each bar carries its value', async () => {
    await ev(`${fmtTool}.click()`);
    await waitFor(`!!(${fmtField('Data labels')})`, 'data labels control');
    await ev(`${fmtField('Data labels')}.querySelector('input').click()`); await settle(500);
    const t = await ev(`[...document.querySelectorAll('.ws-chart-canvas svg text')].map((x) => x.textContent).filter((x) => /^\\d+$/.test(x))`);
    must(['10', '20', '30', '40', '50', '60', '70', '80'].every((v) => t.includes(v)), 'a label per bar: ' + J(t));
    await ev(`${fmtField('Data labels')}.querySelector('input').click()`); await settle(300);
    await ev(`${fmtTool}.click()`); await settle(300);
  });
  await check('bar + Size: a click on a variable-width bar selects its member; the selection dims the others', async () => {
    const pos = await ev(`(() => { const d = ${inst}.getModel().getSeriesByIndex(0).getData(); const r = d.getItemGraphicEl(3).getBoundingRect(); const box = document.querySelector('.ws-chart-canvas').getBoundingClientRect(); return [box.left + r.x + r.width / 2, box.top + r.y + r.height / 2]; })()`);
    await b.click(pos[0], pos[1]); await settle(700);
    const sel = await ev(`document.querySelector('.ws-select__label')?.textContent ?? ''`);
    must(/Selected: .*(LATAM|region)/.test(sel), 'selection pill: ' + sel);
  });

  // ---- a bar chart with two measures, a horizontal one ----------------------------------------------------------------
  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`); await dragChip('qty', `__t.zone('rows')`);
  await settle(400);
  await chartType('Bar');
  await check('two measures on a bar: Size and a colour measure are hints, the bars still draw', async () => {
    await dragChip('discount', toolEl('Size')); await settle(500);
    let h = await hints();
    must(h.some((t) => /single measure/.test(t)), 'size hint: ' + J(h));
    await dragChip('discount', toolEl('Color')); await settle(500);
    h = await hints();
    must(h.some((t) => /single measure/.test(t)), 'colour hint: ' + J(h));
    must(await ev(`!!document.querySelector('#ws-chart svg, #ws-chart canvas')`), 'the chart is still drawn');
  });
  await newSheet();
  await dragChip('region', `__t.zone('rows')`);
  await dragChip('amount', `__t.zone('columns')`);
  await settle(400);
  await chartType('Bar');
  await check('horizontal bar + Size: thickness varies along the category axis; + a colour measure colours them', async () => {
    await dragChip('discount', toolEl('Size')); await settle(500);
    const h = await extent('height');
    const w = await extent('width');
    must(distinct(h) === 8 && h[0] < h[7], 'thickness grows with the Size value: ' + J(h));
    must(w[0] < w[7], 'lengths still follow the measure: ' + J(w));
    await dragChip('qty', toolEl('Color')); await settle(500);
    must(distinct(await fills()) === 8, 'eight colours');
    await shot('bar-horizontal-size-colour');
  });

  // ---- line and area -----------------------------------------------------------------------------------------------------
  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(400);
  await chartType('Line');
  await check('line + Size: the line\'s own thickness varies (a segment overlay; markers keep one size), with a Size legend; + a colour measure: coloured markers and a gradient line', async () => {
    await dragChip('discount', toolEl('Size')); await settle(500);
    must((await hints()).length === 0, 'no hint: ' + J(await hints()));
    const s = await symbolSizes();
    must(distinct(s) === 1, 'markers keep one size: ' + J(s));
    const o0 = await opt();
    must(o0.series.length === 2 && o0.series[1].type === 'custom' && o0.series[1].silent, 'a silent segment series sits beside the line: ' + J(o0.series.map((x) => x.type)));
    must(/^Size: /.test(await sizeText()), 'size legend');
    await dragChip('qty', toolEl('Color')); await settle(500);
    const o = await opt();
    must(o.series[0].lineStyle.color?.type === 'linear' || J(o.series[0].lineStyle.color).includes('colorStops'), 'the line is a gradient: ' + J(o.series[0].lineStyle.color).slice(0, 120));
    must(distinct(await fills()) === 8, 'markers coloured by value');
    must(o.visualMap?.[0]?.type === 'continuous', 'legend');
    await shot('line-size-colour');
  });
  await check('area + a colour measure: the fill follows the same gradient', async () => {
    await chartType('Area');
    const o = await opt();
    must(J(o.series[0].areaStyle.color).includes('colorStops'), 'area fill gradient');
    must(distinct(await fills()) === 8, 'markers coloured');
  });

  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`); await dragChip('qty', `__t.zone('rows')`);
  await settle(400);
  await chartType('Line');
  await check('line with two measures + Size: every line takes its own thickness overlay from the row\'s Size value, the legend names the field once per measure', async () => {
    await dragChip('discount', toolEl('Size')); await settle(600);
    must((await hints()).length === 0, 'no hint: ' + J(await hints()));
    const o = await opt();
    must(o.series.filter((x) => x.type === 'custom').length === 2 && o.series.filter((x) => x.type === 'line').length === 2, 'two lines, two overlays: ' + J(o.series.map((x) => x.type)));
    must(/^Size: /.test(await sizeText()), 'size legend');
    must(distinct(o.legend[0].data.map((d) => d.name ?? d)) === 2, 'the legend lists the two measures once: ' + J(o.legend[0].data));
  });
  await check('a bar chart split by a Colour field draws Size as grouped bars (no hint); a colour measure hides the member-colour editor', async () => {
    await newSheet();
    await dragChip('region', `__t.zone('columns')`);
    await dragChip('amount', `__t.zone('rows')`);
    await settle(300);
    await chartType('Bar');
    await dragChip('channel', toolEl('Color')); await dragChip('discount', toolEl('Size')); await settle(600);
    must((await hints()).length === 0, 'no hint: ' + J(await hints()));
    must((await opt()).series.every((x) => x.type === 'custom'), 'custom bars draw the split');
    must(await ev(`!!document.querySelector('#ws-chart svg, #ws-chart canvas')`), 'the split chart is still drawn');
    await dragChip('qty', toolEl('Color')); await settle(600);
    await ev(`${fmtTool}.click()`); await waitFor(`!!(${fmtField('Reverse palette')})`, 'format open');
    must(await ev(`!document.querySelector('.ws-memcol__toggle')`), 'no member-colour editor while a measure is on Colour');
    await ev(`${fmtTool}.click()`); await settle(300);
  });
  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(300);
  await chartType('Treemap');
  await check('a plain treemap keeps ECharts\' own box (no top / bottom set)', async () => {
    const sr = (await opt()).series[0];
    must(sr.bottom === undefined || sr.bottom === null, 'no bottom: ' + J([sr.top, sr.bottom]));
  });

  // ---- pie / donut ---------------------------------------------------------------------------------------------------------
  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(400);
  await chartType('Pie');
  await check('pie + a colour measure: slices coloured by value with the gradient legend; Size is a hint', async () => {
    await dragChip('qty', toolEl('Color')); await dragChip('discount', toolEl('Size')); await settle(500);
    const f = await fills();
    must(distinct(f) === 8, 'eight slice colours: ' + J(f));
    const o = await opt();
    must(o.visualMap?.[0]?.type === 'continuous', 'gradient legend');
    must((await hints()).some((t) => /compare its size/.test(t)), 'size hint: ' + J(await hints()));
    await shot('pie-colour');
    await chartType('Donut');
    must(distinct(await fills()) === 8, 'donut too');
  });

  // ---- treemap -------------------------------------------------------------------------------------------------------------
  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(400);
  await chartType('Treemap');
  await check('treemap + Size: the Size measure sets each tile\'s area, the shelf measure stays a label; + a colour measure shades the tiles', async () => {
    const before = (await opt()).series[0].data.map((n) => n.value);
    await dragChip('discount', toolEl('Size')); await settle(500);
    const o = await opt();
    const d = o.series[0].data;
    must(d.length === 8 && J(d.map((n) => n.value)) !== J(before), 'areas changed: ' + J([before, d.map((n) => n.value)]));
    must(d.every((n) => n.shelf !== undefined && n.size === n.value), 'tile data carries shelf and size');
    must(/^Size: /.test(await sizeText()), 'size legend');
    await dragChip('qty', toolEl('Color')); await settle(500);
    const f = (await opt()).series[0].data.map((n) => n.itemStyle?.color);
    must(distinct(f) === 8, 'tiles coloured by value: ' + J(f));
    must((await opt()).visualMap?.[0]?.type === 'continuous', 'gradient legend');
    const lum = (h) => { const n = parseInt(h.replace('#', ''), 16); const ch = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255); };
    const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const inks = (await opt()).series[0].data.map((n) => [n.label?.color, n.itemStyle?.color]);
    must(inks.every(([ink, bg]) => /^#[0-9a-f]{6}$/i.test(ink ?? '') && ratio(ink, bg) >= 4.5), 'every tile label is readable on its colour (4.5:1): ' + J(inks));
    must(/discount|v2/.test(await tipText(0, 1)), 'the tooltip names the size and colour measures');
    await shot('treemap-size-colour');
  });

  // ---- scatter: a Colour dimension -------------------------------------------------------------------------------------
  await newSheet();
  await dragChip('amount', `__t.zone('columns')`); await dragChip('qty', `__t.zone('columns')`);
  await settle(400);
  await chartType('Scatter');
  await check('scatter + a Colour dimension: one series per member in palette colours, a legend of members, the Format member colours list them', async () => {
    await dragChip('region', toolEl('Color')); await settle(600);
    must((await hints()).length === 0, 'no hint: ' + J(await hints()));
    const o = await opt();
    must(o.series.length === 8 && distinct(o.series.map((s) => s.name)) === 8, 'eight series: ' + o.series.length);
    must(o.legend?.[0]?.data?.length === 8, 'legend lists the members');
    const cols = o.series.map((s) => s.itemStyle.color);
    must(distinct(cols) === 8, 'distinct palette colours: ' + J(cols));
    await ev(`${fmtTool}.click()`);
    await waitFor(`!!document.querySelector('.ws-memcol__toggle') && !document.querySelector('.ws-memcol__toggle').disabled`, 'member colours enabled for scatter groups');
    await ev(`document.querySelector('.ws-memcol__toggle').click()`);
    must(await ev(`document.querySelectorAll('.ws-memcol__row').length`) === 8, 'eight member rows');
    const before = (await opt()).series[1].itemStyle.color;
    await ev(`document.querySelectorAll('.ws-memcol__row')[1].querySelectorAll('.ws-memcol__swatch')[15].click()`); // #000000
    await settle(500);
    const after = (await opt()).series[1].itemStyle.color;
    must(after === '#000000' && after !== before, 'the chosen member colour reaches the points: ' + J([before, after]));
    await ev(`document.querySelectorAll('.ws-memcol__row')[1].querySelector('.ws-memcol__reset').click()`); await settle(400);
    await ev(`${fmtTool}.click()`); await settle(300);
    await shot('scatter-colour');
  });
  await check('scatter + Colour and Shape on different fields: pair series, symbol by Shape member, colour by Colour member; one field on both is one legend', async () => {
    await dragChip('channel', toolEl('Shape')); await settle(600);
    let o = await opt();
    must(o.series.every((s) => / · /.test(s.name)), 'pair names: ' + J(o.series.map((s) => s.name)));
    must(distinct(o.series.map((s) => s.symbol)) > 1 && distinct(o.series.map((s) => s.itemStyle.color)) === 8, 'symbols by Shape member, colours by Colour member: ' + J(o.series.map((s) => [s.symbol, s.itemStyle.color])));
    await dragChip('region', toolEl('Shape')); await settle(600);
    o = await opt();
    must(o.series.length === 8 && o.series.every((s) => !/ · /.test(s.name)), 'one grouping when the field is the same: ' + J(o.series.map((s) => s.name)));
    must(distinct(o.series.map((s) => s.symbol)) >= 7, 'symbols differ by member: ' + J(o.series.map((s) => s.symbol)));
    must(distinct(o.series.map((s) => s.itemStyle.color)) === 8, 'colours differ by member');
    await shot('scatter-colour-shape');
  });

  // ---- hints on types with no mapping --------------------------------------------------------------------------------------
  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`); await dragChip('qty', `__t.zone('rows')`);
  await settle(400);
  await chartType('Stacked bar');
  await check('stacked bar + a colour measure and Size: hints, never an error', async () => {
    await dragChip('discount', toolEl('Color')); await dragChip('discount', toolEl('Size')); await settle(500);
    const h = (await hints()).join(' ');
    must(/Stacked/.test(h), 'hint: ' + h);
    must(await ev(`!!document.querySelector('#ws-chart svg, #ws-chart canvas')`), 'the chart is still drawn');
  });
  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(400);
  await check('the Size slot is quiet on a pie and not quiet on a bar', async () => {
    const quiet = () => ev(`document.querySelector('.ws-tool[aria-label^="Size"]')?.classList.contains('is-quiet')`);
    await chartType('Pie'); const q = await quiet();
    await chartType('Bar'); const bq = await quiet();
    must(q === true && bq === false, 'quiet on a pie, not on a bar: ' + J([q, bq]));
  });
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
