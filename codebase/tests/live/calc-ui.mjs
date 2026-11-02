// Browser checks for calculated fields: the real dev app (APP_URL, default http://localhost:5180) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/calc-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5180 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { relateTables } from './model.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5180';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'calc-ui-shots');
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

  // (b) an invalid formula shows its message and Save stays disabled
  await check('b: invalid formula shows its message, Save disabled', async () => {
    await openNewDialog();
    await fillDialog('Unit price', 'SUM([orders.amount]) / ');
    const msg = await ev(`${dlg}.querySelector('[id^=calc-fmsg]').textContent.trim()`);
    must(msg.length > 0, 'no formula message');
    must(await saveDisabled(), 'Save enabled for an invalid formula');
    must(!/^\s*$/.test(msg) && /character/.test(msg), `message lacks position: ${msg}`);
    // unknown field
    await focusAndType('.calc-dialog textarea.formula', 'SUM([orders.nope])');
    const msg2 = await ev(`${dlg}.querySelector('[id^=calc-fmsg]').textContent.trim()`);
    must(msg2.length > 0 && await saveDisabled(), `unknown field not refused (${msg2})`);
    await ev(`[...${dlg}.querySelectorAll('.dialog__foot button')].find((x) => x.textContent === 'Cancel').click()`);
    await waitFor(`${dlg} === null`, 'dialog closed');
  });

  await check('a: create "Unit price", save, appears in the field pane; chip name and tag are not clipped', async () => {
    await openNewDialog();
    await fillDialog('Unit price', 'SUM([orders.amount]) / SUM([orders.qty])');
    await focusAndType('.calc-dialog textarea.formula', 'SUM([orders.amount]) / SUM([orders.qty])');
    must(!(await saveDisabled()), 'Save still disabled for a valid formula');
    await saveDialog();
    await waitFor(`!!__t.chip('Unit price')`, 'chip in the field pane');
    const clip = await ev(`(() => { const c = __t.chip('Unit price'); const n = c.querySelector('.ws-field__name'), t = c.querySelector('.calc-chip');
      return { pane: document.getElementById('ws-fields').clientWidth, name: [n.scrollWidth, n.clientWidth], tag: [t.scrollWidth, t.clientWidth], tagText: t.textContent }; })()`);
    must(clip.name[0] <= clip.name[1], `name clipped at pane width ${clip.pane}: ${J(clip)}`);
    must(clip.tag[0] <= clip.tag[1] && clip.tag[1] > 0, `kind tag clipped: ${J(clip)}`);
  });

  await check('a: drag onto Rows -> /api/query carries a calc tree with no agg; chart drawn', async () => {
    await dragChip('region', `__t.zone('columns')`);
    await settle();
    const before = queries.length;
    await dragChip('Unit price', `__t.zone('rows')`);
    await waitFor(`__t.pills('rows').length === 1`, 'pill on Rows');
    await settle();
    must(queries.length > before, 'no query sent after the drop');
    const q = lastQuery();
    const m0 = q.measures?.[0];
    must(m0?.calc, `measure has no calc tree: ${J(m0)}`);
    must(!('agg' in m0) || m0.agg == null, `measure carries agg: ${J(m0)}`);
    must(m0.calc.k === 'bin' && m0.calc.op === '/', `unexpected tree root ${J(m0.calc).slice(0, 120)}`);
    must(await canvasDrawn(), 'no chart drawn');
    must(/APAC/.test(await chartText()) && /US/.test(await chartText()), `chart lacks the mocked categories: ${await chartText()}`);
  });


  // pills: which controls a pill carries (regression test for the calc-pill fix; the plain field is the risk)
  await check('pills: aggregate calc has no agg select / role toggle (keeps fx); row-level number calc and plain numeric keep them', async () => {
    await newCalc('Net', '[orders.amount] * 2');
    await dragChip('Net', `__t.zone('rows')`);
    await dragChip('amount', `__t.zone('rows')`);
    await waitFor(`__t.pills('rows').length === 3`, 'three Rows pills');
    const info = {};
    for (let i = 0; i < 3; i++) {
      await ev(`(() => { const p = document.querySelectorAll('.ws-shelf--rows .ws-pill')[${i}]; p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })); return true; })()`);
      const name = await ev(`document.querySelectorAll('.ws-shelf--rows .ws-pill')[${i}].querySelector('.ws-pill__text').textContent`);
      const items = await ev(`[...document.querySelectorAll('.ctx-menu [role^=menuitem]')].map((x) => [x.getAttribute('role'), x.textContent.trim()])`);
      info[name] = { agg: items.some(([r]) => r === 'menuitemradio'), conv: items.some(([, t]) => /^Use as /.test(t)), fx: items.some(([, t]) => t === 'Table calculation…') };
      await ev(`document.querySelector('.ctx-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    }
    const keys = Object.keys(info);
    const get = (re) => info[keys.find((k) => re.test(k))];
    const agg = get(/Unit price/), row = get(/Net/), plain = get(/amount/);
    must(agg && !agg.agg && !agg.conv, `aggregate calc pill: ${J(info)}`);
    must(agg.fx, `aggregate calc pill lost its table-calculation (fx) button: ${J(info)}`);
    must(row && row.agg && row.conv, `row-level number calc pill: ${J(info)}`);
    must(plain && plain.agg && plain.conv, `plain numeric field pill: ${J(info)}`);
    for (let i = 0; i < 2; i++) { await ev(`document.querySelector('.ws-shelf--rows .ws-pill:last-child button[aria-label="Remove field"]').click()`); await waitFor(`__t.pills('rows').length === ${2 - i}`, 'pill removed'); }
    await settle();
  });

  // final-review fixes: a calc measure never offers "count"; histogram / box plot refuse calc pills without a request
  await check('n: calc aggregation menu has no count; histogram with a calc pill shows the hint and sends no request', async () => {
    await dragChip('Net', `__t.zone('rows')`);
    await waitFor(`__t.pills('rows').length === 2`, 'Net pill on Rows');
    await ev(`(() => { const p = [...document.querySelectorAll('.ws-shelf--rows .ws-pill')].find((x) => /Net/.test(x.querySelector('.ws-pill__text').textContent)); p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })); return true; })()`);
    const opts = await ev(`[...document.querySelectorAll('.ctx-menu [role=menuitemradio]')].map((o) => o.textContent.trim().replace('Percentile…', 'percentile'))`);
    await ev(`document.querySelector('.ctx-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    must(!opts.includes('count') && opts.includes('sum') && opts.includes('countNonNull'), `calc aggregation options: ${J(opts)}`);
    await settle();
    queries.length = 0;
    const pickType = async (label) => {
      await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
      await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === ${J(label)}).click()`);
    };
    await pickType('Histogram');
    await waitFor(`/Histogram and box plot don't use calculated fields yet/.test(document.getElementById('ws-chart').textContent)`, 'histogram hint');
    await pickType('Box plot');
    await waitFor(`/Histogram and box plot don't use calculated fields yet/.test(document.getElementById('ws-chart').textContent)`, 'box plot hint');
    await settle(500);
    must(queries.length === 0, `${queries.length} /api/query call(s) sent`);
    await pickType('Bar');
    await ev(`document.querySelector('.ws-shelf--rows .ws-pill:last-child button[aria-label="Remove field"]').click()`);
    await waitFor(`__t.pills('rows').length === 1`, 'Net removed');
    await settle();
  });

  // (k) autocomplete in a second dialog (a calculation exists now)
  await check('k: "[" opens the autocomplete (fields + calculations); ArrowDown+Enter inserts', async () => {
    await openNewDialog();
    await focusAndType('.calc-dialog textarea.formula', '[');
    await waitFor(`!${dlg}.querySelector('ul.suggest').hidden`, 'listbox open');
    const labels = await ev(`[...${dlg}.querySelectorAll('ul.suggest li .name')].map((x) => x.textContent)`);
    must(labels.includes('orders.amount') && labels.includes('Unit price'), `items: ${J(labels)}`);
    must(labels.some((l) => l.startsWith('customers.')) , `no customers field: ${J(labels)}`);
    const second = labels[1];
    await b.key('ArrowDown', { vk: 40 });
    await b.key('Enter', { vk: 13 });
    const val = await ev(`${dlg}.querySelector('textarea.formula').value`);
    must(val === `[${second}]`, `inserted ${J(val)}, expected [${second}]`);
    must(await ev(`${dlg}.querySelector('ul.suggest').hidden`), 'listbox still open');
    await b.key('Escape', { vk: 27 }); // closes the dialog (list already closed)
    await ev(`${dlg} && (${dlg}.dispatchEvent(new Event('cancel', { cancelable: true })), true)`);
    await waitFor(`${dlg} === null`, 'dialog closes');
  });

  // (c) rename + dependent calculation
  await check('c: rename Unit price -> Avg price; [Unit price]*2 still computes, text rewritten (B3)', async () => {
    await newCalc('Double', '[Unit price] * 2');
    await waitFor(`!!__t.chip('Double')`, 'Double chip');
    await calcMenu('Unit price', 'Edit…');
    await waitFor(`${dlg} !== null`, 'edit dialog');
    await focusAndType('.calc-dialog input.input', 'Avg price');
    await saveDialog();
    await waitFor(`!!__t.chip('Avg price') && !__t.chip('Unit price')`, 'renamed chip');
    await calcMenu('Double', 'Edit…');
    await waitFor(`${dlg} !== null`, 'Double dialog');
    const text = await ev(`${dlg}.querySelector('textarea.formula').value`);
    must(text === '[Avg price] * 2', `formula text now ${J(text)}`);
    const msg = await ev(`${dlg}.querySelector('[id^=calc-fmsg]').textContent.trim()`);
    must(msg === '' && !(await saveDisabled()), `Double no longer valid: ${msg}`);
    await ev(`[...${dlg}.querySelectorAll('.dialog__foot button')].find((x) => x.textContent === 'Cancel').click()`);
    await waitFor(`${dlg} === null`, 'closed');
    // the pill on Rows follows the rename; Double computes
    must((await pills('rows'))[0]?.includes('Avg price'), `pill: ${J(await pills('rows'))}`);
    await dragChip('Double', `__t.zone('rows')`);
    await waitFor(`__t.pills('rows').length === 2`, 'Double pill');
    await settle();
    const q = lastQuery();
    must(q.measures.length === 2 && q.measures.every((m) => m.calc), `measures: ${J(q.measures).slice(0, 300)}`);
    must(J(q.measures[1].calc).includes('"k":"bin"'), 'Double tree missing');
    const err = await chartText();
    must(!/can't be computed/.test(err), `chart says: ${err}`);
  });

  // (d) delete flows
  await check('d: delete used by another calculation -> refused; used by a worksheet -> confirm, pill cleared', async () => {
    await calcMenu('Avg price', 'Delete…');
    await b.sleep(300);
    const t = await toastText();
    must(t === "Used by calculation 'Double'.", `toast: ${J(t)}`);
    must(!!(await ev(`!!__t.chip('Avg price')`)), 'Avg price was deleted anyway');
    must(!(await ev(`!!(${confirmOpen})`)), 'a confirm dialog opened for a refused delete');
    await calcMenu('Double', 'Delete…');
    await waitFor(`!!(${confirmOpen})`, 'confirm dialog');
    const msg = await ev(`(${confirmOpen}).textContent`);
    must(/Double/.test(msg) && /worksheet/.test(msg), `confirm text: ${msg}`);
    await ev(`[...(${confirmOpen}).querySelectorAll('button')].find((x) => x.textContent === 'Delete').click()`);
    await waitFor(`!__t.chip('Double')`, 'Double chip gone');
    const rows = await pills('rows');
    must(rows.length === 1 && !rows.some((p) => p.includes('Double')), `Rows pills: ${J(rows)}`);
    // now Avg price (only on the sheet) goes too, after a confirm
    await calcMenu('Avg price', 'Delete…');
    await waitFor(`!!(${confirmOpen})`, 'second confirm');
    await ev(`[...(${confirmOpen}).querySelectorAll('button')].find((x) => x.textContent === 'Delete').click()`);
    await waitFor(`!__t.chip('Avg price')`, 'Avg price gone');
    must((await pills('rows')).length === 0, `Rows not cleared: ${J(await pills('rows'))}`);
  });

  // fixture for the rest: "Unit price" back, on Rows
  await newCalc('Unit price', 'SUM([orders.amount]) / SUM([orders.qty])');
  await dragChip('Unit price', `__t.zone('rows')`);
  await waitFor(`__t.pills('rows').length === 1`, 'Unit price on Rows again');
  await settle();

  // (e) refusals
  await check("e: calculated field dropped on Filters -> refusal toast, nothing added", async () => {
    await ev(`(() => { const t = document.querySelector('.ws-tool[aria-label^="Filters"]'); __t.drag(__t.chip('Unit price'), t); return true; })()`);
    await b.sleep(300);
    must(await toastText() === "Calculated fields can't be used here yet.", `toast: ${J(await toastText())}`);
    const label = await ev(`document.querySelector('.ws-tool[aria-label^="Filters"]').getAttribute('aria-label')`);
    must(label === 'Filters (empty)', `Filters now: ${label}`);
  });

  // (f) calculated primary dimension: clicking a mark creates no selection
  await check('f: calculated dimension as primary dimension -> clicking a mark makes no selection', async () => {
    await newCalc('Region calc', '[orders.region]');
    await ev(`document.querySelector('.ws-shelf--columns .ws-pill .ws-pill__remove, .ws-shelf--columns .ws-pill button[aria-label^="Remove"]')?.click()`);
    await waitFor(`__t.pills('columns').length === 0`, 'region pill removed');
    await dragChip('Region calc', `__t.zone('columns')`);
    await waitFor(`__t.pills('columns').length === 1`, 'calc dimension on Columns');
    await settle();
    const q = lastQuery();
    must(q.columnDimensions?.[0]?.calc, `column dimension has no calc: ${J(q.columnDimensions)}`);
    must(await canvasDrawn(), 'no chart');
    // click the first bar for real
    const pt = await ev(`(() => { const host = document.querySelector('#ws-chart > div'); const inst = window.echarts.getInstanceByDom(host);
      const r = host.getBoundingClientRect(); const opt = inst.getOption(); const cat = (opt.xAxis?.[0]?.data ?? opt.yAxis?.[0]?.data ?? [])[0];
      const horiz = opt.yAxis?.[0]?.type === 'category';
      const p = inst.convertToPixel({ seriesIndex: 0 }, horiz ? [10, cat] : [cat, 10]);
      return p ? { x: r.left + p[0], y: r.top + p[1] } : null; })()`);
    must(pt, 'could not locate a mark');
    await b.click(pt.x, pt.y);
    await b.sleep(500);
    must(!(await ev(`!!document.querySelector('.ws-select')`)), 'a selection chip appeared');
    // control: the same click on a plain dimension does create one (proves the click lands on a mark)
    await ev(`document.querySelector('.ws-shelf--columns .ws-pill button[aria-label^="Remove"], .ws-shelf--columns .ws-pill .ws-pill__remove')?.click()`);
    await waitFor(`__t.pills('columns').length === 0`, 'calc dim removed');
    await dragChip('region', `__t.zone('columns')`);
    await waitFor(`__t.pills('columns').length === 1`, 'region back'); await settle();
    const pt2 = await ev(`(() => { const host = document.querySelector('#ws-chart > div'); const inst = window.echarts.getInstanceByDom(host);
      const r = host.getBoundingClientRect(); const opt = inst.getOption(); const cat = (opt.xAxis?.[0]?.data ?? opt.yAxis?.[0]?.data ?? [])[0];
      const horiz = opt.yAxis?.[0]?.type === 'category';
      const p = inst.convertToPixel({ seriesIndex: 0 }, horiz ? [10, cat] : [cat, 10]);
      return { x: r.left + p[0], y: r.top + p[1] }; })()`);
    await b.click(pt2.x, pt2.y); await b.sleep(500);
    must(await ev(`!!document.querySelector('.ws-select')`), 'control failed: a click on a plain dimension made no selection (test cannot see marks)');
    await ev(`document.querySelector('.ws-select button[aria-label*="lear"], .ws-select__clear')?.click()`);
  });

  // (l) a sheet whose only pill is a field-less calculation
  await check('l: sheet with only a "1+2" calculation -> hint, no query', async () => {
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    await waitFor(`document.querySelectorAll('.tab:not(.tab--model)').length === 2 && __t.pills('rows').length === 0`, 'second worksheet');
    await newCalc('One plus two', '1+2');
    queries.length = 0; // baseline BEFORE the click, so a query sent right after it is caught
    await ev(`(() => { const c = __t.chip('One plus two'); c.querySelector('.ws-field__add').click(); return true; })()`);
    await waitFor(`__t.pills('rows').length + __t.pills('columns').length === 1`, 'pill added');
    await waitFor(`/Add a field from a table/.test(document.getElementById('ws-chart').textContent)`, 'hint shown');
    await settle(500);
    const pl = [...await pills('rows'), ...await pills('columns')];
    must(pl.length === 1, `pills: ${J(pl)}`);
    const text = await chartText();
    must(/Add a field from a table/.test(text), `chart pane says: ${J(text)}`);
    must(queries.length === 0, `${queries.length} query(ies) sent: ${String(J(queries[0])).slice(0, 200)}`);
    must(!(await ev(`document.getElementById('ws-chart').querySelector('canvas')`)), 'a chart was drawn');
  });
  // back to the first worksheet
  await ev(`document.querySelectorAll('.tab:not(.tab--model) .tab__label')[0].click()`);
  await waitFor(`__t.pills('rows').some((p) => p.includes('Unit price'))`, 'first worksheet active');
  await b.sleep(500);

  // (i) explainer
  await check('i: explainer opens, lists six stages, closes on Esc', async () => {
    await ev(`document.querySelector('.explain__btn').click()`);
    await waitFor(`!document.querySelector('.explain__pop').hidden`, 'popover open');
    const n = await ev(`document.querySelectorAll('.explain__pop .explain__list li').length`);
    must(n === 6, `${n} stages`);
    await b.key('Escape', { vk: 27 });
    await waitFor(`document.querySelector('.explain__pop').hidden`, 'popover closed on Esc');
    must(await ev(`document.activeElement === document.querySelector('.explain__btn')`), 'focus did not return to the button');
  });

  // (j) screenshots, light + dark
  const shots = [];
  for (const scheme of ['light', 'dark']) {
    await b.setScheme(scheme);
    await ev(`document.documentElement.setAttribute('data-theme', ${J(scheme)})`);
    await b.sleep(300);
    // field pane group (with the sheet)
    await check(`j: ${scheme} screenshots`, async () => {
      const p1 = join(SHOTS, `calc-fieldpane-${scheme}.png`);
      await b.screenshot(p1); shots.push(p1);
      await ev(`document.querySelector('.explain__btn').click()`); await b.sleep(400);
      const p3 = join(SHOTS, `calc-explainer-${scheme}.png`);
      await b.screenshot(p3); shots.push(p3);
      await b.key('Escape', { vk: 27 });
      await openNewDialog();
      await focusAndType('.calc-dialog input.input', 'Margin');
      await focusAndType('.calc-dialog textarea.formula', 'SUM([orders.amount] * (1 - [orders.discount]))');
      await b.sleep(400);
      const p2 = join(SHOTS, `calc-dialog-${scheme}.png`);
      await b.screenshot(p2); shots.push(p2);
      await ev(`${dlg}.dispatchEvent(new Event('cancel', { cancelable: true }))`);
      await waitFor(`${dlg} === null`, 'dialog closed');
    });
  }
  console.log('screenshots:\n  ' + shots.join('\n  '));
  await ev(`document.documentElement.removeAttribute('data-theme')`);

  // (g) export, reload with the exported file, restore
  await check('g: export -> reload -> import restores pill, request tree, field-pane group', async () => {
    await ev(`(() => { window.__blobs = []; const orig = URL.createObjectURL; URL.createObjectURL = (x) => { x.text().then((t) => window.__blobs.push(t)); return orig.call(URL, x); }; return true; })()`);
    await ev(`document.getElementById('wb-menu-btn').click()`);
    await ev(`document.getElementById('wb-export').click()`);
    await waitFor(`window.__blobs.length === 1`, 'export blob');
    const json = await ev(`window.__blobs[0]`);
    const wb = JSON.parse(json);
    must(Array.isArray(wb.calculations) && wb.calculations.some((c) => c.name === 'Unit price'), `export lacks calculations: ${Object.keys(wb)}`);
    const file = join(wbDir, 'workbook.json');
    writeFileSync(file, json);
    await ev(`localStorage.clear()`);
    await b.send('Page.reload');
    await waitFor(`document.readyState === 'complete' && !!document.getElementById('conn-connect')`, 'reloaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.getElementById('db-select').options.length > 1`, 'reconnected');
    await waitFor(`!!document.getElementById('wb-file')`);
    const { root } = await b.send('DOM.getDocument');
    const { nodeId } = await b.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#wb-file' });
    await b.send('DOM.setFileInputFiles', { nodeId, files: [file] });
    await waitFor(`document.querySelectorAll('.entity').length === 2`, 'entities restored');
    await waitFor(`!document.getElementById('worksheet-view').hidden || document.querySelectorAll('.tab:not(.tab--model)').length > 0`, 'tabs restored');
    await ev(`document.querySelectorAll('.tab:not(.tab--model) .tab__label')[0].click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet shown');
    await installHelpers();
    await waitFor(`!!__t.chip('Unit price')`, 'field-pane group restored');
    await waitFor(`__t.pills('rows').length === 1`, 'pill restored on Rows');
    const rows = await pills('rows');
    must(rows.length === 1 && rows[0].includes('Unit price'), `pill not restored: ${J(rows)}`);
    // an explicit re-query: Refresh on the view bar (skips every cache)
    queries.length = 0;
    await ev(`(() => { const r = [...document.querySelectorAll('.ws-viewbar button')].find((x) => /refresh/i.test(x.getAttribute('aria-label') ?? x.title ?? '')); if (!r) throw new Error('no Refresh button on the view bar'); r.click(); return true; })()`);
    await until(() => queries.length > 0, 'a query after restore');
    await settle();
    const m0 = lastQuery().measures?.[0];
    must(m0?.calc && !m0.agg, `restored request lacks the calc tree: ${J(m0)}`);
    must(await canvasDrawn(), 'no chart after restore');
  });

  // (h) remove the field's table from the model
  await check("h: table removed from the model -> \"Calculation 'Unit price' can't be computed\", no query sent", async () => {
    await ev(`document.querySelector('.tab--model .tab__label').click()`);
    await waitFor(`document.getElementById('worksheet-view').hidden && document.querySelector('.entity') !== null`, 'model tab shown');
    await ev(`document.querySelector('.entity [aria-label="Remove shop.orders"]').click()`);
    queries.length = 0; // no relationship drawn, so removing a table asks nothing
    await waitFor(`document.querySelectorAll('.entity').length === 1`, 'entity removed');
    await ev(`document.querySelectorAll('.tab:not(.tab--model) .tab__label')[0].click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet shown');
    await waitFor(`/can't be computed/.test(document.getElementById('ws-chart').textContent)`, 'E15 message');
    await settle(500);
    const text = await chartText();
    must(/Calculation 'Unit price' can't be computed: /.test(text), `chart pane says: ${J(text)}`);
    must(queries.length === 0, `${queries.length} /api/query request(s) sent after removal: ${String(J(queries[0])).slice(0, 200)}`);
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
