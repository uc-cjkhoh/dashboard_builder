// Browser checks for the Gantt mark (T03-14): the real dev app (APP_URL, default http://localhost:5226) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/charts1-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5226 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5226';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'gantt-ui-shots');
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
      rows: combos.map((keys, r) => ({ keys, values: (body.measures ?? []).map((m, i) => (m.column === 'placed' ? (m.agg === 'max' ? `2026-02-1${r + 1}` : `2026-02-0${r + 1}`) : i === 0 ? 10 * (r + 1) : (m.agg === 'avg' ? 1234567.5 : 3) * (r + 1))) })),
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
const AGGL = { sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum', median: 'Median', stddev: 'Standard deviation', variance: 'Variance', count: 'Count', countDistinct: 'Count distinct', countNonNull: 'Count non-empty', attr: 'Attribute (single value)' }; // the menu's plain labels
const AGGRAW = Object.fromEntries(Object.entries(AGGL).map(([k, v]) => [v, k]));

let wbDir = null, b = null;
try {
  wbDir = mkdtempSync(join(tmpdir(), 'gantt-wb-'));
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

  const setAgg = async (pillSel, v) => { await ev(`document.querySelector(${J(pillSel)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))`); await ev(`[...document.querySelectorAll('.ctx-menu [role=menuitemradio]')].find((o) => o.textContent.trim() === ${J(AGGL[v] ?? v)}).click()`); await settle(400); };
  globalThis.__failShot = async (n) => shot('fail-' + n.slice(0, 12).replace(/\W/g, '_') + '.png');

  await check('Gantt: a date start (min) and a length in days draw one bar per region, first on top, never colour alone', async () => {
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('placed', `__t.zone('columns')`);
    await dragChip('amount', `__t.zone('columns')`);
    await settle(400);
    await ev(`document.querySelector('.ws-shelf--columns .ws-pill').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))`);
    await ev(`[...document.querySelectorAll('.ctx-menu .menu__item')].find((o) => o.textContent.trim() === 'Use as measure').click()`);
    await settle(400);
    await setAgg('.ws-shelf--columns .ws-pill', 'min');
    await setType('Gantt'); await chartReady();
    const o = await opt();
    const s = o.series.find((x) => x.type === 'custom');
    must(s && s.data.length === 3, `bars: ${s && s.data.length}`);
    must(o.xAxis[0].type === 'time', `axis ${o.xAxis[0].type}`);
    must(o.yAxis[0].inverse === true && J(o.yAxis[0].data) === J(REGIONS), `rows ${J(o.yAxis[0].data)}`);
    must(s.data[0][2] - s.data[0][1] === 86400000 * 3, 'first bar is 3 days long');
    must(o.legend[0].data.length === 1, 'legend names the length measure');
    const txt = await ev(`document.querySelector('.ws-chart-canvas').textContent`);
    must(/3 days/.test(txt) && /6 days/.test(txt), `length written at each bar: ${txt.slice(0, 120)}`);
    // the one-item legend is not a toggle: clicking it keeps the bars
    const r = await ev(`(() => { const r = document.querySelector('.ws-chart-canvas').getBoundingClientRect(); return [r.x + r.width / 2, r.y + 14]; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x: r[0] - 8, y: r[1], button: 'left', clickCount: 1 });
    await settle(300);
    must((await opt()).legend[0].selectedMode === false, 'legend selectedMode false');
    must(await ev(`/3 days/.test(document.querySelector('.ws-chart-canvas').textContent)`), 'bars still drawn after a legend click');
    await shot('gantt-date-light.png');
    await theme('dark'); await setType('Bar'); await setType('Gantt'); await chartReady(); await shot('gantt-date-dark.png'); await theme('light'); await setType('Bar'); await setType('Gantt'); await chartReady();
    must(!(await ev(`document.getElementById('ws-chart').textContent`)).includes('Gantt draws'), 'no hint');
  });

  await check('Gantt: numeric start and length; fewer than two measures shows the rule hint', async () => {
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    await settle(400);
    await waitFor(`!!__t.chip('region')`, 'field pane');
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('qty', `__t.zone('columns')`);
    await settle(400);
    await setType('Gantt');
    must((await ev(`document.getElementById('ws-chart').textContent`)).includes('Gantt draws each row'), 'one measure -> hint');
    await dragChip('amount', `__t.zone('columns')`);
    await settle(400); await chartReady();
    const o = await opt();
    const s = o.series.find((x) => x.type === 'custom');
    must(o.xAxis[0].type === 'value' && J(s.data.map((d) => [d[1], d[2]])) === J([[10, 13], [20, 26], [30, 39]]), `numeric bars ${J(s.data)}`);
    // a long length label keeps its room: the grid's right margin grows
    await shot('gantt-numeric-light.png');
    await theme('dark'); await setType('Bar'); await setType('Gantt'); await chartReady(); await shot('gantt-numeric-dark.png'); await theme('light');
  });
  await check('Gantt: a long length label (1,234,567.5) is not clipped: the right margin grows to fit it', async () => {
    await setAgg('.ws-shelf--columns .ws-pill:nth-child(2)', 'avg'); await chartReady();
    const o = await opt();
    must(o.grid[0].right > 56, `right margin ${o.grid[0].right}`);
    const w = await ev(`(() => { const i = window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')); return i.getWidth(); })()`);
    must(w > o.grid[0].right, 'chart wider than the margin');
    await shot('gantt-long-label-light.png');
  });
  // ---- length from an end field, colour split per bar, click-to-filter ------------------------------------------------------
  const ganttSeries = async () => (await opt()).series.filter((x) => x.type === 'custom');
  await check('Gantt: Format -> Length = End draws the bar from the start to the end measure (numbers: end - start)', async () => {
    // the sheet still holds region on Rows, qty (start) and amount (average) on Columns; the mock end is 1,234,567.5 x (row + 1)
    await openFormat();
    must(await hasField('Length'), 'a Length control on a Gantt');
    await pick('Length', 'end'); await chartReady();
    const s = (await ganttSeries())[0];
    must(s.data.length === 3, `bars ${s.data.length}`);
    must(s.data[0][1] === 10 && s.data[0][2] === 1234567.5, `first bar spans start to end: ${J(s.data[0])}`);
    const txt = await ev(`document.querySelector('.ws-chart-canvas').textContent`);
    must(/1,234,557/.test(txt), `length (end - start) written at the bar: ${txt.slice(0, 120)}`);
    await shot('gantt-end-numeric-light.png');
    await pick('Length', 'length'); await chartReady();
    must((await ganttSeries())[0].data[0][2] === 10 + 1234567.5, 'back to Length: start + length');
    await pick('Length', 'end');
  });
  await check('Gantt: a Colour field draws a bar per row and member, one series per member with a legend, and the tooltip names the member', async () => {
    await dragChip('channel', `document.querySelector('.ws-tool[aria-label^="Color"]')`);
    await settle(500); await chartReady();
    const o = await opt();
    const ss = await ganttSeries();
    must(ss.length === 3 && J(ss.map((x) => x.name)) === J(REGIONS), `a series per member: ${J(ss.map((x) => x.name))}`);
    must(ss.every((x) => x.data.length === 3), 'each member has a bar on every row');
    must(J(o.yAxis[0].data) === J(REGIONS), `rows stay one slot each: ${J(o.yAxis[0].data)}`);
    must(o.legend[0].data.length === 3 && o.legend[0].selectedMode !== false, `legend names the members: ${J(o.legend[0])}`);
    const dq = lastQuery();
    must(J(dq).includes('channel'), 'the colour field is a group-by in the query');
    await shot('gantt-colour-light.png');
    await theme('dark'); await setType('Bar'); await setType('Gantt'); await chartReady(); await shot('gantt-colour-dark.png'); await theme('light');
  });
  await check('Gantt + Colour: Show Me still offers Gantt (the Colour key is not a row dimension)', async () => {
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    const unfit = await ev(`(() => { const it = [...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === 'Gantt'); return it.classList.contains('is-unfit') ? it.title : ''; })()`);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    must(unfit === '', `Gantt flagged unfit with a Colour field: ${unfit}`);
  });
  await check('Gantt + Colour: a legend click highlights that member (the others blur) and selects it', async () => {
    await setType('Bar'); await setType('Gantt'); await chartReady(); await settle(300);
    // each bar's fill and drawn opacity (a legend focus fades the other members' bars; the focused one wears the emphasis stroke)
    const states = () => ev(`(() => { const i = window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')); const els = i.getZr().storage.getDisplayList().filter((e) => e.type === 'rect' && e.shape && e.shape.height && e.shape.height < 40 && e.shape.width >= 2 && e.style && e.style.fill && e.style.fill !== 'transparent' && e.style.fill !== 'rgba(0,0,0,0)');
      return els.map((e) => ({ fill: e.style.fill, op: e.style.opacity ?? 1, st: (e.currentStates ?? []).join('+') })); })()`);
    const before = await states();
    must(before.length === 9 && before.every((x) => x.op === 1 && x.st === ''), `no highlight before the click: ${J(before)}`);
    await ev(`(() => { window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')).dispatchAction({ type: 'legendToggleSelect', name: 'EU' }); return true; })()`);
    await waitFor(`!!document.querySelector('.ws-select')`, 'selection chip from the legend');
    await settle(400); await chartReady();
    const after = await states();
    const byFill = new Map(); for (const x of after) byFill.set(x.fill, [...(byFill.get(x.fill) ?? []), x]);
    const groups = [...byFill.values()];
    const bright = groups.filter((g) => g.every((x) => x.op === 1)), faded = groups.filter((g) => g.every((x) => x.op < 1));
    must(groups.length === 3 && bright.length === 1 && faded.length === 2, `one member at full strength, the other two faded: ${J(after)}`);
    must(bright[0].every((x) => /emphasis/.test(x.st)), 'the focused member wears the emphasis state');
    await ev(`document.querySelector('.ws-select button[aria-label="Clear selection"], .ws-select .ws-select__clear')?.click()`);
    await settle(300);
  });
  await check('Gantt: a click on a bar selects its row (the editor stores the selection; a second click clears it)', async () => {
    await setType('Bar'); await setType('Gantt'); await chartReady(); await settle(300);
    const pos = () => ev(`(() => { const d = document.querySelector('.ws-chart-canvas'); const i = window.echarts.getInstanceByDom(d); const r = d.getBoundingClientRect();
      const s = i.getOption().series[0]; const bar = s.data[1]; const x = (bar[1] + bar[2]) / 2; const p = i.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [x, bar[0]]); return { x: r.left + p[0], y: r.top + p[1] }; })()`);
    const p = await pos();
    await b.click(p.x, p.y); await settle(500);
    const chip = await ev(`document.body.textContent.includes('= EU') || document.body.textContent.includes('region = EU')`);
    must(chip, 'the selection names the clicked row (region = EU)');
    await shot('gantt-selected-light.png');
    const p2 = await pos(); await b.click(p2.x, p2.y); await settle(500);
    must(!(await ev(`document.body.textContent.includes('region = EU')`)), 'a second click clears the selection');
  });
  // ---- a Size measure sets each bar's thickness (D123) ------------------------------------------------------------------------------
  const toolEl = (name) => `document.querySelector('.ws-tool[aria-label^="${name}"]')`;
  const fmtField = (label) => `[...document.querySelectorAll('.ws-fmt-field')].find((l) => l.textContent.includes(${J(label)}))`;
  const setField = (label, v) => ev(`(() => { const i = ${fmtField(label)}.querySelector('input'); i.value = ${J(v)}; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const toggle = (label) => ev(`${fmtField(label)}.querySelector('input').click()`);
  const has = (label) => ev(`!!(${fmtField(label)})`);
  const hints = () => ev(`[...document.querySelectorAll('#ws-chart .ws-hint')].map((h) => h.textContent)`);
  const sizeText = async () => J((await opt()).graphic ?? []).match(/Size: [^"]*/)?.[0] ?? '';
  // The Gantt's drawn bars, read from the live canvas: each rectangle's height in px (a bar is the only rect with a 2 px corner radius), in draw order.
  const barHeights = () => ev(`(() => { const i = window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')); return i.getZr().storage.getDisplayList().filter((e) => e.type === 'rect' && e.shape && e.shape.r === 2 && e.shape.width >= 2).map((e) => Math.round(e.shape.height * 100) / 100); })()`);
  const rowSlot = () => ev(`(() => { const i = window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')); const a = i.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [0, 0]), c = i.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [0, 1]); return Math.abs(c[1] - a[1]); })()`);
  const distinct = (a) => new Set(a).size;
  const monotone = (a, up = true) => a.every((x, i) => i === 0 || (up ? x > a[i - 1] : x < a[i - 1]));

  await check('Gantt + Colour + a Size measure: each (row, member) bar takes its own thickness on one scale, 6 px up to 80% of the slot; the legend and the tooltip name the measure', async () => {
    await dragChip('discount', toolEl('Size')); await settle(600); await chartReady();
    const hs = await barHeights(), slot = await rowSlot();
    must(hs.length === 9, `nine bars (three rows, three members): ${J(hs)}`);
    must(distinct(hs) === 9, `every cell its own thickness: ${J(hs)}`);
    must(Math.min(...hs) === 6, `the smallest value is 6 px: ${Math.min(...hs)}`);
    must(Math.abs(Math.max(...hs) - slot * 0.8) <= 1, `the largest is 80% of the ${slot} px slot: ${Math.max(...hs)}`);
    must(/^Size: v2 \(3 to 27\)/.test(await sizeText()), 'legend in words: ' + await sizeText());
    must(J((await opt()).yAxis[0].data) === J(REGIONS), 'row order unchanged');
    await ev(`window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')).dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 1 })`); await b.sleep(250);
    must(/v2:/.test(await ev(`[...document.querySelectorAll('.ws-chart-canvas div')].map((d) => d.innerText).filter((t) => t && t.includes('v2')).pop() ?? ''`)), 'the tooltip carries the Size line');
    await shot('gantt-colour-size-light.png');
    await theme('dark'); await setType('Bar'); await setType('Gantt'); await chartReady(); await shot('gantt-colour-size-dark.png'); await theme('light'); await setType('Bar'); await setType('Gantt'); await chartReady();
  });

  await check('Gantt + Size measure (fresh sheet): thickness follows the value, rows and extents unchanged; Edit Sizes is offered and changes it; a bar click still selects its row', async () => {
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    await settle(400);
    await waitFor(`!!__t.chip('region') && !document.querySelector('.ws-shelf--columns .ws-pill')`, 'fresh worksheet');
    await dragChip('region', `__t.zone('rows')`); await dragChip('qty', `__t.zone('columns')`); await dragChip('amount', `__t.zone('columns')`);
    await settle(400); await setType('Gantt'); await chartReady();
    const plain = await barHeights(), slot0 = await rowSlot();
    must(plain.length === 3 && distinct(plain) === 1 && Math.abs(plain[0] - Math.min(28, slot0 * 0.6)) < 0.5, `without Size every bar is one thickness: ${J(plain)}`);
    const dataBefore = J((await ganttSeries())[0].data);
    await openFormat();
    must(!(await has('Smallest size')), 'Edit Sizes is not offered without a Size');
    await dragChip('discount', toolEl('Size')); await settle(600); await chartReady();
    const hs = await barHeights(), slot = await rowSlot();
    must(J(hs.map((h) => Math.round(h))) === J([6, Math.round(6 + 0.5 * (slot * 0.8 - 6)), Math.round(slot * 0.8)]), `6 px, the middle, 80% of the slot: ${J(hs)} (slot ${slot})`);
    must(J((await ganttSeries())[0].data) === dataBefore, 'start and end of every bar unchanged');
    must(/^Size: v2 \(3 to 9\)/.test(await sizeText()), await sizeText());
    must(await has('Smallest size') && await has('Largest size') && await has('Reversed'), 'Edit Sizes is offered while a Size measure is drawn');
    await shot('gantt-size-light.png');
    await toggle('Reversed'); await settle(500);
    const rev = await barHeights();
    must(monotone(rev, false) && rev[0] > rev[2], `Reversed: the largest value is the thinnest bar: ${J(rev)}`);
    must(/reversed/.test(await sizeText()), 'the legend says so: ' + await sizeText());
    await toggle('Reversed'); await settle(500);
    await setField('Smallest size', '50'); await settle(500);
    const half = await barHeights();
    must(half[0] > 6 && half[2] === hs[2], `Smallest 50% lifts the thinnest bar: ${J(half)}`);
    await setField('Smallest size', ''); await settle(400);
    await setField('End value', '5'); await settle(500);
    const sat = await barHeights();
    must(sat.every((h) => h >= 6) && sat[2] === sat[1], `a value beyond a typed end saturates at the largest, none is hidden: ${J(sat)}`);
    await setField('End value', ''); await settle(400);
    await ev(`document.querySelector('.ws-viewbar__btn[aria-label="Format"]').click()`); await settle(400); // close Format: the chart gets the room
    await theme('dark'); await setType('Bar'); await setType('Gantt'); await chartReady(); await shot('gantt-size-dark.png'); await theme('light'); await setType('Bar'); await setType('Gantt'); await chartReady();
    const pos = () => ev(`(() => { const d = document.querySelector('.ws-chart-canvas'); const i = window.echarts.getInstanceByDom(d); const r = d.getBoundingClientRect();
      const s = i.getOption().series[0]; const bar = s.data[1]; const x = (bar[1] + bar[2]) / 2; const p = i.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [x, bar[0]]); return { x: r.left + p[0], y: r.top + p[1] }; })()`);
    const p = await pos();
    await b.click(p.x, p.y); await settle(500);
    must(await ev(`document.body.textContent.includes('region = EU')`), 'a click on a sized bar selects its row (region = EU)');
    await shot('gantt-size-selected-light.png');
    const p2 = await pos(); await b.click(p2.x, p2.y); await settle(500);
    must(!(await ev(`document.body.textContent.includes('region = EU')`)), 'a second click clears it');
  });

  await check('Gantt + a Size dimension: a hint that says why, no extra group-by, bars keep one thickness, Edit Sizes is not offered', async () => {
    await dragChip('channel', toolEl('Size')); await settle(600); await chartReady();
    must((await hints()).some((t) => /Gantt/.test(t) && /one bar per row/.test(t)), 'hint: ' + J(await hints()));
    must(!hasKey(lastQuery().columnDimensions ?? [], 'channel') && !J(lastQuery()).includes('"channel"'), 'no group-by for the Size dimension: ' + J(lastQuery().columnDimensions));
    const hs = await barHeights();
    must(hs.length === 3 && distinct(hs) === 1, `bars keep one thickness: ${J(hs)}`);
    await openFormat();
    must(!(await has('Smallest size')), 'Edit Sizes is not offered for a dimension');
    await ev(`${toolEl('Size')}.click()`); await settle(300);
    must(/one bar per row/.test(await ev(`document.querySelector('.ws-toolpanel .ws-shelf__note')?.textContent ?? ''`)), 'the Marks card says so too');
    await shot('gantt-size-dimension-light.png');
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
