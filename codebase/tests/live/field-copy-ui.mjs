// Browser checks for copying a field from the worksheet field list (T02-28): the real dev app (APP_URL, default http://localhost:5180) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/field-copy-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5180 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { PAGE_CHIP } from './model.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5180';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'field-copy-shots');
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
      chip: ${PAGE_CHIP},
      drag(chip, target) {
        const dt = new DataTransfer();
        chip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      },
      zone: (kind) => document.querySelector('.ws-shelf--' + kind + ' .ws-shelf__zone'),
    }; return true; })()`);
  const drag = (name, kind) => ev(`(() => { const c = __t.chip(${J(name)}); if (!c) throw new Error('no chip ${name}'); __t.drag(c, __t.zone(${J(kind)})); return true; })()`);
  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 1`, 'tables listed');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  const menu = (name) => ev(`(() => { __t.chip(${J(name)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); return true; })()`);
  const items = (name) => ev(`[...document.querySelectorAll('.ctx-menu .menu__item')].map((x) => x.textContent.trim())`);
  const click = (name, label) => ev(`(() => { [...document.querySelectorAll('.ctx-menu .menu__item')].find((x) => x.textContent.trim() === ${J(label)}).click(); return true; })()`);
  const shot = async (n) => writeFileSync(join(SHOTS, n), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'table loaded');
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await install();
  await waitFor(`!!__t.chip('region')`, 'field pane filled');
  await ev(`(() => { window.__clip = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { window.__clip.push(t); return Promise.resolve(); } }, configurable: true }); return true; })()`);

  await check('a column field menu offers Copy name, which copies the column name', async () => {
    await menu('region');
    must((await items('region')).includes('Copy name'), J(await items('region')));
    must(!(await items('region')).includes('Copy column name'), 'no column-name item while not renamed');
    await shot('field-copy-light.png');
    await click('region', 'Copy name');
    await b.sleep(150);
    must(J(await ev('window.__clip')) === J(['region']), J(await ev('window.__clip')));
    must(/Copied the field name/.test(await ev(`document.getElementById('toast').textContent`)), 'toast');
  });
  await check('a renamed field copies the display name and the column name separately', async () => {
    await ev(`window.__clip = []`);
    await menu('region');
    await click('region', 'Rename…');
    await ev(`(() => { const i = document.querySelector('.ws-field__rename'); i.value = 'Area'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
    await waitFor(`!!__t.chip('Area')`, 'renamed');
    await menu('Area');
    must(J((await items('Area')).filter((x) => x.startsWith('Copy'))) === J(['Copy name', 'Copy column name']), J(await items('Area')));
    await click('Area', 'Copy name');
    await menu('Area');
    await click('Area', 'Copy column name');
    await b.sleep(150);
    must(J(await ev('window.__clip')) === J(['Area', 'region']), J(await ev('window.__clip')));
  });
  await b.setScheme('dark'); await menu('amount'); await b.sleep(200); await shot('field-copy-dark.png'); await b.setScheme('light');
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
