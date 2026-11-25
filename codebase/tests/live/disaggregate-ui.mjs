// Browser checks for Aggregate Measures off (sheet actions ⋯ → Aggregate Measures; D168): the item is ticked by default and disabled off the point charts,
// unticking it sends `disaggregate: true` with no having / Other bucket, draws one mark per source row (12 rows that share keys stay 12 marks across the Colour
// series, with Data labels on), drops the aggregation word from the pills, names the measures by field in the caption, sort menu and axes, and leaves a bar chart aggregated.
// Chromium over the DevTools protocol (tests/live/cdp.mjs); every /api/* call is answered by a mock, nothing reaches a ClickHouse. Run:  node tests/live/disaggregate-ui.mjs
//   (start the app first: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5262 ; stop it with fuser -k 5262/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5262';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'disaggregate-ui-shots');
mkdirSync(SHOTS, { recursive: true });
const SCHEME = process.env.SCHEME === 'dark' ? 'dark' : 'light'; // SCHEME=dark loads the page in the dark scheme (set before load)

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text'], ['discount', 'Float64', 'numeric'], ['placed', 'DateTime', 'temporal']],
  customers: [['country', 'String', 'text']],
};
const REGIONS = ['APAC', 'EU', 'US', 'LATAM', 'MEA', 'CA', 'UK', 'JP'];
const DIMVALS = { region: REGIONS, channel: ['web', 'shop', 'app'], country: ['DE', 'FR'] };
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
    if (body.disaggregate) { // Aggregate Measures off: 12 source rows, several sharing the same keys (a group would have merged them)
      const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
      return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column), measures: body.measures.map((m) => m.column),
        rows: Array.from({ length: 12 }, (_, r) => ({ keys: dims.map((d) => (d.column === 'channel' ? ['web', 'shop', 'app'][r % 3] : ['APAC', 'EU'][r % 2])), values: body.measures.map((_, i) => 10 * (r % 4) + i + r) })), truncated: false } };
    }
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    // every dimension has its own members; several dimensions give the full product (a group per pair), the way a group-by does
    const members = dims.map((d) => DIMVALS[d.column] ?? REGIONS);
    let combos = [[]];
    for (const m of members) combos = combos.flatMap((c) => m.map((x) => [...c, x]));
    const value = (m, i, r) => (m.column === 'discount' ? (r - Math.floor(combos.length / 2)) * 10 : 10 * (r + 1) + i); // `discount` crosses zero; the rest are positive
    return { json: {
      rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: combos.map((keys, r) => ({ keys, values: (body.measures ?? []).map((m, i) => value(m, i, r)) })),
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
const deepEq = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= 1); // measured pixel extents: one pixel of anti-aliasing is not a difference


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

  // Edit member colours… is a dialog (palettes left, members right, Save): open it, optionally pick, then Save (or Cancel).
  const memDlg = `document.querySelector('dialog.memcol-dialog[open]')`;
  const memOpen = async () => { await ev(`document.querySelector('.ws-memcol__open').click()`); await waitFor(`!!${memDlg}`, 'member colours dialog'); };
  const memNames = () => ev(`[...${memDlg}.querySelectorAll('.memcol-member__name')].map((n) => n.textContent)`);
  const memPick = async (row, hex) => { // a colour typed as #rrggbb in the dialog's custom field: it stages for the selected member (the generated colours are not fixed, so a test names its own)
    await ev(`${memDlg}.querySelectorAll('.memcol-member')[${row}].click()`);
    await ev(`(() => { const i = ${memDlg}.querySelector('.memcol-custom__hex'); i.value = '${hex}'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  };
  const memEnd = async (btn = 'primary') => { await ev(`${memDlg}.querySelector('.dialog__foot .btn${btn === 'primary' ? '--primary' : ':nth-child(2)'}').click()`); await waitFor(`!${memDlg}`, 'member colours dialog closed'); };
  const lastQuery = () => queries[queries.length - 1];
  const hasKey = (o, k) => J(o).includes(`"${k}"`);

  // ---- setup: connect, add the two tables, open a worksheet -----------------------------------------------------
  if (SCHEME === 'dark') await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "new MutationObserver((_, o) => { if (document.documentElement) { document.documentElement.setAttribute('data-scheme', 'dark'); o.disconnect(); } }).observe(document, { childList: true })" }); // read at load
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
  const shot = async (name) => { try { writeFileSync(join(SHOTS, `${name}-${SCHEME}.png`), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } };
  const fmtTool = `document.querySelector('.ws-viewbar__btn[aria-label="Format"]')`;
  const colTool = `document.querySelector('.ws-tool[data-tool="color"]')`; // the Colour controls live in the Color tile's flyout (D151)
  const fmtField = (label) => `[...document.querySelectorAll('.ws-fmt-field')].find((l) => l.textContent.includes(${J(label)}))`;
  const setSelect = (label, v) => ev(`(() => { const s = ${fmtField(label)}.querySelector('select, input[type=range]'); s.value = ${J(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const inst = `window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas'))`;
  const opt = () => ev(`${inst}.getOption()`);
  const hints = () => ev(`[...document.querySelectorAll('#ws-chart .ws-hint')].map((h) => h.textContent)`);
  const chartType = async (name) => {
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === ${J(name)}).click()`);
    await settle(500);
  };
  const toolEl = (name) => `document.querySelector('.ws-tool[aria-label^="${name}"]')`;
  const newSheet = async () => {
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden && !!__t.chip('region') && !document.querySelector('.ws-shelf--columns .ws-pill')`, 'a fresh worksheet');
    await ev(`document.documentElement.${SCHEME === 'dark' ? "setAttribute('data-scheme', 'dark')" : "removeAttribute('data-scheme')"}`); // the boot script may have reset it
  };
  // The drawn marks, read from the live chart: per-item fill, graphic bounds, symbol size.
  const per = (expr) => ev(`(() => { const d = ${inst}.getModel().getSeriesByIndex(0).getData(); return Array.from({ length: d.count() }, (_, k) => (${expr})); })()`);
  const fills = () => per(`d.getItemVisual(k, 'style').fill`);
  const extent = (dim) => per(`Math.round(d.getItemGraphicEl(k).getBoundingRect().${dim})`);
  const symbolSizes = () => per(`(() => { const s = d.getItemVisual(k, 'symbolSize'); return Array.isArray(s) ? s[0] : s; })()`);
  const sizeText = async () => J((await opt()).graphic ?? []).match(/Size: [^"]*/)?.[0] ?? '';
  const distinct = (a) => new Set(a).size;
  const hex = (c) => ev(`'#' + echarts.color.parse(${J(c)}).slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')`);
  const tipText = async (si, di) => {
    await ev(`${inst}.dispatchAction({ type: 'showTip', seriesIndex: ${si}, dataIndex: ${di} })`); await b.sleep(200);
    return ev(`[...document.querySelectorAll('.ws-chart-canvas div')].map((d) => d.innerText).filter((t) => t && t.includes('\\n')).pop() ?? ''`);
  };


  const setField = (label, v) => ev(`(() => { const i = ${fmtField(label)}.querySelector('input'); i.value = ${J(v)}; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const toggle = (label) => ev(`${fmtField(label)}.querySelector('input').click()`);
  const colourOpen = () => ev(`!!document.querySelector('#ws-toolfly:not([hidden]) #ws-toolpanel-color')`);
  const openColour = async () => { if (!(await colourOpen())) await ev(`${colTool}.click()`); await waitFor(`!!document.querySelector('#ws-toolfly:not([hidden]) #ws-toolpanel-color')`, 'Color flyout open'); }; // a drop on the tile opens it already
  const closeColour = async () => { if (await colourOpen()) await ev(`${colTool}.click()`); await settle(300); };
  const formatOpen = () => ev(`!!(${fmtField('Number')})`);
  const openFormat = async () => { if (!(await formatOpen())) await ev(`${fmtTool}.click()`); await waitFor(`!!(${fmtField('Number')})`, 'format panel open'); };
  const closeFormat = async () => { if (await formatOpen()) await ev(`${fmtTool}.click()`); await settle(300); };
  const menuBtn = `document.querySelector('.ws-actions .iconbtn, .ws-actions button')`;
  const aggItem = `[...document.querySelectorAll('.ws-actions .menu__item')].find((x) => x.textContent.includes('Aggregate Measures'))`;
  const openMenu = async () => { if (!(await ev(`!!${aggItem}`))) await ev(`${menuBtn}.click()`); await waitFor(`!!${aggItem}`, 'sheet actions open'); };
  const closeMenu = async () => { if (await ev(`!!${aggItem}`)) await ev(`${menuBtn}.click()`); };
  const itemState = () => ev(`(() => { const i = ${aggItem}; return { checked: i.getAttribute('aria-checked'), disabled: i.disabled, title: i.title }; })()`);
  const points = () => ev(`(() => { const o = ${inst}.getOption(); const s = o.series.filter((x) => x.type === 'scatter'); return { series: s.length, points: s.reduce((a, x) => a + (x.data || []).length, 0), names: s.map((x) => x.name), labels: s.every((x) => x.label && x.label.show) }; })()`);

  await newSheet();
  await chartType('Scatter');
  await dragChip('amount', `__t.zone('columns')`);
  await dragChip('discount', `__t.zone('rows')`);
  await settle(600);

  await check('Aggregate Measures is ticked and enabled on a scatter, and the query is the aggregated one', async () => {
    await openMenu();
    const st = await itemState();
    must(st.checked === 'true' && !st.disabled, 'ticked and enabled: ' + J(st));
    must(!('disaggregate' in lastQuery()), 'no disaggregate key while aggregated');
    must(/Sum/.test(await ev(`document.querySelector('.ws-pill--measure').textContent`)), 'the pill still says Sum');
    await closeMenu();
  });
  await check('unticking it sends disaggregate, drops having and Other, keeps the 5,000 cap, and draws one mark per row', async () => {
    await openMenu();
    await ev(`${aggItem}.click()`); await settle(800);
    const q = lastQuery();
    must(q.disaggregate === true && q.limit === 5000 && q.otherBucket === undefined && q.having === undefined, 'plan: ' + J({ d: q.disaggregate, l: q.limit, o: q.otherBucket, h: q.having }));
    const p = await points();
    must(p.points === 12, 'twelve source rows are twelve marks: ' + J(p));
    await openMenu();
    must((await itemState()).checked === 'false', 'the item reads unticked');
    await closeMenu();
  });
  await check('the pills lose the aggregation word; the caption, sort menu and axes name the field', async () => {
    const pills = await ev(`[...document.querySelectorAll('.ws-pill--measure')].map((p) => [p.textContent.replace('⠿', '').trim(), p.title])`);
    must(pills.every(([t, title]) => !/^(Sum|Average)/.test(t) && /one value per row/.test(title)), 'pills: ' + J(pills));
    must(/amount, discount/.test(await ev(`document.querySelector('.ws-titleblock').textContent`)) && !/sum amount/.test(await ev(`document.querySelector('.ws-titleblock').textContent`)), 'caption names the fields');
    must(/amount/.test(await ev(`document.querySelector('.ws-sort, [aria-label^="Sort"]')?.textContent ?? ''`)) && !/sum amount/.test(await ev(`document.querySelector('.ws-sort, [aria-label^="Sort"]')?.textContent ?? ''`)), 'sort button names the field');
    const o = await opt();
    must(J(o).includes('"name":"amount"') && J(o).includes('"name":"discount"'), 'the axes are named by field');
  });
  await check('a Colour and a Detail dimension still group the marks: rows that share keys stay separate marks, Data labels on', async () => {
    await dragChip('channel', toolEl('Color')); await settle(500);
    await dragChip('region', toolEl('Detail')); await settle(500);
    must(await ev(`(() => { const t = document.querySelector('.ws-tool[data-tool="label"]'); t.click(); const l = [...document.querySelectorAll('#ws-toolfly label, #ws-toolfly .ws-fmt-field')].find((x) => /Data labels/i.test(x.textContent)); if (!l) return false; const i = l.querySelector('input'); if (!i.checked) i.click(); return true; })()`), 'the Data labels switch');
    await settle(800);
    const q = lastQuery();
    must(q.disaggregate === true && q.rowDimensions.concat(q.columnDimensions).map((d) => d.column).join() === 'region,channel', 'dimensions ride along: ' + J(q.rowDimensions.concat(q.columnDimensions).map((d) => d.column)));
    const p = await points();
    must(p.points === 12 && p.series === 3 && J(p.names) === J(['web', 'shop', 'app']) && p.labels, 'twelve marks in three Colour series, labels drawn: ' + J(p));
    await ev(`document.querySelector('.ws-tool[data-tool="label"]').click()`); await settle(300);
    await shot('disaggregate-colour-detail');
  });
  await check('a bar chart ignores the setting: aggregated query, the item ticked and disabled with its reason', async () => {
    await chartType('Bar'); await settle(600);
    must(!('disaggregate' in lastQuery()), 'bar plan is aggregated');
    await openMenu();
    const st = await itemState();
    must(st.checked === 'true' && st.disabled && /Scatter, Square or Circle/.test(st.title), 'disabled with its reason: ' + J(st));
    await closeMenu();
    await chartType('Circle'); await settle(600);
    await openMenu(); // the result comes from the view cache (the same plan as before), so read the menu and the marks, not a new request
    must((await itemState()).checked === 'false' && !(await itemState()).disabled, 'back on a point chart the stored setting applies again: ' + J(await itemState()));
    await closeMenu();
    must((await points()).points === 12, 'twelve marks again: ' + J(await points()));
  });

  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
