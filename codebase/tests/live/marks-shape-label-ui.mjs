// Browser checks for the Shape and Label channels: a measure on Shape (binned symbols, Format → Shape bins), Format → Edit member shapes, and the Label options (Format → Label marks). The real dev app (APP_URL, default http://localhost:5263) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/marks-shape-label-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5263 ; stop it with fuser -k 5263/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5263';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'marks-shape-label-ui-shots');
mkdirSync(SHOTS, { recursive: true });
const SCHEME = process.env.SCHEME === 'dark' ? 'dark' : 'light'; // SCHEME=dark loads the page in the dark scheme (set before load)

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text'], ['discount', 'Float64', 'numeric'], ['placed', 'DateTime', 'temporal']],
  customers: [['country', 'String', 'text']],
};
const REGIONS = ['APAC', 'EU', 'US', 'LATAM', 'MEA', 'CA', 'UK', 'JP'];
const ISO = ['2024-03-01', '2024-04-01', '2024-01-01', '2024-02-01', '2024-06-01', '2024-05-01', '2024-08-01', '2024-07-01']; // the latest is row 6
const queries = [];     // every /api/query body, in order
let tables = ['orders', 'customers'];
let longSeries = false; // a date axis of 200 days: past 60 points a line draws no markers by default
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
    const n = dims.length ? (longSeries && dims.some((d) => d.column === 'placed') ? 200 : REGIONS.length) : 1;
    return { json: {
      rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      // not monotonic (10, 40, 70, 20, 50, 80, 30, 60 + .37, so no label can be mistaken for an axis tick): the lowest is row 0, the highest row 5; a date key comes as an ISO month
      rows: Array.from({ length: n }, (_, r) => ({ keys: dims.map((d) => (d.column === 'placed' ? (longSeries ? new Date(Date.UTC(2024, 0, 1 + r)).toISOString().slice(0, 10) : ISO[r]) : REGIONS[r])), values: (body.measures ?? []).map((_, i) => 10 * (((r * 3) % 8) + 1) + i + 0.37) })),
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

  // ---- scatter: a measure on Shape -------------------------------------------------------------------------------------
  await newSheet();
  await dragChip('amount', `__t.zone('columns')`); await dragChip('qty', `__t.zone('columns')`);
  await dragChip('region', toolEl('Detail'));
  await settle(400);
  await chartType('Scatter');
  await check('a measure on Shape: the query carries it as a measure (not a group-by), the points split into bins with a symbol each, the legend names the ranges', async () => {
    await dragChip('discount', toolEl('Shape')); await settle(600);
    must((await toastText()) === '' || !/categorical/.test(await toastText()), 'no refusal toast: ' + await toastText());
    const q = lastQuery();
    must(J(q.measures).includes('discount') && !J([...(q.rowDimensions ?? []), ...(q.columnDimensions ?? [])]).includes('discount'), 'discount is a measure in the query: ' + J(q));
    must((await hints()).length === 0, 'no hint: ' + J(await hints()));
    const o = await opt();
    must(o.series.length === 5, 'five bins over eight evenly spread values: ' + J(o.series.map((s) => s.name)));
    must(o.series.every((s) => / to /.test(s.name)), 'bins named in words: ' + J(o.series.map((s) => s.name)));
    must(distinct(o.series.map((s) => s.symbol)) === 5, 'a distinct symbol per bin: ' + J(o.series.map((s) => s.symbol)));
    must(o.legend?.[0]?.data?.length === 5, 'a legend of the bins');
    const tip = await tipText(0, 0);
    must(/discount|v2/.test(tip) && /to/.test(tip), 'the tooltip carries the bin and the exact value: ' + tip);
    await shot('shape-measure');
  });
  await check('Format → Shape bins: shown only while Shape holds a measure; 3 bins give three series; 7 is not offered', async () => {
    await ev(`${fmtTool}.click()`);
    await waitFor(`!!(${fmtField('Shape bins')})`, 'the Shape bins control');
    must(await ev(`[...${fmtField('Shape bins')}.querySelectorAll('option')].map((o) => o.value).join(',')`) === '2,3,4,5,6', 'two to six');
    must(await ev(`!document.querySelector('.ws-memcol__toggle') || ![...document.querySelectorAll('.ws-memcol__toggle')].some((t) => /shapes/.test(t.textContent))`), 'no member shapes while Shape holds a measure');
    await setSelect('Shape bins', '3'); await settle(600);
    const o = await opt();
    must(o.series.length === 3 && distinct(o.series.map((s) => s.symbol)) === 3, 'three bins: ' + J(o.series.map((s) => s.name)));
    await ev(`${fmtTool}.click()`); await settle(300);
  });
  await check('a legend click on a bin only highlights: it never becomes a filter on the measure', async () => {
    await ev(`${inst}.dispatchAction({ type: 'legendToggleSelect', name: ${J((await opt()).series[0].name)} })`); await settle(500);
    must(await ev(`!document.querySelector('.ws-select')`), 'no selection chip');
    must(!(lastQuery().filters ?? []).length, 'no filter sent');
  });
  await check('Shape bins is gone when Shape is cleared; a dimension on Shape brings Edit member shapes instead', async () => {
    await ev(`${toolEl('Shape')}.click()`);
    await waitFor(`!!document.querySelector('.ws-pill--mark')`, 'the Shape pill is listed');
    await ev(`document.querySelector('.ws-pill--mark button').click()`);
    await settle(500);
    await ev(`${fmtTool}.click()`);
    await waitFor(`!!(${fmtField('Opacity')})`, 'Format open');
    must(await ev(`!(${fmtField('Shape bins')})`), 'no Shape bins control once Shape is empty');
    await ev(`${fmtTool}.click()`); await settle(300);
  });
  await newSheet();
  await dragChip('amount', `__t.zone('columns')`); await dragChip('qty', `__t.zone('columns')`);
  await settle(400);
  await chartType('Scatter');
  await dragChip('region', toolEl('Shape')); await settle(600);
  await check('a dimension on Shape: Edit member shapes lists the members; a pick changes that member\'s symbol and its legend icon; Reset and Reset all undo it', async () => {
    const before = (await opt()).series.map((s) => s.symbol);
    must(before.length === 8 && distinct(before) === 7, 'a symbol per member (seven symbols, the eighth repeats): ' + J(before));
    await ev(`${fmtTool}.click()`);
    await waitFor(`[...document.querySelectorAll('.ws-memcol__toggle')].some((t) => /member shapes/.test(t.textContent) && !t.disabled)`, 'the member shapes editor is enabled');
    must(await ev(`!(${fmtField('Shape bins')})`), 'no bins control for a dimension');
    await ev(`[...document.querySelectorAll('.ws-memcol__toggle')].find((t) => /member shapes/.test(t.textContent)).click()`);
    const rows = `[...document.querySelectorAll('.ws-memcol__body')].find((x) => x.querySelector('.ws-memcol__swatch svg')).querySelectorAll('.ws-memcol__row')`;
    must(await ev(`${rows}.length`) === 8, 'eight member rows');
    must(await ev(`${rows}[0].querySelectorAll('.ws-memcol__swatch').length`) === 7, 'seven shapes to pick from');
    must(await ev(`[...${rows}[0].querySelectorAll('.ws-memcol__swatch')].every((s) => s.title && s.getAttribute('aria-label'))`), 'each shape is named, not just drawn');
    await shot('member-shapes-open');
    await ev(`${rows}[1].querySelectorAll('.ws-memcol__swatch')[5].click()`); await settle(500); // Pin
    const after = (await opt()).series.map((s) => s.symbol);
    must(after[1] === 'pin' && after.filter((x, i) => i !== 1).join() === before.filter((x, i) => i !== 1).join(), 'only that member changed: ' + J([before, after]));
    must((await opt()).legend[0].data[1].icon === 'pin' && (await opt()).legend[0].data[0].icon === before[0], 'the legend icon wears the chosen symbol: ' + J((await opt()).legend[0].data.slice(0, 2)));
    must(await ev(`${rows}[1].querySelectorAll('.ws-memcol__swatch')[5].getAttribute('aria-pressed')`) === 'true', 'the picked shape is marked pressed');
    await ev(`${rows}[1].querySelector('.ws-memcol__reset').click()`); await settle(500);
    must(J((await opt()).series.map((s) => s.symbol)) === J(before), 'Reset restores the automatic symbol');
    await ev(`${rows}[2].querySelectorAll('.ws-memcol__swatch')[6].click()`); await settle(400);
    await ev(`[...document.querySelectorAll('.ws-memcol__clear')].pop().click()`); await settle(500);
    must(J((await opt()).series.map((s) => s.symbol)) === J(before), 'Reset all restores them');
    await ev(`${fmtTool}.click()`); await settle(300);
  });

  // ---- Label marks ---------------------------------------------------------------------------------------------------------
  // The drawn label texts that carry a value (the mock's values all end in .37; axis ticks never do).
  const labelTexts = () => ev(`[...document.querySelectorAll('#ws-chart svg text')].map((t) => t.textContent).filter((t) => /[.]37/.test(t))`);
  const labelControl = () => ev(`!!(${fmtField('Label marks')})`);
  const modes = () => ev(`[...${fmtField('Label marks')}.querySelectorAll('option')].map((o) => o.value).join(',')`);
  const openFormat = async () => { await ev(`${fmtTool}.click()`); await waitFor(`!!(${fmtField('Opacity')}) || !!(${fmtField('Top N')})`, 'Format open'); };
  const closeFormat = async () => { await ev(`${fmtTool}.click()`); await settle(300); };
  const setMode = async (m) => { await openFormat(); await setSelect('Label marks', m); await settle(600); await closeFormat(); };
  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(400);
  await chartType('Bar');
  await check('Label marks is offered only while labels are drawn: absent without Data labels or a Label field; then All, Min & max, Selected, Highlighted (no date, no line)', async () => {
    await openFormat();
    must(!(await labelControl()), 'no control while no label is drawn');
    await ev(`[...document.querySelectorAll('.ws-fmt-field')].find((l) => l.textContent.includes('Data labels')).querySelector('input').click()`); await settle(500);
    await waitFor(`!!(${fmtField('Label marks')})`, 'the control appears with Data labels');
    must((await modes()) === 'all,minmax,selected,highlighted', 'modes: ' + await modes());
    await closeFormat();
    must((await labelTexts()).length === 8, 'every bar is labelled by default: ' + J(await labelTexts()));
  });
  await check('Min & max: the lowest and the highest bar carry their value, nothing else; All brings every label back', async () => {
    await setMode('minmax');
    const t = await labelTexts();
    must(t.length === 2 && t.some((x) => /^10[.]37/.test(x)) && t.some((x) => /^80[.]37/.test(x)), 'two labels, the lowest 10.37 and the highest 80.37: ' + J(t));
    await shot('label-minmax');
    await setMode('all');
    must((await labelTexts()).length === 8, 'all eight again');
  });
  await check('Highlighted: no label at rest; a highlighted bar shows its own label; a legend-style highlight of the series shows them all', async () => {
    await setMode('highlighted');
    must((await labelTexts()).length === 0, 'no label at rest: ' + J(await labelTexts()));
    await ev(`${inst}.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: 3 })`); await b.sleep(400);
    const one = await labelTexts();
    must(one.length === 1 && /^20[.]37/.test(one[0]), 'only the highlighted bar is labelled: ' + J(one));
    await shot('label-highlighted');
    await ev(`${inst}.dispatchAction({ type: 'downplay' })`); await b.sleep(300);
    must((await labelTexts()).length === 0, 'the label goes away with the highlight');
    await ev(`${inst}.dispatchAction({ type: 'highlight', seriesIndex: 0 })`); await b.sleep(400);
    must((await labelTexts()).length === 8, 'highlighting the whole series labels every mark: ' + (await labelTexts()).length);
    await ev(`${inst}.dispatchAction({ type: 'downplay' })`);
  });
  await check('Selected: no label and a hint until a mark is clicked; the clicked bar then carries its label', async () => {
    await setMode('selected');
    must((await labelTexts()).length === 0, 'nothing selected, nothing labelled');
    must((await hints()).some((h) => /no mark in view is selected/.test(h)), 'the hint says why: ' + J(await hints()));
    const px = await ev(`(() => { const p = ${inst}.convertToPixel({ seriesIndex: 0 }, [2, 5]); const r = document.querySelector('.ws-chart-canvas').getBoundingClientRect(); return [r.left + p[0], r.top + p[1]]; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x: px[0], y: px[1], button: 'left', clickCount: 1 });
    await waitFor(`!!document.querySelector('.ws-select')`, 'a selection chip after the click');
    await settle(500);
    const t = await labelTexts();
    must(t.length === 1 && /^70[.]37/.test(t[0]), 'the clicked bar (third, 70.37) is labelled: ' + J(t));
    must(!(await hints()).some((h) => /no mark in view is selected/.test(h)), 'the hint is gone');
    await ev(`document.querySelector('.ws-select button[aria-label="Clear selection"]').click()`); await settle(500);
    await setMode('all');
  });
  await check('a pie: Min & max labels two slices, and no leader lines are left for the rest', async () => {
    await chartType('Pie');
    await openFormat();
    must((await modes()) === 'all,minmax,selected,highlighted', 'pie modes: ' + await modes());
    await setSelect('Label marks', 'minmax'); await settle(600); await closeFormat();
    const t = await labelTexts();
    must(t.length === 2, 'two slices labelled: ' + J(t));
    const o = await ev(`${inst}.getOption().series[0].data.map((d) => (d.labelLine ? d.labelLine.show : true))`);
    must(o.filter((x) => x === false).length === 6, 'six unlabelled slices have no leader line: ' + J(o));
    await shot('label-pie-minmax');
    await setMode('all');
  });

  // ---- Label marks on a line over dates -----------------------------------------------------------------------------
  await newSheet();
  await dragChip('placed', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(400);
  await chartType('Line');
  await openFormat();
  await ev(`[...document.querySelectorAll('.ws-fmt-field')].find((l) => l.textContent.includes('Data labels')).querySelector('input').click()`); await settle(500);
  await closeFormat();
  await check('a line over dates offers Most recent and Line ends; Line ends labels the first and the last point', async () => {
    await openFormat();
    must((await modes()) === 'all,minmax,selected,highlighted,recent,ends', 'line modes: ' + await modes());
    await setSelect('Label marks', 'ends'); await settle(600); await closeFormat();
    const t = await labelTexts();
    must(t.length === 2 && /^10[.]37/.test(t[0]) && /^60[.]37/.test(t[1]), 'the first (10.37) and last (60.37) points: ' + J(t));
    await shot('label-line-ends');
  });
  await check('Most recent labels the latest date wherever it falls in the drawn order', async () => {
    await setMode('recent');
    const t = await labelTexts();
    must(t.length === 1 && /^30[.]37/.test(t[0]), 'the latest date (row 7, 30.37): ' + J(t));
  });
  await check('switching to a bar keeps the stored mode out of the way: every mark is labelled and a hint says Line ends does not apply', async () => {
    await setMode('ends');
    await chartType('Bar');
    await settle(500);
    must((await labelTexts()).length === 8, 'every bar labelled');
    must((await hints()).some((h) => /Line ends/.test(h)), 'the hint names it: ' + J(await hints()));
    await chartType('Line'); await settle(500);
    must((await labelTexts()).length === 2, 'back on a line the mode returns');
  });

  // ---- Label marks on a bar whose thickness follows Size (a custom series draws its own labels) ---------------------------
  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await dragChip('qty', toolEl('Size'));
  await settle(400);
  await chartType('Bar');
  await openFormat();
  await ev(`[...document.querySelectorAll('.ws-fmt-field')].find((l) => l.textContent.includes('Data labels')).querySelector('input').click()`); await settle(500);
  await closeFormat();
  const shownLabels = () => ev(`[...document.querySelectorAll('#ws-chart svg text')].filter((t) => /^[0-9]+[.]37$/.test(t.textContent) && Number(getComputedStyle(t).opacity) > 0 && t.getAttribute('opacity') !== '0' && t.getAttribute('fill-opacity') !== '0').map((t) => t.textContent)`);
  await check('a Size bar chart: Min & max labels two bars; Highlighted hides the labels until a bar is highlighted', async () => {
    must((await shownLabels()).length === 8, 'every thick bar is labelled: ' + J(await shownLabels()));
    await setMode('minmax');
    must((await shownLabels()).length === 2, 'two labelled: ' + J(await shownLabels()));
    await setMode('highlighted');
    must((await shownLabels()).length === 0, 'none at rest: ' + J(await shownLabels()));
    await ev(`${inst}.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: 3 })`); await b.sleep(500);
    const t = await shownLabels();
    must(t.length === 1 && /^20[.]37/.test(t[0]), 'the highlighted bar shows its label: ' + J(t));
    await ev(`${inst}.dispatchAction({ type: 'downplay' })`);
    await shot('label-size-bar');
  });

  // ---- Label marks on a long line (past 60 points a line draws no markers: its labels must still show) ----------------------
  await check('a line of 200 days: Line ends, Min & max and Most recent still draw their labels', async () => {
    longSeries = true;
    await newSheet();
    await dragChip('placed', `__t.zone('columns')`);
    await dragChip('amount', `__t.zone('rows')`);
    await settle(500);
    await chartType('Line');
    await openFormat();
    await ev(`[...document.querySelectorAll('.ws-fmt-field')].find((l) => l.textContent.includes('Data labels')).querySelector('input').click()`); await settle(500);
    await closeFormat();
    const n = await ev(`${inst}.getOption().series[0].data.length`);
    must(n === 200, '200 points drawn: ' + n);
    const lab = async (m) => { await setMode(m); return labelTexts(); };
    const all = await labelTexts();
    const ends = await lab('ends'), mm = await lab('minmax');
    const recent = await lab('recent');
    await shot('label-long-line');
    must(ends.length === 2, 'Line ends labels the first and last point of 200: ' + J(ends) + ' (all: ' + all.length + ')');
    must(mm.length === 2 && mm.some((t) => /^10[.]37/.test(t)) && mm.some((t) => /^80[.]37/.test(t)), 'Min & max labels the lowest and the highest point: ' + J(mm));
    must(recent.length === 1, 'Most recent labels the last day: ' + J(recent));
    await setMode('ends');
    await ev(`${inst}.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 100 })`); await b.sleep(300);
    const tip = await ev(`[...document.querySelectorAll('.ws-chart-canvas div')].map((d) => d.innerText).filter((t) => t && /[0-9]/.test(t) && t.includes('\\n')).pop() ?? ''`);
    must(/2024-04-10|v0|amount/.test(tip) && /[0-9]+[.]37/.test(tip), 'the tooltip still shows on a clear (unlabelled) point of the long line: ' + J(tip));
    const clearOp = await ev(`${inst}.getOption().series[0].data[100].itemStyle.opacity`);
    must(clearOp === 0, 'an unlabelled point is clear, not shrunk');
    await setMode('highlighted');
    must((await labelTexts()).length === 0, 'Highlighted: no label at rest');
    await ev(`${inst}.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: 100 })`); await b.sleep(500);
    const one = await labelTexts();
    must(one.length === 1, 'Highlighted on a long line: the highlighted point shows its label: ' + J(one));
    await ev(`${inst}.dispatchAction({ type: 'downplay' })`);
    await setMode('all');
    longSeries = false;
  });

  // ---- Label position -------------------------------------------------------------------------------------------------------
  await check('Label position: offered on a line, moves the labels (above / below), absent on a bar', async () => {
    await newSheet();
    await dragChip('placed', `__t.zone('columns')`);
    await dragChip('amount', `__t.zone('rows')`);
    await settle(400);
    await chartType('Line');
    await openFormat();
    await ev(`[...document.querySelectorAll('.ws-fmt-field')].find((l) => l.textContent.includes('Data labels')).querySelector('input').click()`); await settle(500);
    await waitFor(`!!(${fmtField('Label position')})`, 'Label position appears with labels on a line');
    must(await ev(`[...${fmtField('Label position')}.querySelectorAll('option')].map((o) => o.value).join(',')`) === 'auto,above,below,left,right', 'five choices');
    const y = () => ev(`(() => { const t = [...document.querySelectorAll('#ws-chart svg text')].find((x) => /^10[.]37$/.test(x.textContent)); const m = /translate\\(([-0-9.]+) ([-0-9.]+)\\)/.exec(t.getAttribute('transform')); return [Number(m[1]), Number(m[2])]; })()`);
    const above = await y();
    await setSelect('Label position', 'below'); await settle(600);
    const below = await y();
    must(below[1] > above[1] + 8, 'Below sits lower than the automatic (above) place: ' + J([above, below]));
    await setSelect('Label position', 'right'); await settle(600);
    const right = await y();
    must(right[0] > above[0] + 4, 'Right sits to the right: ' + J([above, right]));
    await shot('label-position-right');
    await setSelect('Label position', 'auto'); await settle(600);
    must(J(await y()) === J(above), 'Automatic is back where it was');
    await closeFormat();
    await chartType('Bar'); await openFormat();
    must(!(await ev(`!!(${fmtField('Label position')})`)), 'no Label position on a bar');
    await closeFormat();
    await chartType('Area'); await openFormat();
    must(await ev(`!!(${fmtField('Label position')})`), 'Label position is offered on an area chart');
    await closeFormat();
    await chartType('Pie'); await openFormat();
    must(!(await ev(`!!(${fmtField('Label position')})`)), 'no Label position on a pie');
    await closeFormat();
  });

  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
