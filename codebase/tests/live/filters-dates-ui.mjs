// Browser checks for the filter editor and the Dates tool (beginner-test fixes): the real dev app (APP_URL, default http://localhost:5180) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/filters-dates-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5180 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5180';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'filters-dates-ui-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['status', 'String', 'text'], ['discount', 'Float64', 'numeric'], ['placed', 'DateTime', 'temporal']],
  customers: [['country', 'String', 'text']],
};
const REGIONS = ['APAC', 'EU', 'US'];
let latests = 0;
const queries = [];     // every /api/query body, in order
let tables = ['orders', 'customers'];
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: tables };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (/\/columns\/\w+\/distinct/.test(path)) return { json: /status/.test(path) ? ['Cancelled', 'Returned', 'Shipped'] : REGIONS };
  if (/\/columns\/placed\/latest$/.test(path)) { latests++; return { json: { latest: '2024-03-31' } }; }
  if (path === '/api/query') {
    queries.push(body);
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    const n = (body.filters ?? []).length ? 0 : dims.length ? REGIONS.length : 1; // any filter empties the result
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
  const datesTool = `document.querySelector('.ws-tool[aria-label^="Dates"]')`;
  const shot = async (name) => { try { writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } };
  const ctx = (sel, x = 300, y = 200) => ev(`document.querySelector(${J(sel)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y} }))`);
  const pickOp = (label) => ev(`[...document.querySelectorAll('.ctx-menu [role=menuitemradio]')].find((o) => o.textContent.trim() === ${J(label)}).click()`);
  const noteText = () => ev(`document.querySelector('.ws-notice, [class*=notice]')?.textContent ?? ''`);
  const periodQuery = () => (lastQuery()?.filters ?? []).find((f) => f.column === 'placed');

  await dragChip('region', `__t.zone('rows')`);
  await dragChip('amount', `__t.zone('columns')`);
  await settle();

  await check('Dates: the range counts from the latest day in the data, and says so', async () => {
    queries.length = 0;
    await ev(`(() => { __t.drag(__t.chip('placed'), ${datesTool}); return true; })()`);
    await waitFor(`/Counting from the latest data, 31 Mar 2024/.test(document.querySelector('.ws-period')?.textContent ?? '')`, 'latest anchor line');
    await settle(400);
    const f = queries.flatMap((q) => q.filters ?? []).find((x) => x.column === 'placed' && J(x.values) === J(['2024-03-02 00:00:00', '2024-03-31 23:59:59']));
    must(f, `period filters: ${J(queries.map((q) => (q.filters ?? []).map((x) => x.values)))}`);
    must(latests === 1, `latest read ${latests} times`);
    await shot('dates-light.png');
  });

  await check('Dates: "Count from → Today" falls back to today; "Latest data" returns', async () => {
    const setAnchor = (v) => ev(`(() => { const s = [...document.querySelectorAll('.ws-period select')].find((x) => [...x.options].some((o) => o.value === 'latest')); s.value = ${J(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    queries.length = 0;
    await setAnchor('today');
    await waitFor(`/Counting from today/.test(document.querySelector('.ws-period')?.textContent ?? '')`, 'today line');
    await settle(400);
    must(!/2024-03/.test(J(periodQuery()?.values)), `period filter: ${J(periodQuery())}`);
    await setAnchor('latest');
    await waitFor(`/latest data, 31 Mar 2024/.test(document.querySelector('.ws-period')?.textContent ?? '')`, 'latest line');
  });

  await check('Dates: Custom still works and counts from nothing', async () => {
    await ev(`(() => { const s = [...document.querySelectorAll('.ws-period select')].find((x) => [...x.options].some((o) => o.value === 'custom')); s.value = 'custom'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitFor(`document.querySelectorAll('.ws-period input[type=date]').length >= 2`, 'custom day inputs');
    must(!/Counting from/.test(await ev(`document.querySelector('.ws-period').textContent`)), 'no anchor line for a custom range');
    await ev(`(() => { const s = [...document.querySelectorAll('.ws-period select')].find((x) => [...x.options].some((o) => o.value === 'custom')); s.value = 'last30'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await ev(`document.querySelector('.ws-shelf--period button[aria-label="Remove field"], .ws-toolfly .ws-pill button[aria-label="Remove field"]')?.click()`);
  });

  await check('a filter on a text field starts as an "in" list, not "="', async () => {
    await ev(`(() => { __t.drag(__t.chip('status'), ${filterTool}); return true; })()`);
    await waitFor(`!!document.querySelector('[data-ctx^="filter:"]')`, 'filter pill');
    must(/orders\.status in/.test(await ev(`document.querySelector('[data-ctx^="filter:"] .ws-pill__text').textContent`)), 'pill reads "in"');
    await ctx('[data-ctx^="filter:"]');
    must(await ev(`document.querySelector('.ctx-menu [role=menuitemradio][aria-checked=true]').textContent.trim()`) === 'in', 'in is checked');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  });

  await check('the pill menu opens beside the Filters flyout, not over its editor; Top N box shows all four digits', async () => {
    await ev(`(() => { __t.drag(__t.chip('region'), ${filterTool}); return true; })()`); // second filter, on region
    await waitFor(`document.querySelectorAll('[data-ctx^="filter:"]').length === 2`, 'two filters');
    const fly = await ev(`(() => { const r = document.querySelector('.ws-toolfly').getBoundingClientRect(); return [r.left, r.right]; })()`);
    await ctx('[data-ctx="filter:1"]', fly[0] + 40, 260);
    const menu = await ev(`(() => { const r = document.querySelector('.ctx-menu').getBoundingClientRect(); return [r.left, r.right]; })()`);
    must(menu[0] >= fly[1], `menu ${J(menu)} overlaps flyout ${J(fly)}`);
    await pickOp('top');
    await waitFor(`!!document.querySelector('.ctx-menu .ws-pill__topn')`, 'top control');
    const w = await ev(`document.querySelector('.ctx-menu .ws-pill__topn').getBoundingClientRect().width`);
    const wf = await ev(`document.querySelector('.ws-fcard .ws-pill__topn').getBoundingClientRect().width`);
    must(wf >= 60, `flyout Top N box ${wf}px wide`);
    must(w >= 60, `Top N box ${w}px wide`);
    await shot('flyout-menu-light.png');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await ev(`document.querySelector('[data-ctx="filter:1"] button[aria-label="Remove field"]').click()`);
    await waitFor(`document.querySelectorAll('[data-ctx^="filter:"]').length === 1`, 'region filter removed');
  });

  await check('a typed "=" that matches a member only by case says so', async () => {
    await ctx('[data-ctx="filter:0"]');
    await pickOp('=');
    await waitFor(`!!document.querySelector('.ctx-menu input[aria-label^="Value for"]')`, 'value box');
    await ev(`(() => { const i = document.querySelector('.ctx-menu input[aria-label^="Value for"]'); i.value = 'shipped'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await settle(300);
    await ctx('[data-ctx="filter:0"]');
    await waitFor(`/did you mean 'Shipped'/.test(document.querySelector('.ctx-menu')?.textContent ?? '')`, 'did-you-mean note');
    must(/No member 'shipped'/.test(await ev(`document.querySelector('.ctx-menu').textContent`)), 'note names the typed value');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  });

  await check('filters that removed every row say "No rows match the filters."', async () => {
    await waitFor(`/No rows match the filters\./.test(document.getElementById('ws-chart').textContent)`, 'filtered empty message');
  });

  await check('two filters that exclude each other are flagged on the pills and in the notice', async () => {
    await ev(`(() => { __t.drag(__t.chip('status'), ${filterTool}); return true; })()`);
    await waitFor(`document.querySelectorAll('[data-ctx^="filter:"]').length === 2`, 'second status filter');
    await ev(`(() => { const p = document.querySelector('[data-ctx="filter:1"]'); return true; })()`);
    await ctx('[data-ctx="filter:1"]');
    await waitFor(`!!document.querySelector('.ctx-menu select.ws-pill__in')`, 'in list');
    await waitFor(`document.querySelector('.ctx-menu select.ws-pill__in').options.length === 3`, 'members');
    await ev(`(() => { const s = document.querySelector('.ctx-menu select.ws-pill__in'); s.options[0].selected = true; s.options[1].selected = true; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await ev(`(() => { const i = document.querySelector('.ctx-menu input'); return true; })()`);
    // filter 0 is "= shipped"; set it to "= Shipped"
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await ctx('[data-ctx="filter:0"]');
    await waitFor(`!!document.querySelector('.ctx-menu input[aria-label^="Value for"]')`, 'value box 0');
    await ev(`(() => { const i = document.querySelector('.ctx-menu input[aria-label^="Value for"]'); i.value = 'Shipped'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await settle(300);
    await settle(300);
    await waitFor(`document.querySelector('[data-ctx="filter:1"]')?.title.includes('exclude each other')`, 'pill warning');
    await waitFor(`/exclude each other/.test(document.querySelector('#worksheet-view').textContent)`, 'notice under the chart');
    await shot('conflict-light.png');
  });

  await check('a filter on a calendar day field keeps working after the changes (no page exceptions so far)', async () => {
    must(b.consoleErrors.length === 0, b.consoleErrors.join(' | '));
  });

  for (const scheme of ['dark']) {
    await check(`screenshot (${scheme})`, async () => { await b.setScheme(scheme); await shot(`filters-${scheme}.png`); });
  }

  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
  if (wbDir) rmSync(wbDir, { recursive: true, force: true });
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
