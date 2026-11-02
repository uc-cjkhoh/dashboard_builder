// Browser checks for the worksheet fine-tuning batch: flush chart card, one chart-type control, grouped field pane, Marks grid,
// hide / show field pane, context popups for pill options, tick-only menus (T-ft-worksheet): the real dev app (APP_URL, default http://localhost:5191) in headless
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
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'worksheet-ft-ui-shots');
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

  const shot = async (name) => { try { writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } };
  const ctx = (sel) => ev(`(() => { const e = document.querySelector(${J(sel)}); e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })); return true; })()`);
  const ctxItems = () => ev(`[...document.querySelectorAll('.ctx-menu [role^=menuitem]')].map((x) => x.textContent.trim())`);
  const ctxClick = (label) => ev(`(() => { [...document.querySelectorAll('.ctx-menu [role^=menuitem]')].find((x) => x.textContent.trim() === ${J(label)}).click(); return true; })()`);
  const theme = async (t) => { await b.setScheme(t); await ev(`document.documentElement.setAttribute('data-theme', ${J(t)})`); await b.sleep(300); };
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await waitFor(`document.querySelectorAll('.ws-shelf--rows .ws-pill').length === 1`, 'pills placed');

  await check('the chart card has no margin and no radius', async () => {
    must(await ev(`(() => { const c = getComputedStyle(document.querySelector('.ws-chart-card')); return c.margin === '0px' && c.borderRadius === '0px'; })()`), 'card margin/radius');
  });
  await check('one chart-type control: no Show Me button; the type menu dims unfit types and marks the best fit', async () => {
    must(await ev(`!document.querySelector('.ws-showme-toggle')`), 'Show Me toggle still there');
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    must(await ev(`document.querySelectorAll('.ws-charttypes .menu__item').length >= 10 && !!document.querySelector('.ws-charttypes .is-unfit') && !!document.querySelector('.ws-charttypes__best')`), 'unfit / best cues');
    await shot('chart-menu-light.png');
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
  });
  await check('field groups share one design: Calculated fields, Hierarchies and the table are chevron details', async () => {
    must(await ev(`['.calc-group', '.hier-group', '.ws-table'].every((s) => { const g = document.querySelector('#ws-fields ' + s); return g && g.tagName === 'DETAILS' && g.querySelector(':scope > summary.ws-group__head .icon'); })`), 'details + chevron');
    must(await ev(`(() => { const a = ['.calc-group', '.hier-group', '.ws-table'].map((s) => getComputedStyle(document.querySelector('#ws-fields ' + s + ' > summary'))); return a.every((c) => c.fontWeight === a[0].fontWeight && c.fontSize === a[0].fontSize); })()`), 'same header style');
    await ev(`document.querySelector('#ws-fields .ws-table > summary').click()`);
    must(await ev(`!document.querySelector('#ws-fields .ws-table').open`), 'collapses');
    await ev(`document.querySelector('#ws-fields .ws-table > summary').click()`);
  });
  await check('Marks: a grid of three columns in the field pane after Hierarchies; a field dropped on a slot lands in it', async () => {
    must(await ev(`(() => { const m = document.querySelector('#ws-fields .ws-shelf--marks'); const h = document.querySelector('#ws-fields .hier-group'); return !!m && !!(h.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING); })()`), 'after Hierarchies');
    must(await ev(`!document.querySelector('#ws-shelves .ws-shelf--marks')`), 'still in the header');
    must(await ev(`[...document.querySelectorAll('.ws-marks__row')].every((r) => getComputedStyle(r).gridTemplateColumns.split(' ').length === 3) && document.querySelectorAll('.ws-marks__row .ws-tool').length >= 8`), '3-col rows');
    await ev(`(() => { const c = __t.chip('channel'); const t = document.querySelector('.ws-tool[aria-label^="Color"]'); __t.drag(c, t); return true; })()`);
    await waitFor(`/1 field/.test(document.querySelector('.ws-tool[aria-label^="Color"]').getAttribute('aria-label'))`, 'colour set');
    await shot('marks-light.png');
    await theme('dark'); await shot('marks-dark.png'); await theme('light');
  });
  await check('the field pane hides and shows, and the choice is remembered', async () => {
    const w = () => ev(`document.querySelector('.ws-main').getBoundingClientRect().width`);
    const w0 = await w();
    await ev(`document.querySelector('.ws-fields-collapse').click()`);
    must(await ev(`document.getElementById('ws-fields').hidden && document.querySelector('.ws-fields-collapse').getAttribute('aria-expanded') === 'false'`), 'hidden');
    must((await w()) > w0 + 100, 'worksheet did not grow');
    must(await ev(`localStorage.getItem('dashboardbuilder.fields.collapsed') === '1'`), 'not remembered');
    await ev(`document.querySelector('.ws-fields-collapse').click()`);
    must(await ev(`!document.getElementById('ws-fields').hidden`), 'shown again');
  });
  await check('pill options live in the context popup, not inline; a measure offers aggregations, role, table calculation, choices', async () => {
    must(await ev(`!document.querySelector('.ws-shelf--rows .ws-pill select, .ws-shelf--rows .ws-pill__ctl .iconbtn')`), 'inline controls remain');
    await ctx('.ws-shelf--rows .ws-pill');
    const items = await ctxItems();
    for (const w of ['sum', 'avg', 'median', 'Percentile…', 'Use as dimension', 'Table calculation…', 'Field choices…']) must(items.includes(w), `missing ${w} in ${J(items)}`);
    await shot('ctx-light.png');
    await theme('dark'); await shot('ctx-dark.png'); await theme('light');
    await ctxClick('avg'); await settle(300);
    must(J(lastQuery()).includes('"avg"'), 'avg not sent');
    must(await ev(`!document.querySelector('.ctx-menu')`), 'popup should close');
  });
  await check('keyboard: Enter on a focused pill opens the popup, Esc closes and refocuses', async () => {
    await ev(`document.querySelector('.ws-shelf--rows .ws-pill').focus()`);
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor(`!!document.querySelector('.ctx-menu')`, 'popup open');
    must(await ev(`document.activeElement.closest('.ctx-menu') !== null`), 'focus not in popup');
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(`!document.querySelector('.ctx-menu')`, 'popup closed');
    await waitFor(`document.activeElement?.classList.contains('ws-pill')`, 'focus back on the pill');
  });
  await check('a date dimension offers parts, finer / coarser and the label policy in its popup', async () => {
    await dragChip('placed', `__t.zone('columns')`);
    await waitFor(`document.querySelectorAll('.ws-shelf--columns .ws-pill').length === 2`, 'date pill');
    await ctx('.ws-shelf--columns .ws-pill:nth-of-type(2)');
    const items = await ctxItems();
    for (const w of ['Auto', 'Year', 'Month', 'Finer', 'Coarser', 'Show all date labels']) must(items.includes(w), `missing ${w} in ${J(items)}`);
    await ctxClick('Month');
    await ctx('.ws-shelf--columns .ws-pill[data-ctx="columns:1"]');
    must(await ev(`document.querySelector('.ctx-menu [aria-checked=true]').textContent.trim() === 'Month'`), 'Month not ticked');
    await ev(`document.querySelector('.ctx-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  });
  await check('a filter pill: operator, sharing and value editor in the popup', async () => {
    await dragChip('region', `document.querySelector('.ws-tool[aria-label^="Filters"]')`);
    await waitFor(`!!document.querySelector('[data-ctx="filter:0"]')`, 'filter pill');
    must(await ev(`!document.querySelector('.ws-pill__filter')`), 'inline filter controls');
    await ctx('[data-ctx="filter:0"]');
    must(await ev(`!!document.querySelector('.ctx-menu .ws-pill__filter') && document.querySelectorAll('.ctx-menu [role=menuitemradio]').length >= 4`), 'ops + value editor');
    must((await ctxItems()).includes('Apply on every dashboard'), 'share toggle');
    await ev(`document.querySelector('.ctx-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  });
  await check('a field row offers its options on right-click', async () => {
    await ctx('#ws-fields .ws-field--dimension');
    const items = await ctxItems();
    must(items.includes('Rename…') && items.includes('Hide from the field list'), J(items));
    await ev(`document.querySelector('.ctx-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  });
  await check('sheet menu: Fit and the two toggles are tick-only', async () => {
    await ev(`document.querySelector('.ws-actions .iconbtn').click()`);
    const rows = await ev(`[...document.querySelectorAll('.ws-actions [role=menuitemradio], .ws-actions [role=menuitemcheckbox]')].map((x) => [x.textContent.trim(), x.getAttribute('aria-checked'), x.querySelectorAll('svg').length, getComputedStyle(x.querySelector('.menu__check')).visibility])`);
    must(rows.length === 6, J(rows));
    must(rows.every((r) => r[2] === 1), 'extra icons ' + J(rows));
    must(J(rows.filter((r) => r[1] === 'true').map((r) => r[0])) === J(['Standard', 'Show title and caption', 'Show filter cards']), J(rows));
    must(rows.every((r) => (r[1] === 'true') === (r[3] === 'visible')), 'tick visibility ' + J(rows));
    await shot('sheet-menu-light.png');
    await ev(`[...document.querySelectorAll('.ws-actions [role=menuitemradio]')].find((x) => x.textContent.trim() === 'Fit width').click()`);
    await ev(`document.querySelector('.ws-actions .iconbtn').click()`);
    must(await ev(`document.querySelector('.ws-actions [role=menuitemradio][aria-checked=true]').textContent.trim() === 'Fit width'`), 'fit not ticked');
    await ev(`document.querySelector('.ws-actions .iconbtn').click()`);
  });
  await check('the Analytics button has its own icon', async () => {
    must(await ev(`(() => { const d = (s) => document.querySelector(s + ' svg path')?.getAttribute('d'); const a = d('.ws-viewbar__btn[aria-label="Analytics"]'); return !!a && [...document.querySelectorAll('.ws-viewbar button')].filter((x) => x.getAttribute('aria-label') !== 'Analytics').every((x) => x.querySelector('svg path')?.getAttribute('d') !== a); })()`), 'icon shared');
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
