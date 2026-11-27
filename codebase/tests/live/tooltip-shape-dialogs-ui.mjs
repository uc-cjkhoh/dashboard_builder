// Browser checks for the Edit tooltip modal and the Edit Shape dialog: the Tooltip flyout is one button (no drop row, no text box, no chips), the modal follows Tableau's Edit Tooltip
// (toolbar, lines, behaviour checkboxes, Reset / Preview / OK / Cancel) and the Shape flyout opens a palette dialog (Select Data Item, Select Shape Palette, Assign palette, Reset).
// Real Chromium over CDP (tests/live/cdp.mjs), /api/* mocked. Run:  node tests/live/marks-flyouts-ui.mjs   (start the app first: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5180 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5184';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'tooltip-shape-dialogs-ui-shots');
mkdirSync(SHOTS, { recursive: true });
const LOOK = process.env.LOOK === 'onedark' ? 'onedark' : '';
const SCHEME = LOOK || process.env.SCHEME === 'dark' ? 'dark' : 'light'; // SCHEME=dark loads the page in the dark scheme (set before load)

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text'], ['discount', 'Float64', 'numeric'], ['placed', 'DateTime', 'temporal']],
  customers: [['country', 'String', 'text']],
};
const REGIONS = ['APAC', 'EU', 'US', 'LATAM', 'MEA', 'CA', 'UK', 'JP'];
const DIMVALS = { region: REGIONS, channel: ['web', 'shop', 'app'], country: ['DE', 'FR'] };
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
    // every dimension has its own members; several dimensions give the full product (a group per pair), the way a group-by does
    const members = dims.map((d) => DIMVALS[d.column] ?? REGIONS);
    let combos = [[]];
    for (const m of members) combos = combos.flatMap((c) => m.map((x) => [...c, x]));
    const value = (m, i, r) => (m.column === 'discount' ? (r - Math.floor(combos.length / 2)) * 10 : 10 * (r + 1) + i); // `discount` crosses zero; the rest are positive
    return { json: {
      rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: combos.map((keys, r) => ({ keys, values: (body.measures ?? []).map((m, i) => value(m, i, r)) })),
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
const deepEq = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= 1); // measured pixel extents: one pixel of anti-aliasing is not a difference


let b = null;
try {
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
  if (SCHEME === 'dark') await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "new MutationObserver((_, o) => { if (document.documentElement) { document.documentElement.setAttribute('data-scheme', 'dark'); o.disconnect(); } }).observe(document, { childList: true })" }); // read at load
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
  const fly = `document.getElementById('ws-toolfly')`;
  const fmtTool = `document.querySelector('.ws-viewbar__btn[aria-label="Format"]')`;
  const tile = (key) => `document.querySelector('.ws-tool[data-tool="${key}"]')`;
  const chartType = async (name) => {
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === ${J(name)}).click()`);
    await settle(500);
  };
  const closePanels = async () => {
    await ev(`(() => { document.querySelector('#ws-toolfly .iconbtn[aria-label="Close editor"]')?.click(); if (document.querySelector('.ws-format')) ${fmtTool}.click(); return true; })()`);
    await b.sleep(150);
  };
  const openTile = async (key) => {
    await closePanels();
    await ev(`${tile(key)}.click()`);
    await waitFor(`!!${fly} && !${fly}.hidden && !!${fly}.querySelector('.ws-toolpanel')`, `${key} flyout open`);
    await b.sleep(450); // the flyout's entry motion
  };
  const openFormat = async () => {
    await closePanels();
    await ev(`${fmtTool}.click()`);
    await waitFor(`!!document.querySelector('.ws-format')`, 'format open');
  };
  const labels = (root) => ev(`[...document.querySelectorAll('${root} .ws-fmt-field, ${root} .ws-fmt-check')].map((l) => l.textContent.trim())`);
  const has = async (root, label) => (await labels(root)).some((t) => t.includes(label));
  const inFly = (label) => has('#ws-toolfly', label);
  const inFormat = (label) => has('.ws-format', label);
  const quiet = (key) => ev(`${tile(key)}.classList.contains('is-quiet')`);
  const slotOnly = () => ev(`!!${fly}.querySelector('.ws-toolpanel > .ws-toolpanel__slot') && !${fly}.querySelector('.ws-flyedit')`);

  await ev(`${fmtTool}`); // the worksheet toolbar is there
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(700);
  await chartType('Bar');


  const shot = async (name) => { try { writeFileSync(join(SHOTS, `${name}-${SCHEME}.png`), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } };
  const inst = `window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas'))`;
  const opt = () => ev(`${inst}.getOption()`);
  const toolEl = (name) => `document.querySelector('.ws-tool[aria-label^="${name}"]')`;
  const tipDlg = `document.querySelector('dialog.tipdlg--rich[open]')`;
  const docEl = `document.querySelector('dialog.tipdlg--rich .tipdlg__doc')`;
  const shapeDlg = `document.querySelector('dialog.shapedlg[open]')`;
  const click = (sel) => ev(`document.querySelector(${J(sel)}).click()`);
  const setVal = (sel, v) => ev(`(() => { const e = document.querySelector(${J(sel)}); e.value = ${J(v)}; e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true; })()`);
  const distinct = (a) => new Set(a).size;
  const tipHtml = (di) => ev(`(() => { const o = ${inst}.getOption(); const f = o.tooltip[0].formatter; const s = o.series[0]; return typeof f === 'function' ? String(f(Array.isArray(f.length) ? {} : [{ dataIndex: ${di}, seriesName: s.name, value: s.data[${di}], axisValue: 'x', name: 'x', seriesIndex: 0, componentType: 'series', marker: '' }])) : ''; })()`);

  // ---- Tooltip -------------------------------------------------------------------------------------------------------
  await check('the Tooltip flyout is the Edit tooltip button alone: no Drop Field Here row, no text box, no chips, no Behaviour section', async () => {
    await openTile('tooltip');
    const r = await ev(`(() => { const f = document.getElementById('ws-toolfly'); return { slot: !!f.querySelector('.ws-toolpanel__slot, .ws-addfield, .ws-toolpanel__zone'), ta: !!f.querySelector('textarea'), chips: !!f.querySelector('.ws-tipedit__chip'), preview: !!f.querySelector('.ws-tipedit__preview'), behaviour: !!f.querySelector('.ws-flyedit__group[data-section="Behaviour"]'), buttons: [...f.querySelectorAll('.ws-toolpanel > .ws-flyedit button')].map((x) => x.textContent.trim()) }; })()`);
    must(!r.slot && !r.ta && !r.chips && !r.preview && !r.behaviour, 'leftovers in the flyout: ' + J(r));
    must(J(r.buttons) === '["Edit tooltip…"]', 'the one button: ' + J(r.buttons));
    await shot('tooltip-flyout');
  });
  await check('the tile still takes a dropped field (it is listed in the modal, where it can be removed)', async () => {
    await closePanels();
    await dragChip('channel', toolEl('Tooltip')); await settle(500);
    await openTile('tooltip');
    must(await ev(`!document.getElementById('ws-toolfly').querySelector('.ws-toolpanel__slot')`), 'still no slot after a drop');
    await click('.ws-tipedit__modal');
    await waitFor(`${tipDlg} !== null`, 'modal open');
    must(await ev(`!!${tipDlg}.querySelector('.tipdlg__cardfields:not([hidden])') && ${tipDlg}.querySelector('.tipdlg__cardfields').textContent.includes('channel')`), 'the card field is listed');
    await ev(`${tipDlg}.querySelector('.tipdlg__cardfields').open = true`);
    await click('dialog.tipdlg--rich .tipdlg__cardrow button');
    await click('dialog.tipdlg--rich .btn--primary');
    await waitFor(`${tipDlg} === null`, 'modal closed');
    await settle(500);
    await openTile('tooltip'); await click('.ws-tipedit__modal'); await waitFor(`${tipDlg} !== null`, 'modal reopened');
    must(await ev(`${tipDlg}.querySelector('.tipdlg__cardfields').hidden`), 'the removed card field is gone from the sheet (the modal lists none)');
    await click('dialog.tipdlg--rich .dialog__foot button:nth-child(3)'); await waitFor(`${tipDlg} === null`, 'closed');
  });
  await check('the modal follows Tableau\'s Edit Tooltip: toolbar, lines, behaviour checkboxes, Reset / Preview / Cancel / OK', async () => {
    await openTile('tooltip'); await click('.ws-tipedit__modal');
    await waitFor(`${tipDlg} !== null`, 'modal open');
    const r = await ev(`(() => { const d = ${tipDlg}; const t = d.querySelector('.tipdlg__bar'); return {
      title: d.querySelector('.dialog__title').textContent,
      bar: [...t.querySelectorAll('select, button')].map((x) => x.getAttribute('aria-label') || x.textContent.trim()),
      checks: [...d.querySelectorAll('.tipdlg__check')].map((x) => x.textContent.trim()),
      mode: !!d.querySelector('.tipdlg__mode'),
      foot: [...d.querySelectorAll('.dialog__foot button')].map((x) => x.textContent.trim()) }; })()`);
    must(r.title === 'Edit tooltip', 'title ' + r.title);
    for (const l of ['Font', 'Font size', 'Bold', 'Italic', 'Underline', 'Colour', 'Align left', 'Align center', 'Align right', 'Clear formatting of the selected lines']) must(r.bar.includes(l), `toolbar lacks ${l}: ${J(r.bar)}`);
    must(r.bar.includes('Insert'), 'toolbar lacks Insert');
    must(J(r.checks) === '["Show tooltips","Include command buttons"]', 'checkboxes ' + J(r.checks));
    must(r.mode, 'the mode select beside Show tooltips');
    must(J(r.foot) === '["Reset","Preview","Cancel","OK"]', 'footer ' + J(r.foot));
    await shot('tooltip-modal-empty');
  });
  await check('Insert lists the drawn fields; a line takes font, bold, underline and centre; the preview and the chart follow; OK is one commit', async () => {
    await ev(`${docEl}.focus()`);
    await b.type('Region: ');
    await click('dialog.tipdlg--rich .tipdlg__insertbtn');
    const items = await ev(`[...${tipDlg}.querySelectorAll('.tipdlg__item')].map((x) => x.textContent)`);
    must(items.some((x) => /region$/.test(x)) && items.length >= 2, 'the menu lists the drawn fields: ' + J(items));
    await ev(`[...${tipDlg}.querySelectorAll('.tipdlg__item')].find((x) => /region$/.test(x.textContent)).click()`);
    must((await ev(`${docEl}.children[0].textContent`)) === 'Region: <orders.region>', 'the field is inserted at the caret');
    await click('dialog.tipdlg--rich [aria-label="Bold"]'); await click('dialog.tipdlg--rich [aria-label="Underline"]'); await click('dialog.tipdlg--rich [aria-label="Align center"]');
    await setVal('dialog.tipdlg--rich select[aria-label="Font"]', 'ms-georgia'); await setVal('dialog.tipdlg--rich select[aria-label="Font size"]', '16');
    const pressed = await ev(`['Bold', 'Underline', 'Align center'].map((l) => ${tipDlg}.querySelector('[aria-label="' + l + '"]').getAttribute('aria-pressed'))`);
    must(pressed.join() === 'true,true,true', 'toggles show their state: ' + pressed);
    const css = await ev(`${docEl}.children[0].style.cssText`);
    must(/Georgia|font-georgia|ms-georgia/.test(css) && /text-align: center/.test(css) && /underline/.test(css), 'the line shows its own format: ' + css);
    await click('dialog.tipdlg--rich .dialog__foot button:nth-child(2)'); // Preview
    must(await ev(`!${tipDlg}.querySelector('.tipdlg__preview').hidden && ${tipDlg}.querySelector('.tipdlg__preview').innerHTML.includes('text-align:center')`), 'Preview shows the styled tooltip');
    await shot('tooltip-modal-styled');
    await click('dialog.tipdlg--rich .btn--primary');
    await waitFor(`${tipDlg} === null`, 'closed');
    await settle(600);
    const html = await tipHtml(0);
    must(html.includes('text-align:center') && html.includes('text-decoration:underline') && html.includes('font-weight:700') && html.includes('--font-ms-georgia'), 'the chart tooltip is styled: ' + html);
  });
  await check('behaviour in the modal: Show tooltips off disables the rest; commit lands on OK only; Cancel discards', async () => {
    await openTile('tooltip'); await click('.ws-tipedit__modal'); await waitFor(`${tipDlg} !== null`, 'open');
    await ev(`${tipDlg}.querySelector('.tipdlg__check input').click()`); // Show tooltips off
    must(await ev(`[...${tipDlg}.querySelectorAll('.tipdlg__check input')].slice(1).every((x) => x.disabled) && ${tipDlg}.querySelector('.tipdlg__mode').disabled`), 'the other controls are disabled');
    await click('dialog.tipdlg--rich .dialog__foot button:nth-child(3)'); // Cancel
    await waitFor(`${tipDlg} === null`, 'closed'); await settle(300);
    must(await ev(`${inst}.getOption().tooltip[0].show !== false`), 'Cancel kept tooltips on');
    await openTile('tooltip'); await click('.ws-tipedit__modal'); await waitFor(`${tipDlg} !== null`, 'open');
    await ev(`${tipDlg}.querySelector('.tipdlg__check input').click()`);
    await click('dialog.tipdlg--rich .btn--primary'); await waitFor(`${tipDlg} === null`, 'closed'); await settle(500);
    must(await ev(`${inst}.getOption().tooltip[0].show === false`), 'OK turned tooltips off');
    await openTile('tooltip'); await click('.ws-tipedit__modal'); await waitFor(`${tipDlg} !== null`, 'open');
    await click('dialog.tipdlg--rich .tipdlg__reset');
    must(await ev(`${tipDlg}.querySelector('.tipdlg__check input').checked`), 'Reset turns Show tooltips back on');
    must((await ev(`${docEl}.children[0].textContent`)) === '', 'Reset empties the text');
    await click('dialog.tipdlg--rich .btn--primary'); await waitFor(`${tipDlg} === null`, 'closed'); await settle(500);
    must(await ev(`${inst}.getOption().tooltip[0].show !== false`), 'tooltips on again');
  });
  await check('Esc closes the Insert menu first, then the modal (a draft: nothing is stored)', async () => {
    await openTile('tooltip'); await click('.ws-tipedit__modal'); await waitFor(`${tipDlg} !== null`, 'open');
    const r = await ev(`(() => { const x = ${tipDlg}.querySelector('.tipdlg__insertbtn').getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; })()`);
    await b.click(r.x, r.y); // a real press: the browser's close watcher only lets a page cancel Esc after a user activation
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await b.sleep(150);
    const st = await ev(`({ open: ${tipDlg} !== null, menuHidden: ${tipDlg}?.querySelector('.tipdlg__menu').hidden, dialogs: document.querySelectorAll('dialog[open]').length })`);
    must(st.open && st.menuHidden, 'the menu closed, the modal stayed: ' + J(st));
    await click('dialog.tipdlg--rich .dialog__foot button:nth-child(3)'); await waitFor(`${tipDlg} === null`, 'closed');
  });

  // ---- Shape -----------------------------------------------------------------------------------------------------------
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!!__t.chip('region')`, 'new worksheet');
  await settle(300);
  await dragChip('amount', `__t.zone('columns')`); await dragChip('qty', `__t.zone('columns')`);
  await settle(400);
  await chartType('Scatter');
  await dragChip('region', toolEl('Shape')); await settle(600);
  await check('the Shape flyout: Edit shapes… opens the Edit Shape dialog (Select data item / Select shape palette)', async () => {
    await openTile('shape');
    must(await ev(`!document.querySelector('.ws-memcol__toggle') && !!document.querySelector('.ws-memshape__open')`), 'a button, no inline editor');
    await waitFor(`!document.querySelector('.ws-memshape__open').disabled`, 'enabled');
    await click('.ws-memshape__open');
    await waitFor(`${shapeDlg} !== null`, 'dialog open');
    const r = await ev(`(() => { const d = ${shapeDlg}; return { title: d.querySelector('.dialog__title').textContent, panes: [...d.querySelectorAll('.shapedlg__head')].map((x) => x.textContent.trim()), members: [...d.querySelectorAll('.shapedlg__item .shapedlg__name')].map((x) => x.textContent),
      palettes: [...d.querySelectorAll('.shapedlg__palette option')].map((x) => x.textContent), shapes: d.querySelectorAll('.shapedlg__shape').length, foot: [...d.querySelectorAll('.dialog__foot button')].map((x) => x.textContent.trim()), assign: !!d.querySelector('.shapedlg__assign') }; })()`);
    must(r.title === 'Edit shape' && r.panes[0] === 'Select data item' && r.panes[1].startsWith('Select shape palette'), J(r));
    must(r.members.length === 8, 'eight members: ' + J(r.members));
    must(J(r.palettes) === '["Default","Outline","Arrows","Weather"]', J(r.palettes));
    must(r.shapes === 10 && r.assign && J(r.foot) === '["Reset","Cancel","OK"]', J(r));
    await shot('shape-dialog');
  });
  await check('a pick stages a shape for the selected member and moves on; the chart changes only on OK', async () => {
    const before = (await opt()).series.map((s) => s.symbol);
    await click('dialog.shapedlg .shapedlg__shape[data-shape="star"]');
    must(await ev(`${shapeDlg}.querySelectorAll('.shapedlg__item')[1].getAttribute('aria-selected') === 'true'`), 'the selection moved to the next member');
    must(J((await opt()).series.map((s) => s.symbol)) === J(before), 'nothing drawn before OK');
    await click('dialog.shapedlg .btn--primary'); await waitFor(`${shapeDlg} === null`, 'closed'); await settle(600);
    const after = (await opt()).series.map((s) => s.symbol);
    must(typeof after[0] === 'string' && after[0].startsWith('path://'), 'the first member wears the star path: ' + after[0]);
    must(distinct(after) === 8, 'still eight distinct symbols: ' + J(after.map((s) => String(s).slice(0, 12))));
  });
  await check('Assign palette gives every member the palette in order; Arrows, Weather and Outline draw; Reset returns the defaults', async () => {
    for (const pal of ['outline', 'arrows', 'weather']) {
      await openTile('shape'); await click('.ws-memshape__open'); await waitFor(`${shapeDlg} !== null`, 'open');
      await setVal('dialog.shapedlg .shapedlg__palette', pal);
      await click('dialog.shapedlg .shapedlg__assign');
      await shot('shape-dialog-' + pal);
      await click('dialog.shapedlg .btn--primary'); await waitFor(`${shapeDlg} === null`, 'closed'); await settle(600);
      const syms = (await opt()).series.map((s) => s.symbol);
      must(syms.every((s) => String(s).startsWith('path://')), `${pal}: every member wears a glyph path`);
      await shot('shape-chart-' + pal);
    }
    await openTile('shape'); await click('.ws-memshape__open'); await waitFor(`${shapeDlg} !== null`, 'open');
    await click('dialog.shapedlg .shapedlg__reset'); await click('dialog.shapedlg .btn--primary'); await waitFor(`${shapeDlg} === null`, 'closed'); await settle(600);
    const back = (await opt()).series.map((s) => s.symbol);
    must(distinct(back) === 8 && back[0] === 'circle', 'default symbols again: ' + J(back.map((s) => String(s).slice(0, 12))));
  });
  await check('an untouched OK on the tooltip modal changes nothing: no query, no redraw', async () => {
    await openTile('tooltip'); await click('.ws-tipedit__modal'); await waitFor(`${tipDlg} !== null`, 'open');
    const n = queries.length;
    await click('dialog.tipdlg--rich .btn--primary'); await waitFor(`${tipDlg} === null`, 'closed'); await settle(500);
    must(queries.length === n, 'an untouched OK ran a query');
  });
  await check('Cancel and Esc discard the draft', async () => {
    await openTile('shape'); await click('.ws-memshape__open'); await waitFor(`${shapeDlg} !== null`, 'open');
    await click('dialog.shapedlg .shapedlg__shape[data-shape="cross"]'); await click('dialog.shapedlg .dialog__foot button:nth-child(2)');
    await waitFor(`${shapeDlg} === null`, 'closed'); await settle(500);
    must((await opt()).series[0].symbol === 'circle', 'Cancel kept the default');
    await openTile('shape'); await click('.ws-memshape__open'); await waitFor(`${shapeDlg} !== null`, 'reopened');
    await click('dialog.shapedlg .shapedlg__shape[data-shape="cross"]');
    const r = await ev(`(() => { const x = ${shapeDlg}.querySelector('.shapedlg__palette').getBoundingClientRect(); return { x: x.left + 8, y: x.top + x.height / 2 }; })()`);
    await b.click(r.x, r.y); await b.sleep(150); // a real press, then Esc closes the open palette list, and a second Esc the dialog
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await ev(`${shapeDlg}.dispatchEvent(new Event('cancel', { cancelable: true }))`); await waitFor(`${shapeDlg} === null`, 'closed by cancel'); await settle(500);
    must((await opt()).series[0].symbol === 'circle', 'Esc kept the default');
  });

  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
