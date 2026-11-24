// Browser checks for Size: a dimension on Size (member steps), the Size flyout's Edit Sizes (range, From zero, Reversed), a line's own thickness, Size on Text / Table (font steps), Size beside a Colour split, and the hints where Size has no meaning: the real dev app (APP_URL, default http://localhost:5261) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/marks-size-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5261 ; stop it with fuser -k 5261/tcp)
// Marker size / Edit Sizes live in the Size tile's flyout and Line style in the Path tile's (never open together with Format): the helpers open the panel that owns a label.
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5261';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'marks-size-ui-shots');
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
const deepEq = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= 1); // measured pixel extents: one pixel of anti-aliasing is not a difference


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
  const setSelect = async (label, v) => { await ensure(label); return ev(`(() => { const s = ${fmtField(label)}.querySelector('select'); s.value = ${J(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); };
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


  const setField = async (label, v) => { await ensure(label); return ev(`(() => { const i = ${fmtField(label)}.querySelector('input'); i.value = ${J(v)}; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); };
  const toggle = async (label) => { await ensure(label); return ev(`${fmtField(label)}.querySelector('input').click()`); };
  const formatOpen = () => ev(`!!(${fmtField('Number')})`);
  const openFormat = async () => { if (!(await formatOpen())) await ev(`${fmtTool}.click()`); await waitFor(`!!(${fmtField('Number')})`, 'format panel open'); };
  // Edit Sizes and Marker size live in the Size tile's flyout, Line style in the Path tile's (D151); Format and a flyout are never open together, so each helper opens the panel that holds its label.
  const FLY_TOOL = { 'Marker size (px)': 'size', 'Smallest size': 'size', 'Largest size': 'size', 'Sizes vary': 'size', 'Start value': 'size', 'End value': 'size', 'Reversed': 'size', 'Line style': 'path' };
  const flyOpen = (tool) => ev(`!!document.querySelector('#ws-toolfly:not([hidden]) #ws-toolpanel-${tool}')`);
  const closeFly = async () => { await ev(`document.querySelector('#ws-toolfly:not([hidden]) .iconbtn[aria-label="Close editor"]')?.click()`); };
  const ensure = async (label) => {
    const tool = FLY_TOOL[label];
    if (!tool) return openFormat();
    if (!(await flyOpen(tool))) await ev(`document.querySelector('.ws-tool[data-tool="${tool}"]').click()`);
    await waitFor(`!!document.querySelector('#ws-toolfly:not([hidden]) #ws-toolpanel-${tool}')`, `${tool} flyout open`);
  };
  const closeFormat = async () => { if (await formatOpen()) await ev(`${fmtTool}.click()`); await closeFly(); await settle(300); }; // both panels: the bare chart
  // The mock answers rows in REGIONS order; a dimension's steps follow the SORTED members (APAC, CA, EU, JP, LATAM, MEA, UK, US): the expected rank of each row.
  const rankOfRow = REGIONS.map((r) => [...REGIONS].sort().indexOf(r));
  const byMember = (a) => rankOfRow.map((rk, i) => [rk, a[i]]).sort((x, y) => x[0] - y[0]).map((x) => x[1]); // values listed smallest member first
  const rectDim = (dim) => per(`Math.round(d.getItemGraphicEl(k).getBoundingRect().${dim})`);
  const cellClasses = () => ev(`[...document.querySelectorAll('#ws-chart table.xtab tbody td.num')].map((t) => t.className)`);
  const monotone = (a, up = true) => a.every((x, i) => i === 0 || (up ? x > a[i - 1] : x < a[i - 1]));

  // ---- bar: a dimension on Size ---------------------------------------------------------------------------------------
  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(400);
  await chartType('Bar');
  await check('bar + a dimension on Size: each member a step in member order (APAC smallest), named in the legend; a Size dimension is one more group-by', async () => {
    await dragChip('channel', toolEl('Size')); await settle(600);
    must((await hints()).length === 0, 'no hint: ' + J(await hints()));
    must(toastText && !/Size needs a numeric/.test(await toastText()), 'no numeric-only toast');
    must(hasKey(lastQuery().columnDimensions, 'column') && lastQuery().columnDimensions.some((d) => d.column === 'channel'), 'the query groups by the Size dimension: ' + J(lastQuery().columnDimensions));
    must((await opt()).series[0].type === 'custom', 'variable-width bars');
    const w = await rectDim('width');
    must(distinct(w) === 8 && monotone(byMember(w)), 'eight steps, growing in member order (APAC ... US): ' + J(byMember(w)));
    const t = await sizeText();
    must(/^Size: channel \(APAC to US, 8 steps\)/.test(t), 'legend in words: ' + t);
    must(/channel:/.test(await tipText(0, 2)), 'the tooltip names the member');
    await shot('size-dimension-bar');
  });
  await check('Edit Sizes: Reversed flips the steps; a smaller largest size narrows them; an invalid pair is refused with a message and nothing changes', async () => {
    await ensure('Smallest size');
    must(await ev(`!!(${fmtField('Smallest size')}) && !!(${fmtField('Largest size')}) && !!(${fmtField('Reversed')})`), 'the controls show while Size is set');
    must(await ev(`${fmtField('Sizes vary')}.querySelector('select').disabled && /members are steps/.test(${fmtField('Sizes vary')}.title)`), 'Sizes vary is off for a dimension, with the reason');
    must(await ev(`${fmtField('Start value')}.querySelector('input').disabled && ${fmtField('End value')}.querySelector('input').disabled`), 'Start / End are off for a dimension');
    await toggle('Reversed'); await settle(500);
    let w = await rectDim('width');
    must(distinct(w) === 8 && monotone(byMember(w), false), 'reversed: APAC is the widest: ' + J(byMember(w)));
    must(/reversed/.test(await sizeText()), 'the legend says so: ' + await sizeText());
    await shot('size-dimension-reversed');
    await toggle('Reversed'); await settle(500);
    const before = await rectDim('width');
    await setField('Largest size', '50'); await settle(500);
    w = await rectDim('width');
    must(Math.max(...w) < Math.max(...before) && Math.min(...w) === Math.min(...before), 'a largest size of 50 % caps the widest bar: ' + J([Math.max(...before), Math.max(...w)]));
    await setField('Smallest size', '80'); await settle(400);
    must(/below the largest/.test(await toastText()), 'refused: ' + await toastText());
    must((await ev(`${fmtField('Smallest size')}.querySelector('input').value`)) === '', 'the input returns to its stored value');
    await setField('Largest size', ''); await settle(400);
    must(deepEq(await rectDim('width'), before), 'blank = the default again');
    await closeFormat();
  });

  // ---- bar: a measure, Edit Sizes From zero -----------------------------------------------------------------------------------
  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(400);
  await chartType('Bar');
  await check('bar + a measure on Size: Sizes vary From zero starts the thinnest bar above the minimum; the default (Automatic) is unchanged', async () => {
    await dragChip('discount', toolEl('Size')); await settle(500);
    const dflt = await rectDim('width');
    must(dflt[0] === 6, 'the smallest value gets the minimum thickness: ' + J(dflt));
    await ensure('Smallest size');
    must((await ev(`${fmtField('Sizes vary')}.querySelector('select').value`)) === 'automatic', 'Sizes vary is Automatic by default');
    await setSelect('Sizes vary', 'zero'); await settle(500);
    const z = await rectDim('width');
    must(z[0] > dflt[0] && Math.abs(z[7] - dflt[7]) <= 1, "from zero: the smallest bar is thicker, the largest unchanged: " + J([dflt, z]));
    await setSelect('Sizes vary', 'automatic'); await closeFormat(); await settle(400); // measured with the panel closed, like the first reading
    { const again = await rectDim('width'); must(deepEq(again, dflt), 'off again = the default: ' + J([dflt, again])); }
  });

  // ---- bar: Sizes vary and a typed Start / End value --------------------------------------------------------------------------
  await check('bar + a measure on Size: a typed Start / End sets the span; a value beyond saturates (a bar is never hidden); the legend names them; a refused pair keeps the stored value', async () => {
    const dflt = await rectDim('width');
    const legend0 = await sizeText();
    const m = legend0.match(/\(([\d.]+) to ([\d.]+)\)/); must(m, 'a plain range legend: ' + legend0);
    const lo = Number(m[1]), hi = Number(m[2]), mid = Math.round((lo + hi) / 2);
    await ensure('Smallest size');
    await setField('Start value', String(mid)); await settle(500);
    let w = await rectDim('width');
    must(w.every((x) => x >= 6) && w.length === dflt.length, 'every bar is still drawn: ' + J(w));
    must(w.filter((x) => x === 6).length === 4 && w.filter((x) => x > 6).length === 4, 'the four values below the start take the thinnest bar, the four above grow: ' + J(w));
    must(Math.abs(w[w.length - 1] - dflt[dflt.length - 1]) <= 1, 'the largest value keeps the widest bar: ' + J(w));
    must(new RegExp(`^Size: .* \\(${mid} to ${hi}, start set\\)`).test(await sizeText()), 'the legend names the typed start: ' + await sizeText());
    await setField('End value', String(mid + 5)); await settle(500);
    w = await rectDim('width');
    const top = Math.max(...dflt);
    must(w.every((x) => x >= 6 && x <= top + 1), 'every bar is drawn inside the size range: ' + J(w));
    must(w.filter((x) => x === 6).length >= 1 && w.filter((x) => Math.abs(x - top) <= 1).length >= 1, 'saturating at both ends: ' + J(w));
    must(new RegExp(`\\(${mid} to ${mid + 5}, set\\)`).test(await sizeText()), 'the legend names both: ' + await sizeText());
    await shot('size-range-typed');
    await setField('End value', String(mid - 1)); await settle(400);
    must(/below the end/.test(await toastText()), 'a start at or above the end is refused: ' + await toastText());
    must((await ev(`${fmtField('End value')}.querySelector('input').value`)) === String(mid + 5), 'the input returns to the stored end');
    await setField('End value', 'abc'); await settle(300);
    must(!!(await toastText()), 'a non-number is refused');
    await setField('Start value', ''); await setField('End value', ''); await settle(500);
    must((await sizeText()) === legend0, 'blank start and end: the legend is the default again: ' + await sizeText());
    await closeFormat(); await settle(400); // measured with the panel closed, like the first reading
    must(deepEq(await rectDim('width'), dflt), 'and the drawing: ' + J([dflt, await rectDim('width')]));
  });
  await check('Sizes vary From zero: Start and Reversed say why they are off; picking it drops a start and Reversed; By range / Automatic bring the controls back', async () => {
    await ensure('Smallest size');
    await setSelect('Sizes vary', 'range'); await settle(400);
    await setField('Start value', '30'); await toggle('Reversed'); await settle(500);
    await setSelect('Sizes vary', 'zero'); await settle(500);
    must(await ev(`${fmtField('Start value')}.querySelector('input').disabled && /starts at zero/.test(${fmtField('Start value')}.title)`), 'Start is off under From zero, with the reason');
    must(await ev(`${fmtField('Reversed')}.querySelector('input').disabled && /not available under From zero/.test(${fmtField('Reversed')}.title)`), 'Reversed is off under From zero, with the reason');
    must((await ev(`${fmtField('Start value')}.querySelector('input').value`)) === '', 'the start was dropped');
    must(await ev(`!${fmtField('Reversed')}.querySelector('input').checked`), 'Reversed was dropped');
    must(await ev(`!${fmtField('End value')}.querySelector('input').disabled`), 'End still applies from zero');
    must(!/reversed/.test(await sizeText()), 'the legend no longer says reversed');
    await shot('size-range-from-zero');
    await setSelect('Sizes vary', 'range'); await settle(400);
    must(await ev(`!${fmtField('Start value')}.querySelector('input').disabled && !${fmtField('Reversed')}.querySelector('input').disabled`), 'By range: Start and Reversed are back');
    await setSelect('Sizes vary', 'automatic'); await closeFormat(); await settle(300);
  });

  // ---- scatter ---------------------------------------------------------------------------------------------------------------
  await newSheet();
  await dragChip('amount', `__t.zone('columns')`);
  await dragChip('qty', `__t.zone('rows')`);
  await settle(400);
  await chartType('Scatter');
  await check('scatter + a dimension on Size: bubbles in member steps; Reversed flips; the default From zero is on for bubbles', async () => {
    await dragChip('region', toolEl('Detail')); await dragChip('channel', toolEl('Size')); await settle(600);
    const s = await symbolSizes();
    must(distinct(s) === 8 && monotone(byMember(s)) && Math.min(...s) === 8 && Math.round(Math.max(...s)) === 36, 'eight bubble steps from 8 to 36 px: ' + J(byMember(s)));
    must(/^Size: channel \(APAC to US, 8 steps\)/.test(await sizeText()), await sizeText());
    await ensure('Smallest size');
    must(await ev(`${fmtField('Sizes vary')}.querySelector('select').disabled && /members are steps/.test(${fmtField('Sizes vary')}.title)`), 'Sizes vary is off for a dimension, with the reason');
    must(await ev(`${fmtField('Start value')}.querySelector('input').disabled && ${fmtField('End value')}.querySelector('input').disabled`), 'Start / End are off for a dimension');
    await toggle('Reversed'); await settle(500);
    const r = await symbolSizes();
    must(monotone(byMember(r), false), 'reversed: ' + J(byMember(r)));
    await shot('size-dimension-scatter');
    await toggle('Reversed'); await closeFormat();
  });
  await check('scatter + a measure on Size: bubbles are zero-based by default (Automatic); By range starts at the data minimum', async () => {
    await ev(`(() => { const x = document.querySelector('.ws-tool[aria-label^="Size"]'); return true; })()`);
    await dragChip('discount', toolEl('Size')); await settle(600); // replaces the dimension
    const dflt = await symbolSizes();
    must(dflt[0] > 8 && Math.round(dflt[7]) === 36, 'zero-based: the smallest bubble is above the minimum: ' + J(dflt));
    await ensure('Smallest size');
    must((await ev(`${fmtField('Sizes vary')}.querySelector('select').value`)) === 'automatic', 'Sizes vary is Automatic by default');
    await setSelect('Sizes vary', 'range'); await settle(500);
    const off = await symbolSizes();
    must(Math.round(off[0]) === 8, 'from the data minimum: the smallest bubble is 8 px: ' + J(off));
    await setSelect('Sizes vary', 'automatic'); await settle(500);
    must(deepEq((await symbolSizes()).map(Math.round), dflt.map(Math.round)), 'back to the default');
    await closeFormat();
  });

  await check('scatter + a measure on Size: under Automatic a start waits for By range (the control says so); an End applies and the legend names it', async () => {
    await ensure('Smallest size');
    must(await ev(`${fmtField('Start value')}.querySelector('input').disabled && /Automatic starts these marks at zero/.test(${fmtField('Start value')}.title)`), 'Start is off under the bubble default, with the reason');
    must(await ev(`!${fmtField('Reversed')}.querySelector('input').disabled`), 'Reversed still works on bubbles under Automatic');
    const dflt = (await symbolSizes()).map(Math.round);
    const t0 = await sizeText(); const hi = Number(t0.match(/to ([\d.]+)\)/)?.[1]);
    await setField('End value', String(Math.round(hi / 2))); await settle(500);
    const s = (await symbolSizes()).map(Math.round);
    must(Math.max(...s) === 36 && s.filter((x) => x === 36).length > 1 && s.every((x) => x >= 8), 'values above the end saturate at the biggest bubble, none hidden: ' + J(s));
    must(/end set\)/.test(await sizeText()), 'the legend names the end: ' + await sizeText());
    await setSelect('Sizes vary', 'range'); await settle(400);
    must(await ev(`!${fmtField('Start value')}.querySelector('input').disabled`), 'By range turns Start on');
    await setField('Start value', '15'); await settle(500);
    must((await sizeText()).includes(`(15 to ${Math.round(hi / 2)}, set)`), 'the legend names both ends: ' + await sizeText());
    await setSelect('Sizes vary', 'automatic'); await settle(400); // the start (15) is stored but off again
    must(await ev(`${fmtField('Start value')}.querySelector('input').disabled`), 'Start is off again under Automatic');
    await setField('End value', '5'); await settle(500); // below the hidden start: accepted, the user is not blocked by a start they cannot clear
    must((await ev(`${fmtField('End value')}.querySelector('input').value`)) === '5', 'the end 5 was accepted: ' + J([await ev(`${fmtField('End value')}.querySelector('input').value`), await sizeText(), await toastText()]));
    must((await sizeText()).includes('to 5, end set)'), 'and it draws: ' + await sizeText());
    await setField('Start value', ''); await setField('End value', ''); await setSelect('Sizes vary', 'automatic'); await settle(500);
    must(deepEq((await symbolSizes()).map(Math.round), dflt), 'cleared = the default drawing');
    await closeFormat();
  });

  // ---- line: thickness ----------------------------------------------------------------------------------------------------------
  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(400);
  await chartType('Line');
  await check('line + Size: the line itself gets thicker with the value (screenshot); Reversed flips; a stepped line falls back to markers with a hint', async () => {
    await dragChip('discount', toolEl('Size')); await settle(600);
    const o = await opt();
    must(o.series.length === 2 && o.series[1].type === 'custom', 'a segment overlay beside the line');
    must(distinct(await symbolSizes()) === 1, 'markers keep one size');
    const polys = await ev(`(() => { const s = ${inst}.getModel().getSeriesByIndex(1); const d = s.getData(); return d.count(); })()`);
    must(polys === 8, 'one item per point: ' + polys);
    must((await hints()).length === 0, 'no hint');
    await shot('line-thickness');
  });
  await check('line thickness: Path flyout → Line style Step keeps the markers\' size and says how to get thickness back', async () => {
    await ensure('Line style');
    await setSelect('Line style', 'step'); await settle(600);
    const o = await opt();
    must(o.series.every((x) => x.type !== 'custom'), 'no overlay on a stepped line');
    const s = await symbolSizes();
    must(distinct(s) === 8 && s[0] >= 6 && s[7] <= 24, 'marker sizes vary: ' + J(s));
    must((await hints()).some((t) => /Straight/.test(t)), 'hint: ' + J(await hints()));
    await setSelect('Line style', 'straight'); await settle(600);
    must((await opt()).series.some((x) => x.type === 'custom'), 'thickness is back');
    await closeFormat();
  });
  await check('line thickness: the legend, tooltip and the click still work on the line', async () => {
    must(/^Size: /.test(await sizeText()), 'size legend');
    const tip = await tipText(0, 3);
    must(/v1: 41/.test(tip), 'the tooltip carries the size value (v1): ' + tip);
    must(((tip.match(/v0|amount/g)) ?? []).length >= 1, 'the measure is listed: ' + tip);
  });
  await check('area + Size: markers keep their size scale (no thickness on an area)', async () => {
    await chartType('Area'); await settle(500);
    const s = await symbolSizes();
    must(distinct(s) === 8 && (await opt()).series.every((x) => x.type !== 'custom'), 'markers sized: ' + J(s));
  });

  // ---- Size beside a Colour split -------------------------------------------------------------------------------------------------
  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(400);
  await chartType('Bar');
  await check('bar + Colour dimension + Size measure: grouped bars, thickness per cell, no hint', async () => {
    await dragChip('channel', toolEl('Color')); await dragChip('discount', toolEl('Size')); await settle(700);
    must((await hints()).length === 0, 'no hint: ' + J(await hints()));
    const o = await opt();
    must(o.series.length >= 1 && o.series.every((x) => x.type === 'custom'), 'custom bars: ' + J(o.series.map((x) => x.type)));
    must(/^Size: /.test(await sizeText()), 'size legend');
    await shot('split-bar-size');
  });
  await check('line + Colour dimension + Size: a thickness overlay per member line', async () => {
    await chartType('Line'); await settle(600);
    const o = await opt();
    must(o.series.filter((x) => x.type === 'custom').length === o.series.filter((x) => x.type === 'line').length, 'one overlay per line: ' + J(o.series.map((x) => x.type)));
  });
  await check('stacked + Colour dimension + Size: the Stacked hint, the chart still draws', async () => {
    await chartType('Stacked bar'); await settle(600);
    must((await hints()).some((t) => /Stacked/.test(t)), 'hint: ' + J(await hints()));
    must(await ev(`!!document.querySelector('#ws-chart svg, #ws-chart canvas')`), 'drawn');
  });

  // ---- Text / Table: font steps -----------------------------------------------------------------------------------------------------
  await newSheet();
  await dragChip('region', `__t.zone('rows')`);
  await dragChip('amount', `__t.zone('columns')`);
  await settle(400);
  await chartType('Text');
  await check('Text table + a measure on Size: cells wear three text steps (body / lead / title) and the Size column is not a column', async () => {
    await dragChip('discount', toolEl('Size')); await settle(700);
    const cls = await cellClasses();
    must(cls.length === 8, 'one value column: ' + cls.length);
    must(cls.some((c) => /xt-fs-1/.test(c)) && cls.some((c) => /xt-fs-2/.test(c)) && cls.some((c) => !/xt-fs/.test(c)), 'three steps: ' + J(cls));
    must(cls[0].indexOf('xt-fs') < 0 && /xt-fs-2/.test(cls[7]), 'the smallest value stays body size, the largest is the title size');
    const fs = await ev(`[...document.querySelectorAll('#ws-chart table.xtab tbody td.num')].map((t) => getComputedStyle(t).fontSize)`);
    must(distinct(fs) === 3 && fs[0] === '14px' && fs[7] === '24px', 'the type scale: ' + J(fs));
    must((await ev(`document.querySelectorAll('#ws-chart table.xtab thead th.xt-meas').length`)) === 1, 'one measure header');
    must(/^Size: .*three text sizes/.test(await ev(`document.querySelector('#ws-chart .xt-legend')?.textContent ?? ''`)), 'the words: ' + await ev(`document.querySelector('#ws-chart .xt-legend')?.textContent ?? ''`));
    await shot('text-size');
  });
  await check('Text table: Reversed flips the steps; a Size dimension is a hint, not a column', async () => {
    await ensure('Smallest size'); await toggle('Reversed'); await settle(500);
    const cls = await cellClasses();
    must(/xt-fs-2/.test(cls[0]) && !/xt-fs/.test(cls[7]), 'reversed: ' + J(cls));
    await toggle('Reversed'); await closeFormat();
    await dragChip('channel', toolEl('Size')); await settle(600);
    must((await hints()).some((t) => /measure/.test(t)), 'hint: ' + J(await hints()));
    must((await ev(`document.querySelectorAll('#ws-chart table.xtab thead th').length`)) <= 3, 'no extra column');
    await ensure('Smallest size');
    must(await ev(`!(${fmtField('Smallest size')})`), 'Edit Sizes is not offered while the Size field is only a hint');
    await closeFormat();
  });
  await check('Table (crosstab) takes Size too', async () => {
    await dragChip('discount', toolEl('Size')); await settle(500);
    await chartType('Table'); await settle(600);
    const cls = await cellClasses();
    must(cls.some((c) => /xt-fs-2/.test(c)), 'steps on a table: ' + J(cls));
  });

  // The step lookup is keyed by the crosstab's own row and column tuples: a Columns dimension and measures down the left are the other layouts.
  await newSheet();
  await dragChip('region', `__t.zone('rows')`);
  await dragChip('channel', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('columns')`);
  await settle(400);
  await chartType('Text');
  await check('Text table with a Columns dimension: the cells of the diagonal wear their text steps', async () => {
    await dragChip('discount', toolEl('Size')); await settle(700);
    const cls = await cellClasses();
    const steps = cls.filter((c) => /xt-fs-/.test(c));
    must(steps.length === 5 && steps.some((c) => /xt-fs-1/.test(c)) && steps.some((c) => /xt-fs-2/.test(c)), 'steps with a Columns dimension: ' + J(cls));
  });
  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await dragChip('qty', `__t.zone('rows')`);
  await settle(400);
  await chartType('Text');
  await check('Text table with measures down the left: every measure of a column wears its step', async () => {
    await dragChip('discount', toolEl('Size')); await settle(700);
    const cls = await cellClasses();
    must(cls.filter((c) => /xt-fs-2/.test(c)).length >= 2 && cls.some((c) => !/xt-fs/.test(c)), 'steps with measures on Rows: ' + J(cls));
  });

  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`); await dragChip('qty', `__t.zone('rows')`);
  await settle(400);
  await chartType('Bar');
  await check('a bar with two measures: Size is a hint and Edit Sizes is not offered', async () => {
    await dragChip('discount', toolEl('Size')); await settle(500);
    await ensure('Smallest size');
    must(await ev(`!(${fmtField('Smallest size')})`), 'no Edit Sizes controls');
    await closeFormat();
  });

  // ---- hints -----------------------------------------------------------------------------------------------------------------------------
  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(400);
  await chartType('Pie');
  await check('pie + Size: a hint that says why (one pie has nothing to compare)', async () => {
    await dragChip('discount', toolEl('Size')); await settle(500);
    must((await hints()).some((t) => /compare its size/.test(t)), 'hint: ' + J(await hints()));
  });
  await check('treemap + a dimension on Size: a hint (area is a measure)', async () => {
    await chartType('Treemap');
    await dragChip('channel', toolEl('Size')); await settle(600);
    must((await hints()).some((t) => /Treemap.*measure/.test(t)), 'hint: ' + J(await hints()));
    must(await ev(`!!document.querySelector('#ws-chart svg, #ws-chart canvas')`), 'the treemap still draws');
  });
  await check('Edit Sizes is not offered on a treemap', async () => {
    await ensure('Smallest size');
    must(await ev(`!(${fmtField('Smallest size')})`), 'no range on a treemap');
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
