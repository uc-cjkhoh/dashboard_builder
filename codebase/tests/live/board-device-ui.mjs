// Browser check for the device preview: Desktop / Tablet / Phone buttons on the board bar. Tablet draws the 12-column grid in a 768 px
// box, Phone stacks the widgets in a 390 px box, Desktop restores the full panel; the preview is never saved; the page does not scroll.
// Real dev app (APP_URL), every /api/* mocked; any page error fails the run. Screenshots go to SHOTS_DIR.
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5227';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'board-device-shots');
mkdirSync(SHOTS, { recursive: true });
const COLS = [['amount', 'Float64', 'numeric'], ['region', 'String', 'text']];
const VALUES = { region: ['APAC', 'EU', 'US'] };
async function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders'] };
  if (path === '/api/databases/shop/tables/orders/columns') return { json: COLS.map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/query') {
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: Array.from({ length: dims.length ? 3 : 1 }, (_, r) => ({ keys: dims.map((d) => VALUES[d.column][r]), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })), truncated: false } };
  }
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) { try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; } }
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;
const KEY = 'dashboardbuilder.workbook.v2|mock-ch|8443|default';

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); ${code} })()`);
  const shot = (name) => b.screenshot(join(SHOTS, name));
  const press = (key) => ev(`(document.querySelector('[data-device=${key}]').click(), true)`);
  const gridW = () => ev(`Math.round(document.getElementById('board-grid').getBoundingClientRect().width)`);
  const rect = (i) => ev(`(() => { const g = document.getElementById('board-grid').getBoundingClientRect(); const r = document.querySelectorAll('.board-widget')[${i}].getBoundingClientRect(); return { l: Math.round(r.left - g.left), t: Math.round(r.top - g.top), w: Math.round(r.width) }; })()`);

  await b.goto(APP + '/');
  await waitFor(`document.readyState === 'complete' && !!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 1`, 'tables listed');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'orders loaded');
  await store(`
    const f = (column, category, extra = {}) => ({ db: 'shop', table: 'orders', column, category, ...extra });
    const t = st.createWorksheet('Revenue'); t.sheet = { ...st.emptySheet(), chartType: 'bar', columns: [f('region', 'text')], rows: [f('amount', 'numeric', { agg: 'sum' })] };
    const d = st.createDashboard('Overview');
    st.setWidgets(d.id, [{ id: st.nextWidgetId(), kind: 'sheet', sheetId: t.id, x: 0, y: 0, w: 6, h: 3 }, { id: st.nextWidgetId(), kind: 'text', heading: 'Notes', body: 'n', x: 6, y: 0, w: 6, h: 3 }]);
    return true;`);
  await waitFor(`document.querySelectorAll('.board-widget .ws-chart-canvas svg').length === 1`, 'widget drawn');
  const panel = await ev(`Math.round(document.getElementById('board-grid').getBoundingClientRect().width)`);

  await check('three labelled device buttons; Desktop is pressed by default', async () => {
    const labels = await ev(`[...document.querySelectorAll('.board-device__btn')].map((x) => x.textContent + ':' + x.getAttribute('aria-pressed'))`);
    must(J(labels) === J(['Desktop:true', 'Tablet:false', 'Phone:false']), J(labels));
    must(panel > 768, `panel too narrow for the check: ${panel}`);
  });
  await check('Tablet: a 768 px box, the two widgets still side by side', async () => {
    await press('tablet');
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().width === 768`, 'width 768');
    const [a, c] = [await rect(0), await rect(1)];
    must(c.l > a.l && c.t === a.t, `side by side: ${J([a, c])}`);
    must(await ev(`document.querySelector('[data-device=tablet]').getAttribute('aria-pressed')`) === 'true', 'tablet pressed');
    await b.sleep(300); await shot('device-tablet-light.png');
  });
  await check('Phone: a 390 px box, the widgets stacked full width', async () => {
    await press('phone');
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().width === 390`, 'width 390');
    const [a, c] = [await rect(0), await rect(1)];
    must(a.w === 390 && c.w === 390 && c.l === 0 && c.t > a.t, `stacked: ${J([a, c])}`);
    must(await ev(`document.getElementById('board-grid').classList.contains('is-stacked')`), 'is-stacked');
    must(await ev(`document.querySelector('.board-bar__size').disabled`), 'size select not disabled in preview');
    await b.sleep(300); await shot('device-phone-light.png');
  });
  await check('the preview is not saved and the page does not scroll', async () => {
    await b.sleep(700);
    const saved = await ev(`localStorage.getItem(${J(KEY)}) ?? ''`);
    must(!/preview|device|phone|tablet/i.test(saved), 'preview leaked into the workbook');
    must(await ev(`document.documentElement.scrollHeight <= window.innerHeight + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1`), 'page scrolls');
  });
  await check('print ignores the preview: the grid drops the preview box', async () => {
    await ev(`window.dispatchEvent(new Event('beforeprint'))`);
    await b.sleep(200);
    must(await ev(`!document.getElementById('board-grid').classList.contains('is-preview') && document.getElementById('board-grid').style.width === ''`), 'preview box kept while printing');
    await ev(`window.dispatchEvent(new Event('afterprint'))`);
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().width === 390`, 'back to phone');
  });
  await check('Desktop restores the full panel and the size select', async () => {
    await press('desktop');
    await waitFor(`!document.getElementById('board-grid').classList.contains('is-preview')`, 'preview off');
    must(await gridW() === panel, `width ${await gridW()} vs ${panel}`);
    must(await ev(`!document.querySelector('.board-bar__size').disabled`), 'size select still disabled');
  });
  await check('a fixed-size dashboard: the preview drops the box, Desktop brings it back; the disabled select says why', async () => {
    const pickSize = (v) => ev(`(() => { const s = document.querySelector('.board-bar__size'); s.value = ${J(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await pickSize('800x600');
    await waitFor(`document.getElementById('board-grid').classList.contains('is-fixed')`, 'fixed');
    must(await gridW() === 800, `fixed width ${await gridW()}`);
    must(await ev(`document.querySelector('.board-bar__size').title`) === '', 'title set on Desktop');
    await press('tablet');
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().width === 768`, 'tablet box');
    must(await ev(`!document.getElementById('board-grid').classList.contains('is-fixed')`), 'is-fixed kept in preview');
    const h = await ev(`Math.round(document.getElementById('board-grid').getBoundingClientRect().height)`);
    must(h !== 600, `height not recomputed: ${h}`);
    must(await ev(`document.querySelector('.board-bar__size').disabled`), 'select enabled');
    must(/replaced by the device preview; choose Desktop/.test(await ev(`document.querySelector('.board-bar__size').title`)), 'no reason on the select');
    must(/choose Desktop/.test(await ev(`document.getElementById('board-status').textContent`)), 'no reason in the status line');
    await press('desktop');
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().width === 800 && document.getElementById('board-grid').classList.contains('is-fixed')`, 'fixed back');
    must(await ev(`document.querySelector('.board-bar__size').title`) === '' && await ev(`!document.querySelector('.board-bar__size').disabled`), 'select not restored');
    must(await ev(`document.querySelector('.board-bar__size').value`) === '800x600', 'value lost');
    await pickSize('auto');
    await waitFor(`!document.getElementById('board-grid').classList.contains('is-fixed')`, 'automatic');
  });
  await check('the pressed button carries a check mark besides colour', async () => {
    await press('tablet');
    must(await ev(`document.querySelectorAll('.board-device__check').length === 1 && !!document.querySelector('[data-device=tablet] .board-device__check')`), 'check mark missing / duplicated');
    await press('desktop');
  });
  await check('Phone to Desktop re-measures the panel (no stale preview width)', async () => {
    await press('phone'); await waitFor(`document.getElementById('board-grid').getBoundingClientRect().width === 390`, 'phone');
    await press('desktop');
    must(await ev(`document.getElementById('board-grid').style.width === ''`), 'width style kept');
    const a = await rect(1);
    must(a.l > 100, `second widget not back in the grid: ${J(a)}`);
  });
  await check('a panel narrower than the device disables its button and says why', async () => {
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor(`document.querySelector('[data-device=tablet]').disabled`, 'tablet disabled');
    must(/narrower than 768/.test(await ev(`document.querySelector('[data-device=tablet]').title`)), 'no reason');
    must(await ev(`!document.querySelector('[data-device=phone]').disabled`), 'phone disabled');
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor(`!document.querySelector('[data-device=tablet]').disabled`, 'tablet enabled again');
  });
  await check('screenshot: dark, phone', async () => {
    await press('phone'); await b.setScheme('dark'); await b.sleep(400);
    await shot('device-phone-dark.png');
    await b.setScheme('light');
  });
  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
