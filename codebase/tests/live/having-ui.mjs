// Browser check for the filter on an aggregated measure (HAVING): the real dev app (APP_URL, default http://localhost:5180) in
// headless Chromium over the DevTools protocol (tests/live/cdp.mjs), every /api/* call mocked — nothing reaches a ClickHouse.
// Run:  node tests/live/having-ui.mjs   (start the app first: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5180;
// stop it with fuser -k 5180/tcp).   Env: APP_URL, SHOTS_DIR, CDP_PORT, CHROME_BIN.
import { launch } from './cdp.mjs';
import { PAGE_CHIP, relateTables } from './model.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5180';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'having-ui-shots');
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
    const hv = body.having ?? []; // the mock honours a measure filter on the first measure, like the server would
    return { json: {
      rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: Array.from({ length: n }, (_, r) => ({ keys: dims.map(() => REGIONS[r]), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })).filter((row) => hv.every((h) => h.op === '>=' ? row.values[h.measure] >= Number(h.value) : true)),
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
    };
    return true; })()`);
  const dragChip = (name, target) => ev(`(() => { const c = __t.chip(${J(name)}); if (!c) throw new Error('no field chip ${name}'); __t.drag(c, ${target}); return true; })()`);
  const settle = async (quiet = 300) => { let n = -1; for (let i = 0; i < 60 && n !== queries.length; i++) { n = queries.length; await b.sleep(quiet); } };
  const lastQuery = () => queries[queries.length - 1];
  const notice = () => ev(`document.getElementById('ws-chart-notice').textContent.trim()`);
  const openMenu = () => ev(`(() => { const p = document.querySelector('.ws-shelf--rows .ws-pill--measure'); p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })); return true; })()`);
  const closeMenu = () => ev(`document.querySelector('.ctx-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  // change a control the way a user does: set the value, fire change (blur)
  const setControl = (sel, value) => ev(`(() => { const e = document.querySelector(${J(sel)}); e.value = ${J(value)}; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders', 'customers'])
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'both tables loaded');
  await relateTables(ev, waitFor, ['orders', 'region', 'customers', 'country']);
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await installHelpers();
  await waitFor(`!!__t.chip('region')`, 'field pane filled');
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await waitFor(`__t.pills('rows').length === 1`, 'measure on Rows');
  await settle();

  await check('no measure filter: nothing sent, no notice about one', async () => {
    must(!('having' in lastQuery()), `having sent: ${J(lastQuery().having)}`);
    must(!/Showing only/.test(await notice()), await notice());
  });

  await check('the measure pill menu has the filter editor, with named, keyboard-reachable controls', async () => {
    await openMenu();
    await waitFor(`!!document.querySelector('.ctx-menu .ws-pill__havingop')`, 'having editor in the menu');
    const info = await ev(`(() => { const m = document.querySelector('.ctx-menu'); const op = m.querySelector('.ws-pill__havingop'), i = m.querySelector('.ws-pill__having input.ws-pill__val');
      return { opLabel: op.getAttribute('aria-label'), inLabel: i.getAttribute('aria-label'), lead: m.querySelector('.ws-pill__havinglead').textContent, ops: [...op.options].map((o) => o.value),
        tab: op.tabIndex >= 0 && i.tabIndex >= 0, clearHidden: m.querySelector('.ws-pill__having .btn').hidden }; })()`);
    must(/Measure filter condition for/.test(info.opLabel) && /Number for/.test(info.inLabel), J(info));
    must(J(info.ops) === J(['=', '!=', '>', '>=', '<', '<=', 'between']), J(info.ops));
    must(/^Keep groups where /.test(info.lead) && info.tab && info.clearHidden, J(info));
    await closeMenu();
  });

  await check('set "is at least 20": the request carries having by measure position; the notice and pill say so in words', async () => {
    await openMenu();
    await waitFor(`!!document.querySelector('.ctx-menu .ws-pill__havingop')`, 'menu');
    await setControl('.ctx-menu .ws-pill__havingop', '>=');
    await settle(200);
    await openMenu().catch(() => {});
    await waitFor(`!!document.querySelector('.ctx-menu .ws-pill__having input.ws-pill__val')`, 'menu again');
    await setControl('.ctx-menu .ws-pill__having input.ws-pill__val', '20');
    await settle();
    const h = lastQuery().having;
    must(J(h) === J([{ measure: 0, op: '>=', value: '20' }]), `having: ${J(h)}`);
    const n = await notice();
    must(/Showing only groups where .* is at least 20, per .*region/.test(n), `notice: ${n}`);
    const badge = await ev(`document.querySelector('.ws-shelf--rows .ws-pill__having-badge').textContent.trim()`);
    must(badge === '≥ 20', `badge: ${badge}`);
    const hasIcon = await ev(`!!document.querySelector('.ws-shelf--rows .ws-pill__having-badge svg')`);
    must(hasIcon, 'badge has no icon');
    must(!/APAC/.test(await ev(`document.getElementById('ws-chart').textContent`)), 'the group below 20 is still drawn');
  });

  await check('a number that is not one is not applied: nothing sent for it, the pill and notice say so', async () => {
    await openMenu();
    await waitFor(`!!document.querySelector('.ctx-menu .ws-pill__having input.ws-pill__val')`, 'menu');
    await setControl('.ctx-menu .ws-pill__having input.ws-pill__val', 'abc');
    await settle();
    // (a result for an unchanged plan comes from the client's cache, so read the chart: the mock drops groups below the filter)
    must(/APAC/.test(await ev(`document.getElementById('ws-chart').textContent`)), 'the invalid filter was still applied (APAC missing)');
    const n = await notice();
    must(/not applied/.test(n), `notice: ${n}`);
    must(await ev(`!!document.querySelector('.ws-shelf--rows .ws-pill__having-badge.is-invalid svg')`), 'no warning badge');
    await openMenu();
    await waitFor(`!!document.querySelector('.ctx-menu .ws-pill__having input.ws-pill__val[aria-invalid=true]')`, 'invalid input marked');
    await closeMenu();
  });

  await check('between takes two numbers; Clear removes the filter', async () => {
    await openMenu();
    await waitFor(`!!document.querySelector('.ctx-menu .ws-pill__havingop')`, 'menu');
    await setControl('.ctx-menu .ws-pill__havingop', 'between');
    await settle(200);
    await openMenu();
    await waitFor(`document.querySelectorAll('.ctx-menu .ws-pill__having input.ws-pill__val').length === 2`, 'two inputs');
    await setControl('.ctx-menu .ws-pill__having input.ws-pill__val:nth-of-type(1)', '10');
    await settle(200);
    await openMenu();
    await waitFor(`document.querySelectorAll('.ctx-menu .ws-pill__having input.ws-pill__val').length === 2`, 'two inputs again');
    await ev(`(() => { const i = document.querySelectorAll('.ctx-menu .ws-pill__having input.ws-pill__val')[1]; i.value = '30'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await settle();
    must(J(lastQuery().having) === J([{ measure: 0, op: 'between', values: ['10', '30'] }]), `having: ${J(lastQuery().having)}`);
    must(/is between 10 and 30/.test(await notice()), await notice());
    await openMenu();
    await waitFor(`!!document.querySelector('.ctx-menu .ws-pill__having .btn:not([hidden])')`, 'Clear shown');
    await ev(`document.querySelector('.ctx-menu .ws-pill__having .btn').click()`);
    await settle();
    must(/APAC/.test(await ev(`document.getElementById('ws-chart').textContent`)), 'the filter still applied after Clear (APAC missing)');
    must(!/Showing only/.test(await notice()), await notice());
  });

  await check('the filter survives a chart-type change and a measure filter drops the Other bucket from the request', async () => {
    await openMenu();
    await waitFor(`!!document.querySelector('.ctx-menu .ws-pill__havingop')`, 'menu');
    await setControl('.ctx-menu .ws-pill__havingop', '>');
    await settle(200);
    await openMenu();
    await waitFor(`!!document.querySelector('.ctx-menu .ws-pill__having input.ws-pill__val')`, 'menu');
    await setControl('.ctx-menu .ws-pill__having input.ws-pill__val', '5');
    await settle();
    must(lastQuery().otherBucket === undefined && lastQuery().having?.length === 1, J(lastQuery()).slice(0, 300));
  });

  await check('between draws a two-thumb range slider over the measure span; moving a thumb fills the inputs and applies', async () => {
    await openMenu();
    await waitFor(`!!document.querySelector('.ctx-menu .ws-pill__havingop')`, 'menu');
    await setControl('.ctx-menu .ws-pill__havingop', 'between');
    await settle(200);
    await openMenu();
    await waitFor(`document.querySelectorAll('.ctx-menu .ws-pill__slider-input').length === 2`, 'two sliders');
    const info = await ev(`(() => { const [a, c] = document.querySelectorAll('.ctx-menu .ws-pill__slider-input');
      return { min: a.min, max: a.max, lo: a.value, hi: c.value, la: a.getAttribute('aria-label'), lb: c.getAttribute('aria-label') }; })()`);
    must(Number(info.min) === 10 && Number(info.max) === 30 && Number(info.lo) === 10 && Number(info.hi) === 30, J(info));
    must(/From slider for/.test(info.la) && /To slider for/.test(info.lb), J(info));
    await setControl('.ctx-menu .ws-pill__slider-input:nth-of-type(1)', '15');
    await settle(200);
    await openMenu();
    await waitFor(`document.querySelectorAll('.ctx-menu .ws-pill__slider-input').length === 2`, 'two sliders again');
    await setControl('.ctx-menu .ws-pill__slider-input:nth-of-type(2)', '25');
    await settle();
    must(J(lastQuery().having) === J([{ measure: 0, op: 'between', values: ['15', '25'] }]), `having: ${J(lastQuery().having)}`);
    await openMenu();
    await waitFor(`document.querySelectorAll('.ctx-menu .ws-pill__slider-input').length === 2`, 'sliders after apply');
    const after = await ev(`(() => { const [a, c] = document.querySelectorAll('.ctx-menu .ws-pill__slider-input'); const i = document.querySelectorAll('.ctx-menu .ws-pill__having input.ws-pill__val');
      return { min: a.min, max: a.max, lo: a.value, hi: c.value, from: i[0].value, to: i[1].value }; })()`);
    must(Number(after.min) === 10 && Number(after.max) === 30 && after.from === '15' && after.to === '25' && Number(after.lo) === 15, J(after));
    await closeMenu();
  });

  // screenshots, light + dark (the app reads <html data-scheme>)
  const shots = [];
  for (const scheme of ['light', 'dark']) {
    await b.setScheme(scheme);
    await ev(`document.documentElement.setAttribute('data-scheme', ${J(scheme)})`);
    await b.sleep(300);
    await check(`${scheme}: screenshots`, async () => {
      const p1 = join(SHOTS, `having-view-${scheme}.png`);
      await b.screenshot(p1); shots.push(p1);
      await openMenu();
      await b.sleep(300);
      const p2 = join(SHOTS, `having-menu-${scheme}.png`);
      await b.screenshot(p2); shots.push(p2);
      await closeMenu();
    });
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
