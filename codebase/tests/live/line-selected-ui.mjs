// Browser check for the Color flyout's Line markers → Selected: dots only at the click-selected marks. REAL mouse clicks on the real chart (a point is clicked where
// zrender drew it, found with convertToPixel): set Selected -> no marker is visible; click a point -> its dot shows on EVERY series; click it again -> cleared;
// a click on another point moves the dot; hover still shows a point's dot and tooltip; a long line (70 points) shows only the selected dots; an area and a combo;
// the control is disabled with the reason where Size draws the markers; a dashboard widget's cross-filter selection shows its dot; light + dark screenshots
// (run once with SCHEME=dark for the dark set). What is "visible" is read from zrender's own drawn items (a clear dot is drawn but transparent: it stays for hover once something is selected).
// Chromium over the DevTools protocol (tests/live/cdp.mjs), every /api/* call answered by a mock — nothing reaches a ClickHouse. Run:
//   node tests/live/line-selected-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5271 ; stop it with fuser -k 5271/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN, SCHEME=dark.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5271';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'line-selected-ui-shots');
mkdirSync(SHOTS, { recursive: true });
const SCHEME = process.env.SCHEME === 'dark' ? 'dark' : 'light'; // SCHEME=dark loads the page in the dark scheme (set before load)

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text'], ['discount', 'Float64', 'numeric'], ['placed', 'DateTime', 'temporal']],
  customers: [['country', 'String', 'text']],
};
const names = (n) => Array.from({ length: n }, (_, i) => 'R' + String(i + 1).padStart(2, '0'));
let REGIONS = names(8); // 8 points; the long-line check switches to 70 (past the 60 where Automatic stops drawing markers)
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
    if (dims[0]?.column === 'placed') { // a date axis: the server groups it by the asked grain (Auto -> month) unless Group dates is Exact, and says which key it grouped
      const MONTHS = ['2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01', '2024-05-01'];
      return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
        measures: (body.measures ?? []).map((_, i) => `v${i}`), rows: MONTHS.map((m, r) => ({ keys: dims.map(() => m), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i * 3) })),
        ...(body.dateBucket ? { bucket: { key: 0, grain: body.dateBucket === 'auto' ? 'month' : body.dateBucket } } : {}), truncated: false } };
    }
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
  // Line markers live in the Color tile's flyout (D151): every panel helper here opens and closes that flyout.
  const colTool = `document.querySelector('.ws-tool[data-tool="color"]')`;
  const colourOpen = () => ev(`!!document.querySelector('#ws-toolfly:not([hidden]) #ws-toolpanel-color')`);
  const openColour = async () => { if (!(await colourOpen())) await ev(`${colTool}.click()`); await waitFor(`!!document.querySelector('#ws-toolfly:not([hidden]) #ws-toolpanel-color')`, 'Color flyout open'); };
  const labTool = `document.querySelector('.ws-tool[data-tool="label"]')`;
  const labelOpen = () => ev(`!!document.querySelector('#ws-toolfly:not([hidden]) #ws-toolpanel-label')`);
  const openLabel = async () => { if (!(await labelOpen())) await ev(`${labTool}.click()`); await waitFor(`!!document.querySelector('#ws-toolfly:not([hidden]) #ws-toolpanel-label')`, 'Label flyout open'); };
  const closeColour = async () => { if (await colourOpen()) await ev(`${colTool}.click()`); if (await labelOpen()) await ev(`${labTool}.click()`); await settle(300); }; // whichever flyout is open
  // Data labels moved to the Label flyout, Line markers to the Color flyout; Group dates … stay in Format. Format and a flyout are never open together, so a helper opens the panel that holds its label.
  const formatOpen = () => ev(`!!(${fmtField('Number')})`);
  const ensure = async (label) => {
    if (label === 'Line markers') await openColour();
    else if (label === 'Show mark labels') await openLabel();
    else { if (!(await formatOpen())) await ev(`${fmtTool}.click()`); await waitFor(`!!(${fmtField('Number')})`, 'format panel open'); }
  };
  // The mock answers rows in REGIONS order; a dimension's steps follow the SORTED members (APAC, CA, EU, JP, LATAM, MEA, UK, US): the expected rank of each row.
  const rankOfRow = REGIONS.map((r) => [...REGIONS].sort().indexOf(r));
  const byMember = (a) => rankOfRow.map((rk, i) => [rk, a[i]]).sort((x, y) => x[0] - y[0]).map((x) => x[1]); // values listed smallest member first
  const rectDim = (dim) => per(`Math.round(d.getItemGraphicEl(k).getBoundingRect().${dim})`);
  const cellClasses = () => ev(`[...document.querySelectorAll('#ws-chart table.xtab tbody td.num')].map((t) => t.className)`);
  const monotone = (a, up = true) => a.every((x, i) => i === 0 || (up ? x > a[i - 1] : x < a[i - 1]));


  // ---- helpers specific to this check ------------------------------------------------------------------------------
  const zr = (expr) => ev(`(() => { const z = ${inst}.getZr(); const list = z.storage.getDisplayList(true); return (${expr}); })()`);
  const series0 = async () => (await opt()).series[0];
  const control = (label) => `${fmtField(label)}.querySelector('select')`;
  const fieldState = async (label) => { await ensure(label); return ev(`(() => { const s = ${control(label)}; return s ? { value: s.value, disabled: s.disabled, title: s.title, options: [...s.options].map((o) => o.value) } : null; })()`); };
  const pickOpt = async (label, v) => { await setSelect(label, v); await settle(500); };
  const snap = async (name) => { await closeColour(); const t = await ev(`document.documentElement.getAttribute('data-scheme') || 'light'`); try {
    writeFileSync(join(SHOTS, `${name}-${t}.png`), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } await openColour(); };
  // The marks zrender really drew on series `si`: { drawn: points with a symbol, visible: points whose symbol is not transparent }.
  const marksOf = (si = 0) => ev(`(() => { const d = ${inst}.getModel().getSeriesByIndex(${si}).getData(); const drawn = [], visible = [];
    for (let k = 0; k < d.count(); k++) { const el = d.getItemGraphicEl(k); if (!el || el.ignore) continue; drawn.push(k); if (d.getItemVisual(k, 'style').fill !== 'transparent') visible.push(k); }
    return { drawn, visible }; })()`);
  const snapPanel = async (name) => { await ev(`document.querySelector('#ws-toolfly .iconbtn[aria-label="Close editor"]')?.click()`); await openColour(); const t = await ev(`document.documentElement.getAttribute('data-scheme') || 'light'`); try { writeFileSync(join(SHOTS, `${name}-${t}.png`), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } }; // with the Format panel open (the disabled choice and its reason)
  const visible = async (si = 0) => (await marksOf(si)).visible;
  // A REAL mouse click on point `di` of series `si`, where the chart drew it.
  const pointXY = (di, si = 0) => ev(`(() => { const d = document.querySelector('.ws-chart-canvas'); d.scrollIntoView({ block: 'center' }); const i = ${inst}; const r = d.getBoundingClientRect();
    const raw = i.getOption().series[${si}].data[${di}]; const v = raw !== null && typeof raw === 'object' ? raw.value : raw; const p = i.convertToPixel({ seriesIndex: ${si} }, [${di}, v]);
    return { x: r.left + p[0], y: r.top + p[1] }; })()`);
  const clickPoint = async (di, si = 0) => { await closeColour(); const p0 = await pointXY(di, si); await b.sleep(80); const p = await pointXY(di, si); await b.click(p.x, p.y); await settle(700); return p0; };
  const hoverDot = async (di) => {
    await ev(`${inst}.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: ${di} })`);
    await ev(`${inst}.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: ${di} })`); await b.sleep(250);
    const dot = await ev(`(() => { const el = ${inst}.getModel().getSeriesByIndex(0).getData().getItemGraphicEl(${di}); return !!el && !el.ignore; })()`);
    const tip = await ev(`[...document.querySelectorAll('.ws-chart-canvas div')].map((d) => d.innerText).filter((t) => t && t.includes('\\n')).pop() ?? ''`);
    await ev(`${inst}.dispatchAction({ type: 'downplay', seriesIndex: 0, dataIndex: ${di} }); ${inst}.dispatchAction({ type: 'hideTip' })`);
    return { dot, tip };
  };
  const selectionPill = () => ev(`[...document.querySelectorAll('#worksheet-view *')].filter((x) => x.children.length === 0 && /region = R/.test(x.textContent)).map((x) => x.textContent)`);

  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(500);
  await chartType('Line'); await openColour();

  await check('Line markers offers Selected beside Automatic / All / None; Automatic is the default and draws a dot on every one of the 8 points as before', async () => {
    const m = await fieldState('Line markers');
    must(J(m.options) === J(['auto', 'selected', 'all', 'none']) && m.value === 'auto' && !m.disabled, J(m));
    must((await visible()).length === 8, 'Automatic: all 8 dots: ' + J(await marksOf()));
  });
  await check('Selected with nothing selected: no marker is visible on the line; the title says "no selection = no markers"', async () => {
    await pickOpt('Line markers', 'selected');
    const m = await fieldState('Line markers');
    must(m.value === 'selected' && !m.disabled && /no selection = no markers/.test(m.title), J(m));
    const k = await marksOf();
    must(k.visible.length === 0, 'nothing visible: ' + J(k));
    must(k.drawn.length === 0, 'no symbol is drawn at all (as under None): ' + J(k));
    await snap('selected-none');
  });
  await check('a real click on a point selects it (no dot exists to click: the hover symbol takes the click); its dot shows, the others stay clear; the redraw keeps Selected', async () => {
    await clickPoint(3);
    await openColour();
    must(J(await visible()) === J([3]), 'only point 3 shows a dot: ' + J(await marksOf()));
    must((await fieldState('Line markers')).value === 'selected', 'the control still reads Selected');
    const pill = await selectionPill(); must(pill.some((t) => /region = R04/.test(t)), 'the selection is R04: ' + J(pill));
    await snap('selected-one');
  });
  await check('clicking another point moves the dot; clicking the selected point again clears it (no marker)', async () => {
    await clickPoint(5);
    must(J(await visible()) === J([5]), 'the dot moved to point 5: ' + J(await marksOf()));
    await clickPoint(5);
    must((await visible()).length === 0, 'cleared: ' + J(await marksOf()));
    must((await marksOf()).drawn.length === 0, 'no symbol again');
    await clickPoint(5); must(J(await visible()) === J([5]), 'and still clickable');
    await clickPoint(5);
  });
  await check('hovering a clear point still shows its dot and the tooltip lists its value', async () => {
    await clickPoint(2);
    const h = await hoverDot(6);
    must(h.dot && /R07/.test(h.tip), 'hover: ' + J(h));
    must(J(await visible()) === J([2]), 'the selection is unchanged by a hover: ' + J(await visible()));
  });
  await check('with two measures every series shows its dot at the selected category', async () => {
    await dragChip('qty', `__t.zone('rows')`); await settle(700);
    await openColour();
    must((await fieldState('Line markers')).value === 'selected', 'still Selected');
    const o = (await opt()).series.filter((s) => s.type === 'line');
    must(o.length === 2, 'two lines');
    await closeColour();
    must(J(await visible(0)) === J([2]) && J(await visible(1)) === J([2]), 'both series show point 2: ' + J([await visible(0), await visible(1)]));
    await snap('selected-two-series');
    await clickPoint(2, 1);
    must((await visible(0)).length === 0 && (await visible(1)).length === 0, 'a click on the other series\' point clears both');
    await ev(`document.querySelector('.ws-shelf--rows .ws-pill:last-of-type button[aria-label="Remove field"], .ws-shelf--rows .ws-pill:last-child .ws-pill__remove')?.click()`);
    await settle(500);
  });
  await check('Selected is independent of Label marks: Data labels with Label marks All still label every point, the dot follows the selection', async () => {
    await openLabel();
    await toggle('Show mark labels'); await settle(600);
    const labelled = await zr(`list.filter((e) => e.type === 'tspan' && e.style && String(e.style.text ?? '') !== '' && !e.ignore).length`);
    await closeColour(); await clickPoint(1); await openLabel();
    const after = await zr(`list.filter((e) => e.type === 'tspan' && e.style && String(e.style.text ?? '') !== '' && !e.ignore).length`);
    must(labelled >= 8 && after >= 8, `the labels are drawn: ${labelled} / ${after}`);
    must(J(await visible()) === J([1]), 'the dot follows the click: ' + J(await visible()));
    await snap('selected-labels');
    await toggle('Show mark labels'); await settle(400);
    await clickPoint(1);
  });
  await check('an Area and a Combo take Selected the same way', async () => {
    await chartType('Area'); await openColour();
    must((await fieldState('Line markers')).options.includes('selected'), 'offered on an area');
    await clickPoint(4); must(J(await visible()) === J([4]), 'area: ' + J(await marksOf()));
    await snap('selected-area');
    await clickPoint(4);
    await dragChip('discount', `__t.zone('rows')`); await settle(500);
    await chartType('Combo (dual-axis)'); await openColour();
    must((await fieldState('Line markers')).options.includes('selected'), 'offered on a combo');
    await clickPoint(5, 1);
    const k = await visible(1);
    must(J(k) === J([5]), 'combo line series 1 shows the dot at point 5: ' + J(await marksOf(1)));
    await snap('selected-combo');
    await clickPoint(5, 1);
    await chartType('Line'); await openColour();
  });
  await check('Size on an area draws the markers itself: Line markers is disabled with the reason and reads All, even with Selected stored', async () => {
    await chartType('Area'); await openColour();
    await dragChip('discount', toolEl('Size')); await settle(700); await openColour();
    const m = await fieldState('Line markers');
    must(m.disabled && /Size/.test(m.title) && m.value === 'all', J(m));
    await closeColour();
    must((await visible()).length === 8, 'every marker is drawn, sized by Size: ' + J(await marksOf()));
    await snap('selected-size-disabled');
    await openColour();
    await ev(`${toolEl('Size')}.click()`); await settle(300);
    await ev(`document.querySelector('#ws-toolfly .ws-pill button[aria-label="Remove field"]').click()`); await settle(700);
    await chartType('Line'); await openColour();
    must((await fieldState('Line markers')).value === 'selected', 'Size removed: Selected is live again');
  });
  await check('a Bar chart still offers no Line markers control', async () => {
    await chartType('Bar'); await openColour();
    must(await ev(`!(${fmtField('Line markers')})`), 'none on a bar');
    await chartType('Line'); await openColour();
  });

  await check('a line over a date column: Auto keeps Selected with a hint above the chart; a grain disables the Selected choice with the reason; Exact selects with a real click', async () => {
    await newSheet();
    await dragChip('placed', `__t.zone('columns')`);
    await dragChip('amount', `__t.zone('rows')`);
    await settle(700); await chartType('Line'); await openColour();
    must(J((await fieldState('Line markers')).options) === J(['auto', 'selected', 'all', 'none']), 'Selected is offered');
    await pickOpt('Line markers', 'selected');
    const auto = await fieldState('Line markers');
    must(auto.value === 'selected' && !auto.disabled && /Group dates → Auto may group/.test(auto.title), 'Auto: the control is live with a note: ' + J(auto));
    const h = await hints(); must(h.some((t) => /Selected.*dates are grouped into periods.*Group dates → Exact/.test(t)), 'the chart says why no mark selects: ' + J(h));
    await snap('selected-date-auto-hint');
    await pickOpt('Group dates', 'month'); await openColour(); // Group dates is in Format, Line markers in the Color flyout
    const optDis = await ev(`(() => { const o = [...${control('Line markers')}.options].find((x) => x.value === 'selected'); return { disabled: o.disabled, title: o.title }; })()`);
    must(optDis.disabled && /Group dates is Month.*Exact/.test(optDis.title), 'a grain: the Selected choice is disabled with the reason: ' + J(optDis));
    must(!(await fieldState('Line markers')).disabled, 'the other choices stay usable');
    must((await fieldState('Line markers')).title.includes('Group dates is Month'), 'a stored Selected says why on the control');
    await snapPanel('selected-date-grain-disabled');
    await pickOpt('Group dates', 'exact'); await openColour();
    must(!(await ev(`[...${control('Line markers')}.options].find((x) => x.value === 'selected').disabled`)), 'Exact: Selected is available again');
    must((await hints()).every((t) => !/dates are grouped/.test(t)), 'and the hint is gone: ' + J(await hints()));
    await clickPoint(2);
    must(J(await visible()) === J([2]), 'Exact: a real click selects the third month: ' + J(await marksOf()));
    await snap('selected-date-exact');
    await clickPoint(2);
  });

  // ---- a dashboard widget: the board's cross-filter selection ------------------------------------------------------
  await check('a dashboard widget: a real click selects the mark (cross-filter) and its dot shows; clicking again clears it', async () => {
    await ev(`(async () => { const st = await import('/features/Core/store.js');
      const f = (column, category, extra = {}) => ({ db: 'shop', table: 'orders', column, category, ...extra });
      const mk = (name, chartType, dim, format) => { const t = st.createWorksheet(name); t.sheet = { ...st.emptySheet(), chartType, columns: [f(dim, 'text')], rows: [f('amount', 'numeric', { agg: 'sum' })], format: { ...st.defaultFormat(), ...format } }; return t; };
      mk('Trend', 'line', 'region', { lineMarkers: 'selected' }); mk('Split', 'bar', 'channel', {});
      st.createDashboard('Board'); return true; })()`);
    await waitFor(`!document.getElementById('board-view').hidden`, 'board shown');
    for (const n of ['Trend', 'Split']) await ev(`document.querySelector('.board-panel__item[data-sheet-id="' + [...document.querySelectorAll('.board-panel__item')].find((x) => x.querySelector('.board-panel__name').textContent === ${J(n)}).dataset.sheetId + '"] button').click()`);
    await waitFor(`document.querySelectorAll('.board-widget .ws-chart-canvas svg').length === 2`, 'two widgets drawn');
    await b.sleep(500);
    const W = (t) => `[...document.querySelectorAll('.board-widget')].find((x) => x.querySelector('.board-widget__title').textContent === ${J(t)})`;
    const wInst = (t) => `window.echarts.getInstanceByDom(${W(t)}.querySelector('.ws-chart-canvas'))`;
    const wVisible = (t) => ev(`(() => { const d = ${wInst(t)}.getModel().getSeriesByIndex(0).getData(); const out = []; for (let k = 0; k < d.count(); k++) { const el = d.getItemGraphicEl(k); if (el && !el.ignore && d.getItemVisual(k, 'style').fill !== 'transparent') out.push(k); } return out; })()`);
    const wClick = async (t, di) => {
      const xy = () => ev(`(() => { const w = ${W(t)}; w.scrollIntoView({ block: 'center' }); const d = w.querySelector('.ws-chart-canvas'); const i = ${wInst(t)}; const r = d.getBoundingClientRect();
        const raw = i.getOption().series[0].data[${di}]; const v = raw !== null && typeof raw === 'object' ? raw.value : raw; const p = i.convertToPixel({ seriesIndex: 0 }, [${di}, v]); return { x: r.left + p[0], y: r.top + p[1] }; })()`);
      await xy(); await b.sleep(80); const p = await xy(); await b.click(p.x, p.y); await b.sleep(700);
    };
    must((await wVisible('Trend')).length === 0, 'nothing selected: no visible dot: ' + J(await wVisible('Trend')));
    await wClick('Trend', 4);
    must(J(await wVisible('Trend')) === J([4]), 'the source widget shows the selected dot: ' + J(await wVisible('Trend')));
    must(await ev(`document.getElementById('board-filter').hidden === false`), 'the board chip shows the selection');
    await b.screenshot(join(SHOTS, `selected-dashboard-${SCHEME}.png`));
    await wClick('Trend', 4);
    must((await wVisible('Trend')).length === 0, 'clicking again clears it: ' + J(await wVisible('Trend')));
  });

  await check('a long line (70 points) shows only the selected dot; Automatic shows none past 60 points', async () => {
    REGIONS = names(70);
    await ev(`document.getElementById('board-view').hidden ? 0 : document.querySelector('.tab-add').click()`);
    await newSheet();
    await dragChip('region', `__t.zone('columns')`);
    await dragChip('discount', `__t.zone('rows')`); // a different measure: a different query, so the 70 rows are fetched
    await settle(600); await chartType('Line'); await openColour();
    must((await marksOf()).drawn.length === 0, 'Automatic: none past 60 points');
    await pickOpt('Line markers', 'selected');
    must((await visible()).length === 0 && (await marksOf()).drawn.length === 0, 'no symbol drawn: ' + (await marksOf()).drawn.length);
    await clickPoint(33);
    must(J(await visible()) === J([33]), 'only point 33 shows a dot: ' + J(await marksOf()));
    await snap('selected-long');
    await clickPoint(33);
    must((await visible()).length === 0, 'cleared');
  });

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
