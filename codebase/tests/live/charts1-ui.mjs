// Browser checks for line styles, circle heatmap and bullet target field (T03-05, T03-10, T03-12): the real dev app (APP_URL, default http://localhost:5191) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/charts1-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5191 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { CHIP_SCOPE, NEW_CALC, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5191';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'charts1-ui-shots');
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
      chip: (name) => [...document.querySelectorAll(${J(CHIP_SCOPE)})].find((c) => c.querySelector('.ws-field__name')?.textContent === name),
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
  const theme = async (t) => { await ev(`document.documentElement.setAttribute('data-scheme', ${J(t)})`); await settle(500); };
  const chartReady = () => waitFor(`!!document.querySelector('.ws-chart-canvas') && !!window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas'))`, 'chart drawn');

  await check('Line style appears for Line, not for Bar, and sets the line series step', async () => {
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('amount', `__t.zone('columns')`);
    await settle(400);
    await setType('Bar'); await openFormat();
    must(!(await hasField('Line style')), 'Line style on a bar');
    await setType('Line'); await openFormat(); await chartReady();
    must(await hasField('Line style'), 'Line style missing on a line');
    must((await opt()).series[0].step === false || (await opt()).series[0].step === undefined, 'straight by default');
    await pick('Line style', 'step'); await chartReady();
    must((await opt()).series[0].step === 'end', `step: ${(await opt()).series[0].step}`);
    await shot('line-step-light.png');
    await pick('Line style', 'jump'); await chartReady();
    must((await opt()).series[0].step === 'middle', 'jump');
    await theme('dark'); await shot('line-jump-dark.png'); await theme('light');
    await setType('Area'); await openFormat(); await chartReady();
    must((await opt()).series[0].step === 'middle', 'area keeps the style');
    await pick('Line style', 'straight');
  });

  globalThis.__failShot = async (n) => shot('fail-' + n.slice(0, 12).replace(/\W/g, '_') + '.png');
  await check('Heatmap: squares by default; Circles switch the series to scatter marks sharing the colour scale', async () => {
    await dragChip('channel', `__t.zone('columns')`);
    await settle(400);
    await setType('Heatmap'); await openFormat(); await chartReady();
    must(await hasField('Shape'), 'Shape missing on a heatmap');
    let o = await opt();
    must(o.series[0].type === 'heatmap', `default series: ${o.series[0].type}`);
    await shot('heatmap-squares-light.png');
    await pick('Shape', 'circle'); await chartReady();
    o = await opt();
    must(o.series[0].type === 'scatter' && o.series[0].symbol === 'circle', `circle series: ${J(o.series[0].type)}`);
    must(o.series[0].data.length === 9, `cells: ${o.series[0].data.length}`);
    const sz0 = await ev(`window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')).getModel().getSeriesByIndex(0).getData().getItemVisual(0, 'symbolSize')`);
    must(sz0 >= 6 && sz0 <= 48, `size ${sz0}`);
    must(o.visualMap.length === 1 && o.visualMap[0].dimension === 2, 'colour legend (visualMap) kept on the value');
    must(o.series[0].itemStyle.opacity === 1, 'circles are opaque');
    const size = () => ev(`(() => { const i = window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')); return [i.getWidth(), i.getModel().getSeriesByIndex(0).getData().getItemVisual(0, 'symbolSize')]; })()`);
    const [w0, s0] = await size();
    await ev(`(() => { const c = document.getElementById('ws-chart'); c.style.maxWidth = '240px'; c.style.width = '240px'; return true; })()`);
    await settle(600);
    const [w1, s1] = await size();
    must(w1 < w0 && s1 < s0, `circle size follows the pane: width ${w0}->${w1}, size ${s0}->${s1}`);
    await ev(`(() => { const c = document.getElementById('ws-chart'); c.style.maxWidth = ''; c.style.width = ''; return true; })()`);
    await settle(400);
    await shot('heatmap-circles-light.png');
    await theme('dark'); await shot('heatmap-circles-dark.png');
    await pick('Shape', 'square'); await chartReady();
    must((await opt()).series[0].type === 'heatmap', 'back to squares'); await theme('light');
  });

  await check('Bullet: a Target field supplies per-category targets; none falls back to the fixed Target', async () => {
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    await settle(400);
    await waitFor(`!!__t.chip('region')`, 'field pane');
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('amount', `__t.zone('columns')`);
    await dragChip('discount', `__t.zone('columns')`);
    await settle(400);
    await setType('Bullet'); await openFormat();
    must(await ev(`document.querySelector('.ws-chart-canvas') === null`), 'no chart until a target is given');
    must((await ev(`document.getElementById('ws-chart').textContent`)).includes('Target field'), 'hint names the Target field');
    must(await hasField('Target field'), 'Target field missing');
    const optsTxt = await ev(`[...[...document.querySelectorAll('.ws-fmt-field')].find((l) => l.querySelector('.ws-fmt-label').textContent === 'Target field').querySelectorAll('option')].map((o) => o.textContent)`);
    must(optsTxt.length === 2 && optsTxt[0].startsWith('None'), `options ${J(optsTxt)}`);
    await pick('Target field', '1'); await chartReady();
    let o = await opt();
    const tick = o.series.find((x) => x.name === 'Target');
    must(J(tick.data.map((d) => d[0])) === J([20, 35, 50]), `targets ${J(tick.data)}`); // second measure: 15*(r+1)+5
    await shot('bullet-field-light.png');
    await theme('dark'); await shot('bullet-field-dark.png'); await theme('light');
    await pick('Target field', 'null');
    must(await ev(`document.querySelector('.ws-chart-canvas') === null`), 'fixed target absent again -> hint');
    await ev(`(() => { const i = [...document.querySelectorAll('.ws-fmt-field')].find((l) => l.querySelector('.ws-fmt-label').textContent === 'Target').querySelector('input'); i.value = '25'; i.dispatchEvent(new Event('change')); return true; })()`);
    await settle(400); await chartReady();
    o = await opt();
    must(J(o.series.find((x) => x.name === 'Target').data.map((d) => d[0])) === J([25, 25, 25]), 'fixed target for every category');
  });
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
  if (wbDir) rmSync(wbDir, { recursive: true, force: true });
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
