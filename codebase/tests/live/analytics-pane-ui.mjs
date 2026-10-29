// Browser checks for the Analytics pane items (T07-01): drag onto the chart or press to add; the card's selects follow: the real dev app (APP_URL, default http://localhost:5221) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/analytics-pane-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5221 ; stop it with fuser -k 5221/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5221';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'analytics-pane-ui-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['discount', 'Float64', 'numeric'], ['channel', 'String', 'text'], ['placed', 'DateTime', 'temporal']],
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
    const nd = dims.length;
    const combos = nd >= 2 ? REGIONS.flatMap((a) => REGIONS.map((c) => [a, c])) : dims.length ? REGIONS.map((a) => [a]) : [[]];
    return { json: {
      rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: combos.map((keys, r) => ({ keys, values: (body.measures ?? []).map((_, i) => (i === 0 ? 10 * (r + 1) : 15 * (r + 1) + 5)) })),
      truncated: false } };
  }
  return null;
}

// ---- tiny test runner ---------------------------------------------------------------------------------------
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; }
  catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; await globalThis.__failShot?.(name); }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const J = JSON.stringify;

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
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
  const settle = async (quiet = 300) => { let n = -1; for (let i = 0; i < 60 && n !== queries.length; i++) { n = queries.length; await b.sleep(quiet); } };
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

  const fmtTool = `document.querySelector('.ws-viewbar__btn[aria-label="Format"]')`;
  const setType = async (label) => {
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === ${J(label)}).click()`);
    await settle(400);
  };
  const opt = () => ev(`window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')).getOption()`);
  const pick = async (label, value) => {
    await ev(`(() => { const s = [...document.querySelectorAll('.ws-fmt-field')].find((l) => l.querySelector('.ws-fmt-label').textContent === ${J(label)}).querySelector('select'); s.value = ${J(value)}; s.dispatchEvent(new Event('change')); return true; })()`);
    await settle(400);
  };
  const theme = async (t) => { await ev(`import('/features/Core/scheme.js').then((m) => m.setSchemePref(${J(t)}))`); await settle(600); };
  const chartReady = () => waitFor(`!!document.querySelector('.ws-chart-canvas') && !!window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas'))`, 'chart drawn');

  globalThis.__failShot = async (n) => shot('fail-' + n.slice(0, 12).replace(/\W/g, '_') + '.png');
  const anaTool = `document.querySelector('.ws-viewbar__btn[aria-label="Analytics"]')`;
  const openAna = async () => { if (!(await ev(`!!document.querySelector('.ws-analytics')`))) await ev(`${anaTool}.click()`); await waitFor(`!!document.querySelector('.ws-analytics')`, 'analytics panel'); };
  const aPick = async (label, value) => {
    await ev(`(() => { const s = [...document.querySelectorAll('.ws-analytics .ws-fmt-field')].find((l) => l.querySelector('.ws-fmt-label').textContent === ${J(label)}).querySelector('select'); s.value = ${J(value)}; s.dispatchEvent(new Event('change')); return true; })()`);
    await settle(400); await chartReady();
  };
  const mark = async (k) => (await opt()).series[0][k];

  const item = (id) => `document.querySelector('.ws-ana-item[data-item="${id}"]')`;
  const dropItem = (id) => ev(`(() => { const dt = new DataTransfer(); const it = ${item(id)};
    it.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const c = document.getElementById('ws-chart');
    c.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    c.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    c.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    it.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return true; })()`);
  const sheetAna = () => ev(`import('/features/Core/store.js').then((m) => { const t = m.tabs.find((x) => x.kind === 'worksheet'); return JSON.stringify(t.sheet.analytics); })`).then((x) => (x ? JSON.parse(x) : x));
  const ids = () => ev(`[...document.querySelectorAll('.ws-ana-item')].map((x) => x.dataset.item)`);
  const selVal = (label) => ev(`[...document.querySelectorAll('.ws-analytics .ws-fmt-field')].find((l) => l.querySelector('.ws-fmt-label').textContent === ${J(label)}).querySelector('select').value`);
  const pressed = (id) => ev(`${item(id)}.getAttribute('aria-pressed')`);
  const focused = () => ev(`document.activeElement?.dataset?.item ?? null`);
  const hasCheck = (id) => ev(`!!${item(id)}.querySelector('svg:last-child') && ${item(id)}.querySelectorAll('svg').length === 2`);
  const undo = async () => { await ev(`document.querySelector('[aria-label="Undo (Ctrl+Z)"]').click()`); await settle(400); await chartReady(); };
  const redo = async () => { await ev(`document.querySelector('[aria-label="Redo (Ctrl+Shift+Z)"]').click()`); await settle(400); await chartReady(); };
  const canUndo = () => ev(`!document.querySelector('[aria-label="Undo (Ctrl+Z)"]').disabled`);

  await check('items per chart type; distinct icons', async () => {
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('amount', `__t.zone('columns')`);
    await settle(400);
    await setType('Bar'); await chartReady(); await openAna();
    must(J(await ids()) === J(['ref', 'band', 'trend']), 'bar items');
    must(await ev(`new Set([...document.querySelectorAll('.ws-ana-item svg path')].map((p) => p.getAttribute('d'))).size === 3`), 'icons not distinct');
    must(await sheetAna() === null, 'an old sheet has no analytics key');
    await setType('Line'); await chartReady(); await openAna();
    must(J(await ids()) === J(['ref', 'band', 'trend', 'forecast']), 'line items');
    await setType('Bar'); await chartReady(); await openAna();
  });

  await check('drop on an old sheet adds, shows a check, a repeat drop adds no undo step, undo / redo', async () => {
    await dropItem('ref'); await settle(400); await chartReady();
    must(await selVal('Reference line') === 'average' && (await mark('markLine')) != null, 'ref not added');
    must(await pressed('ref') === 'true' && await hasCheck('ref') && !(await hasCheck('band')), 'on-state cue');
    await dropItem('ref'); await settle(300);
    await undo(); // one undo must remove the ref (no spurious step from the repeat drop)
    await openAna();
    must(await selVal('Reference line') === 'none', 'one undo should remove the reference line');
    await redo(); await openAna();
    must(await selVal('Reference line') === 'average', 'redo lost the reference line');
    await dropItem('trend'); await settle(400); await chartReady();
    await shot('items-light.png');
    await theme('dark'); await settle(400); await chartReady();
    await shot('items-dark.png'); await theme('light'); await settle(400);
  });

  await check('pressing keeps focus on the item; press then undo / redo; press again switches off', async () => {
    await openAna();
    await ev(`${item('band')}.focus(); ${item('band')}.click()`); await settle(400); await chartReady();
    must(await focused() === 'band', `focus after press: ${await focused()}`);
    must(await selVal('Band') === 'stddev1', 'band not added');
    await undo(); await openAna();
    must(await selVal('Band') === 'none', 'undo of a press');
    await redo(); await openAna();
    must(await selVal('Band') === 'stddev1', 'redo of a press');
    await ev(`${item('band')}.click()`); await settle(400); await chartReady();
    must(await selVal('Band') === 'none' && await pressed('band') === 'false', 'band not removed');
    await aPick('Trend', 'log'); await openAna();
    must(await pressed('trend') === 'true', 'chip should follow the select');
  });

  await check('forecast by drop and by press on a line chart', async () => {
    await setType('Line'); await chartReady(); await openAna();
    await dropItem('forecast'); await settle(400); await chartReady();
    must(await selVal('Forecast') === '3', 'forecast drop');
    await ev(`${item('forecast')}.click()`); await settle(400); await chartReady();
    must(await selVal('Forecast') === '0' && await focused() === 'forecast', 'forecast off');
    await ev(`${item('forecast')}.click()`); await settle(400); await chartReady();
    must(await selVal('Forecast') === '3', 'forecast press');
    await setType('Bar'); await chartReady(); await openAna();
  });

  await check('field chips still drop onto shelves while the card is open', async () => {
    await openAna();
    await dragChip('channel', `__t.zone('rows')`); await settle(400);
    must((await pills('rows')).some((t) => /channel/.test(t)), `rows: ${J(await pills('rows'))}`);
  });

  await check('a drop is ignored when the card is closed: analytics unchanged, no query', async () => {
    await ev(`${anaTool}.click()`); await settle(200);
    const before = J(await sheetAna()), n = queries.length;
    await ev(`(() => { const dt = new DataTransfer(); dt.setData('application/x-ch-analytics', 'band');
      const c = document.getElementById('ws-chart'); c.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()`);
    await settle(300);
    must(queries.length === n && J(await sheetAna()) === before, 'state changed');
  });

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
