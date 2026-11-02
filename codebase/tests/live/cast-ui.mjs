// Browser checks for the data type cast (T02-34): the real dev app (APP_URL, default http://localhost:5180) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/calc-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5180 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { CHIP_SCOPE } from './model.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5180';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'cast-ui-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['qty_s', 'String', 'text'], ['when_s', 'String', 'text'], ['region', 'String', 'text'], ['amount', 'Float64', 'numeric']],
};
const REGIONS = ['APAC', 'EU', 'US'];
const queries = [];
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders'] };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/query') {
    queries.push(body);
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    const n = dims.length ? REGIONS.length : 1;
    return { json: {
      rowDimensions: (body.rowDimensions ?? []).map((d) => `orders.${d.column}`), columnDimensions: (body.columnDimensions ?? []).map((d) => `orders.${d.column}`),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: Array.from({ length: n }, (_, r) => ({ keys: dims.map(() => `2024-0${r + 1}-01`), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })),
      truncated: false } };
  }
  return null;
}

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
  const install = () => ev(`(() => { window.__t = {
      chip: (name) => [...document.querySelectorAll(${J(CHIP_SCOPE)})].find((c) => c.querySelector('.ws-field__name')?.textContent === name),
      drag(chip, target) {
        const dt = new DataTransfer();
        chip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      },
      zone: (kind) => document.querySelector('.ws-shelf--' + kind + ' .ws-shelf__zone'),
    }; return true; })()`);
  const drag = (name, kind) => ev(`(() => { const c = __t.chip(${J(name)}); if (!c) throw new Error('no chip ${name}'); __t.drag(c, __t.zone(${J(kind)})); return true; })()`);
  const castTo = async (name, item) => {
    await ev(`(() => { __t.chip(${J(name)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); return true; })()`);
    await ev(`(() => { const x = [...document.querySelectorAll('.ctx-menu .menu__item')].find((i) => i.textContent.trim() === ${J(item)}); if (!x) throw new Error('no menu item ${item}'); x.click(); return true; })()`);
  };
  const settle = async (quiet = 300) => { let n = -1; for (let i = 0; i < 60 && n !== queries.length; i++) { n = queries.length; await b.sleep(quiet); } };
  const lastQuery = () => queries[queries.length - 1];
  const group = (name) => ev(`(() => { const c = __t.chip(${J(name)}); let g = c.previousElementSibling; while (g && !g.classList.contains('ws-field-group')) g = g.previousElementSibling; return g?.textContent; })()`);

  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 1`, 'tables listed');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'table loaded');
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await install();
  await waitFor(`!!__t.chip('qty_s')`, 'field pane filled');

  await check('a text field offers Original / Number / Date; a number field only Original / Text', async () => {
    await ev(`__t.chip('qty_s').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))`);
    const items = await ev(`[...document.querySelectorAll('.ctx-menu .menu__item')].map((x) => x.textContent.trim())`);
    must(J(items.slice(items.indexOf('Original'), items.indexOf('Original') + 3)) === J(['Original', 'Number', 'Date']), `qty_s menu: ${J(items)}`);
    await ev(`document.querySelector('.ctx-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await ev(`__t.chip('amount').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))`);
    const a = await ev(`[...document.querySelectorAll('.ctx-menu .menu__item')].map((x) => x.textContent.trim())`);
    must(a.includes('Text') && !a.includes('Date') && !a.includes('Number'), `amount menu: ${J(a)}`);
    await ev(`document.querySelector('.ctx-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  });

  await check('cast qty_s to Number: tag "as Number", moves to Measures, query measure carries cast', async () => {
    must((await group('qty_s')) === 'Dimensions', 'qty_s should start under Dimensions');
    await castTo('qty_s', 'Number');
    await waitFor(`!!__t.chip('qty_s')?.querySelector('.ws-cast')`, 'cast tag on the chip');
    must(/as Number/.test(await ev(`__t.chip('qty_s').querySelector('.ws-cast').textContent`)), 'tag text');
    const clip = await ev(`(() => { const c = __t.chip('qty_s'); const n = c.querySelector('.ws-field__name'), t = c.querySelector('.ws-cast');
      const pn = document.getElementById('ws-fields'); return { pane: pn.clientWidth, paneScroll: pn.scrollWidth, name: [n.scrollWidth, n.clientWidth], tag: [t.scrollWidth, t.clientWidth] }; })()`);
    must(clip.name[0] <= clip.name[1] && clip.name[1] > 20, `chip name clipped: ${J(clip)}`);
    must(clip.tag[0] <= clip.tag[1], `chip tag clipped: ${J(clip)}`);
    must(clip.paneScroll <= clip.pane + 1, `field pane scrolls sideways: ${J(clip)}`);
    must(await ev(`!!__t.chip('qty_s').querySelector('.ws-field__type')`), 'the type icon stays beside the name (icon + text, never colour alone)');
    must((await group('qty_s')) === 'Measures', `group is ${await group('qty_s')}`);
    await ev(`__t.chip('qty_s').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))`);
    must(await ev(`/Default aggregation/.test(document.querySelector('.ctx-menu').textContent)`), 'a text field cast to Number offers a default aggregation');
    await ev(`document.querySelector('.ctx-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await drag('region', 'columns');
    await drag('qty_s', 'rows');
    await waitFor(`document.querySelectorAll('.ws-shelf--rows .ws-pill').length === 1`, 'pill on Rows');
    await settle();
    const q = lastQuery();
    must(q.measures?.[0]?.cast === 'number' && q.measures[0].agg === 'sum', `measure: ${J(q.measures)}`);
    must(!('cast' in (q.rowDimensions?.[0] ?? q.columnDimensions[0])), `region must not be cast: ${J(q.columnDimensions)}`);
    must(await ev(`!!document.querySelector('.ws-shelf--rows .ws-pill .ws-cast')`), 'pill carries the cast tag');
  });

  await check('cast when_s to Date: a date dimension with a date part picker and a cast on the wire', async () => {
    await castTo('when_s', 'Date');
    await drag('when_s', 'columns');
    await waitFor(`document.querySelectorAll('.ws-shelf--columns .ws-pill').length >= 1`, 'date pill');
    const partMenu = () => ev(`[...document.querySelectorAll('.ws-shelf--columns .ws-pill')].at(-1).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))`);
    await partMenu();
    must(await ev(`[...document.querySelectorAll('.ctx-menu [role=menuitemradio]')].some((x) => x.textContent.trim() === 'Month')`), 'date parts on the cast pill');
    await ev(`document.querySelector('.ctx-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await settle();
    const q = lastQuery();
    const d = [...(q.rowDimensions ?? []), ...(q.columnDimensions ?? [])].find((x) => x.column === 'when_s');
    must(d?.cast === 'date', `dimension: ${J(d)}`);
    await partMenu();
    await ev(`[...document.querySelectorAll('.ctx-menu [role=menuitemradio]')].find((x) => x.textContent.trim() === 'Month').click()`);
    await settle();
    const d2 = lastQuery().columnDimensions.find((x) => x.column === 'when_s');
    must(d2?.cast === 'date' && d2.datePart === 'month', `dimension after part: ${J(d2)}`);
  });

  await check('back to Original: the cast leaves the request and the pill', async () => {
    await castTo('when_s', 'Original');
    await settle();
    const q = lastQuery();
    const d = [...(q.rowDimensions ?? []), ...(q.columnDimensions ?? [])].find((x) => x.column === 'when_s');
    must(d && !('cast' in d) && !('datePart' in d), `dimension: ${J(d)}`);
    must(!(await ev(`!!__t.chip('when_s').querySelector('.ws-cast')`)), 'the chip still shows a cast tag after going back to Original');
  });

  await check('histogram refuses a cast field with a hint and sends no request', async () => {
    await settle(); queries.length = 0;
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === 'Histogram').click()`);
    await waitFor(`/data type cast/.test(document.getElementById('ws-chart').textContent)`, 'histogram hint');
    await settle(500);
    must(queries.length === 0, `${queries.length} request(s) sent`);
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === 'Bar').click()`);
  });

  await check('the cast survives export (field settings carry it)', async () => {
    await ev(`(() => { window.__blobs = []; const orig = URL.createObjectURL; URL.createObjectURL = (x) => { x.text().then((t) => window.__blobs.push(t)); return orig.call(URL, x); }; return true; })()`);
    await ev(`document.getElementById('wb-menu-btn').click()`);
    await ev(`document.getElementById('wb-export').click()`);
    await waitFor(`window.__blobs.length === 1`, 'export blob');
    const wb = JSON.parse(await ev(`window.__blobs[0]`));
    must(wb.fields?.['shop.orders.qty_s']?.cast === 'number', `fields: ${J(wb.fields)}`);
    const pill = wb.worksheets[0].sheet.rows[0];
    must(pill.category === 'numeric', `pill category ${pill.category}`);
  });

  const shots = [];
  for (const scheme of ['light', 'dark']) {
    await b.setScheme(scheme);
    await ev(`document.documentElement.setAttribute('data-theme', ${J(scheme)})`);
    await b.sleep(300);
    await check(`${scheme} screenshot`, async () => { const p = join(SHOTS, `cast-${scheme}.png`); await b.screenshot(p); shots.push(p); });
  }
  console.log('screenshots:\n  ' + shots.join('\n  '));
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
