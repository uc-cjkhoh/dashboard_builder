// Browser checks for a calculated field as a FILTER (D82): the real dev app (APP_URL, default http://localhost:5228) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/notin-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5228 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5228';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'calc-filter-ui-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['discount', 'Float64', 'numeric'], ['placed', 'DateTime', 'temporal']],
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

  const newCalcNamed = async (name, formula) => { await openNewDialog(); await fillDialog(name, formula); await saveDialog(); };
  const openFilterMenu = async () => {
    await ev(`document.querySelector('[data-ctx^="filter:"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))`);
    await waitFor(`document.querySelector('.ctx-menu') !== null`, 'filter menu');
  };
  const menuOps = () => ev(`[...document.querySelectorAll('.ctx-menu [role=menuitemradio]')].map((o) => o.textContent.trim())`);
  const pickOp = (label) => ev(`[...document.querySelectorAll('.ctx-menu [role=menuitemradio]')].find((o) => o.textContent.trim() === ${J(label)}).click()`);

  await dragChip('region', `__t.zone('rows')`);
  await dragChip('amount', `__t.zone('columns')`);
  await settle();
  await newCalcNamed('Net', '[orders.amount] * 2');
  await newCalcNamed('Region calc', '[orders.region]');
  await newCalcNamed('Unit price', 'SUM([orders.amount]) / SUM([orders.qty])');

  await check('a row-level number dropped on Filters becomes a filter pill; its query carries the tree, the label and a bound value', async () => {
    await ev(`(() => { __t.drag(__t.chip('Net'), ${filterTool}); return true; })()`);
    await waitFor(`!!document.querySelector('[data-ctx^="filter:"]')`, 'filter pill');
    must(!/can't be a filter/.test(await toastText()), `toast: ${J(await toastText())}`);
    await openFilterMenu();
    const ops = await menuOps();
    must(ops.includes('between') && ops.includes('>') && !ops.includes('top'), `operators: ${J(ops)}`);
    await pickOp('>');
    await waitFor(`document.querySelector('.ctx-menu input.ws-pill__val') !== null`, 'value input');
    queries.length = 0;
    await ev(`(() => { const i = document.querySelector('.ctx-menu input.ws-pill__val'); i.value = '100'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await settle(400);
    const f = (lastQuery()?.filters ?? [])[0];
    must(f && f.op === '>' && f.value === '100' && f.column === 'Net' && f.db === '' && f.table === '' && f.calc?.k === 'bin', `filter sent: ${J(f)}`);
    must(hasKey(f.calc, 'column') && J(f.calc).includes('"amount"'), `tree: ${J(f.calc)}`);
    await shot('calc-filter-light.png');
  });

  await check('a text calculation: in lists its members from a one-dimension calculated query, then filters by the picked two', async () => {
    await ev(`document.querySelector('[data-ctx^="filter:"] .ws-pill__remove, [data-ctx^="filter:"] button[aria-label^="Remove"]')?.click()`);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`!document.querySelector('[data-ctx^="filter:"]')`, 'filter removed');
    await ev(`(() => { __t.drag(__t.chip('Region calc'), ${filterTool}); return true; })()`);
    await waitFor(`!!document.querySelector('[data-ctx^="filter:"]')`, 'second filter pill');
    await openFilterMenu();
    const ops = await menuOps();
    must(ops.includes('contains') && ops.includes('in') && !ops.includes('top'), `text operators: ${J(ops)}`);
    queries.length = 0;
    await pickOp('in');
    await waitFor(`document.querySelector('select.ws-pill__in')?.options.length === 3`, 'members listed');
    const m = queries.find((q) => (q.measures ?? []).length === 0 && (q.rowDimensions ?? []).length === 1);
    must(m && m.rowDimensions[0].calc && m.rowDimensions[0].column === 'Region calc' && m.limit === 201 && (m.filters ?? []).length === 0, `member query: ${J(m)}`);
    queries.length = 0;
    await ev(`(() => { const s = document.querySelector('select.ws-pill__in'); s.options[0].selected = true; s.options[2].selected = true; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await settle(400);
    const f = (lastQuery()?.filters ?? [])[0];
    must(f && f.op === 'in' && J(f.values) === J(['APAC', 'US']) && f.calc?.k === 'field', `filter sent: ${J(f)}`);
  });

  await check('an aggregate calculation dropped on Filters is refused in words and adds nothing', async () => {
    const before = await ev(`document.querySelectorAll('[data-ctx^="filter:"]').length`);
    await ev(`(() => { __t.drag(__t.chip('Unit price'), ${filterTool}); return true; })()`);
    await b.sleep(300);
    const t = await toastText();
    must(/Unit price.*can't be a filter.*aggregates/.test(t), `toast: ${J(t)}`);
    must((await ev(`document.querySelectorAll('[data-ctx^="filter:"]').length`)) === before, 'a filter was added');
  });

  await check('the filter goes when its calculation is deleted', async () => {
    await ev(`(() => { const c = __t.chip('Region calc'); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); return true; })()`);
    await ev(`[...document.querySelectorAll('.ctx-menu .menu__item')].find((x) => x.textContent.trim() === 'Delete…').click()`);
    await waitFor(`!!(${confirmOpen})`, 'confirm dialog');
    const text = await ev(`(${confirmOpen}).textContent`);
    must(/Region calc/.test(text), `confirm text: ${J(text)}`);
    await ev(`[...(${confirmOpen}).querySelectorAll('button')].find((x) => x.textContent === 'Delete').click()`);
    await waitFor(`!document.querySelector('[data-ctx^="filter:"]')`, 'filter gone with its calculation');
  });

  await check('dark theme renders the calculated filter pill', async () => {
    await ev(`(() => { __t.drag(__t.chip('Net'), ${filterTool}); return true; })()`);
    await waitFor(`!!document.querySelector('[data-ctx^="filter:"]')`, 'pill');
    await ev(`document.documentElement.setAttribute('data-theme', 'dark')`);
    await shot('calc-filter-dark.png');
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
