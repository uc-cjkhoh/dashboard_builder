// Browser checks for the Edit tooltip modal (T01-19): the Tooltip flyout is one button; the modal is Tableau's Edit Tooltip (toolbar, lines, Insert menu, behaviour, Reset / Preview / Cancel / OK). The real dev app (APP_URL, default http://localhost:5184) in headless
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
  const tdlg = `document.querySelector('dialog.tipdlg--rich[open]')`;
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
  const foot = (label) => `[...document.querySelectorAll('.tipdlg .dialog__foot button')].find((x) => x.textContent === ${J(label)})`;
  const openModal = async () => {
    if (await ev(`${tdlg} !== null`)) { await ev(`${foot('Cancel')}.click()`); await waitFor(`${tdlg} === null`, 'a stale modal closed'); } // a failed check never leaves one open for the next
    if (!(await ev(`!!document.querySelector('#ws-toolfly .ws-tipedit__modal')`))) { await ev(`${tipTool}.click()`); await waitFor(`!!document.querySelector('#ws-toolfly .ws-tipedit__modal')`, 'Edit tooltip button'); }
    await ev(`document.querySelector('#ws-toolfly .ws-tipedit__modal').click()`);
    await waitFor(`${tdlg} !== null`, 'tooltip modal');
  };
  const ok = async () => { await ev(`${foot('OK')}.click()`); await waitFor(`${tdlg} === null`, 'modal closed'); await settle(500); };
  const setLine = (i, v) => ev(`(() => { const t = document.querySelector('.tipdlg__text[data-line="${i}"]'); t.value = ${J(v)}; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const lineTexts = () => ev(`[...document.querySelectorAll('.tipdlg__text')].map((t) => t.value)`);
  const focusLine = async (i) => { // a real press: a script's focus() does not fire the focus event while the page itself is unfocused
    const r = await ev(`(() => { const x = document.querySelector('.tipdlg__text[data-line="${i}"]').getBoundingClientRect(); return { x: x.left + 12, y: x.top + x.height / 2 }; })()`);
    await b.click(r.x, r.y);
  };
  const preview = async () => { if (await ev(`document.querySelector('.tipdlg__preview').hidden`)) await ev(`${foot('Preview')}.click()`); };
  const tool = (label) => `document.querySelector('.tipdlg [aria-label=${J(label)}]')`;
  const setSel = (label, v) => ev(`(() => { const s = ${tool(label)}; if (!s) throw new Error('no control ${label}'); s.value = ${J(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const insert = async (name) => {
    await ev(`document.querySelector('.tipdlg__insertbtn').click()`);
    await ev(`[...document.querySelectorAll('.tipdlg__item')].find((x) => x.textContent === ${J(name)}).click()`);
  };

  await check('the Tooltip flyout is one button; the modal opens with the first line focused and an automatic preview', async () => {
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('amount', `__t.zone('columns')`);
    await settle(400);
    await ev(`${tipTool}.click()`);
    await waitFor(`!!document.querySelector('#ws-toolfly .ws-tipedit__modal')`, 'Edit tooltip button');
    must(await ev(`!document.querySelector('#ws-toolfly textarea, #ws-toolfly .ws-addfield, #ws-toolfly .ws-tipedit__chip, #ws-toolfly .ws-tipedit__preview')`), 'only the button');
    await openModal();
    must(await ev(`document.activeElement.classList.contains('tipdlg__text')`), 'first line not focused');
    await preview();
    must(await ev(`document.querySelector('.tipdlg__preview').textContent`) === 'Automatic tooltip', 'preview');
    await shot('tooltip-modal-light.png');
  });

  await check('Insert adds <field> at the caret; the live preview shows the sample value', async () => {
    await insert('orders.region');
    must((await lineTexts())[0] === '<orders.region>', `text: ${J(await lineTexts())}`);
    must(await ev(`document.querySelector('.tipdlg__preview b')?.textContent`) === 'APAC', 'sample is the first mark value');
  });

  await check('the chart tooltip renders the template; user HTML is escaped', async () => {
    await setLine(0, 'Region <orders.region> / <script>alert(1)</script> "q" <nope>');
    await ok();
    const html = await showTip();
    must(html.includes('<b>EU</b>'), `tooltip: ${html}`);
    must(!/<script/i.test(html), `raw script in tooltip: ${html}`);
    must(html.includes('&lt;script&gt;'), `escaped script missing: ${html}`);
    must(html.includes('&lt;nope&gt;'), 'unknown field is literal');
    await shot('tooltip-light.png');
  });

  await check('an empty template falls back to the automatic tooltip', async () => {
    await openModal(); await setLine(0, ''); await ok();
    const html = await showTip();
    must(html.includes('EU') && !html.includes('Region'), `automatic tooltip: ${html}`);
  });

  await check('style a line (font, size, bold, italic, underline, colour, centre), add and reorder lines; the preview and the line follow; OK commits them', async () => {
    await openModal();
    await setLine(0, '<orders.region>');
    await ev(`document.querySelector('.tipdlg__add').click()`);
    await setLine(1, 'Total <orders.region>');
    await focusLine(0);
    await setSel('Font size', '24'); await setSel('Colour', 'accent'); await setSel('Font', 'serif');
    for (const l of ['Bold', 'Italic', 'Underline', 'Align center']) await ev(`${tool(l)}.click()`);
    await preview();
    const css = await ev(`document.querySelector('.tipdlg__preview div')?.getAttribute('style')`);
    must(css === 'font-family:var(--font-serif);text-align:center;font-size:24px;font-weight:700;font-style:italic;text-decoration:underline;color:var(--accent-ink)', `preview style: ${css}`);
    must(await ev(`document.querySelector('.tipdlg__text[data-line="0"]').style.textAlign === 'center'`), 'the line shows its own alignment');
    // Alt+ArrowDown on line 0 moves it below line 1, with its style
    await key('ArrowDown', 1);
    must((await lineTexts()).join('|') === 'Total <orders.region>|<orders.region>', `order: ${J(await lineTexts())}`);
    must(await ev(`document.querySelector('.tipdlg__text[data-line="1"]').style.fontSize === '24px'`), 'style moved with its line');
    must(await ev(`document.activeElement.dataset.line`) === '1', 'focus follows the moved line');
    must(await ev(`${tool('Font size')}.value`) === '24', 'the toolbar shows the focused line\'s size');
    await shot('tooltip-styled.png');
    await ok();
    await waitFor(`document.activeElement === document.querySelector('.ws-tipedit__modal')`, 'focus returns to Edit tooltip after OK');
    const html = await showTip();
    must(html.includes('font-size:24px') && html.includes('font-weight:700') && html.includes('text-decoration:underline') && html.includes('text-align:center') && html.includes('var(--accent-ink)'), `tooltip style: ${html}`);
    must(html.includes('<b>EU</b>'), 'values still rendered');
  });

  await check('Clear formatting empties the line\'s style; Backspace on an empty line removes it; Enter adds one below', async () => {
    await openModal();
    await focusLine(1);
    await ev(`${tool('Clear formatting of the selected line')}.click()`);
    must(await ev(`document.querySelector('.tipdlg__text[data-line="1"]').style.cssText === ''`), 'style cleared');
    await ev(`(() => { const t = document.querySelector('.tipdlg__text[data-line="1"]'); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
    must((await lineTexts()).length === 3, `Enter adds a line: ${J(await lineTexts())}`);
    await ev(`document.querySelector('.tipdlg__text[data-line="2"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))`);
    must((await lineTexts()).length === 2, `Backspace removes the empty line: ${J(await lineTexts())}`);
    await key('Escape'); await waitFor(`${tdlg} === null`, 'closed');
  });

  await check('Escape discards the draft and returns focus; Reset applies an empty tooltip', async () => {
    await openModal();
    await setLine(0, 'discarded');
    await key('Escape');
    await waitFor(`${tdlg} === null`, 'closed by Escape');
    await waitFor(`document.activeElement === document.querySelector('.ws-tipedit__modal')`, 'focus returns to Edit tooltip after Escape');
    await openModal();
    must((await lineTexts())[0] !== 'discarded', 'Escape discarded');
    await ev(`document.querySelector('.tipdlg__reset').click()`);
    await preview();
    must(await ev(`document.querySelector('.tipdlg__preview').textContent`) === 'Automatic tooltip', 'reset previews automatic');
    await ok();
    await openModal();
    must((await lineTexts()).join('|') === '', 'template cleared');
    await key('Escape'); await waitFor(`${tdlg} === null`, 'closed');
  });

  await check('text over the limit and more than 12 lines block OK with a reason; HTML stays escaped in the preview', async () => {
    await openModal();
    await setLine(0, '<img src=x onerror=1> ');
    await preview();
    must(await ev(`document.querySelector('.tipdlg__preview img') === null`), 'raw img in preview');
    await setLine(0, 'x'.repeat(301));
    must(await ev(`${foot('OK')}.disabled`), 'OK not blocked');
    must(/at most 300/.test(await ev(`document.querySelector('.tipdlg__error').textContent`)), 'no reason shown');
    await setLine(0, 'a');
    for (let i = 0; i < 12; i++) await ev(`document.querySelector('.tipdlg__add').click()`);
    must(await ev(`document.querySelector('.tipdlg__add').disabled`), 'Add line stops at 12');
    await ev(`document.querySelectorAll('.tipdlg__line').length === 12 || (() => { throw new Error('lines ' + document.querySelectorAll('.tipdlg__line').length); })()`);
    await ev(`document.documentElement.setAttribute('data-scheme', 'dark')`);
    await b.sleep(600);
    await shot('tooltip-modal-dark.png');
    must(await ev(`getComputedStyle(document.querySelector('.tipdlg')).backgroundColor !== 'rgb(255, 255, 255)'`), 'modal keeps light colours in dark theme');
    await ev(`document.documentElement.removeAttribute('data-scheme')`);
    await key('Escape'); await waitFor(`${tdlg} === null`, 'closed');
  });

  const fsel = (label, v) => ev(`(() => { const s = document.querySelector('.tipdlg select[aria-label=${J(label)}]'); if (!s) throw new Error('no select ${label}'); s.value = ${J(v)}; s.dispatchEvent(new Event('change')); return true; })()`);
  let measureName = '';
  await check('the modal offers a per-field number format for a measure; preview and chart tooltip apply it', async () => {
    await openModal(); await setLine(0, '<orders.region>: <v0>'); // the mock names the measure v0
    await ev(`document.querySelector('.tipdlg__formats').open = true`);
    const sels = await ev(`[...document.querySelectorAll('.tipdlg__formats select')].map((s) => s.getAttribute('aria-label'))`);
    measureName = (sels.find((l) => l.startsWith('Number format for ')) ?? '').slice('Number format for '.length);
    must(measureName && sels.includes(`Decimals for ${measureName}`), `format controls: ${J(sels)}`);
    must(!sels.some((l) => l.startsWith('Date format')), 'a text group-by gets no date format');
    await preview();
    const before = await ev(`document.querySelector('.tipdlg__preview').textContent`);
    await fsel(`Number format for ${measureName}`, 'percent');
    await fsel(`Decimals for ${measureName}`, '1');
    const after = await ev(`document.querySelector('.tipdlg__preview').textContent`);
    must(after !== before && after.includes('%') && after.includes('.0%'), `preview: ${before} -> ${after}`);
    await shot('tooltip-formats-light.png');
    await ok();
    const html = await showTip();
    must(html.includes('<b>EU</b>') && html.includes('2,000.0%'), `chart tooltip: ${html}`);
  });

  await check('a date group-by gets a date format; formats are dropped when the field leaves the template', async () => {
    await ev(`(() => { const c = __t.chip('placed'); __t.drag(c, __t.zone('rows')); return true; })()`);
    await settle(500);
    await openModal();
    await insert('orders.placed');
    await ev(`document.querySelector('.tipdlg__formats').open = true`);
    const sels = await ev(`[...document.querySelectorAll('.tipdlg__formats select')].map((s) => s.getAttribute('aria-label'))`);
    must(sels.some((l) => l.startsWith('Date format for ')), `date control: ${J(sels)}`);
    await fsel(sels.find((l) => l.startsWith('Date format for ')), 'year');
    await preview();
    const txt = await ev(`document.querySelector('.tipdlg__preview').textContent`);
    must(/\b2024\b/.test(txt) && !txt.includes('2024-'), 'preview shows the year only: ' + txt);
    await shot('tooltip-formats-dark.png');
    await ok();
    await openModal(); await setLine(0, 'only <orders.region>');
    must(await ev(`document.querySelector('.tipdlg__formats').hidden`), 'no field to format -> the section is hidden');
    await ev(`document.querySelector('.tipdlg__reset').click()`);
    await key('Escape'); await waitFor(`${tdlg} === null`, 'closed');
  });

  await check('an empty sheet offers no stale fields in Insert', async () => {
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    await settle(400);
    await openModal();
    await ev(`document.querySelector('.tipdlg__insertbtn').click()`);
    must(await ev(`document.querySelectorAll('.tipdlg__item').length`) === 0, 'stale fields offered');
    must((await ev(`document.querySelector('.tipdlg__menu').textContent`)).includes('Add fields'), 'empty state text');
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
