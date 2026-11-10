// Browser checks for calculated-field text functions (LOWER, LEFT, SPLIT, CONTAINS, LEN …): the real dev app (APP_URL, default http://localhost:5190) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/text-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5190 ; stop it with fuser -k 5190/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5190';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'text-ui-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['status', 'String', 'text'], ['active', 'Bool', 'boolean'], ['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['discount', 'Float64', 'numeric'], ['placed', 'DateTime', 'temporal']],
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
  wbDir = mkdtempSync(join(tmpdir(), 'text-wb-'));
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

  const msgOf = () => ev(`${dlg}.querySelector('[id^=calc-fmsg]').textContent.trim()`);
  const chipOf = () => ev(`(${dlg}.querySelector('.calc-chip, .calc-dialog__chip, [class*=chip]')?.textContent ?? '').trim()`);
  const cancel = async () => {
    await ev(`[...${dlg}.querySelectorAll('.dialog__foot button')].find((x) => x.textContent === 'Cancel').click()`);
    await waitFor(`!!(${confirmOpen})`, 'discard confirm');
    await ev(`[...(${confirmOpen}).querySelectorAll('button')].find((x) => x.textContent === 'Discard').click()`);
    await waitFor(`${dlg} === null`, 'dialog closed');
  };

  await check('type, length and arity mistakes are refused with a plain sentence and Save stays disabled', async () => {
    await openNewDialog();
    await fillDialog('Bad', 'LOWER([orders.amount])');
    must(/LOWER needs a text — orders\.amount is number\./.test(await msgOf()), `message: ${await msgOf()}`);
    must(await saveDisabled(), 'Save enabled');
    await focusAndType('.calc-dialog textarea.formula', 'LEFT([orders.status], [orders.qty])');
    must(/LEFT's length must be a whole number from 0 to 1000 written in the formula\./.test(await msgOf()), `length message: ${await msgOf()}`);
    await focusAndType('.calc-dialog textarea.formula', "SPLIT([orders.status], '', 1)");
    must(/SPLIT's separator must be text written in the formula, 1 to 20 characters\./.test(await msgOf()), `separator message: ${await msgOf()}`);
    await focusAndType('.calc-dialog textarea.formula', 'LOWER([orders.status], 1)');
    must(/LOWER takes 1 argument: LOWER\(text\)\./.test(await msgOf()), `arity message: ${await msgOf()}`);
    await focusAndType('.calc-dialog textarea.formula', 'LOWER([orders.status]');
    must(/Expected \)/.test(await msgOf()), `paren message: ${await msgOf()}`);
    must(await saveDisabled(), 'Save enabled on a syntax error');
    await cancel();
  });

  await check('LOWER saves as a text dimension and the Rows shelf sends an fn tree with no literal text in the field', async () => {
    await newCalc('Region lower', 'LOWER([orders.region])');
    await waitFor(`!!__t.chip('Region lower')`, 'chip');
    const tag = await ev(`__t.chip('Region lower').querySelector('.calc-chip').textContent`);
    must(/text/i.test(tag), `kind tag: ${tag}`);
    await dragChip('Region lower', `__t.zone('rows')`);
    await waitFor(`__t.pills('rows').length === 1`, 'pill on Rows');
    await settle();
    const d = lastQuery().rowDimensions?.[0];
    must(d?.calc?.k === 'fn' && d.calc.fn === 'lower' && d.calc.args.length === 1 && d.calc.args[0].k === 'field', `no fn tree: ${J(d)?.slice(0, 240)}`);
    must(await canvasDrawn(), 'no chart drawn');
    await ev(`document.querySelector('.ws-shelf--rows .ws-pill:last-child button[aria-label="Remove field"]').click()`);
    await waitFor(`__t.pills('rows').length === 0`, 'pill removed');
  });

  await check('a text predicate and SPLIT are dimensions; COUNTD(LOWER) sends its tree', async () => {
    await newCalc('Has us', "CONTAINS([orders.region], 'U')");
    await newCalc('Distinct lower', 'COUNTD(LOWER([orders.region]))');
    await newCalc('Second word', "SPLIT([orders.region], ' ', 2)");
    await waitFor(`['Has us', 'Distinct lower', 'Second word'].every((n) => !!__t.chip(n))`, 'chips');
    must(/boolean/i.test(await ev(`__t.chip('Has us').querySelector('.calc-chip').textContent`)), 'Has us is boolean');
    await dragChip('Has us', `__t.zone('rows')`);
    await waitFor(`__t.pills('rows').length === 1`, 'predicate pill');
    await settle();
    must(lastQuery().rowDimensions?.[0]?.calc?.fn === 'contains', `contains: ${J(lastQuery().rowDimensions?.[0])?.slice(0, 200)}`);
    await dragChip('Second word', `__t.zone('rows')`);
    await settle();
    must(lastQuery().rowDimensions?.some((x) => x.calc?.fn === 'split' && x.calc.args[1].v === ' ' && x.calc.args[2].v === 2), 'split tree');
    for (let i = 0; i < 2; i++) await ev(`document.querySelector('.ws-shelf--rows .ws-pill:last-child button[aria-label="Remove field"]').click()`);
    await waitFor(`__t.pills('rows').length === 0`, 'pills removed');
    await dragChip('Distinct lower', `__t.zone('columns')`);
    await waitFor(`__t.pills('columns').length === 1`, 'COUNTD pill');
    await settle();
    const m = lastQuery().measures?.[0] ?? lastQuery().rowDimensions?.[0];
    must(J(lastQuery()).includes('"fn":"countd"') && J(lastQuery()).includes('"fn":"lower"'), `countd(lower): ${J(lastQuery()).slice(0, 300)}`);
    void m;
  });

  for (const scheme of ['light', 'dark']) {
    await check(`screenshot (${scheme}): dialog with a text formula`, async () => {
      await b.setScheme(scheme);
      await openNewDialog();
      await fillDialog('Initial', "UPPER(LEFT([orders.region], 1)) + 1");
      await focusAndType('.calc-dialog textarea.formula', "CONCAT(UPPER(LEFT([orders.region], 1)), LOWER(RIGHT([orders.region], 2)))");
      await ev(`document.querySelector('.calc-dialog textarea.formula').blur()`);
      await b.screenshot(join(SHOTS, `text-dialog-${scheme}.png`));
      console.log(`  shot ${join(SHOTS, `text-dialog-${scheme}.png`)}`);
      await cancel();
    });
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
