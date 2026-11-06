// Browser checks for the continuous colour scale ramp and range scale (T03-19): the real dev app (APP_URL, default http://localhost:5218) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/colour-scale-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5218 ; stop it with fuser -k 5218/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5218';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'colour-scale-ui-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['discount', 'Float64', 'numeric'], ['placed', 'DateTime', 'temporal']],
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

  const fillsNow = async () => (await vm()).inRange.color;
  const vm = async () => (await ev(`window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')).getOption()`)).visualMap?.[0];
  const fmtField = (label) => `[...document.querySelectorAll('.ws-fmt-field')].find((l) => l.textContent.includes(${J(label)}))`;
  const setSelect = (label, v) => ev(`(() => { const s = ${fmtField(label)}.querySelector('select'); s.value = ${J(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const setNum = (label, v) => ev(`(() => { const i = ${fmtField(label)}.querySelector('input'); i.value = ${J(v)}; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

  await check('a scatter with continuous Colour draws on the brand ramp; Format offers ramp and range', async () => {
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('amount', `__t.zone('columns')`);
    await dragChip('qty', `__t.zone('columns')`);
    await settle(400);
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === 'Scatter').click()`);
    await settle(400);
    await dragChip('discount', `document.querySelector('.ws-tool[aria-label^="Color"]')`);
    await settle(500);
    await waitFor(`${fmtTool} !== null`, 'format tool');
    await ev(`${fmtTool}.click()`);
    await waitFor(`!!(${fmtField('Colour ramp')})`, 'ramp control');
    must(await ev(`!!(${fmtField('Colour from')}) && !!(${fmtField('Colour to')})`), 'range controls');
    const f = await fillsNow();
    must(f.length === 2 && f[0] !== f[1], 'ramp ends: ' + J(f));
    const v = await vm(); must(v && v.inRange.color.length === 2 && v.min === 12, 'visualMap ' + J(v));
    await shot('scale-light.png');
  });
  await check('choosing Blue recolours the points; reverse swaps the ends', async () => {
    const a = await fillsNow();
    await setSelect('Colour ramp', 'blue'); await settle(400);
    const bl = await fillsNow();
    must(J(a) !== J(bl), 'colours changed ' + J(a) + ' -> ' + J(bl));
    await setSelect('Colour ramp', 'brand'); await settle(400);
    must(J(await fillsNow()) === J(a), 'back to brand');
  });
  await check('a pinned range saturates points beyond it; an inverted range is refused', async () => {
    await setNum('Colour from', '25'); await settle(400);
    const v = await vm(); must(v.min === 25 && v.max > 25, 'range ' + J([v.min, v.max]));
    must(/beyond range/.test(v.text[0]), 'legend note while pinned: ' + J(v.text));
    const fills = await ev(`(() => { const i = window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')); const d = i.getModel().getSeriesByIndex(0).getData(); return Array.from({ length: d.count() }, (_, k) => [d.getRawDataItem(k).value[2], d.getItemVisual(k, 'style').fill]); })()`);
    must(fills[0][1] === fills[1][1] && fills[1][1] !== fills[2][1], 'values below the pin share the low-end colour: ' + J(fills));
    await setNum('Colour from', ''); await settle(300);
    must(!/beyond/.test((await vm()).text?.[0] ?? ''), 'no note once the pin is cleared');
    await setNum('Colour from', '25'); await settle(300);
    await setNum('Colour to', '20'); await settle(300);
    must((await toastText()).includes('less than'), 'toast: ' + await toastText());
    must(await ev(`${fmtField('Colour to')}.querySelector('input').value`) === '', 'refused value not kept');
    await ev(`document.documentElement.setAttribute('data-theme', 'dark')`);
    await settle(300);
    await shot('scale-dark.png');
  });
  await check('Diverging scale: three colours, centre in the legend, the ramp control gives way to a centre field', async () => {
    await setNum('Colour from', ''); await setNum('Colour to', ''); await settle(300);
    await setSelect('Colour scale', 'diverging'); await settle(500);
    must(await ev(`!!(${fmtField('Colour centre')}) && !(${fmtField('Colour ramp')})`), 'centre field replaces the ramp');
    const v = await vm();
    must(v.inRange.color.length === 3 && v.inRange.color[0] !== v.inRange.color[2], 'three stops: ' + J(v.inRange.color));
    must(/centre/.test(v.text[0]), 'legend names the centre: ' + J(v.text));
    const lo = v.min, hi = v.max;
    await setNum('Colour centre', '20'); await settle(400);
    const w = await vm();
    must(w.min + w.max === 40 && w.min <= lo && w.max >= hi, 'symmetric about 20: ' + J([w.min, w.max]));
    must(/centre 20/.test(w.text[0]), 'legend: ' + J(w.text));
    await shot('diverging-light.png');
    must(!(await ev(`!!(${fmtField('Colour from')})`)), 'no pins while diverging (the ends follow the centre)');
    await setNum('Colour centre', '1e20'); await settle(300);
    must((await toastText()).includes('1e15'), 'bad centre refused with a toast: ' + await toastText());
    must(await ev(`${fmtField('Colour centre')}.querySelector('input').value`) === '20', 'refused centre not kept');
    await ev(`document.documentElement.setAttribute('data-scheme', 'dark')`); await settle(400);
    await ev(`document.getElementById('toast').hidden = true`);
    await shot('diverging-scatter-dark.png');
    await ev(`document.documentElement.removeAttribute('data-scheme')`); await settle(300);
    await ev(`document.getElementById('toast').hidden = true`);
    await shot('diverging-scatter-light.png');
    await setSelect('Colour scale', 'sequential'); await settle(400);
    must((await vm()).inRange.color.length === 2, 'back to the sequential ramp');
    must(await ev(`!!(${fmtField('Colour from')})`), 'pins return with the sequential scale');
  });
  await check('Diverging heatmap: legend names the centre; light and dark shots', async () => {
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === 'Heatmap').click()`);
    await settle(400);
    await dragChip('country', `__t.zone('columns')`); await settle(400);
    await setSelect('Colour scale', 'diverging'); await settle(500);
    const v = await vm();
    must(v && v.inRange.color.length === 3 && /centre/.test(v.text?.[0] ?? ''), 'heatmap legend: ' + J(v?.text));
    await ev(`document.getElementById('toast').hidden = true`);
    await shot('diverging-heatmap-light.png');
    await ev(`document.documentElement.setAttribute('data-scheme', 'dark')`); await settle(400);
    await shot('diverging-heatmap-dark.png');
    await ev(`document.documentElement.removeAttribute('data-scheme')`);
  });
  await check('Steps: a heatmap legend of discrete steps named in words, on both scales, light and dark', async () => {
    await setSelect('Steps', '5'); await settle(500);
    let v = await vm();
    must(v && v.type === 'piecewise' && v.pieces.length === 5, 'five pieces: ' + J(v?.pieces?.length));
    must(v.pieces.every((p) => / to /.test(p.label)) && new Set(v.pieces.map((p) => p.color)).size === 5, 'boundaries in words, five colours: ' + J(v.pieces.map((p) => p.label)));
    must(/centre/.test((await ev(`window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')).getOption()`)).title?.[0]?.text ?? ''), 'centre named in the note');
    await ev(`document.getElementById('toast').hidden = true`);
    await shot('steps-diverging-light.png');
    await ev(`document.documentElement.setAttribute('data-scheme', 'dark')`); await settle(400);
    await setSelect('Steps', '5'); await settle(500); // redraw so the chart re-reads the dark tokens
    await shot('steps-diverging-dark.png');
    await ev(`document.documentElement.removeAttribute('data-scheme')`); await settle(300);
    await setSelect('Colour scale', 'sequential'); await settle(400);
    v = await vm();
    must(v.type === 'piecewise' && v.pieces.length === 5, 'sequential steps too');
    await shot('steps-sequential-light.png');
    await ev(`document.documentElement.setAttribute('data-scheme', 'dark')`); await settle(400);
    await setSelect('Steps', '5'); await settle(500); // redraw so the chart re-reads the dark tokens
    await shot('steps-sequential-dark.png');
    await ev(`document.documentElement.removeAttribute('data-scheme')`);
    await setSelect('Steps', '0'); await settle(400);
    must((await vm()).type === 'continuous', 'Continuous restores the gradient');
  });
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
