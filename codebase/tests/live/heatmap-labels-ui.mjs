// Browser checks for heatmap cell labels (automatic when they fit, forced by the Label flyout's Data labels, ink per cell colour) and the
// stacked-scale notice: the real dev app (APP_URL, default http://localhost:5261) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/heatmap-labels-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5261 ; stop it with fuser -k 5261/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5261';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'heatmap-labels-ui-shots');
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
let CHANNELS = 3;      // members the channel dimension returns
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
    const members = (d) => (d.column === 'channel' ? Array.from({ length: CHANNELS }, (_, i) => 'ch' + (i + 1)) : REGIONS);
    let combos = [[]];
    for (const d of dims) combos = combos.flatMap((c) => members(d).map((m) => [...c, m]));
    return { json: {
      rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      // amount is in the hundred-thousands, the other measures in the tens: very different scales
      rows: combos.map((keys, r) => ({ keys, values: (body.measures ?? []).map((m) => (J(m).includes('amount') || (CHANNELS > 3 && J(m).includes('qty')) ? 100000 * (1 + (r % 8)) + 10 * r : 10 + (r % 8))) })),
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

  // ---- heatmap -------------------------------------------------------------------------------------------------------------
  const cellTexts = () => per(`((d.getItemGraphicEl(k)?.getTextContent() ?? d.getItemGraphicEl(k)?.getSymbolPath?.()?.getTextContent())?.style?.text ?? '')`); // the label drawn on each mark
  const labelled = async () => (await cellTexts()).filter((t) => t !== '').length;
  const cellInks = () => ev(`(() => { const o = ${inst}.getOption(); return o.series[0].data.map((d) => d.label?.color ?? null); })()`);
  const lum = (h) => { const n = parseInt(h.replace('#', ''), 16); const ch = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255); };
  const ratio = (a, c) => { const [hi, lo] = [lum(a), lum(c)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

  await newSheet();
  await dragChip('region', `__t.zone('rows')`);
  await dragChip('channel', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('columns')`);
  await settle(400);
  await chartType('Heatmap');
  await check('heatmap: large cells draw their values without Data labels on; the ink reads on each cell colour', async () => {
    await settle(500);
    must(await ev(`!!document.querySelector('#ws-chart .ws-chart-canvas svg')`), 'chart drawn: ' + (await chartText()).slice(0, 200));
    const o = await opt();
    must(o.series[0].type === 'heatmap', 'a heatmap series');
    const t = await cellTexts();
    must(t.length === 24 && t.every((x) => /^\d[\d,]+$/.test(x)), 'a value in each of the 24 cells: ' + J(t));
    const f = await Promise.all((await fills()).map(hex));
    const inks = await cellInks();
    must(inks.every((c) => /^#[0-9a-f]{6}$/i.test(c ?? '')), 'every cell has its own ink: ' + J(inks.slice(0, 3)));
    must(inks.every((c, i) => ratio(c, f[i]) >= 4.5), 'ink reads on its cell (4.5:1): ' + J(inks.map((c, i) => [c, f[i], ratio(c, f[i]).toFixed(1)]).filter(([, , r]) => r < 4.5)));
    must(distinct(inks) > 1, 'both inks are used across the ramp: ' + J([...new Set(inks)]));
    await shot('heatmap-labels');
  });
  await check('heatmap: cells too small hold no labels; Label flyout Data labels forces them on anyway', async () => {
    CHANNELS = 40;
    await newSheet();
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('channel', `__t.zone('columns')`);
    await dragChip('qty', `__t.zone('columns')`);
    await settle(400);
    await chartType('Heatmap'); await settle(800);
    must(await ev(`!!document.querySelector('#ws-chart .ws-chart-canvas svg')`), 'chart drawn: ' + (await chartText()).slice(0, 200));
    must((await cellTexts()).length === 320 && (await labelled()) === 0, 'no labels on the tiny cells: ' + await labelled());
    await shot('heatmap-labels-tiny');
    await ev(`document.querySelector('.ws-tool[data-tool="label"]').click()`); // Data labels live in the Label tile's flyout (D151), not in Format
    await waitFor(`!!document.querySelector('#ws-toolfly:not([hidden]) #ws-toolpanel-label') && !!(${fmtField('Show mark labels')})`, 'data labels control');
    await ev(`${fmtField('Show mark labels')}.querySelector('input').click()`); await settle(600);
    must((await labelled()) === 320, 'forced labels appear on every cell: ' + await labelled());
    await shot('heatmap-labels-forced');
    await ev(`${fmtField('Show mark labels')}.querySelector('input').click()`); await settle(500);
    must((await labelled()) === 0, 'unchecked: back to automatic (none, the cells are tiny)');
    await ev(`document.querySelector('#ws-toolfly:not([hidden]) .iconbtn[aria-label="Close editor"]')?.click()`); await settle(300);
    CHANNELS = 3;
  });
  await check('heatmap circles: a label is drawn inside each circle that is big enough for it', async () => {
    await newSheet();
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('channel', `__t.zone('columns')`);
    await dragChip('discount', `__t.zone('columns')`);
    await settle(400);
    await chartType('Heatmap'); await settle(600);
    await ev(`${fmtTool}.click()`);
    await waitFor(`!!(${fmtField('Shape')})`, 'shape control');
    await setSelect('Shape', 'circle'); await settle(700);
    must((await opt()).series[0].type === 'scatter', 'circles');
    const t = await cellTexts();
    must(t.length === 24 && (await labelled()) === 24, 'a label in each of the 24 circles: ' + J(t));
    await shot('heatmap-circles-labels');
    await setSelect('Shape', 'square'); await settle(400);
    await ev(`${fmtTool}.click()`); await settle(300);
  });

  // ---- stacked scale notice ---------------------------------------------------------------------------------------------------
  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`); await dragChip('qty', `__t.zone('rows')`);
  await settle(400);
  const notice = () => ev(`(() => { const n = document.getElementById('ws-chart-notice'); return n.hidden ? '' : n.textContent; })()`);
  const noticeIcon = () => ev(`!!document.querySelector('#ws-chart-notice svg')`);
  await chartType('Stacked bar');
  await check('stacked bar of measures on very different scales: a notice with an icon says the small one is almost invisible', async () => {
    const n = await notice();
    must(/v1|qty/i.test(n) && /under 2% of the tallest stack/.test(n) && /almost invisible/.test(n), 'notice: ' + n);
    must(await noticeIcon(), 'icon beside the text, not colour alone');
    await shot('stacked-notice');
  });
  await check('the same measures grouped (Bar) draw without that notice; so does a stack of similar scales', async () => {
    await chartType('Bar');
    must(!/almost invisible/.test(await notice()), 'no stacked notice on a grouped bar: ' + await notice());
    await newSheet();
    await dragChip('region', `__t.zone('columns')`);
    await dragChip('qty', `__t.zone('rows')`); await dragChip('discount', `__t.zone('rows')`); await settle(400); // both in the tens
    await chartType('Stacked bar');
    must(!/almost invisible/.test(await notice()), 'similar scales: ' + await notice());
  });
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
