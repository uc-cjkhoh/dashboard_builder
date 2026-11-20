// Browser check for "Include totals" in Format -> Conditional formatting (Table / Text): the real dev app (APP_URL, default http://localhost:5269) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/colour-totals-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5269 ; stop it with fuser -k 5269/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5269';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'colour-totals-ui-shots');
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

  // ---- helpers for this check -------------------------------------------------------------------------------
  const pageScheme = async (s) => { await ev(`import('/features/Core/scheme.js').then((m) => m.setSchemePref(${J(s)}))`); await settle(500); };
  // A real mouse click on the middle of the element `expr` evaluates to (scrolled into view first).
  const realClick = async (expr) => {
    const r = await ev(`(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    must(r, 'nothing to click: ' + expr);
    await b.click(r.x, r.y);
    await settle(400);
  };
  const cfBlock = `[...document.querySelectorAll('.ws-cf')].find((c) => c.querySelector('.ws-cf__title')?.textContent === 'Conditional formatting')`;
  const inclBox = `${cfBlock}.querySelector('.ws-cf__totals input')`;
  const inclState = () => ev(`(() => { const i = ${inclBox}; const n = ${cfBlock}.querySelector('.ws-cf__totals-note'); return { exists: !!i, checked: i?.checked, disabled: i?.disabled, title: i?.closest('label')?.title ?? '', desc: i?.getAttribute('aria-description') ?? '', note: n ? n.textContent : '' }; })()`);
  const checkboxOf = (label) => `[...document.querySelectorAll('.ws-fmt-check')].find((l) => l.textContent.trim() === ${J(label)}).querySelector('input')`;
  const keyText = () => ev(`(document.querySelector('#ws-chart .xt-legend')?.textContent ?? '')`);
  const cellBg = (sel) => ev(`getComputedStyle(${tbl}.querySelector(${J(sel)})).backgroundColor`);
  const totalCells = () => ev(`[...${tbl}.querySelectorAll('td.xt-total')].map((td) => ({ text: td.textContent, cf: td.classList.contains('xt-cf'), bg: td.style.background, ink: td.style.color }))`);
  // The contrast of each coloured total cell: ink against its own tint (page-side, with the app's own contrast module).
  const totalContrasts = () => ev(`(async () => { const { contrastRatio } = await import('/features/Dashboard/contrast.js');
    const hex = (c) => '#' + (c.match(/\\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
    return [...${tbl}.querySelectorAll('td.xt-total.xt-cf')].filter((td) => td.style.background).map((td) => { const cs = getComputedStyle(td); return contrastRatio(hex(cs.color), hex(cs.backgroundColor)); }); })()`);

  await check('a table worksheet draws (region down, amount and qty across); Format has Include totals, off and saying why', async () => {
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('amount', `__t.zone('columns')`);
    await dragChip('qty', `__t.zone('columns')`);
    await settle(400);
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === 'Table').click()`);
    await settle(400);
    await waitFor(`${tbl} !== null`, 'table drawn');
    await ev(`${fmtTool}.click()`);
    await waitFor(`!!${cfBlock}`, 'conditional formatting block');
    const s = await inclState();
    must(s.exists && s.disabled && !s.checked, 'present, off and disabled: ' + J(s));
    must(s.title === 'Turn on Grand totals or Subtotals' && s.desc === s.title && s.note === '', 'says why in the tooltip and the description, with no extra text on the card: ' + J(s));
  });
  let scaleOnHtml = null;
  await check('Grand totals on, but no scale yet: still disabled, now saying what to pick', async () => {
    await realClick(checkboxOf('Grand totals'));
    await waitFor(`${tbl}.querySelector('tr.xt-grand') !== null`, 'grand total row');
    const s = await inclState();
    must(s.disabled && /colour scale, data bars or a rule/.test(s.title) && s.desc === s.title && s.note === '', J(s));
    must((await totalCells()).every((c) => !c.cf), 'totals are plain');
  });
  await check('Colour scale on: the checkbox enables; totals stay plain until it is ticked', async () => {
    await setSelect('Cells', 'scale'); await settle(400);
    const s = await inclState();
    must(!s.disabled && !s.checked && s.note === '', J(s));
    must((await totalCells()).every((c) => !c.cf), 'totals are plain');
    must(!/Totals included/.test(await keyText()), 'key does not say it');
    scaleOnHtml = await ev(`${tbl}.parentElement.outerHTML`);
  });
  let plain30 = null;
  await check('ticking Include totals (a real click) colours the grand total, widens the scale, and the key says so', async () => {
    plain30 = await cellBg('tbody tr:nth-child(3) td.xt-cf'); // US amount (30) on a 10..30 scale
    await realClick(inclBox);
    await waitFor(`${tbl}.querySelector('td.xt-total.xt-cf') !== null`, 'a coloured total');
    const s = await inclState();
    must(s.checked && /Totals are larger than single cells, so cells may look pale/.test(s.note), J(s));
    const t = await totalCells();
    must(t.length === 2 && t[0].cf && t[0].bg && !t[1].cf, 'the amount total is coloured, the qty total (no scale) is not: ' + J(t));
    must(/Totals included/.test(await keyText()), 'key: ' + await keyText());
    const now30 = await cellBg('tbody tr:nth-child(3) td.xt-cf');
    must(now30 !== plain30, 'the 30 cell is paler on the widened 10..60 scale: ' + plain30 + ' -> ' + now30);
    must(await ev(`getComputedStyle(${tbl}.querySelector('tr.xt-grand td.xt-total')).fontWeight`) === '600', 'a total keeps its bold look');
    must((await totalContrasts()).every((r) => r >= 4.5), 'contrast: ' + J(await totalContrasts()));
    await shot('colour-totals-light.png');
    await pageScheme('dark');
    must((await totalContrasts()).every((r) => r >= 4.5), 'dark contrast: ' + J(await totalContrasts()));
    await shot('colour-totals-dark.png');
    await pageScheme('light');
  });
  await check('unticking returns the table exactly to how it was (same DOM) and drops the key text', async () => {
    await realClick(inclBox);
    await waitFor(`${tbl}.querySelector('td.xt-total.xt-cf') === null`, 'totals plain again');
    must(!/Totals included/.test(await keyText()), 'key');
    must((await cellBg('tbody tr:nth-child(3) td.xt-cf')) === plain30, 'the 30 cell has its old tint');
    const stored = await ev(`import('/features/Core/store.js').then((st) => JSON.stringify(st.activeWorksheet().sheet.format.conditional))`);
    must(!/totals/.test(stored), 'off is not stored: ' + stored);
    must((await ev(`${tbl}.parentElement.outerHTML`)) === scaleOnHtml, 'the table and its key are byte-identical to before the box was ticked');
  });
  await check('turning Grand totals off while Include totals is ticked keeps it visible and clearable, with the reason', async () => {
    await realClick(inclBox);
    await waitFor(`${tbl}.querySelector('td.xt-total.xt-cf') !== null`, 'coloured total');
    await realClick(checkboxOf('Grand totals'));
    await waitFor(`${tbl}.querySelector('tr.xt-grand') === null`, 'no grand row');
    const s = await inclState();
    must(s.checked && !s.disabled && /no total is coloured yet/.test(s.note), J(s));
    must(!/Totals included/.test(await keyText()), 'key does not claim totals that are not drawn');
    await realClick(checkboxOf('Grand totals'));
    await waitFor(`${tbl}.querySelector('tr.xt-grand') !== null`, 'grand row back');
    must((await totalCells())[0].cf, 'the saved choice applies again');
  });
  await check('switching the scale off while ticked clears the flag; a rule on a total keeps its tone and icon', async () => {
    await setSelect('Cells', 'none'); await settle(300);
    const s = await inclState();
    must(s.disabled && !s.checked, J(s));
    must(!/totals/.test(await ev(`import('/features/Core/store.js').then((st) => JSON.stringify(st.activeWorksheet().sheet.format.conditional))`)), 'no stale flag stored');
    // a rule with Include totals (set through the store: the rule editor is covered by worksheet-ux-ui)
    await ev(`(async () => {
      const st = await import('/features/Core/store.js'), cm = await import('/features/Dashboard/conditional-model.js'), sp = await import('/features/Dashboard/sheet-plan.js');
      const tab = st.activeWorksheet(); const sheet = tab.sheet;
      const key = cm.measureKey(sp.planMeasures(sheet)[0]);
      sheet.format = { ...sheet.format, conditional: { [key]: { mode: 'none', scale: 'sequential', mid: null, rules: [{ op: '>=', value: 50, tone: 'bad' }], totals: true } } };
      st.updateSheet(tab.id, sheet); return true; })()`);
    await settle(500);
    await waitFor(`${tbl}.querySelector('td.xt-total.xt-rule--bad') !== null`, 'rule tone on the total');
    const r = await ev(`(() => { const td = ${tbl}.querySelector('td.xt-total.xt-rule--bad'); const probe = document.createElement('i'); probe.style.background = 'var(--danger-bg)'; document.body.append(probe);
      const want = getComputedStyle(probe).backgroundColor; probe.remove(); return { got: getComputedStyle(td).backgroundColor, want, icon: !!td.querySelector('.xt-cf__icon svg'), title: td.title, text: td.textContent }; })()`);
    must(r.got === r.want && r.icon && r.title === 'Bad: >= 50', 'tone + icon + title on the total: ' + J(r));
    await shot('colour-totals-rule-light.png');
    await pageScheme('dark'); await shot('colour-totals-rule-dark.png'); await pageScheme('light');
  });
  const setAgg = (agg) => ev(`(async () => {
    const st = await import('/features/Core/store.js'); const tab = st.activeWorksheet(); const sheet = tab.sheet;
    const m = sheet.columns.find((f) => f.category === 'numeric'); m.agg = ${J(agg)}; st.updateSheet(tab.id, sheet); return true; })()`);
  await check('a measure whose totals read — (an average) has the box disabled with the reason, and no key text', async () => {
    await ev(`(async () => { const st = await import('/features/Core/store.js'); const tab = st.activeWorksheet(); const sheet = tab.sheet;
      sheet.format = { ...sheet.format, conditional: {} }; st.updateSheet(tab.id, sheet); return true; })()`);
    await setAgg('avg'); await settle(500);
    await waitFor(`${cfBlock}.querySelector('select').selectedOptions[0].textContent.toLowerCase().startsWith('avg')`, 'the Measure drop-down names the average');
    let s = await inclState();
    must(s.disabled && !s.checked && s.title === 'A total of an average, median or distinct count has no value here' && s.desc === s.title, J(s));
    await setSelect('Cells', 'scale'); await settle(400);
    s = await inclState();
    must(s.disabled && s.title === 'A total of an average, median or distinct count has no value here', 'still disabled with a scale on: ' + J(s));
    must(!/Totals included/.test(await keyText()), 'key: ' + await keyText());
    must(!/look pale/.test(await ev(`${cfBlock}.textContent`)), 'no pale note');
    await shot('colour-totals-avg-light.png');
    await pageScheme('dark'); await shot('colour-totals-avg-dark.png'); await pageScheme('light');
  });
  await check('back to a sum the box is enabled again', async () => {
    await setAgg('sum'); await settle(500);
    await setSelect('Cells', 'scale'); await settle(400);
    const s = await inclState();
    must(!s.disabled && s.title === '', J(s));
  });
  await check('a layout that draws no total (Subtotals only, one Rows dimension) disables the box with the reason', async () => {
    await realClick(checkboxOf('Grand totals'));
    await realClick(checkboxOf('Subtotals'));
    await waitFor(`${tbl}.querySelector('tr.xt-grand') === null`, 'no grand row');
    must(await ev(`${tbl}.querySelector('tr.xt-subtotal') === null`), 'no subtotal row either');
    const s = await inclState();
    must(s.disabled && s.title === 'No total is drawn in this layout' && s.desc === s.title, J(s));
    await realClick(checkboxOf('Grand totals'));
    await waitFor(`${tbl}.querySelector('tr.xt-grand') !== null`, 'grand row back');
    must(!(await inclState()).disabled, 'enabled again with a total drawn');
  });
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
