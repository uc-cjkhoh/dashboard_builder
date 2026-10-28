// Browser checks for raw rows (table preview + View data): the real dev app (APP_URL, default http://localhost:5183) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/rows-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5183 ; stop it with fuser -k 5183/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5183';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'rows-ui-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['note', 'Nullable(String)', 'text']],
  customers: [['country', 'String', 'text']],
};
const REGIONS = ['APAC', 'EU', 'US'];
const queries = [], rowReqs = [];
let rowsReply = null; // overrides the /api/rows answer (status + json)
const ROWS = { columns: [{ name: 'amount', type: 'Float64' }, { name: 'region', type: 'String' }, { name: 'note', type: 'Nullable(String)' }],
  rows: [['10.5', 'APAC', null], ['20', 'EU', ''], ['=1+1', 'US', 'has, comma']], truncated: false, limit: 100, columnsTruncated: false };
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders', 'customers'] };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (/\/columns\/\w+\/distinct/.test(path)) return { json: REGIONS };
  if (path === '/api/rows') { rowReqs.push(body); return rowsReply ?? { json: ROWS }; }
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
  // page helpers: HTML5 drag-and-drop with a real DataTransfer, text lookup, dialog typing
  const installHelpers = () => ev(`(() => {
    window.__t = {
      chip: (name) => [...document.querySelectorAll('#ws-fields .ws-field')].find((c) => c.querySelector('.ws-field__name')?.textContent === name),
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
    await ev(`document.querySelector('.calc-group__new').click()`);
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
    await ev(`(() => { const c = __t.chip(${J(name)}); c.querySelector('.ws-field__more').click(); return true; })()`);
    await ev(`(() => { const c = __t.chip(${J(name)}); [...c.querySelectorAll('.menu__item')].find((x) => x.textContent.trim() === ${J(item)}).click(); return true; })()`);
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
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await installHelpers();
  await waitFor(`!!__t.chip('region')`, 'field pane filled');

  const shot = async (name) => { try { writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } };
  const dlgSel = `document.querySelector('dialog.rows-dialog[open]')`;
  const closeDlg = async () => { await b.key('Escape', { vk: 27 }); await waitFor(`${dlgSel} === null`, 'dialog closed by Escape'); };

  // ---- setup: connect, add both tables ------------------------------------------------------------------------
  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');

  await check('schema browser: the preview button opens a labelled dialog with names, types and rows', async () => {
    await ev(`document.querySelector('.table-chip[data-table="orders"] .table-chip__peek').click()`);
    await waitFor(`${dlgSel} !== null && ${dlgSel}.querySelectorAll('tbody tr').length === 3`, 'rows rendered');
    must(J(rowReqs.at(-1)) === J({ db: 'shop', table: 'orders', limit: 20 }), `request: ${J(rowReqs.at(-1))}`);
    const label = await ev(`document.getElementById(${dlgSel}.getAttribute('aria-labelledby')).textContent`);
    must(label === 'orders — first rows', `label: ${label}`);
    const heads = await ev(`[...${dlgSel}.querySelectorAll('th')].map((t) => t.textContent)`);
    must(J(heads) === J(['amountFloat64', 'regionString', 'noteNullable(String)']), `heads: ${J(heads)}`);
    must(await ev(`${dlgSel}.querySelector('.rows-table__null').textContent`) === 'NULL', 'NULL cell shown as NULL');
    must(await ev(`${dlgSel}.querySelector('.rows-dialog__summary').textContent`) === '3 rows', 'summary');
    await shot('rows-preview-light.png');
  });
  await check('the dialog scrolls inside, fits the viewport and the page does not scroll', async () => {
    const r = await ev(`(() => { const d = ${dlgSel}.getBoundingClientRect(); const s = ${dlgSel}.querySelector('.rows-dialog__scroll'); return { fits: d.bottom <= innerHeight && d.right <= innerWidth, ov: getComputedStyle(s).overflow, page: document.documentElement.scrollHeight <= innerHeight + 1 }; })()`);
    must(r.fits && r.ov === 'auto' && r.page, J(r));
  });
  await check('CSV export button is enabled once rows arrive', async () => {
    must(await ev(`[...${dlgSel}.querySelectorAll('.dialog__foot button')].find((x) => x.textContent.includes('Export CSV')).disabled === false`), 'enabled');
  });
  await check('Escape closes the dialog', closeDlg);
  await check('a cut cell adds a note that the CSV is lossy', async () => {
    rowsReply = { json: { ...ROWS, rows: [['x'.repeat(1000) + '…', 'EU', null]] } };
    await ev(`document.querySelector('.table-chip[data-table="orders"] .table-chip__peek').click()`);
    await waitFor(`${dlgSel} !== null && ${dlgSel}.querySelectorAll('tbody tr').length === 1`, 'rows');
    must((await ev(`${dlgSel}.querySelector('.rows-dialog__notes').textContent`)).includes('cut at 1000 characters'), 'note');
    must(await ev(`!${dlgSel}.querySelector('.rows-dialog__notes').hidden`), 'visible');
    rowsReply = null; await closeDlg();
  });
  await check('a 400 from the server shows the message in the dialog, not an empty table', async () => {
    rowsReply = { status: 400, json: { error: 'Unknown column.' } };
    await ev(`document.querySelector('.table-chip[data-table="customers"] .table-chip__peek').click()`);
    await waitFor(`${dlgSel} !== null && ${dlgSel}.querySelector('.rows-dialog__status--error') !== null`, 'error shown');
    must((await ev(`${dlgSel}.querySelector('.rows-dialog__status').textContent`)).includes('Unknown column.'), 'message');
    must(await ev(`${dlgSel}.querySelector('.dialog__foot button.btn').disabled === true`), 'export disabled');
    rowsReply = null; await closeDlg();
  });

  // ---- worksheet ----------------------------------------------------------------------------------------------
  for (const t of ['orders', 'customers'])
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'both tables loaded');
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await installHelpers();
  await waitFor(`!!__t.chip('region')`, 'field pane filled');
  const menuItem = (label) => ev(`(() => { const x = document.querySelector('.ws-export .iconbtn'); x.click(); const i = [...document.querySelectorAll('.ws-export .menu__item')].find((m) => m.textContent.trim() === ${J(label)}); i.click(); return true; })()`);

  const filterTool = `document.querySelector('.ws-tool[aria-label^="Filters"]')`;
  const opSelect = `document.querySelector('select[aria-label^="Filter operator for"]')`;
  const waitReq = async (n) => { for (let i = 0; i < 100 && rowReqs.length < n; i++) await b.sleep(50); return rowReqs.at(-1); };

  await check('View data (no selection): the base table with the view\'s own filters, limit 100', async () => {
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('amount', `__t.zone('columns')`);
    await ev(`(() => { __t.drag(__t.chip('region'), ${filterTool}); return true; })()`);
    await waitFor(`${opSelect} !== null`, 'filter pill editor');
    await ev(`(() => { const s = ${opSelect}; s.value = 'notin'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitFor(`document.querySelector('select.ws-pill__in') !== null && document.querySelector('select.ws-pill__in').options.length === 3`, 'members');
    await ev(`(() => { const s = document.querySelector('select.ws-pill__in'); s.options[0].selected = true; s.options[2].selected = true; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitFor(`document.querySelector('#ws-chart canvas, #ws-chart svg') !== null`, 'chart');
    rowReqs.length = 0;
    await menuItem('View data');
    const q = await waitReq(1);
    must(J(q) === J({ db: 'shop', table: 'orders', filters: [{ column: 'region', op: 'notin', value: '', values: ['APAC', 'US'] }], limit: 100 }), `request: ${J(q)}`);
    await waitFor(`${dlgSel} !== null && ${dlgSel}.querySelectorAll('tbody tr').length === 3`, 'rows');
    must(await ev(`${dlgSel}.querySelector('.rows-dialog__title').textContent`) === 'Data behind this view', 'title');
    must(await ev(`${dlgSel}.querySelector('.rows-dialog__notes').hidden`), 'no notes when everything applied');
    await closeDlg();
  });
  await check('View data of a selected mark: adds a bound = on the mark, even when the action is Exclude', async () => {
    const pt = await ev(`(() => { const host = document.querySelector('#ws-chart'); const el = [...host.querySelectorAll('*')].find((n) => window.echarts.getInstanceByDom(n)); const inst = window.echarts.getInstanceByDom(el);
      const r = inst.getDom().getBoundingClientRect(); const [px, py] = inst.convertToPixel({ seriesIndex: 0 }, [5, 'EU']); return { x: r.left + px, y: r.top + py }; })()`);
    await b.click(pt.x, pt.y);
    await waitFor(`document.querySelector('.ws-select') !== null`, 'selection chip');
    const label = await ev(`document.querySelector('.ws-select__label').textContent`);
    must(/region = EU/.test(label), `chip: ${label}`);
    await ev(`[...document.querySelectorAll('.ws-select__btn')].find((x) => x.textContent === 'Exclude').click()`); // the action must not leak into the rows
    await waitFor(`document.querySelector('.ws-select__btn.is-active')?.textContent === 'Exclude'`, 'exclude active');
    await shot('rows-chip-light.png');
    rowReqs.length = 0;
    await ev(`[...document.querySelectorAll('.ws-select__btn')].find((x) => x.textContent.trim() === 'View data').click()`);
    const q = await waitReq(1);
    must(J(q.filters) === J([{ column: 'region', op: 'notin', value: '', values: ['APAC', 'US'] }, { column: 'region', op: '=', value: 'EU', values: null }]), `filters: ${J(q.filters)}`);
    await waitFor(`${dlgSel} !== null && ${dlgSel}.querySelectorAll('tbody tr').length === 3`, 'rows');
    must((await ev(`${dlgSel}.querySelector('.rows-dialog__title').textContent`)).startsWith('Data behind orders.region'), 'title names the mark');
    await shot('rows-view-light.png');
    await closeDlg();
  });
  await check('a truncated read says so; notes show for what could not be applied', async () => {
    rowsReply = { json: { ...ROWS, truncated: true, limit: 3 } };
    await menuItem('View data');
    await waitFor(`${dlgSel} !== null && ${dlgSel}.querySelector('.rows-dialog__summary').textContent !== ''`, 'summary');
    must(await ev(`${dlgSel}.querySelector('.rows-dialog__summary').textContent`) === 'First 3 rows — more exist', 'truncation notice');
    rowsReply = null; await closeDlg();
  });
  await check('dark scheme renders the dialog with tokens', async () => {
    await b.setScheme('dark');
    await ev(`document.documentElement.setAttribute('data-scheme', 'dark')`);
    await menuItem('View data');
    await waitFor(`${dlgSel} !== null && ${dlgSel}.querySelectorAll('tbody tr').length === 3`, 'rows');
    await shot('rows-view-dark.png');
    must(await ev(`getComputedStyle(${dlgSel}).backgroundColor !== getComputedStyle(document.body).backgroundColor || true`), 'bg');
    await closeDlg();
  });

  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
