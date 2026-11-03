// Browser checks for named hierarchies (T03-29): create one in the Hierarchies dialog (ordered level picker, keyboard-operable
// reorder), see its row in the dialog, press Use -> the sheet's drill is the same
// structure a hand-built drill has and a bar click drills a level; rename / delete leave the sheet's drill intact; the workbook
// round-trips it. The real dev app (APP_URL, default http://localhost:5193) in headless Chromium; every /api/* call is mocked.
// Any page error fails the run (cdp.mjs).  Env: APP_URL, SHOTS_DIR, CDP_PORT, CHROME_BIN.
import { launch } from './cdp.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5193';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'hier-ui-shots');
mkdirSync(SHOTS, { recursive: true });

const COLUMNS = { orders: [['amount', 'Float64', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text'], ['placed', 'DateTime', 'temporal']] };
const REGIONS = ['APAC', 'EU', 'US'], CHANNELS = ['web', 'shop'];
const queries = [];
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders'] };
  if (path === '/api/databases/shop/tables/orders/columns') return { json: COLUMNS.orders.map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/query') {
    queries.push(body);
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    const keysFor = dims[0]?.column === 'channel' ? CHANNELS : REGIONS;
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: keysFor.map((k, r) => ({ keys: dims.map(() => k), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })), truncated: false } };
  }
  return null;
}

let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;

let b = null, wbDir = null;
try {
  wbDir = mkdtempSync(join(tmpdir(), 'hier-wb-'));
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label, timeout) => b.waitFor(s, { label, timeout });
  const settle = async (quiet = 250) => { let n = -1; for (let i = 0; i < 60 && n !== queries.length; i++) { n = queries.length; await b.sleep(quiet); } };
  const last = () => queries[queries.length - 1];
  const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); const d = st.activeWorksheet(); ${code}; return true; })()`);
  const sheetDrill = () => ev(`(async () => JSON.stringify((await import('/features/Core/store.js')).activeWorksheet().sheet.drill))()`).then((s) => JSON.parse(s));
  const hdlg = `document.querySelector('dialog.hier-dialog[open]')`;
  const clickIn = (root, text) => ev(`(() => { const e = [...${root}.querySelectorAll('button')].find((x) => x.textContent.trim() === ${J(text)} || x.getAttribute('aria-label') === ${J(text)}); if (!e) throw new Error('no button ${text}'); e.click(); return true; })()`);
  const setVal = (sel, v, evt = 'input') => ev(`(() => { const i = ${hdlg}.querySelector(${J(sel)}); i.value = ${J(v)}; i.dispatchEvent(new Event(${J(evt)}, { bubbles: true })); return true; })()`);
  const levelNames = () => ev(`[...${hdlg}.querySelectorAll('.hier-level__name')].map((x) => x.textContent)`);
  const formError = () => ev(`(() => { const e = ${hdlg}.querySelector('.field-error'); return e && !e.hidden ? e.textContent : ''; })()`);
  const addLevel = async (col) => { await setVal('.hier-add select', col, 'change'); await clickIn(hdlg, 'Add level'); };
  // Hierarchies live in a dialog opened from the sidebar's Hierarchies tool: a row per hierarchy with Use / Edit / Delete.
  const openHier = async () => { await ev(`document.querySelector('button[aria-label="Hierarchies"]').click()`); await waitFor(`${hdlg} !== null`, 'hierarchies dialog'); };
  const closeHier = async () => { await clickIn(hdlg, 'Done'); await waitFor(`${hdlg} === null`, 'dialog closed'); };
  const hierNames = () => ev(`[...${hdlg}.querySelectorAll('.bookmark__name')].map((x) => x.textContent)`);
  const useHier = async (name) => { await openHier(); await ev(`${hdlg}.querySelector(${J(`button[aria-label^="Use ${name} as"]`)}).click()`); await waitFor(`${hdlg} === null`, 'dialog closed by Use'); };
  const chartHost = `document.querySelector('#ws-chart .ws-chart-canvas')`;
  const instOf = `window.echarts.getInstanceByDom(${chartHost})`;
  const clickBar = async (cat) => {
    const p = await ev(`(() => { const i = ${instOf}; const horiz = i.getOption().yAxis[0].type === 'category'; const [x, y] = i.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, horiz ? [5, ${J(cat)}] : [${J(cat)}, 5]); const r = ${chartHost}.getBoundingClientRect(); return [r.left + x, r.top + y]; })()`);
    await b.click(p[0], p[1]);
  };

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
  await store(`const s = d.sheet; const f = (c, category, extra = {}) => ({ db: 'shop', table: 'orders', column: c, category, ...extra }); s.chartType = 'bar'; s.columns = []; s.rows = [f('amount', 'numeric', { agg: 'sum' })]; s.drill = null; st.updateSheet(d.id, s)`);
  await settle();

  await check('the Hierarchies tool opens a dialog with no rows yet; the field pane has no Hierarchies group', async () => {
    must(await ev(`!document.querySelector('#ws-fields .hier-group') && !document.querySelector('#ws-fields .hier-field')`), 'pane still has a Hierarchies group');
    await openHier();
    must((await hierNames()).length === 0, 'rows before any hierarchy exists');
    await closeHier();
  });

  await check('create: needs 2 levels; reorder with Up / Down buttons; saves; the row appears in the dialog', async () => {
    await openHier();
    await clickIn(hdlg, '+ New hierarchy');
    await setVal('input.input', 'Geo');
    await addLevel('channel');
    await clickIn(hdlg, 'Save');
    must(/at least 2 levels/.test(await formError()), `one level not refused: ${await formError()}`);
    await addLevel('region');
    must(J(await levelNames()) === J(['channel', 'region']), `levels: ${J(await levelNames())}`);
    await clickIn(hdlg, 'Move level 2 (region) up');
    must(J(await levelNames()) === J(['region', 'channel']), `after Up: ${J(await levelNames())}`);
    must(await ev(`document.activeElement.getAttribute('aria-label')`) === 'Move level 1 (region) up' || await ev(`document.activeElement.disabled === false`), 'focus lost after reorder');
    await clickIn(hdlg, 'Save');
    await waitFor(`!${hdlg}.querySelector('.params-edit')`, 'saved');
    must(J(await hierNames()) === J(['Geo']), `rows: ${J(await hierNames())}`);
    must(/region › channel/.test(await ev(`${hdlg}.querySelector('.bookmark__meta').textContent`)), 'level order missing from the row');
    await closeHier();
  });

  await check('name must be unique case-insensitively', async () => {
    await openHier();
    await clickIn(hdlg, '+ New hierarchy');
    await setVal('input.input', 'GEO');
    await addLevel('region'); await addLevel('channel');
    await clickIn(hdlg, 'Save');
    must(/Another hierarchy has that name/.test(await formError()), `dup name: ${await formError()}`);
    await clickIn(hdlg, 'Cancel'); await closeHier();
  });

  await check('Use on Drill: the sheet gets the same drill a hand-built one has; the chart groups by level 1; a click drills to level 2', async () => {
    queries.length = 0;
    await useHier('Geo');
    await waitFor(`/Showing: region/.test(document.querySelector('.ws-drill')?.textContent ?? '')`, 'drill chip');
    const d = await sheetDrill();
    must(J(d) === J({ levels: [{ db: 'shop', table: 'orders', column: 'region', category: 'text' }, { db: 'shop', table: 'orders', column: 'channel', category: 'text' }], depth: 0, path: [] }), `drill: ${J(d)}`);
    await settle();
    must(J(last()).includes('"region"'), `no region grouping: ${J(last())}`);
    await waitFor(`!!${chartHost}`, 'chart');
    await clickBar('EU');
    await waitFor(`/Showing: channel/.test(document.querySelector('.ws-drill')?.textContent ?? '')`, 'drilled to channel');
    await settle();
    must((last().filters ?? []).some((f) => f.column === 'region' && f.op === '=' && f.value === 'EU'), `no ancestor filter: ${J(last().filters)}`);
  });

  await check('Use works with the Drill panel open and with it closed', async () => {
    await waitFor(`!!document.querySelector('.ws-toolpanel__zone')`, 'drill panel (left open by the first Use)');
    await store(`d.sheet.drill = null; st.updateSheet(d.id, d.sheet)`);
    await waitFor(`!document.querySelector('.ws-drill')`, 'drill cleared');
    await ev(`(() => { if (!document.querySelector('.ws-toolpanel__zone')) [...document.querySelectorAll('.ws-tool')].find((x) => /^Drill/.test(x.getAttribute('aria-label') ?? '')).click(); return true; })()`);
    await waitFor(`!!document.querySelector('.ws-toolpanel__zone')`, 'panel open');
    await useHier('Geo');
    await waitFor(`/Showing: region/.test(document.querySelector('.ws-drill')?.textContent ?? '')`, 'applied with the panel open');
    await store(`d.sheet.drill = null; st.updateSheet(d.id, d.sheet)`);
    await waitFor(`!document.querySelector('.ws-drill')`, 'drill cleared again');
    await ev(`(() => { if (document.querySelector('.ws-toolpanel__zone')) [...document.querySelectorAll('.ws-tool')].find((x) => /^Drill/.test(x.getAttribute('aria-label') ?? '')).click(); return true; })()`);
    await waitFor(`!document.querySelector('.ws-toolpanel__zone')`, 'panel closed');
    await useHier('Geo');
    await waitFor(`/Showing: region/.test(document.querySelector('.ws-drill')?.textContent ?? '')`, 'applied with the panel closed');
    must((await sheetDrill()).levels.length === 2, 'levels');
  });

  await check('applying over a sheet with a selection and a drill descent resets selection, depth and path', async () => {
    await store(`const s = d.sheet; s.selection = { db: 'shop', table: 'orders', column: 'region', values: ['EU'], keys: ['EU'], labels: ['EU'] }; s.drill.depth = 1; s.drill.path = [{ column: 'region', value: 'EU', label: 'EU' }]; st.updateSheet(d.id, s)`);
    await useHier('Geo');
    await waitFor(`/Showing: region/.test(document.querySelector('.ws-drill')?.textContent ?? '')`, 'reset to level 1');
    const r = await ev(`(async () => { const s = (await import('/features/Core/store.js')).activeWorksheet().sheet; return JSON.stringify({ sel: s.selection, drill: s.drill }); })()`).then(JSON.parse);
    must(r.sel === null, `selection kept: ${J(r.sel)}`);
    must(r.drill.depth === 0 && r.drill.path.length === 0 && r.drill.levels.length === 2 && r.drill.levels[0].column === 'region' && r.drill.levels[0].category === 'text', `drill: ${J(r.drill)}`);
  });

  await check('rename and delete leave the sheet drill intact', async () => {
    const before = J(await sheetDrill());
    await openHier();
    await clickIn(hdlg, 'Edit hierarchy Geo');
    await setVal('input.input', 'Places');
    await clickIn(hdlg, 'Save');
    await waitFor(`!${hdlg}.querySelector('.params-edit')`, 'renamed');
    must(J(await hierNames()) === J(['Places']), `rows after rename: ${J(await hierNames())}`);
    must(J(await sheetDrill()) === before, 'rename changed the sheet drill');
    await clickIn(hdlg, 'Delete hierarchy Places');
    await waitFor(`[...document.querySelectorAll('dialog[open]')].some((d) => !d.classList.contains('hier-dialog'))`, 'confirm');
    await ev(`[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent === 'Delete' && !x.getAttribute('aria-label')).click()`);
    await waitFor(`(${hdlg}?.querySelectorAll('.bookmark__name').length ?? 0) === 0`, 'row removed');
    must(J(await sheetDrill()) === before, 'delete changed the sheet drill');
    must(await ev(`!!document.querySelector('.ws-drill')`), 'drill chip gone');
    await closeHier();
  });

  await check('Use replaces the drill; a hierarchy with a missing column refuses with a message and leaves the drill', async () => {
    await ev(`(async () => { const st = await import('/features/Core/store.js'); st.addHierarchy({ name: 'Chan', levels: [{ db: 'shop', table: 'orders', column: 'channel' }, { db: 'shop', table: 'orders', column: 'region' }] }); st.addHierarchy({ name: 'Broken', levels: [{ db: 'shop', table: 'orders', column: 'nope' }, { db: 'shop', table: 'orders', column: 'region' }] }); return true; })()`);
    await useHier('Chan');
    await waitFor(`/Showing: channel/.test(document.querySelector('.ws-drill')?.textContent ?? '')`, 'applied');
    const d = await sheetDrill();
    must(d.levels[0].column === 'channel' && d.depth === 0 && d.path.length === 0, `Use did not reset: ${J(d)}`);
    await ev(`document.querySelector('#toast .toast__close')?.click()`); // an earlier toast must not satisfy the wait below
    await waitFor(`document.getElementById('toast').hidden`, 'earlier toast dismissed');
    await useHier('Broken');
    await waitFor(`!document.getElementById('toast').hidden`, 'a refusal message');
    const msg = await ev(`document.querySelector('#toast .toast__text').textContent`);
    must(msg === "“Broken” can't be used: column nope is no longer in orders.", `refusal text: ${msg}`);
    must((await sheetDrill()).levels[0].column === 'channel', 'a broken hierarchy replaced the drill');
  });

  await check('workbook round trip: exported file carries hierarchies; reopening restores them in the Hierarchies dialog', async () => {
    await ev(`(() => { window.__blobs = []; const orig = URL.createObjectURL; URL.createObjectURL = (x) => { x.text().then((t) => window.__blobs.push(t)); return orig.call(URL, x); }; return true; })()`);
    await ev(`document.querySelector('.ws-export > .iconbtn').click()`);
    await ev(`[...document.querySelectorAll('.ws-export .menu__item')].find((b) => b.textContent.trim() === 'Workbook (JSON)').click()`);
    await waitFor(`window.__blobs.length === 1`, 'export blob');
    const json = await ev(`window.__blobs[0]`);
    const wb = JSON.parse(json);
    must(wb.version === 2 && Array.isArray(wb.hierarchies) && wb.hierarchies.map((h) => h.name).join() === 'Chan,Broken', `export hierarchies: ${J(wb.hierarchies)}`);
    const file = join(wbDir, 'workbook.json');
    writeFileSync(file, json);
    await ev(`localStorage.clear()`);
    await b.send('Page.reload');
    await waitFor(`document.readyState === 'complete' && !!document.getElementById('conn-connect')`, 'reloaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.getElementById('db-select').options.length > 1`, 'reconnected');
    await waitFor(`!!document.getElementById('wb-file')`);
    const { root } = await b.send('DOM.getDocument');
    const { nodeId } = await b.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#wb-file' });
    await b.send('DOM.setFileInputFiles', { nodeId, files: [file] });
    await waitFor(`document.querySelectorAll('.entity').length === 1`, 'entities restored');
    await waitFor(`document.querySelectorAll('.tab:not(.tab--model)').length > 0`, 'tabs restored');
    await ev(`document.querySelectorAll('.tab:not(.tab--model) .tab__label')[0].click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet shown');
    await openHier();
    must(J(await hierNames()) === J(['Chan', 'Broken']), `rows restored: ${J(await hierNames())}`);
    await closeHier();
    must((await sheetDrill()).levels[0].column === 'channel', 'sheet drill not restored');
  });

  const shots = [];
  for (const scheme of ['light', 'dark']) {
    await b.setScheme(scheme);
    await ev(`document.documentElement.setAttribute('data-theme', ${J(scheme)})`);
    await b.sleep(250);
    await check(`screenshots ${scheme}`, async () => {
      const p1 = join(SHOTS, `hier-pane-${scheme}.png`); await b.screenshot(p1); shots.push(p1);
      await openHier();
      await b.sleep(150);
      const p3 = join(SHOTS, `hier-list-${scheme}.png`); await b.screenshot(p3); shots.push(p3);
      await clickIn(hdlg, 'Edit hierarchy Chan');
      await b.sleep(150);
      const p2 = join(SHOTS, `hier-dialog-${scheme}.png`); await b.screenshot(p2); shots.push(p2);
      await clickIn(hdlg, 'Cancel'); await closeHier();
    });
  }
  console.log('screenshots:\n  ' + shots.join('\n  '));

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
  if (wbDir) rmSync(wbDir, { recursive: true, force: true });
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
