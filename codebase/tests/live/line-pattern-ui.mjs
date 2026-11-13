// Browser checks for Format → Line pattern (Solid / Dashed / Dotted) and Format → Line markers (Automatic / All / None) on Line, Area and Combo: the controls and their
// gates (a Size-thickness line, a stepped line, a cued chart, a combo with bar right-axis marks), what is drawn (zrender's own line dash and the symbols), hover with markers None,
// Data labels beside None, and screenshots (run once with SCHEME=dark for the dark set) (the PNG export reads the same chart instance's scene, which the dash assertions read; its bytes are not deterministic in headless, so they are not diffed).
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/line-pattern-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5265 ; stop it with fuser -k 5265/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5265';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'line-pattern-ui-shots');
mkdirSync(SHOTS, { recursive: true });
const SCHEME = process.env.SCHEME === 'dark' ? 'dark' : 'light'; // SCHEME=dark loads the page in the dark scheme (set before load)

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text'], ['discount', 'Float64', 'numeric'], ['placed', 'DateTime', 'temporal']],
  customers: [['country', 'String', 'text']],
};
const REGIONS = Array.from({ length: 70 }, (_, i) => 'R' + String(i + 1).padStart(2, '0')); // 70 points: past the 60 where Automatic stops drawing markers
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
      rows: Array.from({ length: n }, (_, r) => ({ keys: dims.map(() => REGIONS[r]), values: (body.measures ?? []).map((_, i) => 10 + ((r * 7 + i * 3) % 23)) })),
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


  const setField = (label, v) => ev(`(() => { const i = ${fmtField(label)}.querySelector('input'); i.value = ${J(v)}; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const toggle = (label) => ev(`${fmtField(label)}.querySelector('input').click()`);
  const formatOpen = () => ev(`!!(${fmtField('Number')})`);
  const openFormat = async () => { if (!(await formatOpen())) await ev(`${fmtTool}.click()`); await waitFor(`!!(${fmtField('Number')})`, 'format panel open'); };
  const closeFormat = async () => { if (await formatOpen()) await ev(`${fmtTool}.click()`); await settle(300); };
  // The mock answers rows in REGIONS order; a dimension's steps follow the SORTED members (APAC, CA, EU, JP, LATAM, MEA, UK, US): the expected rank of each row.
  const rankOfRow = REGIONS.map((r) => [...REGIONS].sort().indexOf(r));
  const byMember = (a) => rankOfRow.map((rk, i) => [rk, a[i]]).sort((x, y) => x[0] - y[0]).map((x) => x[1]); // values listed smallest member first
  const rectDim = (dim) => per(`Math.round(d.getItemGraphicEl(k).getBoundingRect().${dim})`);
  const cellClasses = () => ev(`[...document.querySelectorAll('#ws-chart table.xtab tbody td.num')].map((t) => t.className)`);
  const monotone = (a, up = true) => a.every((x, i) => i === 0 || (up ? x > a[i - 1] : x < a[i - 1]));


  // ---- helpers specific to this check ------------------------------------------------------------------------------
  const zr = (expr) => ev(`(() => { const z = ${inst}.getZr(); const list = z.storage.getDisplayList(true); return (${expr}); })()`);
  // The dash of every drawn line (a polyline with a stroke): null for a solid one, else its lineDash array.
  const dashes = () => zr(`list.filter((e) => e.type === 'ec-polyline' && e.style && e.style.stroke && e.style.stroke !== 'none' && !e.ignore).map((e) => (e.style.lineDash && e.style.lineDash !== 'solid' ? e.style.lineDash : null))`);
  const textCount = () => zr(`list.filter((e) => e.type === 'tspan' && e.style && String(e.style.text ?? '') !== '' && !e.ignore).length`);
  const drawnSymbols = () => ev(`(() => { const d = ${inst}.getModel().getSeriesByIndex(0).getData(); let n = 0; for (let k = 0; k < d.count(); k++) { const el = d.getItemGraphicEl(k); if (el && !el.ignore && el.invisible !== true) n++; } return n; })()`);
  const snap = async (name) => { await closeFormat(); const t = await ev(`document.documentElement.getAttribute('data-scheme') || 'light'`); try { // run the file with SCHEME=dark for the dark set (the charts read their tokens when drawn, so a mid-run toggle would show light charts on a dark page)
    writeFileSync(join(SHOTS, `${name}-${t}.png`), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } await openFormat(); }; // the chart without the Format panel over it; named by the scheme actually showing
  const snapPanel = async (name) => { await ev(`document.querySelector('#ws-toolfly .iconbtn[aria-label="Close editor"]')?.click()`); await openFormat(); const t = await ev(`document.documentElement.getAttribute('data-scheme') || 'light'`); try { writeFileSync(join(SHOTS, `${name}-${t}.png`), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } }; // with the Format panel open (the disabled controls and their reasons)
  const control = (label) => `${fmtField(label)}.querySelector('select')`;
  const fieldState = async (label) => ev(`(() => { const s = ${control(label)}; return s ? { value: s.value, disabled: s.disabled, title: s.title } : null; })()`);
  const pickOpt = async (label, v) => { await setSelect(label, v); await settle(500); };
  const scheme = async (t) => { await ev(`document.documentElement.${t === 'dark' ? "setAttribute('data-scheme', 'dark')" : "removeAttribute('data-scheme')"}`); await settle(500); };
  const series0 = async () => (await opt()).series[0];
  const hoverDot = async (di) => { // dispatch a hover over a point and report whether its dot exists and what the tooltip says
    await ev(`${inst}.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: ${di} })`);
    await ev(`${inst}.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: ${di} })`); await b.sleep(250);
    const dot = await ev(`(() => { const el = ${inst}.getModel().getSeriesByIndex(0).getData().getItemGraphicEl(${di}); return !!el && !el.ignore; })()`);
    const tip = await ev(`[...document.querySelectorAll('.ws-chart-canvas div')].map((d) => d.innerText).filter((t) => t && t.includes('\\n')).pop() ?? ''`);
    await ev(`${inst}.dispatchAction({ type: 'downplay', seriesIndex: 0, dataIndex: ${di} }); ${inst}.dispatchAction({ type: 'hideTip' })`);
    return { dot, tip };
  };

  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(500);
  await chartType('Line'); await openFormat();

  await check('Line pattern and Line markers are offered on a line, start at Solid / Automatic, and draw as before', async () => {
    must(await ev(`!!(${fmtField('Line pattern')}) && !!(${fmtField('Line markers')})`), 'both controls on a line');
    const p = await fieldState('Line pattern'), m = await fieldState('Line markers');
    must(p.value === 'solid' && !p.disabled && m.value === 'auto' && !m.disabled, J([p, m]));
    const s = await series0();
    must((s.lineStyle.type === undefined || s.lineStyle.type === 'solid') && s.showSymbol === false, 'a plain 70-point line: solid, no markers (as before): ' + J([s.lineStyle.type, s.showSymbol]));
    must((await dashes()).every((d) => d === null), 'every drawn line solid: ' + J(await dashes()));
    must(!/(Line pattern|Line markers)/.test(await ev(`(${fmtField('Number')}).textContent`)), 'sanity');
  });
  await check('Dashed / Dotted: the drawn line really is dashed (zrender lineDash), Solid brings it back; light and dark screenshots', async () => {
    await pickOpt('Line pattern', 'dashed');
    must((await series0()).lineStyle.type === 'dashed', 'option');
    const d = await dashes(); must(d.length >= 1 && d.every((x) => x === 'dashed'), 'drawn dashed: ' + J(d));
    await snap('pattern-dashed');
    await pickOpt('Line pattern', 'dotted');
    must((await series0()).lineStyle.type === 'dotted', 'dotted option');
    const dd = await dashes(); must(dd.length >= 1 && dd.every((x) => x === 'dotted'), 'drawn dotted: ' + J(dd));
    await snap('pattern-dotted');
    await pickOpt('Line pattern', 'solid');
    must((await dashes()).every((x) => x === null), 'solid again');
  });
  await check('Line markers All draws a dot on all 70 points; None draws none; Automatic is back to none past 60 points; light + dark screenshots', async () => {
    await pickOpt('Line markers', 'all');
    let s = await series0(); must(s.showSymbol === true && s.showAllSymbol === true, 'option');
    const n = await drawnSymbols(); must(n === 70, `all 70 dots drawn: ${n}`);
    await snap('markers-all');
    await pickOpt('Line markers', 'none');
    s = await series0(); must(s.showSymbol === false, 'none option');
    must((await drawnSymbols()) === 0, 'no dot drawn: ' + await drawnSymbols());
    must((await fieldState('Line markers')).title.includes('Marker size'), 'None says what it does to Marker size / shape');
    await snap('markers-none');
    await pickOpt('Line markers', 'auto');
    must((await series0()).showSymbol === false && (await drawnSymbols()) === 0, 'Automatic: none past 60 points');
  });
  await check('with markers None the hover still shows the point\'s dot and the tooltip lists its value', async () => {
    await pickOpt('Line markers', 'none');
    const h = await hoverDot(10);
    must(h.dot, 'the hovered point has its dot');
    must(/R11/.test(h.tip) && /amount|v0/.test(h.tip), 'the tooltip: ' + J(h.tip));
    await pickOpt('Line markers', 'auto');
  });
  await check('Dashed beside Dotted markers None: both settings at once', async () => {
    await pickOpt('Line pattern', 'dashed'); await pickOpt('Line markers', 'none');
    const s = await series0(); must(s.lineStyle.type === 'dashed' && s.showSymbol === false, 'both applied');
    await pickOpt('Line pattern', 'solid'); await pickOpt('Line markers', 'auto');
  });
  await check('Data labels with markers None: the label text is still drawn', async () => {
    await pickOpt('Line markers', 'none');
    const bare = await textCount();
    await toggle('Data labels'); await settle(600);
    const labelled = await textCount();
    must(labelled > bare, `the labels draw with markers None: ${bare} texts without, ${labelled} with`);
    must((await drawnSymbols()) === 70, 'the label anchors exist (clear): ' + await drawnSymbols());
    const fill = await ev(`${inst}.getModel().getSeriesByIndex(0).getData().getItemVisual(5, 'style').fill`);
    must(fill === 'transparent', 'the anchor is transparent, not opacity 0 (a label would inherit that): ' + fill);
    await snap('markers-none-labels');
    await pickOpt('Line markers', 'auto'); await toggle('Data labels'); await settle(400);
  });
  await check('an Area takes both controls: the border is dashed, the fill is not', async () => {
    await chartType('Area'); await openFormat();
    must(await ev(`!!(${fmtField('Line pattern')}) && !!(${fmtField('Line markers')})`), 'both on an area');
    await pickOpt('Line pattern', 'dashed');
    const s = await series0(); must(s.lineStyle.type === 'dashed' && !!s.areaStyle, 'area: dashed border + fill');
    await snap('area-dashed');
    await pickOpt('Line pattern', 'solid');
    await chartType('Line'); await openFormat();
  });
  await check('a Bar chart offers neither control', async () => {
    await chartType('Bar'); await openFormat();
    must(await ev(`!(${fmtField('Line pattern')}) && !(${fmtField('Line markers')})`), 'no controls on a bar');
    await chartType('Line'); await openFormat();
  });
  await check('Size on a straight line sets its thickness: Line pattern is disabled with the reason and the line stays solid; Line markers stay offered', async () => {
    await pickOpt('Line pattern', 'dashed'); // stored; Size then overrides it
    await dragChip('discount', toolEl('Size')); await settle(700); await openFormat();
    const p = await fieldState('Line pattern');
    must(p.disabled && /thickness/.test(p.title) && p.value === 'solid', J(p));
    must(await ev(`getComputedStyle(${control('Line pattern')}).opacity < 1 && getComputedStyle(${control('Line markers')}).opacity === '1'`), 'the disabled control looks disabled, the live one does not');
    must((await dashes()).every((x) => x === null), 'the line is solid: ' + J(await dashes()));
    const s = (await opt()).series; must(s.some((x) => x.type === 'custom'), 'the thickness overlay is drawn');
    must(!(await fieldState('Line markers')).disabled, 'markers are offered');
    await snapPanel('size-thickness-pattern-disabled');
    await pickOpt('Line style', 'step');
    const q = await fieldState('Line pattern'), m = await fieldState('Line markers');
    must(!q.disabled && m.disabled && /Size/.test(m.title) && m.value === 'all', 'stepped line: pattern offered, markers carry Size: ' + J([q, m]));
    must((await series0()).lineStyle.type === 'dashed', 'the stored Dashed applies again on a stepped line');
    await pickOpt('Line style', 'straight');
    await pickOpt('Line pattern', 'solid');
  });
  await check('Size removed: the pattern control is live again', async () => {
    if (await ev(`document.getElementById('ws-toolfly').hidden`)) { await ev(`${toolEl('Size')}.click()`); await settle(300); }
    await ev(`document.querySelector('#ws-toolfly .ws-pill button[aria-label="Remove field"]').click()`);
    await settle(700); await openFormat();
    must(await ev(`!document.querySelector('.ws-tool[aria-label^="Size"].is-set')`), 'Size is cleared');
    const p = await fieldState('Line pattern'); must(!p.disabled && p.value === 'solid', J(p));
    await pickOpt('Line pattern', 'dashed');
    must((await dashes()).every((x) => x === 'dashed'), 'and it draws dashed again: ' + J(await dashes()));
    await pickOpt('Line pattern', 'solid');
  });
  await check('a combo with bars on the right axis draws no lines: both controls are disabled with the reason', async () => {
    await newSheet();
    await dragChip('region', `__t.zone('columns')`);
    await dragChip('amount', `__t.zone('rows')`); await dragChip('discount', `__t.zone('rows')`);
    await settle(500);
    await chartType('Combo (dual-axis)'); await openFormat();
    const p = await fieldState('Line pattern'); must(!p.disabled, 'a combo with a line right axis: offered ' + J(p));
    await pickOpt('Right-axis marks', 'bar');
    const q = await fieldState('Line pattern'), m = await fieldState('Line markers');
    must(q.disabled && /no lines/.test(q.title) && m.disabled && /no lines/.test(m.title), J([q, m]));
    await pickOpt('Right-axis marks', 'line');
    await pickOpt('Line pattern', 'dotted');
    const s = (await opt()).series; must(s[0].type === 'bar' && s[1].lineStyle.type === 'dotted', 'bars untouched, the line dotted: ' + J(s.map((x) => [x.type, x.lineStyle?.type])));
    await snap('combo-dotted');
  });
  await check('a colour measure on several measures: each measure keeps its own dash and marker, both controls are disabled with the reason', async () => {
    await newSheet();
    await dragChip('region', `__t.zone('columns')`);
    await dragChip('amount', `__t.zone('rows')`); await dragChip('qty', `__t.zone('rows')`);
    await settle(400); await chartType('Line');
    await dragChip('discount', toolEl('Color')); await settle(700); await openFormat();
    const p = await fieldState('Line pattern'), m = await fieldState('Line markers');
    must(p.disabled && /measure/.test(p.title) && m.disabled && /measure/.test(m.title), J([p, m]));
    const ts = (await opt()).series.filter((x) => x.type === 'line').map((x) => x.lineStyle.type);
    must(J(ts) === J(['solid', 'dashed']), 'the measure cues: ' + J(ts));
    await snapPanel('cued-controls-disabled');
  });
  await check('past 2,000 points a straight line with Size draws Size as marker size: the panel agrees (pattern live, markers carry Size) and the dash applies; All skips sampling', async () => {
    for (let i = REGIONS.length; i < 2001; i++) REGIONS.push('R' + String(i + 1).padStart(4, '0'));
    await newSheet();
    await dragChip('region', `__t.zone('columns')`);
    await dragChip('amount', `__t.zone('rows')`);
    await settle(600); await chartType('Line');
    await dragChip('discount', toolEl('Size')); await settle(900); await openFormat();
    await ev(`document.querySelector('#ws-toolfly .iconbtn[aria-label="Close editor"]')?.click()`);
    await pickOpt('Line style', 'step'); await pickOpt('Line style', 'straight'); // rebuilds the panel after the 2,001-point chart has drawn
    const o = (await opt()).series;
    must(o.length === 1 && o[0].type === 'line', 'no thickness overlay past the bound: ' + J(o.map((x) => x.type)));
    const p = await fieldState('Line pattern'), m = await fieldState('Line markers');
    must(!p.disabled, 'Line pattern is live past the bound: ' + J(p));
    must(m.disabled && /Size/.test(m.title) && m.value === 'all', 'Line markers carry Size: ' + J(m));
    await pickOpt('Line pattern', 'dashed');
    must((await series0()).lineStyle.type === 'dashed', 'the dash applies');
    must((await series0()).sampling === 'lttb', 'Automatic samples a big canvas chart');
    await pickOpt('Line pattern', 'solid');
  });
  await check('a Line markers All chart of 2,001 points keeps every point (no sampling)', async () => {
    await ev(`${toolEl('Size')}.click()`); await settle(300);
    await ev(`document.querySelector('#ws-toolfly .ws-pill button[aria-label="Remove field"]').click()`);
    await settle(900); await openFormat();
    must((await series0()).sampling === 'lttb', 'Automatic samples');
    await pickOpt('Line markers', 'all');
    must((await series0()).sampling === 'none', 'All: no sampling (ECharts reads none): ' + (await series0()).sampling);
    await pickOpt('Line markers', 'auto');
  });
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
