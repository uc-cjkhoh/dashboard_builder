// Browser check for Detail on a bar / line / area (D170): the Detail members split each mark inside the unchanged categories (stacked segments, one line each), in one
// colour with no legend; a second measure puts Detail back to an extra category. Real Chromium over CDP, /api/* mocked. Run:  node tests/live/detail-split-ui.mjs
// (start the app first: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5180). Env: APP_URL, CDP_PORT, CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5180';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'detail-split-ui-shots');
mkdirSync(SHOTS, { recursive: true });
const LOOK = process.env.LOOK === 'onedark' ? 'onedark' : '';
const SCHEME = LOOK || process.env.SCHEME === 'dark' ? 'dark' : 'light'; // SCHEME=dark loads the page in the dark scheme (set before load)

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text'], ['discount', 'Float64', 'numeric'], ['placed', 'DateTime', 'temporal']],
  customers: [['country', 'String', 'text']],
};
const REGIONS = ['APAC', 'EU', 'US', 'LATAM', 'MEA', 'CA', 'UK', 'JP'];
const DIMVALS = { region: REGIONS, channel: ['web', 'shop', 'app'], country: ['DE', 'FR'] };
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
    // every dimension has its own members; several dimensions give the full product (a group per pair), the way a group-by does
    const members = dims.map((d) => DIMVALS[d.column] ?? REGIONS);
    let combos = [[]];
    for (const m of members) combos = combos.flatMap((c) => m.map((x) => [...c, x]));
    const value = (m, i, r) => (m.column === 'discount' ? (r - Math.floor(combos.length / 2)) * 10 : 10 * (r + 1) + i); // `discount` crosses zero; the rest are positive
    return { json: {
      rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: combos.map((keys, r) => ({ keys, values: (body.measures ?? []).map((m, i) => value(m, i, r)) })),
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
  const fly = `document.getElementById('ws-toolfly')`;
  const fmtTool = `document.querySelector('.ws-viewbar__btn[aria-label="Format"]')`;
  const tile = (key) => `document.querySelector('.ws-tool[data-tool="${key}"]')`;
  const chartType = async (name) => {
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === ${J(name)}).click()`);
    await settle(500);
  };
  const option = () => ev(`(() => { const o = window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas, #ws-chart [_echarts_instance_]') ?? document.querySelector('#ws-chart canvas').parentElement.parentElement).getOption(); return JSON.stringify({ series: o.series.map((s) => ({ name: s.name, type: s.type, stack: s.stack ?? null, color: s.itemStyle?.color ?? s.lineStyle?.color ?? null, n: s.data.length })), cats: (o.xAxis[0].data ?? o.yAxis[0].data ?? []), legend: Boolean(o.legend && o.legend[0] && o.legend[0].show !== false && (o.legend[0].data ?? []).length) }); })()`).then(JSON.parse);

  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(700);
  await chartType('Bar');
  const regions = (await option()).cats.length;
  await check('before Detail: one bar per region, one series, no legend', async () => {
    const o = await option();
    must(o.series.length === 1 && !o.legend, J(o));
  });
  await dragChip('channel', `${tile('detail')}`);
  await settle(700);
  await check('bar + Detail: the categories are unchanged and each channel is a stacked segment in one colour, no legend', async () => {
    const o = await option();
    must(o.cats.length === regions && o.cats.every((c) => !c.includes(' / ')), `categories changed: ${J(o.cats)}`);
    must(o.series.length === 3 && o.series.every((s) => s.stack === 'total'), `not stacked: ${J(o.series)}`);
    must(new Set(o.series.map((s) => s.color)).size === 1, `colours differ: ${J(o.series)}`);
    must(!o.legend, 'a legend appeared');
  });
  if (process.env.SHOT_DIR) await b.screenshot(process.env.SHOT_DIR + '/bar.png');
  await chartType('Line');
  await check('line + Detail: one line per channel in one colour, categories unchanged', async () => {
    const o = await option();
    must(o.cats.length === regions && o.series.length === 3 && new Set(o.series.map((s) => s.color)).size === 1 && !o.legend, J(o));
  });
  await chartType('Area');
  if (process.env.SHOT_DIR) await b.screenshot(process.env.SHOT_DIR + '/area.png');
  await check('area + Detail: draws (one series per channel)', async () => {
    const o = await option();
    must(o.cats.length === regions && o.series.length === 3, J(o));
  });
  await dragChip('qty', `__t.zone('rows')`);
  await settle(700);
  await chartType('Bar');
  await check('two measures: Detail stays an extra category (the old drawing)', async () => {
    const o = await option();
    must(o.cats.length === regions * 3 && o.cats.every((c) => c.includes(' / ')), J(o.cats));
  });
  console.log(`${passed} passed, ${failed} failed`);
} finally {
  if (b) await b.close();
}
process.exit(failed ? 1 : 0);
