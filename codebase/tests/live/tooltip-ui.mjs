// Browser checks for the Tooltip text editor (T01-19): the real dev app (APP_URL, default http://localhost:5184) in headless
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
  const tipText = async (value) => {
    await ev(`(() => { const t = document.querySelector('.ws-tipedit__text'); t.value = ${J(value)}; t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await settle(300);
  };
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

  await check('the Tooltip tool shows the text editor with field chips and an automatic preview', async () => {
    await dragChip('region', `__t.zone('rows')`);
    await dragChip('amount', `__t.zone('columns')`);
    await settle(400);
    await ev(`${tipTool}.click()`);
    await waitFor(`!!document.querySelector('.ws-tipedit__text')`, 'tooltip editor');
    must(await ev(`document.querySelector('.ws-tipedit__preview').textContent`) === 'Automatic tooltip', 'preview');
    const chips = await ev(`[...document.querySelectorAll('.ws-tipedit__chip')].map((c) => c.textContent)`);
    must(chips.length >= 2, `chips: ${J(chips)}`);
  });

  await check('a chip inserts <field>; the live preview shows the sample value', async () => {
    await ev(`document.querySelector('.ws-tipedit__chip').click()`);
    const v = await ev(`document.querySelector('.ws-tipedit__text').value`);
    must(/^<.+>$/.test(v), `text: ${v}`);
    must(await ev(`document.querySelector('.ws-tipedit__preview b')?.textContent`) === 'APAC', 'sample is the first mark value');
  });

  await check('the chart tooltip renders the template; user HTML is escaped', async () => {
    await tipText('Region <orders.region> / <script>alert(1)</script> "q" <nope>');
    const html = await showTip();
    must(html.includes('<b>EU</b>'), `tooltip: ${html}`);
    must(!/<script/i.test(html), `raw script in tooltip: ${html}`);
    must(html.includes('&lt;script&gt;'), `escaped script missing: ${html}`);
    must(html.includes('&lt;nope&gt;'), 'unknown field is literal');
    await shot('tooltip-light.png');
  });

  await check('an empty template falls back to the automatic tooltip; over-long text is refused', async () => {
    await tipText('');
    const html = await showTip();
    must(html.includes('EU') && !html.includes('Region'), `automatic tooltip: ${html}`);
    must(await ev(`document.querySelector('.ws-tipedit__text').maxLength`) === 300, 'maxlength 300');
  });

  const tdlg = `document.querySelector('dialog.tipdlg[open]')`;
  const key = (k, mods = 0) => b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: { ArrowUp: 38, ArrowDown: 40, Escape: 27 }[k], modifiers: mods })
    .then(() => b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: { ArrowUp: 38, ArrowDown: 40, Escape: 27 }[k], modifiers: mods }));
  const setLine = (i, v) => ev(`(() => { const t = document.querySelector('.tipdlg__text[data-line="${i}"]'); t.value = ${J(v)}; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const lineTexts = () => ev(`[...document.querySelectorAll('.tipdlg__text')].map((t) => t.value)`);

  await check('Edit tooltip... opens a side-by-side modal: editor left, live preview right, first line focused', async () => {
    await tipText('<orders.region>');
    await ev(`document.querySelector('.ws-tipedit__modal').click()`);
    await waitFor(`${tdlg} !== null`, 'tooltip modal');
    must(await ev(`document.activeElement.classList.contains('tipdlg__text')`), 'first line not focused');
    const r = await ev(`(() => { const a = document.querySelector('.tipdlg__edit').getBoundingClientRect(), p = document.querySelector('.tipdlg__side').getBoundingClientRect(); return { left: a.left < p.left, sameRow: Math.abs(a.top - p.top) < 8 }; })()`);
    must(r.left && r.sameRow, `not side by side: ${J(r)}`);
    must(await ev(`document.querySelector('.tipdlg__preview b')?.textContent`) === 'APAC', 'preview uses the chart sample');
    await shot('tooltip-modal-light.png');
  });

  await check('style a line (size, bold, italic, colour), add and reorder lines; the preview follows; Apply commits them; editing the text back to one line clears the style', async () => {
    await ev(`document.querySelector('.tipdlg__add').click()`);
    await setLine(1, 'Total <orders.region>');
    await ev(`(() => { const r = document.querySelectorAll('.tipdlg__line')[0]; const sz = r.querySelector('.tipdlg__size'); sz.value = '24'; sz.dispatchEvent(new Event('change')); r.querySelector('.tipdlg__tog').click(); const c = r.querySelector('.tipdlg__colour'); c.value = 'accent'; c.dispatchEvent(new Event('change')); return true; })()`);
    let css = await ev(`document.querySelector('.tipdlg__preview span')?.getAttribute('style')`);
    must(css === 'font-size:24px;font-weight:700;color:var(--accent-ink)', `preview style: ${css}`);
    // Alt+ArrowDown on line 0 moves it below line 1, with its style
    await ev(`document.querySelector('.tipdlg__text[data-line="0"]').focus()`);
    await key('ArrowDown', 1);
    must((await lineTexts()).join('|') === 'Total <orders.region>|<orders.region>', `order: ${J(await lineTexts())}`);
    must(await ev(`document.querySelectorAll('.tipdlg__line')[1].querySelector('.tipdlg__size').value`) === '24', 'style moved with its line');
    must(await ev(`document.activeElement.dataset.line`) === '1', 'focus follows the moved line');
    await ev(`[...document.querySelectorAll('.tipdlg .dialog__foot button')].find((x) => x.textContent === 'Apply').click()`);
    await waitFor(`${tdlg} === null`, 'modal closed');
    await waitFor(`document.activeElement === document.querySelector('.ws-tipedit__modal')`, 'focus returns to Edit tooltip after Apply');
    must(await ev(`document.querySelector('.ws-tipedit__text').value`) === 'Total <orders.region>\n<orders.region>', 'panel text updated');
    const html = await showTip();
    must(html.includes('font-size:24px') && html.includes('font-weight:700') && html.includes('var(--accent-ink)'), `tooltip style: ${html}`);
    must(html.includes('<b>EU</b>'), 'values still rendered');
    await shot('tooltip-styled.png');
    await tipText('<orders.region>'); // back to one plain line: the line count changed, so the styles go
    must(await ev(`document.querySelector('.ws-tipedit__text')?.value`) === '<orders.region>', 'the text is back');
    const html2 = await showTip();
    must(!html2.includes('font-size:24px'), `the style is cleared with the line count: ${html2}`);
  });

  await check('Escape discards the draft and returns focus; Reset ("Automatic") applies an empty tooltip', async () => {
    await ev(`document.querySelector('.ws-tipedit__modal').click()`);
    await waitFor(`${tdlg} !== null`, 'tooltip modal');
    await setLine(0, 'discarded');
    await key('Escape');
    await waitFor(`${tdlg} === null`, 'closed by Escape');
    await waitFor(`document.activeElement === document.querySelector('.ws-tipedit__modal')`, 'focus returns to Edit tooltip after Escape');
    must(await ev(`document.querySelector('.ws-tipedit__text').value`) === '<orders.region>', 'Escape discarded');
    await ev(`document.querySelector('.ws-tipedit__modal').click()`);
    await waitFor(`${tdlg} !== null`, 'reopened');
    await ev(`document.querySelector('.tipdlg__reset').click()`);
    must(await ev(`document.querySelector('.tipdlg__preview').textContent`) === 'Automatic tooltip', 'reset previews automatic');
    await ev(`[...document.querySelectorAll('.tipdlg .dialog__foot button')].find((x) => x.textContent === 'Apply').click()`);
    await waitFor(`${tdlg} === null`, 'closed');
    must(await ev(`document.querySelector('.ws-tipedit__text').value`) === '', 'template cleared');
  });

  await check('field chips insert at the selected line; text over the limit blocks Apply; HTML stays escaped in the preview', async () => {
    await ev(`document.querySelector('.ws-tipedit__modal').click()`);
    await waitFor(`${tdlg} !== null`, 'modal');
    await setLine(0, '<img src=x onerror=1> ');
    must(await ev(`document.querySelector('.tipdlg__preview img') === null`), 'raw img in preview');
    await ev(`document.querySelector('.tipdlg__chip').click()`);
    must((await lineTexts())[0].endsWith('<orders.region>'), `chip: ${J(await lineTexts())}`);
    await setLine(0, 'x'.repeat(301));
    must(await ev(`[...document.querySelectorAll('.tipdlg .dialog__foot button')].find((x) => x.textContent === 'Apply').disabled`), 'Apply not blocked');
    await key('Escape');
    await waitFor(`${tdlg} === null`, 'closed');
  });

  await check('more than 12 lines from the textarea block Apply with a reason; the textarea clears styles when the line count changes', async () => {
    await tipText(Array.from({ length: 13 }, (_, i) => 'L' + i).join('\n'));
    await ev(`document.querySelector('.ws-tipedit__modal').click()`);
    await waitFor(`${tdlg} !== null`, 'modal');
    must(await ev(`[...document.querySelectorAll('.tipdlg .dialog__foot button')].find((x) => x.textContent === 'Apply').disabled`), 'Apply not blocked at 13 lines');
    must(/at most 12 lines/.test(await ev(`document.querySelector('.tipdlg__error').textContent`)), 'no reason shown');
    await ev(`document.querySelectorAll('.tipdlg__line')[12].querySelector('button[aria-label^="Remove"]').click()`);
    must(!(await ev(`[...document.querySelectorAll('.tipdlg .dialog__foot button')].find((x) => x.textContent === 'Apply').disabled`)), 'Apply still blocked at 12');
    await ev(`(() => { const r = document.querySelectorAll('.tipdlg__line')[0]; const c = r.querySelector('.tipdlg__colour'); c.value = 'ok'; c.dispatchEvent(new Event('change')); return true; })()`);
    await ev(`document.documentElement.setAttribute('data-scheme', 'dark')`);
    await b.sleep(600);
    await shot('tooltip-modal-dark.png');
    const dark = await ev(`(() => { const d = document.querySelector('.tipdlg'); return getComputedStyle(d).backgroundColor !== 'rgb(255, 255, 255)' && getComputedStyle(document.querySelector('.tipdlg__preview')).backgroundColor !== 'rgb(255, 255, 255)'; })()`);
    must(dark, 'modal keeps light colours in dark theme');
    await ev(`document.documentElement.removeAttribute('data-scheme')`);
    await ev(`[...document.querySelectorAll('.tipdlg .dialog__foot button')].find((x) => x.textContent === 'Apply').click()`);
    await waitFor(`${tdlg} === null`, 'closed');
    await tipText('only one line');
    const html = await showTip();
    must(!html.includes('var(--ok-ink)'), `style should be cleared when the line count changed: ${html}`);
  });

  const applyBtn = `[...document.querySelectorAll('.tipdlg .dialog__foot button')].find((x) => x.textContent === 'Apply')`;
  const fsel = (label, v) => ev(`(() => { const s = document.querySelector('.tipdlg select[aria-label=${J(label)}]'); if (!s) throw new Error('no select ${label}'); s.value = ${J(v)}; s.dispatchEvent(new Event('change')); return true; })()`);
  let measureName = '';
  await check('the modal offers a per-field number format for a measure; preview and chart tooltip apply it', async () => {
    await tipText('<orders.region>: <v0>'); // the mock names the measure v0
    await ev(`document.querySelector('.ws-tipedit__modal').click()`);
    await waitFor(`${tdlg} !== null`, 'modal');
    const sels = await ev(`[...document.querySelectorAll('.tipdlg__formats select')].map((s) => s.getAttribute('aria-label'))`);
    measureName = (sels.find((l) => l.startsWith('Number format for ')) ?? '').slice('Number format for '.length);
    must(measureName && sels.includes(`Decimals for ${measureName}`), `format controls: ${J(sels)}`);
    must(!sels.some((l) => l.startsWith('Date format')), 'a text group-by gets no date format');
    const before = await ev(`document.querySelector('.tipdlg__preview').textContent`);
    await fsel(`Number format for ${measureName}`, 'percent');
    await fsel(`Decimals for ${measureName}`, '1');
    const after = await ev(`document.querySelector('.tipdlg__preview').textContent`);
    must(after !== before && after.includes('%') && after.includes('.0%'), `preview: ${before} -> ${after}`);
    await shot('tooltip-formats-light.png');
    await ev(`${applyBtn}.click()`);
    await waitFor(`${tdlg} === null`, 'closed');
    const html = await showTip();
    must(html.includes('<b>EU</b>') && html.includes('2,000.0%'), `chart tooltip: ${html}`);
  });

  await check('a date group-by gets a date format; dark theme; formats are dropped when the field leaves the template', async () => {
    await ev(`(() => { const c = __t.chip('placed'); __t.drag(c, __t.zone('rows')); return true; })()`);
    await settle(500);
    await ev(`document.querySelector('.ws-tipedit__modal').click()`);
    await waitFor(`${tdlg} !== null`, 'modal');
    await ev(`document.querySelector('.tipdlg__chips button[title*="placed"]').click()`);
    const sels = await ev(`[...document.querySelectorAll('.tipdlg__formats select')].map((s) => s.getAttribute('aria-label'))`);
    must(sels.some((l) => l.startsWith('Date format for ')), `date control: ${J(sels)}`);
    await fsel(sels.find((l) => l.startsWith('Date format for ')), 'year');
    must(/\b2024\b/.test(await ev(`document.querySelector('.tipdlg__preview').textContent`)) && !(await ev(`document.querySelector('.tipdlg__preview').textContent`)).includes('2024-'), 'preview shows the year only');
    await ev(`document.documentElement.setAttribute('data-scheme', 'dark')`);
    await b.sleep(500);
    await shot('tooltip-formats-dark.png');
    await ev(`document.documentElement.removeAttribute('data-scheme')`);
    await ev(`${applyBtn}.click()`);
    await waitFor(`${tdlg} === null`, 'closed');
    await tipText('only <orders.region>');
    await ev(`document.querySelector('.ws-tipedit__modal').click()`);
    await waitFor(`${tdlg} !== null`, 'modal');
    must(await ev(`document.querySelector('.tipdlg__formats').hidden`), 'no field to format -> the section is hidden');
    await ev(`document.querySelector('.tipdlg__reset').click()`);
    await key('Escape');
    await waitFor(`${tdlg} === null`, 'closed');
  });

  await check('dark theme renders the editor', async () => {
    await tipText('<orders.region>: <orders.amount>');
    await ev(`document.documentElement.setAttribute('data-theme', 'dark')`);
    await shot('tooltip-dark.png');
  });

  await check('an empty sheet offers no stale chips; the note names the views that keep the automatic tooltip', async () => {
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    await settle(400);
    await ev(`${tipTool}.click()`);
    await waitFor(`!!document.querySelector('.ws-tipedit__text')`, 'tooltip editor on the new sheet');
    must(await ev(`document.querySelectorAll('.ws-tipedit__chip').length`) === 0, 'stale chips offered');
    must((await ev(`document.querySelector('.ws-tipedit__chips').textContent`)).includes('Add fields'), 'empty state text');
    must((await ev(`document.querySelector('.ws-tipedit__preview + .ws-shelf__note').textContent`)).includes('automatic tooltip kept on'), 'automatic-views note');
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
