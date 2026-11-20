// Browser checks for per-column alignment and width (T01-23): the real dev app (APP_URL, default http://localhost:5265) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/table-columns-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5265 ; stop it with fuser -k 5265/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5265';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'table-columns-ui-shots');
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

  const fmtField = (label) => `[...document.querySelectorAll('.ws-fmt-field')].find((l) => l.textContent.includes(${J(label)}))`;
  const setSelect = (label, v) => ev(`(() => { const s = ${fmtField(label)}.querySelector('select'); s.value = ${J(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const tbl = `document.querySelector('#ws-chart table.xtab')`;
  const cell = (what) => ev(`(() => { const t = ${tbl}; const e = t.querySelector(${J(what)}); const cs = getComputedStyle(e); return { align: cs.textAlign, pt: cs.paddingTop, pl: cs.paddingLeft, bg: cs.backgroundColor }; })()`);

  const colHdr = (i) => `${tbl}.querySelectorAll('thead th.xt-meas')[${i}]`;
  const gripOf = (i) => `${colHdr(i)}.querySelector('.xt-grip')`;
  const cellInfo = (sel, i = 0) => ev(`(() => { const e = ${tbl}.querySelectorAll(${J(sel)})[${i}]; const cs = getComputedStyle(e); return { align: cs.textAlign, w: Math.round(e.getBoundingClientRect().width), cls: e.className }; })()`);
  const key = (k, extra = {}) => b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, ...extra }).then(() => b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, ...extra }));
  const sheetCols = () => ev(`import('/features/Core/store.js').then((m) => m.activeWorksheet().sheet.format.tableCols ?? null)`);

  await check('a table with two measures draws; Format → Columns lists the stub and measure columns', async () => {
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('amount', `__t.zone('columns')`);
    await dragChip('qty', `__t.zone('columns')`);
    await settle(400);
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === 'Table').click()`);
    await settle(400);
    await waitFor(`${tbl} !== null`, 'table drawn');
    await ev(`${fmtTool}.click()`);
    await waitFor(`!!(${fmtField('Column')})`, 'columns editor');
    const opts = await ev(`[...${fmtField('Column')}.querySelectorAll('option')].map((o) => o.textContent)`);
    must(J(opts) === J(['region', 'sum amount', 'sum qty']), 'column options: ' + J(opts));
    must(await ev(`${tbl}.querySelectorAll('.xt-grip').length === 2`), 'a resize handle on each measure header');
    must(await ev(`!${tbl}.querySelector('td.xt-w')`), 'no widths until set');
    await shot('columns-default-light.png');
  });
  await check('a column\'s alignment overrides the table-wide one', async () => {
    await setSelect('Align', 'center'); await settle(300); // the table-wide Align (first field named Align)
    await ev(`(() => { const s = ${fmtField('Column')}.querySelector('select'); s.value = 'm0'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await settle(300);
    const colAlign = (v) => ev(`(() => { const f = [...document.querySelectorAll('.ws-fmt-field')].filter((l) => l.textContent.includes('Align')); const s = f[f.length - 1].querySelector('select'); s.value = ${J(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await colAlign('left'); await settle(300);
    must((await cellInfo('tbody tr td:nth-of-type(1)')).align === 'left', 'first measure column left: ' + J(await cellInfo('tbody tr td:nth-of-type(1)')));
    must((await cellInfo('tbody tr td:nth-of-type(2)')).align === 'center', 'second keeps the table setting');
    must((await cellInfo('thead th.xt-meas', 0)).align === 'left', 'the header follows its column: ' + J(await cellInfo('thead th.xt-meas', 0)));
    must((await cellInfo('thead th.xt-meas', 1)).align === 'center', 'the other header keeps the table setting');
    must(J(await sheetCols()) === J({ m0: { align: 'left' } }), 'stored: ' + J(await sheetCols()));
    await colAlign('right'); await settle(300);
    must((await cellInfo('tbody tr td:nth-of-type(1)')).align === 'right', 'right');
    must((await cellInfo('thead th.xt-meas', 0)).align === 'right', 'header right');
    await colAlign('auto'); await settle(300);
    must((await cellInfo('tbody tr td:nth-of-type(1)')).align === 'center', 'auto returns to the table setting');
    must((await sheetCols()) === null, 'emptied column leaves nothing stored');
    await setSelect('Align', 'auto'); await settle(300);
  });
  await check('Width (px) fixes a column; out of range is refused with a message; Reset clears it', async () => {
    const width = async (raw) => { await focusAndType(`.ws-fmt-field input[placeholder="Auto"]`, raw); await ev(`document.querySelector('.ws-fmt-field input[placeholder="Auto"]').dispatchEvent(new Event('change', { bubbles: true }))`); await settle(300); };
    await width('160');
    must((await cellInfo('thead th.xt-meas', 0)).w === 160, 'header 160: ' + J(await cellInfo('thead th.xt-meas', 0)));
    must((await cellInfo('tbody td.num')).w === 160, 'cells 160');
    must((await cellInfo('thead th.xt-meas', 1)).w !== 160, 'the other column is untouched');
    await width('5'); must(/between 48 and 600/.test(await toastText()), 'toast: ' + await toastText());
    must((await sheetCols()).m0.width === 160, 'the stored width is kept');
    await width('100.5'); must(/whole/.test(await toastText()), 'whole pixels: ' + await toastText());
    await shot('columns-width-light.png');
    await ev(`[...document.querySelectorAll('button')].find((x) => x.textContent === 'Reset column').click()`); await settle(300);
    must((await sheetCols()) === null, 'reset clears the column');
    must(await ev(`!${tbl}.querySelector('td.xt-w')`), 'and the widths');
  });
  await check('the header handle: arrow keys step 8 px, Shift five steps, bounds hold, Delete resets', async () => {
    await ev(`${gripOf(0)}.focus()`);
    const w0 = (await cellInfo('thead th.xt-meas', 0)).w;
    must(await ev(`${gripOf(0)}.getAttribute('role') === 'separator' && ${gripOf(0)}.getAttribute('aria-label').startsWith('Resize column ')`), 'handle semantics');
    await key('ArrowRight', { windowsVirtualKeyCode: 39 }); await settle(300);
    must((await sheetCols()).m0.width === w0 + 8, 'ArrowRight +8: ' + J(await sheetCols()) + ' from ' + w0);
    must(await ev(`document.activeElement === ${gripOf(0)}`), 'focus stays on the handle after the redraw');
    await key('ArrowLeft', { windowsVirtualKeyCode: 37, modifiers: 8 }); await settle(300);
    must((await sheetCols()).m0.width === Math.max(48, w0 + 8 - 40), 'Shift+ArrowLeft -40: ' + J(await sheetCols()));
    for (let i = 0; i < 40; i++) await key('ArrowLeft', { windowsVirtualKeyCode: 37, modifiers: 8 });
    await settle(300);
    must((await sheetCols()).m0.width === 48, 'stops at the 48 px minimum: ' + J(await sheetCols()));
    await key('Delete', { windowsVirtualKeyCode: 46 }); await settle(300);
    must((await sheetCols()) === null, 'Delete returns to automatic');
  });
  await check('a drag that ends where it started commits nothing and leaves no widths behind', async () => {
    const r = await ev(`(() => { const g = ${gripOf(1)}.getBoundingClientRect(); return { x: g.x + g.width / 2, y: g.y + g.height / 2 }; })()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + 40, y: r.y, button: 'left' });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'left' });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await settle(300);
    must((await sheetCols()) === null, 'nothing stored: ' + J(await sheetCols()));
    must(await ev(`!${tbl}.querySelector('.xt-w') && !${tbl}.classList.contains('xt-sized') && ${tbl}.querySelector('td.num').style.width === ''`), 'no leftover widths or xt-sized');
  });
  await check('dragging the handle resizes live and commits one width', async () => {
    const r = await ev(`(() => { const g = ${gripOf(1)}.getBoundingClientRect(); return { x: g.x + g.width / 2, y: g.y + g.height / 2, w: ${colHdr(1)}.getBoundingClientRect().width }; })()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + 56, y: r.y, button: 'left' });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x + 56, y: r.y, button: 'left', clickCount: 1 });
    await settle(300);
    const got = (await sheetCols())?.m1?.width;
    must(got != null && Math.abs(got - (Math.round(r.w) + 56)) <= 8, `dragged +56 from ${r.w}: ${got}`);
    must((await cellInfo('thead th.xt-meas', 1)).w === got, 'drawn at the stored width');
    await shot('columns-dragged-light.png');
    await ev(`import('/features/Core/scheme.js').then((m) => m.setSchemePref('dark'))`); await settle(600);
    await shot('columns-dragged-dark.png');
    await ev(`import('/features/Core/scheme.js').then((m) => m.setSchemePref('light'))`);
  });
  await check('the stub column takes an alignment and a width from Format; saved sheets restore it', async () => {
    await ev(`(() => { const s = ${fmtField('Column')}.querySelector('select'); s.value = 'd0'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await settle(300);
    await focusAndType(`.ws-fmt-field input[placeholder="Auto"]`, '200');
    await ev(`document.querySelector('.ws-fmt-field input[placeholder="Auto"]').dispatchEvent(new Event('change', { bubbles: true }))`); await settle(300);
    must((await cellInfo('tbody th.xt-rowhdr')).w === 200, 'stub header 200: ' + J(await cellInfo('tbody th.xt-rowhdr')));
    const back = await ev(`(async () => { const st = await import('/features/Core/store.js'), wm = await import('/features/Workbook/workbook-model.js');
      return wm.restoreSheet(JSON.parse(JSON.stringify(st.activeWorksheet().sheet))).format.tableCols; })()`);
    must(J(back) === J({ d0: { width: 200 }, m1: back.m1 }) && back.m1.width > 0, 'round trip: ' + J(back));
  });
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
