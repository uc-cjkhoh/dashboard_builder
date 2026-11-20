// Browser checks for the Analytics card: reference line over a chosen measure, and standard-deviation / percentile bands (T07): the real dev app (APP_URL, default http://localhost:5219) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/ref-lines-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5219 ; stop it with fuser -k 5219/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5219';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'ref-lines-ui-shots');
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

  const anaTool = `document.querySelector('.ws-viewbar__btn[aria-label="Analytics"]')`;
  const openAna = async () => { if (!(await ev(`!!document.querySelector('.ws-analytics')`))) await ev(`${anaTool}.click()`); await waitFor(`!!document.querySelector('.ws-analytics')`, 'analytics panel'); };
  const aPick = async (label, value) => {
    await ev(`(() => { const s = [...document.querySelectorAll('.ws-analytics .ws-fmt-field')].find((l) => l.querySelector('.ws-fmt-label').textContent === ${J(label)}).querySelector('select'); s.value = ${J(value)}; s.dispatchEvent(new Event('change')); return true; })()`);
    await settle(400); await chartReady();
  };
  const aHas = (label) => ev(`[...document.querySelectorAll('.ws-analytics .ws-fmt-field')].some((l) => l.querySelector('.ws-fmt-label').textContent === ${J(label)})`);
  // the line/band sits on the series of the chosen measure (dual-axis change 310acbc), so read series[i]
  const mark = async (k, i = 0) => { const sr = (await opt()).series; must(sr[i] && sr[i][k], `no ${k} on series ${i}; carried by series ${J(sr.map((x, j) => x[k] ? j : null).filter((j) => j !== null))}`); return sr[i][k]; };

  await check('reference line reads the chosen measure; the label names it', async () => {
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('amount', `__t.zone('columns')`);
    await dragChip('discount', `__t.zone('columns')`);
    await settle(400);
    await setType('Bar'); await chartReady(); await openAna();
    await aPick('Reference line', 'average');
    let ml = await mark('markLine');
    must(ml.data[0].yAxis === 20 || ml.data[0].xAxis === 20, `first measure average: ${J(ml.data)}`);
    must(await aHas('of'), 'no measure chooser with two measures');
    await aPick('of', '1');
    must(!(await opt()).series[0].markLine, 'line stayed on the first measure');
    ml = await mark('markLine', 1);
    must(ml.data[0].yAxis === 35 || ml.data[0].xAxis === 35, `second measure average: ${J(ml.data)}`);
    must(/Average \(.+\): 35/.test(ml.label.formatter), `label: ${ml.label.formatter}`);
    await shot('refline-measure-light.png');
  });

  await check('distribution bands: mean ± 1σ and percentile range, each labelled with its rule', async () => {
    await aPick('Band', 'stddev1');
    let ma = await mark('markArea', 1);
    const [from, to] = [ma.data[0][0].yAxis ?? ma.data[0][0].xAxis, ma.data[0][1].yAxis ?? ma.data[0][1].xAxis];
    must(Math.abs(from - 20) < 1e-9 && Math.abs(to - 50) < 1e-9, `σ band ${from}..${to}`); // values 20,35,50: mean 35, sd 15
    must(/^Mean ± 1σ/.test(ma.label.formatter), `label ${ma.label.formatter}`);
    await aPick('Band', 'p25-75');
    ma = await mark('markArea', 1);
    const f2 = ma.data[0][0].yAxis ?? ma.data[0][0].xAxis, t2 = ma.data[0][1].yAxis ?? ma.data[0][1].xAxis;
    must(f2 === 27.5 && t2 === 42.5 && /^P25–P75/.test(ma.label.formatter), `percentile band ${f2}..${t2} ${ma.label.formatter}`);
    await shot('band-light.png');
    await aPick('Band', 'pcustom');
    must(await aHas('low percentile') && await aHas('high percentile'), 'custom percentile inputs missing');
    ma = await mark('markArea', 1);
    const bnd = (m) => [m.data[0][0].yAxis ?? m.data[0][0].xAxis, m.data[0][1].yAxis ?? m.data[0][1].xAxis];
    let [cf, ct] = bnd(ma);
    must(Math.abs(cf - 21.5) < 1e-9 && Math.abs(ct - 48.5) < 1e-9 && /^P5–P95/.test(ma.label.formatter), `custom P5-P95 ${cf}..${ct} ${ma.label.formatter}`);
    await setNum('low percentile', '10'); await setNum('high percentile', '90'); await chartReady();
    ma = await mark('markArea', 1); [cf, ct] = bnd(ma);
    must(Math.abs(cf - 23) < 1e-9 && Math.abs(ct - 47) < 1e-9 && /^P10–P90/.test(ma.label.formatter), `custom P10-P90 ${cf}..${ct}`);
    await setNum('high percentile', '100'); // refused with a message, not clamped: the band is unchanged
    must(/percentile/i.test(await tick()), 'no refusal message for 100');
    const fieldVal = (l) => ev(`[...document.querySelectorAll('.ws-fmt-field')].find((x) => x.querySelector('.ws-fmt-label').textContent === ${J(l)}).querySelector('input').value`);
    must(await fieldVal('high percentile') === '90', `refused 100 stayed in the box: ${await fieldVal('high percentile')}`);
    await setNum('low percentile', ''); // empty is refused too and restored
    must(await fieldVal('low percentile') === '10', `refused empty stayed: ${await fieldVal('low percentile')}`);
    ma = await mark('markArea', 1); [cf, ct] = bnd(ma);
    must(Math.abs(ct - 47) < 1e-9, `rejected value changed the band: ${ct}`);
    await setNum('high percentile', '95'); await chartReady();
    const clip = await ev(`(() => { const s = [...document.querySelectorAll('.ws-analytics .ws-fmt-field')].find((l) => l.querySelector('.ws-fmt-label').textContent === 'Band').querySelector('select'); return { t: s.selectedOptions[0].text, title: s.title, fits: s.scrollWidth <= s.clientWidth }; })()`);
    must(clip.t === 'Percentiles' && clip.title === 'Percentiles' && clip.fits, `band select clipped: ${J(clip)}`);
    await shot('band-custom-light.png');
    await theme('dark'); await settle(400); await chartReady();
    await shot('band-custom-dark.png'); await theme('light'); await settle(400);
    await theme('dark'); await settle(400); await chartReady();
    await shot('band-dark.png'); await theme('light'); await settle(400);
    await aPick('Band', 'range');
    must(await aHas('from') && await aHas('to'), 'typed range inputs missing');
  });

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
