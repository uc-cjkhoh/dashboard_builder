// Browser check (D163): when the session ends (a redeploy, a restart, the 2 h idle timeout) everything closes and only the connect card
// shows — an open modal dialog, a confirm, a context menu and the Color flyout do not outlive the workspace behind them.
// Real dev app (APP_URL, default http://localhost:5189) in headless Chromium over the DevTools protocol (tests/live/cdp.mjs); every /api/*
// call is mocked. Run: node tests/live/session-lost-overlays-ui.mjs
// (start the app: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5189; stop it by port)
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5189';
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['region', 'String', 'text']],
  customers: [['country', 'String', 'text']],
};
const REGIONS = ['APAC', 'EU', 'US'];
let session = { connected: false };
let pingMode = 'ok'; // ok | gone
function answer({ method, path, body }) {
  if (path === '/api/connection/ping') {
    if (pingMode === 'gone') { session = { connected: false }; return { json: { connected: false } }; }
    return { json: { connected: true, reachable: true } };
  }
  if (path === '/api/connection' && method === 'GET') return { json: session };
  if (path === '/api/connection/disconnect') { session = { connected: false }; return { json: session }; }
  if (path === '/api/connection') { session = { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false }; return { json: session }; }
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: Object.keys(COLUMNS) };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (/\/columns\/\w+\/distinct/.test(path)) return { json: REGIONS };
  if (path === '/api/query') {
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
let failed = 0, passed = 0;
async function check(name, fn) { try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; } }
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;
let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label, timeout) => b.waitFor(s, { label, timeout });
  await b.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  const setup = async ({ pie = false } = {}) => {
    session = { connected: false }; pingMode = 'ok';
    await b.goto(APP + '/');
    await ev(`(() => { localStorage.clear(); return true; })()`); // an earlier scenario's workbook would restore on reconnect
    await b.goto(APP + '/');
    await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, 'databases listed');
    await ev(`(() => { for (const r of document.querySelectorAll('.db-row[data-db]')) if ((r.dataset.db === 'shop') !== (r.getAttribute('aria-expanded') === 'true')) r.click(); return true; })()`);
    await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
    for (const t of ['orders', 'customers']) await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
    await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'both tables loaded');
    if (!pie) return;
    await relateTables(ev, waitFor, ['orders', 'region', 'customers', 'country']);
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
    await ev(`(() => {
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
      };
      return true; })()`);
    await waitFor(`!!__t.chip('region')`, 'field pane filled');
    for (const [name, zone] of [['region', 'rows'], ['amount', 'columns']]) await ev(`(() => { __t.drag(__t.chip(${J(name)}), __t.zone(${J(zone)})); return true; })()`);
    await b.sleep(600);
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === 'Pie').click()`);
    await b.sleep(600);
  };
  // The session ends while the user is looking at the overlay: the next probe finds it gone (the tab regains focus, as after a redeploy).
  const sessionEnds = async () => { pingMode = 'gone'; await ev(`document.dispatchEvent(new Event('visibilitychange'))`); };
  const authOnly = `document.querySelector('.app').hasAttribute('data-disconnected') && !document.getElementById('conn-form').hidden && document.querySelectorAll('.entity').length === 0`;
  const noOverlay = `document.querySelectorAll('dialog[open]').length === 0 && document.querySelector('.ctx-menu') === null && document.querySelectorAll(':popover-open').length === 0`;

  await check('the Edit member colours dialog (from the Color flyout) closes when the session ends: only the connect card is left', async () => {
    await setup({ pie: true });
    await ev(`document.querySelector('.ws-tool[data-tool="color"]').click()`);
    await waitFor(`!!document.querySelector('.ws-memcol__open') && !document.querySelector('.ws-memcol__open').disabled`, 'Edit member colours enabled');
    await ev(`document.querySelector('.ws-memcol__open').click()`);
    await waitFor(`!!document.querySelector('dialog.memcol-dialog[open]')`, 'member colours dialog open');
    await ev(`(() => { window.__f = []; const d = (t) => (t && t.id ? '#' + t.id : t && t.tagName ? t.tagName + '.' + String(t.className).slice(0, 24) : String(t));
      for (const type of ['focusin', 'focusout']) document.addEventListener(type, (e) => window.__f.push(type + ':' + d(e.target)), true); return true; })()`);
    await sessionEnds();
    await waitFor(authOnly, 'connect card showing', 8000);
    await waitFor(noOverlay, 'every overlay closed', 3000);
    await b.sleep(500);
    const active = await ev(`(() => { const a = document.activeElement; return a ? a.tagName + '#' + a.id + '.' + a.className : 'none'; })()`);
    must(/^(INPUT#conn-host|INPUT#conn-password)\./.test(active), `focus is not on the connect form: ${active}; focus events: ${await ev('window.__f.join(" > ")')}`);
    must(await ev(`document.querySelector('.ws-tool[data-tool="color"]') === null || document.querySelector('.ws-tool[data-tool="color"]').offsetParent === null`), 'the Color flyout\'s tool is still on screen');
  });

  await check('an unsaved calculated field (manager + dialog + its "Discard?" confirm) closes when the session ends: the multi-pass path', async () => {
    await setup({ pie: true });
    await ev(NEW_CALC); // the manager, then the calculation dialog on top of it
    await waitFor(`!!document.querySelector('dialog.calc-dialog[open]')`, 'calc dialog open');
    await ev(`(() => { const i = document.querySelector('.calc-dialog input.input'); i.value = 'half'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await ev(`(() => { const t = document.querySelector('.calc-dialog textarea.formula'); t.value = '[amount] / 2'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    must(await ev(`document.querySelectorAll('dialog[open]').length`) >= 2, 'manager and calculation dialog open');
    await sessionEnds();
    await waitFor(authOnly, 'connect card showing', 8000);
    await waitFor(noOverlay, 'every dialog closed, including the Discard confirm', 3000);
  });

  await check('the Settings dialog closes when the session ends', async () => {
    await setup();
    await ev(`(() => { const o = [...document.querySelectorAll('[data-settings-open]')].find((x) => x.offsetParent !== null); o.click(); return true; })()`);
    await waitFor(`!!document.querySelector('dialog[open]')`, 'settings open');
    await sessionEnds();
    await waitFor(authOnly, 'connect card showing', 8000);
    await waitFor(noOverlay, 'settings closed', 3000);
  });

  await check('an open confirm (Disconnect) closes when the session ends, and its answer is "no": nothing is disconnected twice', async () => {
    await setup();
    await ev(`document.getElementById('conn-disconnect').click()`);
    await waitFor(`!!document.querySelector('dialog[open]')`, 'confirm open');
    await sessionEnds();
    await waitFor(authOnly, 'connect card showing', 8000);
    await waitFor(noOverlay, 'confirm closed', 3000);
  });

  await check('an open context menu closes when the session ends', async () => {
    await setup({ pie: true });
    await ev(`(() => { __t.chip('region').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 })); return true; })()`);
    await waitFor(`document.querySelector('.ctx-menu') !== null`, 'context menu open');
    await sessionEnds();
    await waitFor(authOnly, 'connect card showing', 8000);
    await waitFor(noOverlay, 'menu closed', 3000);
  });

  await check('a dialog does not stay open after a Disconnect either, and the connect card is the only view', async () => {
    await setup();
    await ev(`document.getElementById('conn-disconnect').click()`);
    await waitFor(`!!document.querySelector('dialog[open]')`, 'confirm open');
    await ev(`[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === 'Disconnect').click()`);
    await waitFor(authOnly, 'connect card showing', 8000);
    await waitFor(noOverlay, 'no overlay', 3000);
  });
} catch (e) { console.log(`FAIL harness: ${e.stack}`); failed++; } finally { if (b) await b.close(); }
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
