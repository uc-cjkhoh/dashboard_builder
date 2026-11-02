// Browser checks for expand / collapse crosstab headers (T03-29): the real dev app (APP_URL, default http://localhost:5220) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/expand-collapse-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5220 ; stop it with fuser -k 5220/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5220';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'expand-collapse-ui-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server: a grouped result over 4 row paths (region > country) x 3 column paths (segment > tier) -----------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['country', 'String', 'text'], ['segment', 'String', 'text'], ['tier', 'String', 'text']],
  customers: [['name', 'String', 'text']],
};
const ROWS = [['EU', 'FR'], ['EU', 'DE'], ['US', 'US'], ['US', 'CA']];
const COLS = [['Retail', 'Gold'], ['Retail', 'Basic'], ['Trade', 'Gold']];
const queries = [];     // every /api/query body, in order
let tables = ['orders', 'customers'];
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: tables };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (/\/columns\/\w+\/distinct/.test(path)) return { json: ['a'] };
  if (path === '/api/query') {
    queries.push(body);
    const rd = body.rowDimensions ?? [], cd = body.columnDimensions ?? [];
    const rows = [];
    ROWS.forEach((rt, ri) => COLS.forEach((ct, ci) => rows.push({
      keys: [...rt.slice(0, rd.length), ...ct.slice(0, cd.length)],
      values: (body.measures ?? []).map((_, i) => (i + 1) * 100 * (ri + 1) + 10 * (ci + 1)) })));
    const seen = new Set();
    const uniq = rows.filter((r) => { const k = r.keys.join('|'); if (seen.has(k)) return false; seen.add(k); return true; });
    return { json: { rowDimensions: rd.map((d) => d.column), columnDimensions: cd.map((d) => d.column), measures: (body.measures ?? []).map((_, i) => `v${i}`), rows: uniq, truncated: false } };
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
  await relateTables(ev, waitFor, ['orders', 'region', 'customers', 'name']); // an unrelated table is held out of the field pane
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await installHelpers();
  await waitFor(`!!__t.chip('region')`, 'field pane filled');

  const shot = async (name) => { try { writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } };
  const tbl = `document.querySelector('#ws-chart table.xtab')`;
  const bodyRows = () => ev(`[...${tbl}.tBodies[0].rows].map((r) => [...r.cells].map((c) => c.textContent.trim()))`);
  const headRows = () => ev(`[...${tbl}.tHead.rows].map((r) => [...r.cells].map((c) => c.textContent.trim()))`);
  const toggles = (axis) => ev(`[...${tbl}.querySelectorAll('${axis === 'rows' ? 'tbody' : 'thead'} .xt-toggle')].map((x) => ({ label: x.getAttribute('aria-label'), open: x.getAttribute('aria-expanded') }))`);
  const clickToggle = (label) => ev(`(() => { const x = [...${tbl}.querySelectorAll('.xt-toggle')].find((e) => e.getAttribute('aria-label') === ${J(label)}); if (!x) throw new Error('no toggle ' + ${J(label)}); x.click(); return true; })()`);
  const collapsedState = () => ev(`import('/features/Core/store.js').then((m) => m.activeWorksheet().sheet.collapsed ?? null)`);

  await check('a Rows x Columns table draws with a toggle on every header that has a next level', async () => {
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('country', `__t.zone('rows')`);
    await dragChip('segment', `__t.zone('columns')`);
    await dragChip('tier', `__t.zone('columns')`);
    await dragChip('amount', `__t.zone('columns')`);
    await dragChip('qty', `__t.zone('columns')`);
    await settle(400);
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === 'Table').click()`);
    await settle(400);
    await waitFor(`${tbl} !== null`, 'table drawn');
    // amount sums (additive); qty averages (not additive)
    await ev(`import('/features/Core/store.js').then((m) => { const t = m.activeWorksheet(); const q = t.sheet.columns.find((p) => p.column === 'qty'); q.agg = 'avg'; m.updateSheet(t.id, t.sheet); return true; })`);
    await settle(400);
    await waitFor(`${tbl} !== null && ${tbl}.querySelectorAll('.xt-toggle').length > 0`, 'toggles drawn');
    const r = await toggles('rows'), c = await toggles('cols');
    must(r.length === 2 && r.every((x) => x.open === 'true') && r[0].label === 'Collapse EU (rows)', `row toggles: ${J(r)}`);
    must(c.length === 2 && c[0].label === 'Collapse Retail (columns)', `column toggles: ${J(c)}`);
    must((await bodyRows()).length === 4, 'four rows');
    await shot('expand-collapse-expanded-light.png');
  });

  let q0;
  await check('collapsing a row header shows one row; sums add, an average shows "—"; no new query', async () => {
    q0 = queries.length;
    await clickToggle('Collapse EU (rows)');
    await waitFor(`[...${tbl}.tBodies[0].rows].length === 3`, 'EU collapsed');
    const rows = await bodyRows();
    must(rows[0][0] === 'EU', `first row: ${J(rows[0])}`);
    // header row 2 is the measure band (amount, qty per column path); the EU row's amount cells are the FR + DE sums
    must(rows[0].some((t) => t === '—'), `an average cell should read —: ${J(rows[0])}`);
    must(rows[1].every((t) => t !== '—'), `expanded rows keep their values: ${J(rows[1])}`);
    must(queries.length === q0, 'collapsing must not query again');
    must(J(await collapsedState()).includes('EU'), `state: ${J(await collapsedState())}`);
    const t = await toggles('rows');
    must(t[0].label === 'Expand EU (rows)' && t[0].open === 'false', J(t));
    await b.sleep(300);
    must(await ev(`document.activeElement?.getAttribute('aria-label') === 'Expand EU (rows)'`), 'focus returns to the toggle: ' + await ev(`document.activeElement?.tagName + '.' + document.activeElement?.className`));
    await shot('expand-collapse-rows-light.png');
  });

  await check('the collapsed row\'s value is the sum of its children (110 + 210 = 320), the amount cell of Retail / Gold', async () => {
    await clickToggle('Expand EU (rows)');
    await waitFor(`[...${tbl}.tBodies[0].rows].length === 4`, 'EU expanded');
    const open = await bodyRows();
    const num = (t) => Number(t.replace(/[^0-9.-]/g, ''));
    // EU / FR row: [EU, FR, amount, qty, ...]; EU / DE row: [DE, amount, qty, ...] (EU is rowSpan-merged)
    must(num(open[0][2]) === 110 && num(open[1][1]) === 210, `children: ${open[0][2]} and ${open[1][1]}`);
    await clickToggle('Collapse EU (rows)');
    await waitFor(`[...${tbl}.tBodies[0].rows].length === 3`, 'EU collapsed again');
    const shut = await bodyRows();
    must(shut[0][0] === 'EU' && num(shut[0][1]) === 320, `collapsed row: ${J(shut[0])}`);
    must(shut[0][2] === '—', `the average qty has no value when collapsed: ${J(shut[0])}`);
  });

  await check('collapsing a column header drops its sub-columns and hides nothing else', async () => {
    const before = (await headRows()).length;
    await clickToggle('Collapse Retail (columns)');
    await waitFor(`${tbl}.querySelectorAll('.xt-toggle[aria-label="Expand Retail (columns)"]').length === 1`, 'Retail collapsed');
    const hdr = await headRows();
    must(hdr.length === before, `header rows: ${before} -> ${hdr.length}`);
    must(!hdr.some((r) => r.includes('Basic')), `Basic hidden: ${J(hdr)}`);
    must(hdr.some((r) => r.includes('Gold')), `Trade/Gold still there: ${J(hdr)}`);
    must(J(await collapsedState()).includes('Retail'), 'state keeps the column key');
    await shot('expand-collapse-both-light.png');
  });

  await check('toggles are keyboard operable: focusable buttons, Enter and Space flip them', async () => {
    await ev(`(() => { [...${tbl}.querySelectorAll('.xt-toggle')].find((e) => e.getAttribute('aria-label') === 'Expand EU (rows)').focus(); return true; })()`);
    for (const key of ['Enter', ' ']) {
      const before = await ev(`document.activeElement.getAttribute('aria-expanded')`);
      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key === ' ' ? 'Space' : 'Enter', text: key === ' ' ? ' ' : '\r', windowsVirtualKeyCode: key === ' ' ? 32 : 13 });
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key === ' ' ? 'Space' : 'Enter', windowsVirtualKeyCode: key === ' ' ? 32 : 13 });
      await b.sleep(300);
      const after = await ev(`document.activeElement.getAttribute('aria-expanded')`);
      must(before !== after && after !== null, `key "${key}": ${before} -> ${after}`);
    }
    const o = await ev(`(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle + ' ' + s.outlineWidth; })()`);
    must(/solid 2px/.test(o), `visible focus: ${o}`);
  });

  await check('the collapsed state is saved with the sheet and drawn again after a redraw (restore)', async () => {
    const saved = await ev(`import('/features/Core/store.js').then((m) => JSON.stringify(m.activeWorksheet().sheet.collapsed))`);
    await ev(`import('/features/Core/store.js').then((m) => { const t = m.activeWorksheet(); t.sheet.collapsed = null; m.updateSheet(t.id, t.sheet); return true; })`);
    await waitFor(`[...${tbl}.tBodies[0].rows].length === 4 && !${tbl}.querySelector('.xt-toggle[aria-expanded="false"]')`, 'all expanded');
    await ev(`import('/features/Core/store.js').then((m) => { const t = m.activeWorksheet(); t.sheet.collapsed = ${saved}; m.updateSheet(t.id, t.sheet); return true; })`);
    await waitFor(`${tbl}.querySelectorAll('.xt-toggle[aria-expanded="false"]').length >= 1`, 'restored');
  });

  await check('undo restores the collapsed state, redo re-applies it', async () => {
    const before = J(await collapsedState());
    await clickToggle('Collapse US (rows)');
    await waitFor(`${tbl}.querySelectorAll('.xt-toggle[aria-label="Expand US (rows)"]').length === 1`, 'US collapsed');
    must(J(await collapsedState()) !== before, 'state changed');
    await ev(`[...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Undo (Ctrl+Z)').click()`);
    await waitFor(`${tbl}.querySelectorAll('.xt-toggle[aria-label="Collapse US (rows)"]').length === 1`, 'undone');
    must(J(await collapsedState()) === before, `after undo: ${J(await collapsedState())} vs ${before}`);
    await ev(`[...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Redo (Ctrl+Shift+Z)').click()`);
    await waitFor(`${tbl}.querySelectorAll('.xt-toggle[aria-label="Expand US (rows)"]').length === 1`, 'redone');
    await clickToggle('Expand US (rows)');
    await waitFor(`${tbl}.querySelectorAll('.xt-toggle[aria-label="Collapse US (rows)"]').length === 1`, 'US expanded');
  });

  await check('geometry: toggle and header text are >= 4px apart, no overflow, rows and header cells do not touch', async () => {
    await clickToggle('Collapse US (rows)');
    await settle(300);
    const r = await ev(`(() => {
      const out = { gaps: [], overflow: [], drift: [] };
      for (const h of document.querySelectorAll('#ws-chart .xt-hdr')) {
        const b = h.querySelector('.xt-toggle').getBoundingClientRect(), t = h.querySelector('.xt-hdr__text').getBoundingClientRect();
        out.gaps.push(Math.round((t.left - b.right) * 10) / 10);
        out.drift.push(Math.round(Math.abs((b.top + b.height / 2) - (t.top + t.height / 2)) * 10) / 10);
        const th = h.closest('th').getBoundingClientRect();
        if (b.left < th.left || t.right > th.right + 0.5) out.overflow.push(h.textContent);
      }
      return out; })()`);
    must(r.gaps.length >= 3 && r.gaps.every((g) => g >= 4), `gaps: ${J(r.gaps)}`);
    must(r.drift.every((d) => d <= 1.5), `vertical drift: ${J(r.drift)}`);
    must(r.overflow.length === 0, `overflow: ${J(r.overflow)}`);
    // optical alignment: the +/- glyph (not its 24px box) meets the left edge of the text above it in the same column
    const o = await ev(`(() => {
      const corner = document.querySelector('#ws-chart .xt-corner'); const cs = getComputedStyle(corner);
      const textLeft = corner.getBoundingClientRect().left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth) / 2;
      const rowTh = document.querySelector('#ws-chart tbody .xt-rowhdr .xt-toggle svg');
      const box = rowTh.getBoundingClientRect(); // 16px svg, 20-unit viewBox: the path starts 4 units in
      return { textLeft, glyphLeft: box.left + 4 * box.width / 20 }; })()`);
    must(Math.abs(o.glyphLeft - o.textLeft) <= 2, `glyph ${o.glyphLeft.toFixed(1)} vs text ${o.textLeft.toFixed(1)}`);
    await ev(`import('/features/Core/scheme.js').then((m) => m.setSchemePref('dark'))`); await settle(600);
    await shot('expand-collapse-both-dark.png');
    await ev(`import('/features/Core/scheme.js').then((m) => m.setSchemePref('light'))`); await settle(300);
  });

  await check('no page exceptions', async () => { must(b.consoleErrors.length === 0, b.consoleErrors.join(' | ')); });
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
