// Browser checks for the two tab kinds (P24b stage 1): the [+] menu, worksheet / dashboard tabs, the empty board body,
// closing a worksheet used by a dashboard, workbook format v2 (export, autosave, v1 file + v1 autosave open with zero issues),
// and the 50-tab limit. The real dev app (APP_URL, default http://localhost:5193) in headless Chromium; every /api/* call is
// mocked. Any page error fails the run (cdp.mjs). Screenshots (light + dark) go to SHOTS_DIR.
import { launch } from './cdp.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = process.env.APP_URL ?? 'http://localhost:5193';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'tabs-ui-shots');
mkdirSync(SHOTS, { recursive: true });
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'workbook-v1-full.json');

const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['status', 'String', 'text'], ['created', 'DateTime', 'temporal'], ['customer_id', 'Int64', 'numeric']],
  customers: [['id', 'Int64', 'numeric'], ['name', 'String', 'text']],
};
const REGIONS = ['APAC', 'EU', 'US'];
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders', 'customers'] };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/query') {
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: Array.from({ length: dims.length ? 3 : 1 }, (_, r) => ({ keys: dims.map(() => REGIONS[r]), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })), truncated: false } };
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
  const waitFor = (s, label) => b.waitFor(s, { label });
  const toastText = () => ev(`(document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent)`);
  const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); ${code} })()`);
  const labels = () => ev(`[...document.querySelectorAll('.tab:not(.tab--model) .tab__label')].map((x) => x.textContent)`);
  const activeLabel = () => ev(`document.querySelector('.tab.is-active .tab__label')?.textContent`);
  const addTab = async (kind) => { await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=${kind}]').click()`); };
  const dialogButton = (text) => `[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === ${J(text)})`;
  const connect = async () => {
    await waitFor(`document.readyState === 'complete' && !!document.getElementById('conn-connect')`, 'app loaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  };
  const reload = async () => { await b.send('Page.reload'); await connect(); };
  const autosaved = (v) => ev(`localStorage.getItem('dashboardbuilder.workbook.v${v}|mock-ch|8443|default')`);

  // Toasts replace each other ("Connected to…" follows "Restored your last workbook…"), so log every one from page start.
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__toasts = []; (() => {
    const d = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    Object.defineProperty(Node.prototype, 'textContent', { configurable: true, get: d.get, set(v) { if (this.className === 'toast__text' && v) window.__toasts.push(v); d.set.call(this, v); } }); })();` });
  const toasts = () => ev(`window.__toasts`);
  await b.goto(APP + '/');
  await connect();
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'orders loaded');

  await check('[+] is a menu: New worksheet / New dashboard, keyboard operable, Esc closes', async () => {
    const add = `document.querySelector('.tab-add')`;
    must(await ev(`${add}.getAttribute('aria-haspopup') === 'menu' && ${add}.getAttribute('aria-expanded') === 'false'`), 'not a menu button');
    must(await ev(`document.querySelector('.tab-menu__list').hidden`), 'menu open at start');
    await ev(`${add}.click()`);
    await waitFor(`!document.querySelector('.tab-menu__list').hidden`, 'menu opened');
    must(J(await ev(`[...document.querySelectorAll('.tab-menu__list [role=menuitem]')].map((x) => x.textContent.trim())`)) === J(['New worksheet', 'New dashboard', 'New story']), 'menu items');
    must(await ev(`document.activeElement === document.querySelector('[data-new-tab=worksheet]')`), 'first item not focused');
    await b.key('ArrowDown', { vk: 40 });
    must(await ev(`document.activeElement === document.querySelector('[data-new-tab=dashboard]')`), 'ArrowDown did not move focus');
    await b.key('Escape', { vk: 27 });
    await waitFor(`document.querySelector('.tab-menu__list').hidden`, 'menu closed by Esc');
    must(await ev(`document.activeElement === ${add}`), 'focus not returned to [+]');
    must((await labels()).length === 0, 'Esc created a tab');
  });

  await check('New worksheet: "Worksheet 1", kind icon, accessible name, worksheet view shown', async () => {
    await addTab('worksheet');
    await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet view');
    must(J(await labels()) === J(['Worksheet 1']), `tabs: ${J(await labels())}`);
    must(await ev(`!!document.querySelector('.tab--worksheet .tab__kind')`), 'no kind icon');
    must(await ev(`document.querySelector('.tab--worksheet .tab__label').getAttribute('aria-label') === 'Worksheet 1 (worksheet)'`), 'accessible name lacks the kind');
    must(await ev(`document.getElementById('board-view').hidden`), 'board view visible on a worksheet');
    must(await ev(`!!document.querySelector('.ws-viewbar__icons .ws-actions [aria-label="Sheet actions"]')`), 'sheet-actions button missing from the worksheet view bar');
    must(await ev(`document.activeElement === document.querySelector('.tab.is-active .tab__label')`), 'new tab label not focused');
  });

  await check('New dashboard: "Dashboard 1", empty board body, no duplicate button, sheet-actions hidden', async () => {
    await addTab('dashboard');
    await waitFor(`!document.getElementById('board-view').hidden`, 'board view');
    must(J(await labels()) === J(['Worksheet 1', 'Dashboard 1']), `tabs: ${J(await labels())}`);
    must(await ev(`document.getElementById('worksheet-view').hidden`), 'worksheet view visible on a dashboard');
    must(await ev(`document.getElementById('board-title').textContent`) === 'Dashboard 1', 'board title');
    must(/Empty dashboard/.test(await ev(`document.getElementById('board-empty').textContent`)) && await ev(`!document.getElementById('board-empty').hidden`), 'empty-board message');
    must(await ev(`!!document.querySelector('.tab--dashboard .tab__kind')`), 'no dashboard icon');
    must(await ev(`document.querySelector('.tab--dashboard .tab__label').getAttribute('aria-label') === 'Dashboard 1 (dashboard)'`), 'accessible name');
    must(await ev(`!document.querySelector('.tab--dashboard .tab__dup') && !!document.querySelector('.tab--worksheet .tab__dup')`), 'duplicate button on the wrong kind');
    must(await ev(`!document.querySelector('.ws-viewbar__icons .ws-actions [aria-label="Sheet actions"]') || document.getElementById('worksheet-view').hidden`), 'sheet-actions button shown on a dashboard');
    await ev(`document.querySelector('.tab--worksheet .tab__label').click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden && !!document.querySelector('.ws-viewbar__icons .ws-actions [aria-label="Sheet actions"]')`, 'back on the worksheet');
  });

  await check('default names count per kind; rename works on both kinds', async () => {
    await addTab('worksheet'); await addTab('dashboard');
    must(J(await labels()) === J(['Worksheet 1', 'Dashboard 1', 'Worksheet 2', 'Dashboard 2']), `tabs: ${J(await labels())}`);
    await ev(`document.querySelectorAll('.tab--dashboard .tab__label')[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await waitFor(`!!document.querySelector('.tab__rename')`, 'rename input');
    must(await ev(`document.querySelector('.tab__rename').getAttribute('aria-label') === 'Rename dashboard'`), 'rename label');
    await ev(`(() => { const i = document.querySelector('.tab__rename'); i.value = 'Ops board'; i.blur(); return true; })()`);
    await waitFor(`!document.querySelector('.tab__rename')`, 'rename done');
    must((await labels())[3] === 'Ops board', `tabs: ${J(await labels())}`);
    await store(`st.closeTab(st.dashboards()[1].id); st.closeTab(st.worksheets()[1].id); return true;`);
    must(J(await labels()) === J(['Worksheet 1', 'Dashboard 1']), `after cleanup: ${J(await labels())}`);
  });

  await check('closing a worksheet used by dashboards names them and removes its widgets; closing a dashboard keeps worksheets', async () => {
    await store(`
      const ws = st.worksheets()[0], db = st.dashboards()[0];
      st.updateSheet(ws.id, { ...ws.sheet, columns: [{ db: 'shop', table: 'orders', column: 'region', category: 'text' }] });
      st.setWidgets(db.id, [{ id: st.nextWidgetId(), kind: 'sheet', sheetId: ws.id, x: 0, y: 0, w: 6, h: 4 }, { id: st.nextWidgetId(), kind: 'text', heading: 'H', body: 'B', x: 6, y: 0, w: 6, h: 2 }]);
      return true;`);
    await ev(`document.querySelector('.tab__close[aria-label="Close Worksheet 1"]').click()`);
    await waitFor(`!!document.querySelector('dialog[open]')`, 'confirm dialog');
    const msg = await ev(`document.querySelector('dialog[open] .dialog__body').textContent`);
    must(/Used on: Dashboard 1/.test(msg) && /removed/.test(msg), `confirm text: ${msg}`);
    await ev(`${dialogButton('Cancel')}.click()`);
    await waitFor(`!document.querySelector('dialog[open]')`, 'dialog closed');
    must((await labels()).includes('Worksheet 1'), 'cancel closed the worksheet');
    must(await store(`return st.dashboards()[0].widgets.length === 2;`), 'cancel removed a widget');
    await ev(`document.querySelector('.tab__close[aria-label="Close Worksheet 1"]').click()`);
    await waitFor(`!!document.querySelector('dialog[open]')`, 'confirm dialog again');
    await ev(`${dialogButton('Close')}.click()`);
    await waitFor(`!(${'document.querySelector(\'.tab__close[aria-label="Close Worksheet 1"]\')'})`, 'worksheet closed');
    must(await store(`const w = st.dashboards()[0].widgets; return w.length === 1 && w[0].kind === 'text';`), 'the worksheet widget was not removed');
    // a dashboard with widgets: confirm, and no worksheet is touched
    await addTab('worksheet');
    await store(`const db = st.dashboards()[0]; st.setWidgets(db.id, [...db.widgets, { id: st.nextWidgetId(), kind: 'sheet', sheetId: st.worksheets()[0].id, x: 0, y: 4, w: 6, h: 4 }]); return true;`);
    await ev(`document.querySelector('.tab__close[aria-label="Close Dashboard 1"]').click()`);
    await waitFor(`!!document.querySelector('dialog[open]')`, 'dashboard confirm');
    must(/not affected/.test(await ev(`document.querySelector('dialog[open] .dialog__body').textContent`)), 'dashboard confirm text');
    await ev(`${dialogButton('Close')}.click()`);
    await waitFor(`!document.querySelector('.tab--dashboard')`, 'dashboard closed');
    must(await store(`return st.worksheets().length === 1;`), 'closing the dashboard touched a worksheet');
    await store(`st.closeTab(st.worksheets()[0].id); return true;`);
    must((await labels()).length === 0, 'cleanup');
  });

  await check('export writes workbook v2: worksheets, dashboards, tabs order, active', async () => {
    await addTab('worksheet'); await addTab('dashboard'); await addTab('worksheet');
    await store(`const [w1, w2] = st.worksheets(), db = st.dashboards()[0]; st.setWidgets(db.id, [{ id: st.nextWidgetId(), kind: 'sheet', sheetId: w2.id, x: 6, y: 0, w: 6, h: 4 }]); st.switchTab(db.id); return true;`);
    await ev(`(() => { window.__blobs = []; const orig = URL.createObjectURL; URL.createObjectURL = (x) => { x.text().then((t) => window.__blobs.push(t)); return orig.call(URL, x); }; return true; })()`);
    await ev(`document.querySelector('.ws-export > .iconbtn').click()`);
    await ev(`[...document.querySelectorAll('.ws-export .menu__item')].find((b) => b.textContent.trim() === 'Workbook (JSON)').click()`);
    await waitFor(`window.__blobs.length === 1`, 'export blob');
    const wb = JSON.parse(await ev(`window.__blobs[0]`));
    must(wb.version === 2, `version ${wb.version}`);
    must(wb.worksheets.length === 2 && wb.dashboards.length === 1, 'lists');
    must(J(wb.tabs) === J([{ kind: 'worksheet', index: 0 }, { kind: 'dashboard', index: 0 }, { kind: 'worksheet', index: 1 }]), `tabs ${J(wb.tabs)}`);
    must(J(wb.active) === J({ kind: 'dashboard', index: 0 }), `active ${J(wb.active)}`);
    must(J(wb.dashboards[0].widgets) === J([{ kind: 'sheet', sheet: 1, x: 6, y: 0, w: 6, h: 4 }]), `widgets ${J(wb.dashboards[0].widgets)}`);
  });

  await check('a v2 autosave reopens both kinds, the order, the widgets and the active dashboard', async () => {
    await waitFor(`localStorage.getItem('dashboardbuilder.workbook.v2|mock-ch|8443|default') !== null`, 'v2 autosave written');
    await b.sleep(700);
    await reload();
    await waitFor(`document.querySelectorAll('.tab:not(.tab--model)').length === 3`, 'tabs restored');
    must(J(await labels()) === J(['Worksheet 1', 'Dashboard 1', 'Worksheet 2']), `tabs: ${J(await labels())}`);
    must(await activeLabel() === 'Dashboard 1', 'active tab not restored');
    await waitFor(`!document.getElementById('board-view').hidden`, 'dashboard body shown');
    must(await store(`const w = st.dashboards()[0].widgets; return w.length === 1 && w[0].sheetId === st.worksheets()[1].id;`), 'widget lost its worksheet');
    await waitFor(`window.__toasts.some((t) => /^Restored your last workbook/.test(t))`, 'restore toast');
    must((await toasts()).includes('Restored your last workbook (1 table, 2 worksheets, 1 dashboard).'), `toasts: ${J(await toasts())}`);
  });

  for (const scheme of ['light', 'dark']) {
    await check(`${scheme} screenshot of the tab strip`, async () => {
      await b.setScheme(scheme);
      await ev(`document.documentElement.setAttribute('data-theme', ${J(scheme)})`);
      await b.sleep(150);
      await b.screenshot(join(SHOTS, `board-${scheme}.png`)); // the dashboard tab's empty board
      await ev(`document.querySelector('.tab-add').click()`);
      await waitFor(`!document.querySelector('.tab-menu__list').hidden`, 'menu open');
      await b.sleep(250);
      await b.screenshot(join(SHOTS, `tabs-${scheme}.png`), { x: 0, y: 0, width: 1400, height: 330 });
      await b.key('Escape', { vk: 27 });
      await waitFor(`document.querySelector('.tab-menu__list').hidden`, 'menu closed');
    });
  }
  await ev(`document.documentElement.removeAttribute('data-theme')`);

  await check('a v1 autosave (no v2 key) opens as worksheets with zero issues, and the v1 key stays', async () => {
    const v1 = readFileSync(FIXTURE, 'utf8');
    await ev(`localStorage.clear()`);
    await ev(`localStorage.setItem('dashboardbuilder.workbook.v1|mock-ch|8443|default', ${J(v1)})`);
    await reload();
    await waitFor(`document.querySelectorAll('.tab:not(.tab--model)').length === 4`, 'v1 tabs restored');
    must(J(await labels()) === J(['Revenue', 'Trend', 'Customers', 'Status mix']), `tabs: ${J(await labels())}`);
    must(await ev(`[...document.querySelectorAll('.tab:not(.tab--model)')].every((t) => t.classList.contains('tab--worksheet'))`), 'not all worksheets');
    must(await activeLabel() === 'Customers', `active: ${await activeLabel()}`);
    await waitFor(`window.__toasts.some((t) => /^Restored your last workbook/.test(t))`, 'restore toast');
    must((await toasts()).includes('Restored your last workbook (2 tables, 4 worksheets).'), `toasts: ${J(await toasts())}`); // no "N part(s) were reset"
    must(await ev(`!document.querySelector('dialog[open]')`), 'an issues dialog opened');
    must(await store(`return JSON.stringify(st.worksheets().map((w) => w.sheet.title)) === JSON.stringify(['Revenue by region', null, null, null]);`), 'sheet content differs');
    await waitFor(`localStorage.getItem('dashboardbuilder.workbook.v2|mock-ch|8443|default') !== null`, 'v2 autosave written');
    must(await ev(`localStorage.getItem('dashboardbuilder.workbook.v1|mock-ch|8443|default') === ${J(v1)}`), 'the v1 key was changed or removed');
  });

  await check('importing a v1 workbook file shows zero issues', async () => {
    await ev(`localStorage.clear()`);
    await reload();
    await waitFor(`!!document.getElementById('wb-file')`);
    const { root } = await b.send('DOM.getDocument');
    const { nodeId } = await b.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#wb-file' });
    await b.send('DOM.setFileInputFiles', { nodeId, files: [FIXTURE] });
    await waitFor(`document.querySelectorAll('.tab:not(.tab--model)').length === 4`, 'imported tabs');
    await waitFor(`!document.getElementById('toast').hidden`, 'toast');
    must(/^Opened workbook-v1-full\.json\.$/.test(await toastText()), `toast: ${await toastText()}`);
    must(await ev(`!document.querySelector('dialog[open]')`), 'an issues dialog opened');
  });

  await check('an automatic worksheet title follows the tab name when the tab is renamed (both texts match)', async () => {
    await addTab('worksheet');
    await waitFor(`!document.getElementById('worksheet-view').hidden && !!document.querySelector('.ws-titleblock__title.is-auto')`, 'worksheet with an automatic title');
    await store(`st.renameTab(st.activeWorksheet().id, 'Sales Q4'); return true;`);
    await waitFor(`document.querySelector('.ws-titleblock__title.is-auto')?.textContent === 'Sales Q4'`, 'title follows the tab');
    must((await activeLabel()) === 'Sales Q4', `tab label: ${await activeLabel()}`);
  });
  await check('the 50-tab limit: a toast at creation, nothing added', async () => {
    await store(`while (st.tabs.length < 50) st.createDashboard(); return true;`);
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=dashboard]').click()`);
    await waitFor(`!document.getElementById('toast').hidden && /at most 50 tabs/.test(document.getElementById('toast').textContent)`, 'limit toast');
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    must(await store(`return st.tabs.length === 50;`), 'a 51st tab was added');
    must(await ev(`document.activeElement === document.querySelector('.tab-add')`), 'focus not returned to [+] after the refusal');
  });

  await check('the page carries the app time zone (default Malaysia, UTC+8 here)', async () => {
    const tz = await ev(`document.querySelector('meta[name=app-timezone]')?.content`);
    must(typeof tz === 'string' && tz.length > 2, `tz: ${tz}`);
  });

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
