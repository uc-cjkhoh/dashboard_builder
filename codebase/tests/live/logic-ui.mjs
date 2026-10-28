// Browser checks for calculated-field logic functions (IF / IIF / CASE / IFNULL, comparisons, text literals): the real dev app (APP_URL, default http://localhost:5188) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/logic-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5188 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5188';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'logic-ui-shots');
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
  wbDir = mkdtempSync(join(tmpdir(), 'logic-wb-'));
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
  await ev(`document.querySelector('.tab-add').click()`);
  await waitFor(`!document.getElementById('dashboard-view').hidden`, 'worksheet open');
  await installHelpers();
  await waitFor(`!!__t.chip('region')`, 'field pane filled');

  const msgOf = () => ev(`${dlg}.querySelector('[id^=calc-fmsg]').textContent.trim()`);
  const chipOf = () => ev(`(${dlg}.querySelector('.calc-chip, .calc-dialog__chip, [class*=chip]')?.textContent ?? '').trim()`);
  const cancel = async () => {
    await ev(`[...${dlg}.querySelectorAll('.dialog__foot button')].find((x) => x.textContent === 'Cancel').click()`);
    await waitFor(`${dlg} === null`, 'dialog closed');
  };

  await check('a non-boolean condition is refused with a plain sentence and Save stays disabled', async () => {
    await openNewDialog();
    await fillDialog('Bad', 'IF([orders.amount], 1, 0)');
    const msg = await msgOf();
    must(/A condition needs a boolean — orders\.amount is number\./.test(msg), `message: ${msg}`);
    must(await saveDisabled(), 'Save enabled');
    await focusAndType('.calc-dialog textarea.formula', "IF([orders.amount] > 1, 'a', 2)");
    must(/same type/.test(await msgOf()), `mismatch message: ${await msgOf()}`);
    await focusAndType('.calc-dialog textarea.formula', "CASE WHEN [orders.amount] > 1 THEN 'a'");
    must(/Expected WHEN, ELSE or END/.test(await msgOf()), `CASE message: ${await msgOf()}`);
    await focusAndType('.calc-dialog textarea.formula', "[orders.status] = 'open");
    must(/Missing '/.test(await msgOf()), `string message: ${await msgOf()}`);
    await cancel();
  });

  await check('a boolean formula: the chip says boolean; a CASE formula saves and is a text dimension', async () => {
    await openNewDialog();
    await fillDialog('Is big', '[orders.amount] > 100');
    const chip = await ev(`${dlg}.textContent`);
    must(/Row-level · boolean/.test(chip), `no boolean chip text in the dialog: ${chip.slice(0, 300)}`);
    await cancel();
    await newCalc('Size', "CASE WHEN [orders.amount] > 100 THEN 'big' WHEN [orders.amount] > 10 THEN 'mid' ELSE 'small' END");
    await waitFor(`!!__t.chip('Size')`, 'Size chip');
    const tag = await ev(`__t.chip('Size').querySelector('.calc-chip').textContent`);
    must(/text/i.test(tag), `kind tag: ${tag}`);
  });

  await check('the CASE dimension on Rows sends a case tree with bound-able literals, and draws', async () => {
    await dragChip('Size', `__t.zone('rows')`);
    await waitFor(`__t.pills('rows').length === 1`, 'Size pill on Rows');
    await settle();
    const d = lastQuery().rowDimensions?.[0];
    must(d?.calc?.k === 'case', `no case tree: ${J(d)?.slice(0, 200)}`);
    must(d.calc.whens.length === 2 && d.calc.whens[0].c.k === 'cmp' && d.calc.whens[0].t.k === 'str', `whens: ${J(d.calc.whens)}`);
    must(d.calc.else.k === 'str' && d.calc.else.v === 'small', `else: ${J(d.calc.else)}`);
    must(!/big|small/.test(J({ ...d, calc: undefined })), 'literal leaked outside the tree');
    must(await canvasDrawn(), 'no chart drawn');
    await ev(`document.querySelector('.ws-shelf--rows .ws-pill:last-child button[aria-label="Remove field"]').click()`);
    await waitFor(`__t.pills('rows').length === 0`, 'pill removed');
  });

  await check('an IF over an aggregate is an aggregate measure; IFNULL / ZN save', async () => {
    await newCalc('Level', "IIF(SUM([orders.amount]) > 100, 'high', 'low')");
    await newCalc('Net or zero', 'ZN([orders.discount]) * 2');
    await waitFor(`!!__t.chip('Level') && !!__t.chip('Net or zero')`, 'chips');
    await dragChip('region', `__t.zone('columns')`);
    await settle();
    await dragChip('Level', `__t.zone('rows')`);
    await waitFor(`__t.pills('rows').length === 1`, 'Level pill');
    await settle();
    const m = lastQuery().measures?.[0];
    must(m?.calc?.k === 'case' && (m.agg == null), `measure: ${J(m)?.slice(0, 200)}`);
    const pillInfo = await ev(`(() => { const p = document.querySelector('.ws-shelf--rows .ws-pill'); return { agg: !!p.querySelector('.ws-pill__agg') }; })()`);
    must(!pillInfo.agg, 'an aggregate IF carries no aggregation select');
    await ev(`document.querySelector('.ws-shelf--rows .ws-pill:last-child button[aria-label="Remove field"]').click()`);
    await waitFor(`__t.pills('rows').length === 0`, 'pill removed');
    await dragChip('Net or zero', `__t.zone('rows')`);
    await waitFor(`__t.pills('rows').length === 1`, 'ZN pill');
    await settle();
    const z = lastQuery().measures?.[0];
    must(z?.calc?.k === 'bin' && z.calc.l.k === 'ifnull' && z.calc.l.r.v === 0 && z.agg, `ZN measure: ${J(z)?.slice(0, 240)}`);
  });

  for (const scheme of ['light', 'dark']) {
    await check(`screenshot (${scheme}): dialog with a CASE formula`, async () => {
      await b.setScheme(scheme);
      await openNewDialog();
      await fillDialog('Size 2', "CASE WHEN [orders.amount] > 100 THEN 'big'\n  WHEN [orders.amount] > 10 THEN 'mid'\n  ELSE 'small' END");
      await b.screenshot(join(SHOTS, `logic-dialog-${scheme}.png`));
      console.log(`  shot ${join(SHOTS, `logic-dialog-${scheme}.png`)}`);
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
