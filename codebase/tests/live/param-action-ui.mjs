// Browser check for the parameter action: a Format -> Parameter action choice puts "Set <parameter>" on the selection chip;
// the click writes the mark's value into the parameter (checked against its type and allowed values). The real dev app
// (APP_URL, default http://localhost:5230) in headless Chromium; every /api/* call is mocked. Run: node tests/live/param-action-ui.mjs
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5230';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'param-action-ui-shots');
mkdirSync(SHOTS, { recursive: true });

const COLUMNS = { orders: [['amount', 'Float64', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text'], ['placed', 'DateTime', 'temporal']] };
const REGIONS = ['APAC', 'EU', 'US'], CHANNELS = ['web', 'shop'];
const TABLE_TOTAL = 150, MOCK_PAGE = 60; // the mock serves short pages, so there is always a next one to load
const queries = [];
let slowMs = 0;
async function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders'] };
  if (path === '/api/databases/shop/tables/orders/columns') return { json: COLUMNS.orders.map(([name, type, category]) => ({ name, type, category })) };
  if (/\/columns\/region\/distinct$/.test(path)) return { json: REGIONS };
  if (path === '/api/query') {
    queries.push(body);
    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    const first = dims[0]?.column;
    const pageRows = body.offset !== undefined || body.withTotal !== undefined;
    let keysFor;
    if (pageRows) { const off = body.offset ?? 0, n = Math.max(0, Math.min(MOCK_PAGE, TABLE_TOTAL - off)); keysFor = Array.from({ length: n }, (_, i) => `row${off + i}`); }
    else keysFor = first === 'channel' ? CHANNELS : REGIONS;
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: keysFor.map((k, r) => ({ keys: dims.map(() => k), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })),
      truncated: false, ...(pageRows && body.withTotal !== false ? { total: TABLE_TOTAL } : {}) } };
  }
  return null;
}

let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label, timeout) => b.waitFor(s, { label, timeout });
  const settle = async (quiet = 250) => { let n = -1; for (let i = 0; i < 60 && n !== queries.length; i++) { n = queries.length; await b.sleep(quiet); } };
  const last = () => queries[queries.length - 1];
  const btn = (text) => `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${J(text)} || x.getAttribute('aria-label') === ${J(text)})`;
  const click = (text) => ev(`(() => { const e = ${btn(text)}; if (!e) throw new Error('no button ${text}'); e.click(); return true; })()`);
  const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); const d = st.activeWorksheet(); ${code}; return true; })()`);
  const chartHost = `document.querySelector('#ws-chart .ws-chart-canvas')`;
  const drawn = () => ev(`!!document.querySelector('#ws-chart svg, #ws-chart canvas')`);
  const instOf = `window.echarts.getInstanceByDom(${chartHost})`;
  // click a category's bar for real, at its pixel position
  const clickBar = async (cat) => {
    const p = await ev(`(() => { const i = ${instOf}; const horiz = i.getOption().yAxis[0].type === 'category'; const [x, y] = i.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, horiz ? [5, ${J(cat)}] : [${J(cat)}, 5]); const r = ${chartHost}.getBoundingClientRect(); return [r.left + x, r.top + y]; })()`);
    await b.click(p[0], p[1]);
  };
  const setSheet = (code) => store(`const s = d.sheet; const f = (c, category, extra = {}) => ({ db: 'shop', table: 'orders', column: c, category, ...extra }); ${code}; st.updateSheet(d.id, s)`);

  // ---- setup ----
  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 1`, 'tables');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'orders loaded');
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await waitFor(`document.querySelectorAll('#ws-fields .ws-field').length >= 4`, 'fields');
  const base = `s.chartType = 'bar'; s.columns = [f('region', 'text')]; s.rows = [f('amount', 'numeric', { agg: 'sum' })]; s.selection = null; s.drill = null; s.pages = null; s.filters = [];`;
  await setSheet(base);
  await waitFor(`!!${chartHost}`, 'bar chart drawn');
  await settle();

  const chipText = () => ev(`document.querySelector('.ws-select')?.textContent ?? ''`);
  const selection = () => ev(`(async () => JSON.stringify((await import('/features/Core/store.js')).activeWorksheet().sheet.selection))()`).then((x) => (typeof x === 'string' ? JSON.parse(x) : x));

  const param = (id) => ev(`(async () => JSON.stringify((await import('/features/Core/store.js')).parameters.find((p) => p.id === ${J(id)})?.value))()`).then((x) => JSON.parse(x));
  const toast = () => ev(`(document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent)`);
  const openFormat = async () => { if (!(await ev(`!!document.querySelector('.ws-fmt-select')`))) await ev(`document.querySelector('.ws-viewbar__btn[aria-label="Format"]').click()`); await waitFor(`!!document.querySelector('.ws-fmt-select')`, 'format card'); };
  const pickParamAction = (label) => ev(`(() => { const f = [...document.querySelectorAll('.ws-link')].find((x) => /Parameter action/.test(x.textContent)); const s = f.querySelector('select'); s.value = [...s.options].find((o) => o.text === ${J(label)}).value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await store(`st.addParameter({ name: 'Pick', type: 'text', value: 'EU', allowed: { kind: 'any' } }); st.addParameter({ name: 'Cap', type: 'number', value: 5, allowed: { kind: 'range', min: 1, max: 10, step: null } })`);
  await setSheet(base);
  await waitFor(`!!${chartHost}`, 'bar drawn'); await settle();

  await check('no parameter action: the selection chip has no Set button', async () => {
    await clickBar('APAC');
    await waitFor(`!!document.querySelector('.ws-select')`, 'chip');
    must(!/Set /.test(await chipText()), `chip: ${await chipText()}`);
    await click('Clear selection');
  });
  await check('Format -> Parameter action lists the parameters; choosing one puts Set <name> on the chip', async () => {
    await openFormat();
    await pickParamAction('Pick');
    await clickBar('APAC');
    await waitFor(`/Set Pick/.test(document.querySelector('.ws-select')?.textContent ?? '')`, 'Set Pick');
  });
  await check('Set Pick writes the clicked value into the parameter; the selection stays', async () => {
    must((await param('prm1')) === 'EU', 'precondition');
    await click('Set Pick');
    await waitFor(`/Pick set to APAC/.test(document.getElementById('toast').textContent)`, 'toast');
    must((await param('prm1')) === 'APAC', `value: ${await param('prm1')}`);
    must(/APAC/.test(await chipText()), 'selection lost');
    await b.screenshot(join(SHOTS, 'param-action-light.png'));
    await ev(`document.documentElement.dataset.theme = 'dark'`); await b.sleep(150);
    await b.screenshot(join(SHOTS, 'param-action-dark.png'));
    await ev(`delete document.documentElement.dataset.theme`);
  });
  await check('a value the parameter refuses changes nothing and says why', async () => {
    await pickParamAction('Cap');
    await waitFor(`/Set Cap/.test(document.querySelector('.ws-select')?.textContent ?? '')`, 'Set Cap');
    await click('Set Cap');
    await waitFor(`/Cap/.test(document.getElementById('toast').textContent) && !/set to/.test(document.getElementById('toast').textContent)`, 'refusal toast');
    must((await param('prm2')) === 5, 'number parameter changed');
  });
  await check('choosing None removes the action and the button; the action round-trips through the sheet', async () => {
    await pickParamAction('None');
    await waitFor(`!/Set /.test(document.querySelector('.ws-select')?.textContent ?? '')`, 'button gone');
    await pickParamAction('Pick');
    must(J(await ev(`(async () => (await import('/features/Core/store.js')).activeWorksheet().sheet.paramAction)()`)) === '{"param":"prm1"}', 'not stored');
  });
  await check('a typed band end follows a number parameter and re-draws when its value changes', async () => {
    await setSheet(`s.analytics = { ref: { kind: 'none' }, band: { from: 0, to: 1000, fromParam: 'prm2' }, trend: 'none', forecast: 0, totals: { grand: false, sub: false } }`);
    const area = () => ev(`(() => { const o = ${instOf}.getOption(); const a = o.series[0].markArea?.data?.[0]; return a ? JSON.stringify([a[0].yAxis ?? a[0].xAxis, a[1].yAxis ?? a[1].xAxis]) : ''; })()`);
    await waitFor(`!!${chartHost}`, 'chart'); await settle();
    await waitFor(`${instOf}.getOption().series[0].markArea?.data?.length`, 'band drawn');
    must(J(JSON.parse(await area())) === '[5,1000]', `band: ${await area()}`);
    await store(`st.updateParameter('prm2', { value: 7 })`);
    await waitFor(`JSON.stringify((() => { const a = ${instOf}.getOption().series[0].markArea.data[0]; return [a[0].yAxis ?? a[0].xAxis, a[1].yAxis ?? a[1].xAxis]; })()) === '[7,1000]'`, 'band follows');
  });
  await check('deleting a parameter removes its chip button and clears the saved action (ids are reused after reopen)', async () => {
    await clickBar('APAC');
    await waitFor(`/Set Pick/.test(document.querySelector('.ws-select')?.textContent ?? '')`, 'Set Pick back');
    await store(`st.removeParameter('prm1'); st.removeParameter('prm2')`);
    await waitFor(`!/Set /.test(document.querySelector('.ws-select')?.textContent ?? '')`, 'chip button gone');
    must(J(await ev(`(async () => (await import('/features/Core/store.js')).activeWorksheet().sheet.paramAction)()`)) === 'null', 'paramAction kept');
    must(J(await ev(`(async () => (await import('/features/Core/store.js')).activeWorksheet().sheet.analytics.band.fromParam ?? null)()`)) === 'null', 'band link kept');
    // a new parameter takes the next id and must not inherit the action
    await store(`st.addParameter({ name: 'Fresh', type: 'text', value: 'x', allowed: { kind: 'any' } })`);
    await clickBar('EU');
    await waitFor(`!!document.querySelector('.ws-select')`, 'chip'); await b.sleep(200);
    must(!/Set /.test(await chipText()), `chip: ${await chipText()}`);
  });

} finally { await b?.close(); }
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
