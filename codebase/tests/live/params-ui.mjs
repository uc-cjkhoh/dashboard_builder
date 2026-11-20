// Browser checks for parameters in calculated fields (and the step-size input, the delete confirm, the reference-line binding): the real dev app (APP_URL, default http://localhost:5180) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/params-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5180 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { CALC_LIST_TEXT, NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5180';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'params-ui-shots');
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
  const confirmOpen = `[...document.querySelectorAll('dialog[open]')].find((d) => !d.classList.contains('calc-dialog') && !d.classList.contains('params-dialog'))`;
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


  // ---- helpers for the parameters dialog ------------------------------------------------------------------------
  const pdlg = `document.querySelector('dialog.params-dialog:not(.calc-manager):not(.hier-dialog)[open]')`;
  const openParams = async () => { await ev(`document.querySelector('#ws-tools [aria-label="Parameters"]').click()`); await waitFor(`${pdlg} !== null`, 'parameters dialog'); };
  const clickIn = (root, text) => ev(`[...${root}.querySelectorAll('button')].find((x) => x.textContent.trim() === ${J(text)} || x.getAttribute('aria-label') === ${J(text)}).click()`);
  const setField = (label, value, tag = 'input') => ev(`(() => { const f = [...${pdlg}.querySelectorAll('.params-field')].find((l) => l.textContent.startsWith(${J(label)})); const i = f.querySelector(${J(tag)}); i.value = ${J(value)}; i.dispatchEvent(new Event(${J(tag === 'select' ? 'change' : 'input')}, { bubbles: true })); return true; })()`);
  const fieldHidden = (label) => ev(`(() => { const f = [...${pdlg}.querySelectorAll('.params-field')].find((l) => l.textContent.startsWith(${J(label)})); return f ? f.hidden : null; })()`);
  const formError = () => ev(`(() => { const e = ${pdlg}.querySelector('.field-error'); return e && !e.hidden ? e.textContent : ''; })()`);
  const addParam = async (name, type, value, extra = async () => {}) => {
    await openParams();
    await clickIn(pdlg, '+ New parameter');
    await setField('Name', name); await setField('Type', type, 'select'); await extra();
    await setField('Current value', value);
    await clickIn(pdlg, 'Save');
    await waitFor(`!${pdlg}.querySelector('.params-edit')`, 'param saved');
    await clickIn(pdlg, 'Done');
    await waitFor(`${pdlg} === null`, 'dialog closed');
  };

  await check('step size: a real input for a number range; invalid values refused; saved and shown again on edit', async () => {
    await openParams();
    await clickIn(pdlg, '+ New parameter');
    await setField('Name', 'Rate'); await setField('Type', 'number', 'select');
    must(await fieldHidden('Step size') === true, 'step visible before a range is chosen');
    await setField('Allowed', 'range', 'select');
    await b.sleep(50);
    must(await fieldHidden('Step size') === false, 'step input not shown for a number range');
    await setField('Min', '0'); await setField('Max', '1'); await setField('Step size', '-1'); await setField('Current value', '0.2');
    await clickIn(pdlg, 'Save');
    must(/Step must be a positive number/.test(await formError()), `bad step not refused: ${await formError()}`);
    await setField('Step size', '0.05');
    await clickIn(pdlg, 'Save');
    await waitFor(`!${pdlg}.querySelector('.params-edit')`, 'saved');
    must(/step 0\.05/.test(await ev(`${pdlg}.textContent`)), 'saved step not listed');
    await clickIn(pdlg, 'Edit parameter Rate');
    must(await ev(`[...${pdlg}.querySelectorAll('.params-field')].find((l) => l.textContent.startsWith('Step size')).querySelector('input').value`) === '0.05', 'step not round-tripped into the editor');
    await clickIn(pdlg, 'Cancel'); await clickIn(pdlg, 'Done');
    await waitFor(`${pdlg} === null`, 'closed');
  });

  await check('autocomplete: [@ offers the parameter; a calculation using it saves', async () => {
    await openNewDialog();
    await focusAndType('.calc-dialog input.input', 'Taxed');
    await focusAndType('.calc-dialog textarea.formula', '[orders.amount] * [@Ra');
    await waitFor(`!document.querySelector('.calc-dialog ul.suggest').hidden`, 'suggestions');
    const opts = await ev(`[...document.querySelectorAll('.calc-dialog ul.suggest li')].map((l) => l.textContent)`);
    must(opts.length === 1 && /Rate/.test(opts[0]) && /parameter · number/.test(opts[0]), `suggestions: ${J(opts)}`);
    await b.key('Enter', { vk: 13 });
    await ev(`document.querySelector('.calc-dialog textarea.formula').blur()`);
    must(await ev(`document.querySelector('.calc-dialog textarea.formula').value`) === '[orders.amount] * [@Rate]', 'accept did not complete [@Rate]');
    must(!(await saveDisabled()), `Save disabled: ${await ev(`document.querySelector('[id^=calc-fmsg]').textContent`)}`);
    await saveDialog();
    await waitFor(`!!__t.chip('Taxed')`, 'chip');
  });

  await check('a text parameter in arithmetic and an unknown parameter are refused in the dialog', async () => {
    await addParam('Label', 'text', 'north');
    await openNewDialog();
    await fillDialog('Bad', '[orders.amount] * [@Label]');
    const m1 = await ev(`document.querySelector('[id^=calc-fmsg]').textContent`);
    must(/numbers/.test(m1) && await saveDisabled(), `text in arithmetic: ${m1}`);
    await focusAndType('.calc-dialog textarea.formula', '[@Nope]');
    const m2 = await ev(`document.querySelector('[id^=calc-fmsg]').textContent`);
    must(/Parameter \[@Nope\] was deleted or doesn't exist/.test(m2) && await saveDisabled(), `unknown: ${m2}`);
    await clickIn(dlg, 'Cancel');
    await waitFor(`!!(${confirmOpen})`, 'discard confirm');
    await clickIn(confirmOpen, 'Discard');
    await waitFor(`/^Really discard /.test(${confirmOpen}?.textContent ?? '')`, 'second discard confirm');
    await clickIn(confirmOpen, 'Discard for good');
    await waitFor(`${dlg} === null`, 'closed');
  });

  await check('shelf: the request carries the literal; changing the parameter sends a new one and redraws; a control for it shows on the sheet', async () => {
    await dragChip('region', `__t.zone('columns')`);
    await settle();
    await dragChip('Taxed', `__t.zone('rows')`);
    await waitFor(`__t.pills('rows').length === 1`, 'pill on Rows');
    await settle();
    let m0 = lastQuery().measures?.[0];
    must(m0?.calc?.k === 'bin' && J(m0.calc.r) === J({ k: 'num', v: 0.2 }), `literal missing: ${J(m0)}`);
    must(!J(lastQuery()).includes('param'), 'a parameter leaked into the request');
    must(await canvasDrawn(), 'no chart');
    // the on-sheet control for [@Rate]
    must(await ev(`!!document.querySelector('.ws-params')`), 'no parameter control on the sheet');
    const n = queries.length;
    await openParams();
    await clickIn(pdlg, 'Edit parameter Rate');
    await setField('Current value', '0.35');
    await clickIn(pdlg, 'Save');
    await clickIn(pdlg, 'Done');
    await settle();
    must(queries.length > n, 'no new query after the parameter changed');
    m0 = lastQuery().measures?.[0];
    must(J(m0.calc.r) === J({ k: 'num', v: 0.35 }), `new literal missing: ${J(m0.calc)}`);
    must(await canvasDrawn(), 'chart not redrawn');
  });

  await check('rename follows into the formula; the view re-queries with no error', async () => {
    await openParams();
    await clickIn(pdlg, 'Edit parameter Rate');
    await setField('Name', 'Tax');
    await clickIn(pdlg, 'Save'); await clickIn(pdlg, 'Done');
    await settle();
    const f = await ev(CALC_LIST_TEXT);
    must(!/can't be computed/.test(await chartText()), `chart: ${await chartText()}`);
    must(J(lastQuery().measures[0].calc.r) === J({ k: 'num', v: 0.35 }), 'literal lost after rename');
    void f;
  });

  await check('reference line binds a number parameter; the line follows it', async () => {
    await ev(`document.querySelector('button[aria-label="Analytics"]').click()`);
    await waitFor(`!!document.querySelector('.ws-analytics')`, 'analytics panel');
    const pick = (label, value) => ev(`(() => { const f = [...document.querySelectorAll('.ws-analytics .ws-fmt-field')].find((l) => l.textContent.startsWith(${J(label)})); const s = f.querySelector('select'); s.value = ${J(value)}; s.dispatchEvent(new Event('change')); return true; })()`);
    await pick('Reference line', 'constant');
    await waitFor(`[...document.querySelectorAll('.ws-analytics .ws-fmt-field')].some((l) => l.textContent.startsWith('or follow'))`, 'follow select');
    const optText = await ev(`[...document.querySelectorAll('.ws-analytics .ws-fmt-field')].find((l) => l.textContent.startsWith('or follow')).textContent`);
    must(/Tax/.test(optText) && !/Label/.test(optText), `only number parameters are offered: ${optText}`);
    const pid = await ev(`(() => { const f = [...document.querySelectorAll('.ws-analytics .ws-fmt-field')].find((l) => l.textContent.startsWith('or follow')); return [...f.querySelector('select').options].find((o) => o.text === 'Tax').value; })()`);
    await pick('or follow', pid);
    await waitFor(`[...document.querySelectorAll('.ws-analytics .ws-fmt-field')].some((l) => /Parameter: Tax/.test(l.textContent))`, 'bound select');
    await settle();
    const st = await ev(`(async () => { const st = await import('/features/Core/store.js'); return st.worksheets()[0].sheet.analytics.ref; })()`);
    must(st.param === pid && st.kind === 'constant', `ref not bound: ${J(st)}`);
  });

  await check('forecast and moving-average window bind a number parameter', async () => {
    const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); const d = st.activeWorksheet(); ${code} })()`);
    const saved = await store(`return JSON.stringify(d.sheet);`), savedTax = await store(`return st.parameters.find((x) => x.name === 'Tax').value;`);
    const f = (c, category, extra = '') => `{ db: 'shop', table: 'orders', column: '${c}', category: '${category}'${extra} }`;
    await store(`const s = d.sheet; s.chartType = 'line'; s.columns = [${f('region', 'text')}]; s.rows = [${f('amount', 'numeric', ", agg: 'sum'")}]; st.updateSheet(d.id, s); return true;`);
    await ev(`(() => { if (!document.querySelector('.ws-analytics')) document.querySelector('button[aria-label="Analytics"]').click(); return true; })()`);
    await waitFor(`[...document.querySelectorAll('.ws-analytics .ws-fmt-field')].some((l) => l.textContent.startsWith('Forecast'))`, 'forecast select');
    const pid = await ev(`(() => { const f = [...document.querySelectorAll('.ws-analytics .ws-fmt-field')].find((l) => l.textContent.startsWith('Forecast')); const o = [...f.querySelector('select').options].find((o) => o.text === 'Parameter: Tax'); if (!o) throw new Error('no parameter option: ' + f.textContent); const s = f.querySelector('select'); s.value = o.value; s.dispatchEvent(new Event('change')); return o.value; })()`);
    await settle();
    const a = await store(`return JSON.stringify(d.sheet.analytics);`);
    must(JSON.parse(a).forecastParam === pid.slice(6), `forecast not bound: ${a}`);
    await store(`const p = st.parameters.find((x) => x.name === 'Tax'); st.updateParameter(p.id, { value: 4 }); return true;`);
    await settle();
    // the moving-average window, on a table so the cells show the result
    await store(`const s = d.sheet; s.chartType = 'table'; s.columns = []; s.rows = [${f('region', 'text')}, ${f('amount', 'numeric', ", agg: 'sum', tableCalc: { type: 'moving', along: 'auto', window: 2 }")}]; st.updateSheet(d.id, s); return true;`);
    await waitFor(`document.querySelectorAll('#ws-chart td.num').length === 3`, 'cells');
    const cells = () => ev(`[...document.querySelectorAll('#ws-chart td.num')].map((x) => x.textContent.trim()).join('|')`);
    must(await cells() === '10|15|25', `window 2 cells: ${await cells()}`);
    await ev(`[...document.querySelectorAll('.ws-shelf--rows .ws-pill')].at(-1).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))`);
    await ev(`[...document.querySelectorAll('.ctx-menu [role^=menuitem]')].find((x) => x.textContent.trim() === 'Table calculation…').click()`);
    await waitFor(`!!document.querySelector('.ws-calc')`, 'calc panel');
    const wid = await ev(`(() => { const sel = [...document.querySelectorAll('.ws-calc .ws-fmt-field')].find((x) => x.textContent.startsWith('Window')).querySelector('select'); const o = [...sel.options].find((o) => o.text === 'Parameter: Tax'); if (!o) throw new Error('no parameter option'); sel.value = o.value; sel.dispatchEvent(new Event('change')); return o.value; })()`);
    await settle();
    await waitFor(`document.querySelectorAll('#ws-chart td.num').length === 3`, 'cells again');
    // Tax = 4 -> window 4 over 10, 20, 30 gives 10, 15, 20
    must(await cells() === '10|15|20', `window follows the parameter: ${await cells()}`);
    const tc = await store(`return JSON.stringify(d.sheet.rows[1].tableCalc);`);
    must(JSON.parse(tc).windowParam === wid.slice(6) && JSON.parse(tc).window === 2, `stored: ${tc}`);
    await ev(`document.querySelector('button[aria-label="Close editor"]').click()`);
    await store(`Object.assign(d.sheet, JSON.parse(${J(saved)})); delete d.sheet.analytics.forecastParam; st.updateParameter(st.parameters.find((x) => x.name === 'Tax').id, { value: ${J(savedTax)} }); st.updateSheet(d.id, d.sheet); return true;`);
    await settle();
  });

  await check('delete: a parameter read by a calculation asks first; cancel keeps it; confirm shows the E15 state and sends no query', async () => {
    await openParams();
    await clickIn(pdlg, 'Delete parameter Tax');
    await waitFor(`${confirmOpen} !== undefined`, 'confirm dialog');
    const msg = await ev(`${confirmOpen}.textContent`);
    must(/Taxed/.test(msg), `confirm doesn't name the calculation: ${msg}`);
    await clickIn(confirmOpen, 'Cancel');
    await waitFor(`${confirmOpen} === undefined`, 'confirm closed');
    must(/Tax/.test(await ev(`${pdlg}.textContent`)), 'parameter gone after Cancel');
    queries.length = 0;
    await clickIn(pdlg, 'Delete parameter Tax');
    await waitFor(`${confirmOpen} !== undefined`, 'confirm again');
    await clickIn(confirmOpen, 'Delete');
    await waitFor(`/^Really delete /.test(${confirmOpen}?.textContent ?? '')`, 'second confirm');
    await clickIn(confirmOpen, 'Delete for good');
    await waitFor(`!/Delete parameter Tax/.test(${pdlg}.innerHTML)`, 'deleted');
    await clickIn(pdlg, 'Done');
    await waitFor(`/can't be computed/.test(document.getElementById('ws-chart').textContent)`, 'E15 message');
    must(/Calculation 'Taxed' can't be computed: Parameter \[@Tax\] was deleted/.test(await chartText()), `chart says: ${await chartText()}`);
    await settle(500);
    must(queries.length === 0, `${queries.length} query(ies) sent for an uncomputable calculation`);
    const pane = await ev(CALC_LIST_TEXT);
    must(/Tax/.test(pane), 'pane lost the calculation');
  });

  await check('deleting a parameter nothing reads asks twice too; restoring the name heals the calculation', async () => {
    await openParams();
    await clickIn(pdlg, 'Delete parameter Label');
    await waitFor(`${confirmOpen} !== undefined`, 'confirm dialog for an unused parameter');
    await clickIn(confirmOpen, 'Delete');
    await waitFor(`/^Really delete /.test(${confirmOpen}?.textContent ?? '')`, 'second confirm');
    await clickIn(confirmOpen, 'Delete for good');
    await waitFor(`!/Delete parameter Label/.test(${pdlg}.innerHTML)`, 'unused parameter deleted');
    await clickIn(pdlg, '+ New parameter');
    await setField('Name', 'Tax'); await setField('Type', 'number', 'select'); await setField('Current value', '0.5');
    await clickIn(pdlg, 'Save'); await clickIn(pdlg, 'Done');
    await settle();
    must(!/can't be computed/.test(await chartText()), `still broken: ${await chartText()}`);
    must(J(lastQuery().measures[0].calc.r) === J({ k: 'num', v: 0.5 }), `healed literal: ${J(lastQuery().measures?.[0])}`);
  });

  await check('dashboard: a widget whose sheet has a calculated pill reading the parameter re-queries with the new literal when it changes', async () => {
    const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); ${code} })()`);
    await store(`st.createDashboard('Board'); return true;`);
    await waitFor(`!document.getElementById('board-view').hidden`, 'board shown');
    await ev(`document.querySelector('.board-panel__item button').click()`);
    await waitFor(`document.querySelectorAll('.board-widget .ws-chart-canvas svg, .board-widget .ws-chart-canvas canvas').length === 1`, 'widget drawn');
    await settle();
    must(J(lastQuery().measures?.[0]?.calc?.r) === J({ k: 'num', v: 0.5 }), `widget request lacks the literal: ${J(lastQuery().measures?.[0])}`);
    const n = queries.length;
    await store(`const p = st.parameters.find((x) => x.name === 'Tax'); st.updateParameter(p.id, { value: 0.9 }); return true;`);
    await settle();
    must(queries.length > n, 'the widget did not re-query');
    must(J(lastQuery().measures?.[0]?.calc?.r) === J({ k: 'num', v: 0.9 }), `new literal missing: ${J(lastQuery().measures?.[0])}`);
    await ev(`document.querySelectorAll('.tab:not(.tab--model) .tab__label')[0].click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet shown again');
  });

  // screenshots, light + dark
  const shots = [];
  for (const scheme of ['light', 'dark']) {
    await b.setScheme(scheme);
    await ev(`document.documentElement.setAttribute('data-theme', ${J(scheme)})`);
    await b.sleep(250);
    await check(`screenshots ${scheme}`, async () => {
      const p1 = join(SHOTS, `params-sheet-${scheme}.png`); await b.screenshot(p1); shots.push(p1);
      await openParams(); await clickIn(pdlg, '+ New parameter');
      await setField('Type', 'number', 'select'); await setField('Allowed', 'range', 'select'); await b.sleep(100);
      const p2 = join(SHOTS, `params-dialog-${scheme}.png`); await b.screenshot(p2); shots.push(p2);
      await clickIn(pdlg, 'Cancel'); await clickIn(pdlg, 'Done');
      await waitFor(`${pdlg} === null`, 'closed');
    });
  }
  console.log('screenshots:\n  ' + shots.join('\n  '));

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
  if (wbDir) rmSync(wbDir, { recursive: true, force: true });
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
