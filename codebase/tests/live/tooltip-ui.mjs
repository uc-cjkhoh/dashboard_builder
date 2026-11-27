// Browser checks for the Edit tooltip editor in the Tooltip flyout (T01-19): the Tooltip flyout is Tableau's Edit Tooltip as a .ws-flyedit (toolbar, lines, Insert menu, preview, behaviour, Reset) that commits live. The real dev app (APP_URL, default http://localhost:5184) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/tooltip-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5184 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5184';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'tooltip-ui-shots');
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
      rows: Array.from({ length: n }, (_, r) => ({ keys: dims.map((d) => (d.column === 'placed' ? ['2024-03-15', '2024-04-15', '2024-05-15'][r] : REGIONS[r])), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })),
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

  const tipTool = `document.querySelector('.ws-tool[aria-label^="Tooltip"]')`;
  const tdlg = `document.querySelector('#ws-toolfly .ws-tipedit')`;
  const showTip = async () => {
    await waitFor(`!!document.querySelector('.ws-chart-canvas') && !!window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas'))`, 'chart drawn');
    for (let i = 0; i < 6; i++) {
      await ev(`window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')).dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 1 })`);
      await b.sleep(400);
      const h = await tipHtml();
      if (h) return h;
    }
    return '';
  };
  const tipHtml = () => {
    return ev(`(() => { const t = [...document.querySelectorAll('.ws-chart-canvas div')].find((d) => d.style.position === 'absolute' && d.textContent.trim() && getComputedStyle(d).opacity !== '0' && d.querySelector('b, span')); return t ? t.innerHTML : ''; })()`);
  };
  const key = (k, mods = 0) => b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: { ArrowUp: 38, ArrowDown: 40, Escape: 27 }[k], modifiers: mods })
    .then(() => b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: { ArrowUp: 38, ArrowDown: 40, Escape: 27 }[k], modifiers: mods }));
  const press = async (k, vk, extra = {}) => { await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: vk, ...extra }); await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk }); await b.sleep(80); };
  const enter = () => press('Enter', 13, { text: '\r' });
  const backspace = () => press('Backspace', 8);
  // the editor is one contenteditable surface with a block per line (no inputs): lines are read from its blocks, text goes in through real input events
  const DOC = `document.querySelector('#ws-toolfly .ws-tipedit__doc')`;
  const lineEl = (i) => `${DOC}.children[${i}]`;
  const lineTexts = () => ev(`[...${DOC}.children].map((d) => d.textContent)`);
  const selectLine = (i, collapse) => ev(`(() => { const d = ${lineEl(i)}; const r = document.createRange(); r.selectNodeContents(d); if (${J(collapse ?? false)}) r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()`);
  const setLine = async (i, v) => { await ev(`${DOC}.focus()`); await selectLine(i); if (v === '') await backspace(); else await b.type(v); await b.sleep(60); };
  const caretLine = () => ev(`(() => { let n = getSelection().anchorNode; while (n && n.parentNode !== ${DOC}) n = n.parentNode; return n ? [...${DOC}.children].indexOf(n) : -1; })()`);
  // the editor is the Tooltip flyout itself: opened by the tile, kept for as long as the flyout stays open, committing live
  const flyHidden = () => ev(`document.getElementById('ws-toolfly').hidden`);
  const openEditor = async () => {
    if (!(await ev(`${tdlg} !== null`))) { await ev(`${tipTool}.click()`); await waitFor(`${tdlg} !== null`, 'the tooltip editor in the flyout'); }
  };
  const closeEditor = async () => { await ev(`document.querySelector('#ws-toolfly .iconbtn[aria-label="Close editor"]').click()`); await waitFor(`document.getElementById('ws-toolfly').hidden`, 'flyout closed'); await settle(400); };
  const committed = async () => { await b.sleep(700); await settle(500); }; // the text group commits a moment after typing stops
  const focusLine = async (i) => { // a real press, so the editor gets focus and its selection
    const r = await ev(`(() => { const x = ${lineEl(i)}.getBoundingClientRect(); return { x: x.left + 12, y: x.top + x.height / 2 }; })()`);
    await b.click(r.x, r.y);
  };
  const tool = (label) => `document.querySelector('#ws-toolfly .ws-tipedit [aria-label=${J(label)}]')`;
  const setSel = (label, v) => ev(`(() => { const s = ${tool(label)}; if (!s) throw new Error('no control ${label}'); s.value = ${J(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const insert = async (name) => {
    await ev(`document.querySelector('.ws-tipedit__insertbtn').click()`);
    await ev(`[...document.querySelectorAll('.ws-tipedit__item')].find((x) => x.textContent === ${J(name)}).click()`);
  };

  await check('the Tooltip flyout is the editor itself (a wider .ws-flyedit): focused, the preview always shown, no modal', async () => {
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('amount', `__t.zone('columns')`);
    await settle(400);
    await ev(`${tipTool}.click()`);
    await waitFor(`${tdlg} !== null`, 'the editor in the flyout');
    must(await ev(`!!document.querySelector('#ws-toolfly .ws-flyedit.ws-tipedit') && !document.querySelector('dialog[open]') && !document.querySelector('#ws-toolfly .ws-tipedit__modal, #ws-toolfly .ws-addfield, #ws-toolfly textarea')`), 'a modal, a button or a slot is left');
    must(await ev(`document.getElementById('ws-toolfly').getBoundingClientRect().width > 400`), 'the Tooltip flyout is wider than the 320px of the other tiles');
    must(await ev(`document.activeElement.classList.contains('ws-tipedit__doc')`), 'the editor is not focused');
    must(await ev(`document.querySelector('.ws-tipedit__preview').textContent`) === 'Automatic tooltip', 'preview');
    must((await ev(`[...document.querySelectorAll('#ws-toolfly .ws-flyedit__group')].map((g) => g.dataset.section)`)).join() === 'Text,Preview,Behaviour,More', 'sections');
    await shot('tooltip-modal-light.png');
  });

  await check('Insert adds <field> at the caret; the live preview shows the sample value', async () => {
    await insert('orders.region');
    must((await lineTexts())[0] === '<orders.region>', `text: ${J(await lineTexts())}`);
    must(await ev(`document.querySelector('.ws-tipedit__preview b')?.textContent`) === 'APAC', 'sample is the first mark value');
  });

  await check('the chart tooltip renders the template; user HTML is escaped', async () => {
    await setLine(0, 'Region <orders.region> / <script>alert(1)</script> "q" <nope>');
    await committed();
    const html = await showTip();
    must(html.includes('<b>EU</b>'), `tooltip: ${html}`);
    must(!/<script/i.test(html), `raw script in tooltip: ${html}`);
    must(html.includes('&lt;script&gt;'), `escaped script missing: ${html}`);
    must(html.includes('&lt;nope&gt;'), 'unknown field is literal');
    await shot('tooltip-light.png');
  });

  await check('an empty template falls back to the automatic tooltip', async () => {
    await openEditor(); await setLine(0, ''); await committed();
    const html = await showTip();
    must(html.includes('EU') && !html.includes('Region'), `automatic tooltip: ${html}`);
  });

  await check('type two lines; style them (font, size, bold, italic, underline, colour, centre) and reorder; the preview and the lines follow; the chart follows', async () => {
    await openEditor();
    await setLine(0, '<orders.region>');
    await enter();
    await b.type('Total <orders.region>');
    must((await lineTexts()).join('|') === '<orders.region>|Total <orders.region>', `two lines: ${J(await lineTexts())}`);
    await focusLine(0);
    await setSel('Font size', '24'); await setSel('Colour', 'accent'); await setSel('Font', 'serif');
    for (const l of ['Bold', 'Italic', 'Underline', 'Align center']) await ev(`${tool(l)}.click()`);
    { const cl = await caretLine(); must(cl === 0, 'the toolbar gave the selection back to line 0: ' + cl + ' ' + J(await lineTexts())); }
    const css = await ev(`document.querySelector('.ws-tipedit__preview div')?.getAttribute('style')`);
    must(css === 'font-family:var(--font-serif);text-align:center;font-size:24px;font-weight:700;font-style:italic;text-decoration:underline;color:var(--accent-ink)', `preview style: ${css}`);
    must(await ev(`${lineEl(0)}.style.textAlign === 'center'`), 'the line shows its own alignment');
    must(await ev(`${lineEl(1)}.style.cssText === ''`), 'the other line is untouched');
    // Alt+ArrowDown on line 0 moves it below line 1, with its style
    await key('ArrowDown', 1);
    must((await lineTexts()).join('|') === 'Total <orders.region>|<orders.region>', `order: ${J(await lineTexts())}`);
    must(await ev(`${lineEl(1)}.style.fontSize === '24px'`), 'style moved with its line');
    must(await caretLine() === 1, 'the caret follows the moved line');
    must(await ev(`${tool('Font size')}.value`) === '24', 'the toolbar shows the caret line\'s size');
    await shot('tooltip-styled.png');
    await committed();
    must(await ev(`document.activeElement === ${DOC}`), 'the caret stays in the editor across the commit and its re-render');
    const html = await showTip();
    must(html.includes('font-size:24px') && html.includes('font-weight:700') && html.includes('text-decoration:underline') && html.includes('text-align:center') && html.includes('var(--accent-ink)'), `tooltip style: ${html}`);
    must(html.includes('<b>EU</b>'), 'values still rendered');
  });

  await check('the surface is a text editor: Enter continues the format, Backspace joins lines, a selection over lines is replaced, undo and redo, paste is plain text', async () => {
    await openEditor();
    await focusLine(1);
    await ev(`${tool('Clear formatting of the selected lines')}.click()`);
    must(await ev(`${lineEl(1)}.style.cssText === ''`), 'style cleared');
    await focusLine(0); await selectLine(0, true);
    await ev(`${tool('Bold')}.click()`);
    await enter();
    must((await lineTexts()).length === 3, `Enter adds a line: ${J(await lineTexts())}`);
    must(await ev(`${lineEl(1)}.style.fontWeight === '700'`), 'the new line continues the format of the one it split');
    await backspace();
    must((await lineTexts()).length === 2, `Backspace at the start of a line joins it to the one above: ${J(await lineTexts())}`);
    await ev(`(() => { const r = document.createRange(); r.setStart(${lineEl(0)}.firstChild, 2); r.setEnd(${lineEl(1)}.firstChild, 3); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()`);
    await b.type('X');
    const t = await lineTexts();
    must(t.length === 1 && t[0].startsWith('To') && t[0].includes('X'), `a selection over two lines is replaced by one edit: ${J(t)}`);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 }); await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 }); await b.sleep(80); // Ctrl+Z
    must((await lineTexts()).length === 2, `undo restores the lines: ${J(await lineTexts())}`);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'y', code: 'KeyY', windowsVirtualKeyCode: 89, modifiers: 2 }); await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'y', code: 'KeyY', windowsVirtualKeyCode: 89, modifiers: 2 }); await b.sleep(80);
    must((await lineTexts()).length === 1, `redo repeats the edit: ${J(await lineTexts())}`);
    must(await ev(`!${DOC}.querySelector('b, i, span, img, script')`), 'no markup in the surface');
    await closeEditor();
  });

  await check('typing across live commits keeps the editor in place (same node, focus, caret); undo works after a commit; a commit waits for a composition', async () => {
    const tipNow = async () => { // the chart's tooltip text for the second mark, whatever its markup
      await ev(`window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')).dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 1 })`);
      await b.sleep(500);
      return ev(`(() => { const t = [...document.querySelectorAll('.ws-chart-canvas div')].find((d) => d.style.position === 'absolute' && d.textContent.trim() && getComputedStyle(d).opacity !== '0'); return t ? t.textContent.trim() : '(none)'; })()`);
    };
    const st = () => ev(`(() => { const d = ${DOC}; const s = getSelection(); return { text: [...d.children].map((x) => x.textContent).join('|'), focused: document.activeElement === d, caret: s.anchorNode && d.contains(s.anchorNode) ? s.anchorOffset : null, same: d === window.__keepDoc }; })()`);
    await openEditor();
    await setLine(0, ''); await committed();
    await ev(`window.__keepDoc = ${DOC}`);
    let typed = '';
    for (const c of ['Hello ', 'world ', 'and <orders.region>']) { // each chunk is typed, then left alone past the commit delay: the commit re-renders the worksheet in between
      await b.type(c); typed += c; await b.sleep(650);
      const r = await st();
      must(r.same && r.focused && r.text === typed && r.caret === typed.length, `after ${J(c)}: ${J(r)}`);
    }
    must((await tipNow()) === 'Hello world and EU', 'the chart tooltip shows the committed text');
    await press('z', 90, { modifiers: 2 }); await b.sleep(700);
    must((await st()).text === 'Hello world ' && (await tipNow()) === 'Hello world', 'undo after a commit steps back one edit, and that is committed too');
    await ev(`${DOC}.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))`);
    await b.type('X'); await b.sleep(700);
    must((await tipNow()) === 'Hello world', 'nothing is committed while a composition is open');
    await ev(`${DOC}.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))`); await b.sleep(700);
    must((await tipNow()) === 'Hello world X', 'the composition is committed when it ends');
    must((await st()).same, 'the editor node survived every commit');
  });

  await check('Escape commits the last typing and closes the flyout; Reset asks once and applies an empty tooltip', async () => {
    await openEditor();
    await setLine(0, 'kept by Escape');
    await key('Escape'); // at once: inside the debounce, so the close itself has to commit it
    await waitFor(`document.getElementById('ws-toolfly').hidden`, 'closed by Escape');
    await settle(500);
    must((await showTip()).includes('kept by Escape'), 'Escape committed the typing');
    await openEditor();
    must((await lineTexts())[0] === 'kept by Escape', 'the committed text is what reopens');
    await ev(`document.querySelector('.ws-tipedit__reset').click()`);
    await waitFor(`!!(${confirmOpen})`, 'Reset asks first');
    await ev(`[...(${confirmOpen}).querySelectorAll('button')].find((x) => x.textContent === 'Reset').click()`);
    await waitFor(`!(${confirmOpen})`, 'confirm closed'); await settle(500);
    must(await ev(`document.querySelector('.ws-tipedit__preview').textContent`) === 'Automatic tooltip', 'reset previews automatic');
    must((await lineTexts()).join('|') === '', 'template cleared');
    must(!(await showTip()).includes('kept by Escape'), 'the chart is automatic again');
    await closeEditor();
  });

  await check('text over the limit and more than 12 lines are never committed (the error says why); closing with one reverts it; HTML stays escaped in the preview', async () => {
    await openEditor();
    await setLine(0, '<img src=x onerror=1> ');
    must(await ev(`document.querySelector('.ws-tipedit__preview img') === null`), 'raw img in preview');
    await setLine(0, 'x'.repeat(301));
    await committed();
    must(/at most 300/.test(await ev(`document.querySelector('.ws-tipedit__error').textContent`)), 'no reason shown');
    must(!(await showTip()).includes('xxxxxxxx'), 'an over-long draft was committed');
    await setLine(0, 'a' + '\n'.repeat(12));
    await committed();
    must((await lineTexts()).length === 13, 'thirteen lines');
    must(/at most 12 lines/.test(await ev(`document.querySelector('.ws-tipedit__error').textContent`)), 'the reason for 13 lines');
    await ev(`document.documentElement.setAttribute('data-scheme', 'dark')`);
    await b.sleep(600);
    await shot('tooltip-modal-dark.png');
    must(await ev(`getComputedStyle(${DOC}).backgroundColor !== 'rgb(255, 255, 255)'`), 'the editor keeps light colours in dark theme');
    await ev(`document.documentElement.removeAttribute('data-scheme')`);
    await closeEditor();
    must(/not saved/.test(await toastText()), `closing an invalid draft says so: ${await toastText()}`);
    await openEditor();
    must((await lineTexts())[0] === '', `the invalid draft was reverted: ${J(await lineTexts())}`);
    await closeEditor();
  });

  const fsel = (label, v) => ev(`(() => { const s = document.querySelector('.ws-tipedit select[aria-label=${J(label)}]'); if (!s) throw new Error('no select ${label}'); s.value = ${J(v)}; s.dispatchEvent(new Event('change')); return true; })()`);
  let measureName = '';
  await check('the editor offers a per-field number format for a measure; preview and chart tooltip apply it', async () => {
    await openEditor(); await setLine(0, '<orders.region>: <v0>'); // the mock names the measure v0
    await ev(`document.querySelector('.ws-tipedit__formats').open = true`);
    const sels = await ev(`[...document.querySelectorAll('.ws-tipedit__formats select')].map((s) => s.getAttribute('aria-label'))`);
    measureName = (sels.find((l) => l.startsWith('Number format for ')) ?? '').slice('Number format for '.length);
    must(measureName && sels.includes(`Decimals for ${measureName}`), `format controls: ${J(sels)}`);
    must(!sels.some((l) => l.startsWith('Date format')), 'a text group-by gets no date format');
    const before = await ev(`document.querySelector('.ws-tipedit__preview').textContent`);
    await fsel(`Number format for ${measureName}`, 'percent');
    await fsel(`Decimals for ${measureName}`, '1'); // a choice from a list commits at once
    const after = await ev(`document.querySelector('.ws-tipedit__preview').textContent`);
    must(after !== before && after.includes('%') && after.includes('.0%'), `preview: ${before} -> ${after}`);
    await shot('tooltip-formats-light.png');
    await committed();
    const html = await showTip();
    must(html.includes('<b>EU</b>') && html.includes('2,000.0%'), `chart tooltip: ${html}`);
  });

  await check('a date group-by gets a date format; formats are dropped when the field leaves the template', async () => {
    await ev(`(() => { const c = __t.chip('placed'); __t.drag(c, __t.zone('rows')); return true; })()`);
    await settle(500);
    await openEditor();
    await insert('orders.placed');
    await ev(`document.querySelector('.ws-tipedit__formats').open = true`);
    const sels = await ev(`[...document.querySelectorAll('.ws-tipedit__formats select')].map((s) => s.getAttribute('aria-label'))`);
    must(sels.some((l) => l.startsWith('Date format for ')), `date control: ${J(sels)}`);
    await fsel(sels.find((l) => l.startsWith('Date format for ')), 'year');
    const txt = await ev(`document.querySelector('.ws-tipedit__preview').textContent`);
    must(/\b2024\b/.test(txt) && !txt.includes('2024-'), 'preview shows the year only: ' + txt);
    await shot('tooltip-formats-dark.png');
    await committed();
    await openEditor(); await setLine(0, 'only <orders.region>');
    must(await ev(`document.querySelector('.ws-tipedit__formats').hidden`), 'no field to format -> the section is hidden');
    await ev(`document.querySelector('.ws-tipedit__reset').click()`);
    await closeEditor();
  });

  await check('an empty sheet offers no stale fields in Insert', async () => {
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    await settle(400);
    await openEditor();
    await ev(`document.querySelector('.ws-tipedit__insertbtn').click()`);
    must(await ev(`document.querySelectorAll('.ws-tipedit__item').length`) === 0, 'stale fields offered');
    must((await ev(`document.querySelector('.ws-tipedit__menu').textContent`)).includes('Add fields'), 'empty state text');
    await key('Escape'); await key('Escape');
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
