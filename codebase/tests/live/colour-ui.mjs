// Browser checks for the member colours and palette reverse (T01-20, T03-33): the real dev app (APP_URL, default http://localhost:5186) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/colour-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5186 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { categoryColour, categoryColours } from '../../src/DashboardBuilder/Features/Core/theme-model.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tick = "(c) => getComputedStyle(c.querySelector('svg')).visibility === 'visible'"; // a swatch's tick is a drawn check icon, shown while it is aria-pressed
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };
const APP = process.env.APP_URL ?? 'http://localhost:5186';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'colour-ui-shots');
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
  if (/\/columns\/\w+\/distinct/.test(path)) return { json: REGIONS };
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
  wbDir = mkdtempSync(join(tmpdir(), 'calc-wb-'));
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const toastText = () => ev(`(document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent)`);

  // page helpers: HTML5 drag-and-drop with a real DataTransfer, text lookup, dialog typing
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
    await ev(NEW_CALC);
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
    await ev(`(() => { const c = __t.chip(${J(name)}); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); return true; })()`);
    await ev(`(() => { const c = __t.chip(${J(name)}); [...document.querySelectorAll('.ctx-menu .menu__item')].find((x) => x.textContent.trim() === ${J(item)}).click(); return true; })()`);
  };
  const confirmOpen = `[...document.querySelectorAll('dialog[open]')].find((d) => !d.classList.contains('calc-dialog') && !d.classList.contains('calc-manager'))`;
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
  await waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, 'databases listed');
  await ev(`(() => { for (const r of document.querySelectorAll('.db-row[data-db]')) if ((r.dataset.db === 'shop') !== (r.getAttribute('aria-expanded') === 'true')) r.click(); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders', 'customers'])
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'both tables loaded');
  await relateTables(ev, waitFor, ['orders', 'region', 'customers', 'country']); // an unrelated table is held out of the field pane
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await installHelpers();
  await waitFor(`!!__t.chip('region')`, 'field pane filled');

  const filterTool = `document.querySelector('.ws-tool[aria-label^="Filters"]')`;
  const opSelect = `document.querySelector('select[aria-label^="Filter operator for"]')`;
  const shot = async (name) => { try { writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } };

  const fmtTool = `document.querySelector('.ws-tool[data-tool="color"]')`; // the Colour controls live in the Color tile's flyout (D151)
  const fills = () => ev(`[...document.querySelectorAll('.ws-chart-canvas svg path')].map((p) => (p.getAttribute('fill') || '').toLowerCase()).filter((f) => /^#[0-9a-f]{6}$/.test(f))`);
  const lum = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };

  await check('a pie colours its members; the Color flyout opens the member colours dialog', async () => {
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('amount', `__t.zone('columns')`);
    await settle(400);
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === 'Pie').click()`);
    await settle(400);
    await waitFor(`${fmtTool} !== null`, 'format tool');
    await ev(`${fmtTool}.click()`);
    const dlg = `document.querySelector('dialog.memcol-dialog[open]')`;
    const openBtn = `document.querySelector('.ws-memcol__open')`;
    await waitFor(`!!${openBtn} && !${openBtn}.disabled`, 'Edit member colours enabled');
    await ev(`${openBtn}.click()`);
    await waitFor(`!!${dlg}`, 'dialog open');
    must(J(await ev(`[...${dlg}.querySelectorAll('.memcol-palette__name')].map((n) => n.textContent)`)) === J(['Default']), 'the generated Default is the only palette, under its title');
    must(await ev(`!${dlg}.querySelector('.memcol-palette + .memcol-palette')`), 'one palette, so no divider yet');
    must(await ev(`${dlg}.querySelector('.memcol-palette__apply').getAttribute('aria-pressed')`) === 'true', 'the Default reads as applied while no member has a colour of its own');
    must(await ev(`${dlg}.querySelectorAll('.memcol-row').length`) === 3, 'three member rows');
    must(await ev(`${dlg}.querySelectorAll('.memcol-cell').length`) === 24, 'a sample of 24 generated colours');
    must(J(await ev(`[...${dlg}.querySelectorAll('.memcol-cell')].map((c) => c.getAttribute('aria-label').match(/#[0-9a-f]{6}/)[0]).sort()`)) === J([...categoryColours(24, false)].sort()), 'the sample is the first 24 generated colours');
    must(await ev(`!!${dlg}.querySelector('.memcol-custom__picker') && !!${dlg}.querySelector('.memcol-custom__hex')`), 'a custom colour: picker and #rrggbb field');
    must(J(await ev(`[...${dlg}.querySelectorAll('.memcol-dot')].map((d) => getComputedStyle(d).backgroundColor)`)) === J([0, 1, 2].map((i) => rgb(categoryColour(i, false)))), 'a member without a colour of its own shows the colour the chart draws for it');
    // the single truth: the dot the dialog shows for each member is the colour the chart really draws for that member
    const hexOf = (c) => '#' + c.match(/\d+/g).slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('');
    const dotHex = (await ev(`[...${dlg}.querySelectorAll('.memcol-dot')].map((d) => getComputedStyle(d).backgroundColor)`)).map(hexOf);
    const drawn = [...new Set(await fills())]; // the legend repeats each slice's colour
    must(J(dotHex) === J(drawn), `the dialog's colours ${J(dotHex)} are the slices' fills ${J(drawn)}`);
    must(await ev(`${dlg}.querySelectorAll('.memcol-member')[0].getAttribute('aria-pressed')`) === 'true', 'the first member is selected on open');
    must(await ev(`(() => { const r = [...${dlg}.querySelectorAll('.memcol-cell')].map((c) => parseInt(c.getAttribute('aria-label').match(/#[0-9a-f]{6}/)[0].slice(1), 16)); return r.every((v, i) => i === 0 || r[i - 1] <= v); })()`), 'the swatches are listed by ascending hex');
    must(await ev(`(() => { const a = ${dlg}.querySelector('.memcol-pane--colours').getBoundingClientRect().width, b = ${dlg}.querySelector('.memcol-pane--members').getBoundingClientRect().width; return Math.abs(b / a - 1.618) < 0.03; })()`), 'the panes split at the golden ratio');
    must(await ev(`${dlg}.getBoundingClientRect().width > ${dlg}.getBoundingClientRect().height`), 'landscape');
    must(await ev(`!!${dlg}.querySelector('.dialog__foot .btn--primary')`) && (await ev(`${dlg}.querySelector('.dialog__foot .btn--primary').textContent`)) === 'Save', 'Save in the footer');
    await ev(`${dlg}.querySelector('.dialog__foot .btn:nth-child(2)').click()`); // Cancel
    await waitFor(`!${dlg}`, 'dialog closed by Cancel');
  });
  const dlgQ = `document.querySelector('dialog.memcol-dialog[open]')`;
  const openDlg = async () => { await ev(`document.querySelector('.ws-memcol__open').click()`); await waitFor(`!!${dlgQ}`, 'dialog open'); };
  const C5 = categoryColour(5, false); // a generated colour no slice of this 3-member pie wears
  const cellOf = (hex) => `[...${dlgQ}.querySelectorAll('.memcol-cell')].find((c) => c.getAttribute('aria-label').includes('${hex}'))`;
  const typeHex = (hex) => ev(`(() => { const i = ${dlgQ}.querySelector('.memcol-custom__hex'); i.value = '${hex}'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); // stages for the selected member, which stays selected
  const choose = async (row, hex) => { await ev(`${dlgQ}.querySelectorAll('.memcol-member')[${row}].click()`); await typeHex(hex); };
  const dotColours = () => ev(`[...${dlgQ}.querySelectorAll('.memcol-dot')].map((d) => getComputedStyle(d).backgroundColor)`);
  const save = async () => { await ev(`${dlgQ}.querySelector('.btn--primary').click()`); await waitFor(`!${dlgQ}`, 'dialog closed by Save'); await settle(400); };
  let before;
  await check('select a member, then a swatch: nothing changes until Save; Save recolours the slice once and it persists; Cancel discards', async () => {
    before = await fills();
    await openDlg();
    await ev(`${dlgQ}.querySelectorAll('.memcol-member')[1].click()`);
    await ev(`${cellOf(C5)}.click()`);
    must(await ev(`${dlgQ}.querySelectorAll('.memcol-member')[2].getAttribute('aria-pressed')`) === 'true', 'the pick moved the selection on to the next member');
    must(await ev(`(${tick})(${cellOf(C5)})`) === false, 'the tick follows the selection, so it is not on the colour just given to the previous member');
    await ev(`${dlgQ}.querySelectorAll('.memcol-member')[1].click()`);
    must(await ev(`(${tick})(${cellOf(C5)})`) === true, 'tick (a drawn check icon) on the chosen colour once its member is selected again');
    must(await ev(`${dlgQ}.querySelector('.memcol-search').hidden`), 'three members: no search box');
    must(await ev(`${dlgQ}.querySelectorAll('.memcol-hex')[1].textContent`) === C5, 'hex shown on the member');
    must(!(await fills()).includes(C5), 'the chart is untouched before Save');
    await save();
    const after = await fills();
    must(after.includes(C5) && !before.includes(C5), `fills before ${J(before)} after ${J(after)}`);
    await waitFor(`document.activeElement && document.activeElement.classList.contains('ws-memcol__open')`, 'focus back on the button');
    await openDlg();
    must(await ev(`${dlgQ}.querySelectorAll('.memcol-hex')[1].textContent`) === C5, 'stored colour shown on reopen');
    await ev(`${dlgQ}.querySelectorAll('.memcol-member')[1].click()`);
    must(await ev(`${cellOf(C5)}.getAttribute('aria-pressed')`) === 'true', 'the member\'s stored colour is the pressed swatch');
    await b.sleep(500); // past the dialog's entrance
    must(await ev(`(() => { const r = ${cellOf(C5)}.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`), 'the generated colours are visible');
    await shot('colour-light.png');
    const kept = await fills();
    await choose(0, '#000000');
    await ev(`${dlgQ}.querySelector('.dialog__foot .btn:nth-child(2)').click()`); // Cancel
    await waitFor(`!${dlgQ}`, 'closed');
    await settle(400);
    must(J(await fills()) === J(kept), `Cancel discarded the staged pick: ${J(kept)} -> ${J(await fills())}`);
    await openDlg();
    await ev(`${dlgQ}.querySelectorAll('.memcol-reset')[1].click()`);
    must((await dotColours())[1] === rgb(categoryColour(1, false)), 'Reset hands the member back the colour the chart generates for it');
    await save();
    must(!(await fills()).includes(C5), 'per-member Reset restored the generated colour');
  });
  await check('Reset all clears every stored member colour, also after new picks', async () => {
    await openDlg(); await choose(0, '#000000'); await choose(2, '#000000'); await save();
    must((await fills()).filter((f) => f === '#000000').length >= 2, 'black slices');
    await openDlg();
    await ev(`${dlgQ}.querySelector('.memcol-resetall').click()`);
    must((await ev(`[...${dlgQ}.querySelectorAll('.memcol-hex')].every((h) => h.textContent === '')`)), 'every member shows no colour');
    await save();
    must(!(await fills()).includes('#000000'), 'all reset');
  });
  await check('a colour typed as #rrggbb is saved for the member; an invalid one is refused; the field follows the selection', async () => {
    await openDlg();
    await ev(`${dlgQ}.querySelectorAll('.memcol-member')[0].click()`);
    await typeHex('#123456');
    must(await ev(`${dlgQ}.querySelectorAll('.memcol-hex')[0].textContent`) === '#123456', 'a whole hex stages for the selected member as it is typed');
    must(await ev(`${dlgQ}.querySelectorAll('.memcol-member')[0].getAttribute('aria-pressed')`) === 'true', 'typing does not move the selection');
    must(await ev(`${dlgQ}.querySelector('.memcol-custom__swatch').dataset.chosen`) === 'true', 'the custom swatch is ticked for a colour of its own');
    await ev(`(() => { const i = ${dlgQ}.querySelector('.memcol-custom__hex'); i.focus(); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    must(await ev(`${dlgQ}.querySelectorAll('.memcol-member')[1].getAttribute('aria-pressed')`) === 'true', 'Enter sets it and moves on');
    await ev(`(() => { const i = ${dlgQ}.querySelector('.memcol-custom__hex'); i.value = '#12345'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    must((await ev(`${dlgQ}.querySelector('.memcol-pane--members .memcol-error').textContent`)).includes('#rrggbb'), 'an invalid hex is refused with the reason');
    await save();
    must((await fills()).includes('#123456'), `the typed colour reaches the slice: ${J(await fills())}`);
    await openDlg();
    must(await ev(`${dlgQ}.querySelector('.memcol-custom__hex').value`) === '#123456', 'the field shows the selected member\'s colour on reopen');
    await ev(`${dlgQ}.querySelector('.memcol-resetall').click()`);
    await save();
    must(!(await fills()).includes('#123456'), 'Reset all gives every member its generated colour back');
  });
  await check('a created palette: made in the Create palette dialog, applied to every member, saved with the workbook; removing it leaves the members\' colours', async () => {
    const pdQ = `document.querySelector('dialog.palcreate-dialog[open]')`;
    const setValue = (sel, v) => ev(`(() => { const i = ${pdQ}.querySelector('${sel}'); i.value = ${J(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const titles = () => ev(`[...${dlgQ}.querySelectorAll('.memcol-palette__name')].map((n) => n.textContent)`);
    // the autosaved workbook itself (localStorage, the entry without the ":backup-" suffix), not only the store: the palettes must reach the file
    const autosaved = () => ev(`(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!k || k.includes(':backup-')) continue; try { const j = JSON.parse(localStorage.getItem(k)); if (j && Array.isArray(j.worksheets)) return { has: 'palettes' in j, palettes: j.palettes ?? null }; } catch { /* not a workbook */ } } return null; })()`);
    const stored = () => ev(`(async () => { const st = await import('/features/Core/store.js'); return st.palettes.map((p) => ({ name: p.name, colours: p.colours })); })()`);
    await openDlg();
    must(J(await titles()) === J(['Default']), 'only the Default is listed, under its title');
    must(await ev(`(() => { const b = ${dlgQ}.querySelector('.memcol-pane__foot .memcol-create__open'), p = ${dlgQ}.querySelector('.memcol-pane--colours'); if (!b) return false; const r = b.getBoundingClientRect(), q = p.getBoundingClientRect(); return Math.abs(r.width - (q.width - 32)) <= 1 && Math.abs(q.bottom - ${dlgQ}.querySelector('.memcol-pane__foot').getBoundingClientRect().bottom) <= 1; })()`), 'Create palette… is pinned at the bottom of the left pane and full width');
    must(await ev(`${dlgQ}.querySelector('.memcol-create__open').textContent.includes('Create palette')`), 'the button is called Create palette…');
    await ev(`${dlgQ}.querySelector('.memcol-create__open').click()`);
    must(await ev(`!!${pdQ}`) && await ev(`${pdQ}.querySelector('.btn--primary').disabled`), 'the Create palette dialog opens on top, and Create waits for a name');
    must(await ev(`${pdQ}.querySelectorAll('.palcreate-swatches .memcol-cell').length`) === 1, 'it starts with one colour');
    must(await ev(`${pdQ}.querySelector('.palcreate-remove').disabled`), 'the last colour cannot be removed');
    await ev(`${pdQ}.dispatchEvent(new Event('cancel', { cancelable: true }))`); // Esc, and a session ending, go through here
    must(!(await ev(`!!${pdQ}`)) && await ev(`!!${dlgQ}`), 'Esc closes the Create palette dialog and leaves Edit member colours open');
    must(await ev(`document.activeElement === ${dlgQ}.querySelector('.memcol-create__open')`), 'focus returns to Create palette…');
    await ev(`${dlgQ}.querySelector('.memcol-create__open').click()`);
    await ev(`${pdQ}.querySelector('.palcreate-add').click()`); await ev(`${pdQ}.querySelector('.palcreate-add').click()`);
    must(await ev(`${pdQ}.querySelectorAll('.palcreate-swatches .memcol-cell').length`) === 3, '+ adds colours');
    const colourAt = async (i, hex) => { await ev(`${pdQ}.querySelectorAll('.palcreate-swatches .memcol-cell')[${i}].click()`); await setValue('.memcol-custom__hex', hex); };
    await colourAt(0, '#112233'); await colourAt(1, '#445566'); await colourAt(2, '#778899');
    must(J(await ev(`[...${pdQ}.querySelectorAll('.palcreate-swatches .memcol-cell')].map((c) => c.style.backgroundColor)`)) === J(['#112233', '#445566', '#778899'].map(rgb)), 'the swatches keep the order they were made in');
    must(await ev(`${pdQ}.querySelectorAll('.palcreate-swatches .memcol-cell')[2].getAttribute('aria-pressed')`) === 'true' && await ev(`(${tick})(${pdQ}.querySelectorAll('.palcreate-swatches .memcol-cell')[2])`) === true, 'the chosen colour is ticked, not only outlined');
    await setValue('.palcreate-name', 'Default');
    must((await ev(`${pdQ}.querySelector('.memcol-error').textContent`)).includes('already exists') && await ev(`${pdQ}.querySelector('.btn--primary').disabled`), 'the name Default is refused with the reason');
    await setValue('.palcreate-name', 'Brand');
    must(!(await ev(`${pdQ}.querySelector('.btn--primary').disabled`)), 'a name and colours enable Create');
    await ev(`${pdQ}.querySelector('.btn--primary').click()`);
    must(!(await ev(`!!${pdQ}`)) && await ev(`!!${dlgQ}`), 'Create closes only the Create palette dialog');
    must(J(await titles()) === J(['Default', 'Brand']), 'Brand is listed under its own title');
    must(await ev(`!!${dlgQ}.querySelector('.memcol-palette + .memcol-palette')`), 'a divider separates the palettes');
    await ev(`[...${dlgQ}.querySelectorAll('.memcol-palette__apply')][1].click()`);
    must(J(await ev(`[...${dlgQ}.querySelectorAll('.memcol-hex')].map((h) => h.textContent)`)) === J(['#112233', '#445566', '#778899']), 'the title applies the palette to every member, in order');
    must(J(await stored()) === J([]), 'nothing is stored until Save');
    await save();
    const f = await fills();
    must(['#112233', '#445566', '#778899'].every((c) => f.includes(c)), `the slices wear the palette: ${J(f)}`);
    must(J(await stored()) === J([{ name: 'Brand', colours: ['#112233', '#445566', '#778899'] }]), 'the workbook holds the palette: ' + J(await stored()));
    await b.sleep(1000); // past the autosave delay
    const saved1 = await autosaved();
    must(saved1 && J(saved1.palettes) === J([{ name: 'Brand', colours: ['#112233', '#445566', '#778899'] }]), 'the palette is in the autosaved workbook: ' + J(saved1));
    await openDlg();
    must(J(await titles()) === J(['Default', 'Brand']), 'the palette is still there on reopen');
    must(await ev(`[...${dlgQ}.querySelectorAll('.memcol-palette__apply')][1].getAttribute('aria-pressed')`) === 'true', 'it reads as applied');
    await ev(`${dlgQ}.querySelector('.memcol-palette__remove').click()`);
    must(J(await titles()) === J(['Default']), 'removed in the dialog');
    must(J((await stored()).map((p) => p.name)) === J(['Brand']), 'a removal is staged until Save');
    await save();
    must(J(await stored()) === J([]), 'Save stores the removal');
    await b.sleep(1000);
    const saved2 = await autosaved();
    must(saved2 && saved2.has === false, 'with none left the autosaved workbook has no palettes key: ' + J(saved2));
    must(['#112233', '#445566', '#778899'].every((c) => f.includes(c)) && (await fills()).includes('#112233'), 'the members keep the colours they were given');
    await openDlg(); await ev(`${dlgQ}.querySelector('.memcol-resetall').click()`); await save();
  });
  await check('Reverse palette is gone from the Color flyout; the dark look still draws the slices', async () => {
    must(await ev(`![...document.querySelectorAll('.ws-fmt-check, label')].some((l) => l.textContent.includes('Reverse palette'))`), 'Reverse palette no longer exists');
    must((await fills()).length >= 3, 'slices drawn');
    await ev(`document.documentElement.setAttribute('data-theme', 'dark')`);
    await shot('colour-dark.png');
  });
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
  if (wbDir) rmSync(wbDir, { recursive: true, force: true });
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
