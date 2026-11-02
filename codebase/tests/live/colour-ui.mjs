// Browser checks for the member colours and palette reverse (T01-20, T03-33): the real dev app (APP_URL, default http://localhost:5186) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/colour-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5186 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { CHIP_SCOPE, NEW_CALC, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5186';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'colour-ui-shots');
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
  const fills = () => ev(`[...document.querySelectorAll('.ws-chart-canvas svg path')].map((p) => (p.getAttribute('fill') || '').toLowerCase()).filter((f) => /^#[0-9a-f]{6}$/.test(f))`);
  const lum = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };

  await check('a pie colours its members; Format lists them with swatches', async () => {
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('amount', `__t.zone('columns')`);
    await settle(400);
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === 'Pie').click()`);
    await settle(400);
    await waitFor(`${fmtTool} !== null`, 'format tool');
    await ev(`${fmtTool}.click()`);
    await waitFor(`!!document.querySelector('.ws-memcol__toggle') && !document.querySelector('.ws-memcol__toggle').disabled`, 'member editor enabled');
    await ev(`document.querySelector('.ws-memcol__toggle').click()`);
    must(await ev(`document.querySelectorAll('.ws-memcol__row').length`) === 3, 'three member rows');
    must(await ev(`document.querySelectorAll('.ws-memcol__row')[0].querySelectorAll('.ws-memcol__swatch').length`) >= 12, 'swatches');
  });
  let before;
  await check('picking a swatch recolours that slice, persists in the sheet and survives a re-render; Reset restores', async () => {
    before = await fills();
    await ev(`document.querySelectorAll('.ws-memcol__row')[1].querySelectorAll('.ws-memcol__swatch')[15].click()`); // #000000
    await settle(400);
    await waitFor(`document.querySelectorAll('.ws-memcol__row').length === 3`, 'editor still open after redraw');
    const after = await fills();
    must(after.includes('#000000') && !before.includes('#000000'), `fills before ${J(before)} after ${J(after)}`);
    must(await ev(`document.querySelectorAll('.ws-memcol__row')[1].querySelector('.ws-memcol__dot').dataset.colour`) === '#000000', 'dot shows colour');
    await shot('colour-light.png');
    await ev(`document.querySelectorAll('.ws-memcol__row')[1].querySelector('.ws-memcol__reset').click()`);
    await settle(400);
    must(!(await fills()).includes('#000000'), 'reset restored the palette colour');
  });
  await check('Reset all for this field clears every stored member colour', async () => {
    const sw = (i, k) => `document.querySelectorAll('.ws-memcol__row')[${i}].querySelectorAll('.ws-memcol__swatch')[${k}].click()`;
    await ev(sw(0, 15)); await settle(400); await ev(sw(2, 15)); await settle(400);
    must((await fills()).filter((f) => f === '#000000').length >= 2, 'black slices');
    must((await ev(`document.querySelector('.ws-memcol__clear').textContent`)).includes('(2)'), 'count shown');
    await ev(`document.querySelector('.ws-memcol__clear').click()`);
    await settle(400);
    must(!(await fills()).includes('#000000'), 'all reset');
    must(await ev(`document.querySelector('.ws-memcol__clear').disabled`), 'button disabled when nothing stored');
  });
  await check('Reverse palette reverses the slice colours', async () => {
    const a = await fills();
    await ev(`[...document.querySelectorAll('.ws-fmt-check, label')].find((l) => l.textContent.includes('Reverse palette')).querySelector('input').click()`);
    await settle(400);
    const r = await fills();
    must(a.length >= 3 && r.length >= 3 && a[0] !== r[0], `a ${J(a)} r ${J(r)}`);
    await ev(`document.documentElement.setAttribute('data-theme', 'dark')`);
    await shot('colour-dark.png');
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
