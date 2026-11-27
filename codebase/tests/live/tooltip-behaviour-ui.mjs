// Browser checks for the tooltip behaviour in the Edit tooltip modal (Show tooltips, Include command buttons, the mode; D151 moved them out of Format, where Group dates stays, and D171 moved them into the modal): the controls and their gates, a REAL mouse hovering a bar, line,
// point and pie mark (the tooltip is enterable: the pointer walks onto it, the buttons run Keep only / Exclude / View data, and nothing is left stuck after a hide), the
// Responsive pin (a click pins the tooltip until Esc, an empty-chart click, the mark again or a command; a redraw never re-opens it), Show tooltips off, the PNG / SVG
// export (never has a tooltip in it) and screenshots (run once with SCHEME=dark for the dark set). The real dev app in headless Chromium, driven over the DevTools
// protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock: nothing reaches a ClickHouse. Run:  node tests/live/tooltip-behaviour-ui.mjs
//   (start the app first: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5267 ; stop it with fuser -k 5267/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN, SCHEME=dark.
import { launch } from './cdp.mjs';
import { PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5267';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'tooltip-behaviour-ui-shots');
mkdirSync(SHOTS, { recursive: true });
const SCHEME = process.env.SCHEME === 'dark' ? 'dark' : 'light'; // SCHEME=dark loads the page in the dark scheme (set before load)

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['placed', 'DateTime', 'temporal']],
  customers: [['country', 'String', 'text']],
};
const REGIONS = ['APAC', 'EU', 'US', '<b onclick=x>'];
const queries = [], rowReqs = [];  // every /api/query and /api/rows body, in order
const ROWS = { columns: [{ name: 'amount', type: 'Float64' }, { name: 'region', type: 'String' }], rows: [['10', 'EU']], truncated: false, limit: 100, columnsTruncated: false };
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders', 'customers'] };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (/\/columns\/\w+\/distinct/.test(path)) return { json: REGIONS };
  if (path === '/api/rows') { rowReqs.push(body); return { json: ROWS }; }
  if (path === '/api/query') {
    queries.push(body);
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    const filt = (body.filters ?? []).find((f) => f.column === 'region');
    const members = !dims.length ? [null] : filt && filt.op === '=' ? REGIONS.filter((r) => r === filt.value) : filt && (filt.op === '!=' || filt.op === '<>') ? REGIONS.filter((r) => r !== filt.value) : REGIONS;
    const dated = dims[0]?.column === 'placed'; // a date axis: the server groups it by the asked grain (Auto -> month) unless Group dates is Exact, and says which key it grouped
    const MONTHS = ['2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01'];
    return { json: {
      rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: dated ? MONTHS.map((m, r) => ({ keys: dims.map(() => m), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i * 3) }))
        : members.map((mem, r) => ({ keys: dims.map(() => mem), values: (body.measures ?? []).map((_, i) => 10 * (REGIONS.indexOf(mem) + 1) + i * 3) })),
      ...(dated && body.dateBucket ? { bucket: { key: 0, grain: body.dateBucket === 'auto' ? 'month' : body.dateBucket } } : {}),
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


  const shot = async (name) => { try { const t = await ev(`document.documentElement.getAttribute('data-scheme') || 'light'`); writeFileSync(join(SHOTS, `${name}-${t}.png`), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } };
  const fmtTool = `document.querySelector('.ws-viewbar__btn[aria-label="Format"]')`;
  const fmtField = (label) => `[...document.querySelectorAll('.ws-fmt-field')].find((l) => l.textContent.includes(${J(label)}))`;
  const inst = `window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas'))`;
  const chartType = async (name) => {
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === ${J(name)}).click()`);
    await settle(500);
  };
  const newSheet = async () => {
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden && !!__t.chip('region') && !document.querySelector('.ws-shelf--columns .ws-pill')`, 'a fresh worksheet');
    await ev(`document.documentElement.${SCHEME === 'dark' ? "setAttribute('data-scheme', 'dark')" : "removeAttribute('data-scheme')"}`);
  };
  // Show tooltips / Command buttons / Tooltip mode live in the Edit tooltip modal (the Tooltip flyout is its button alone); everything else (Number, Group dates ...) stays in Format.
  // Reading a control opens the modal and cancels it; changing one opens it, changes it and presses OK (one commit). The modal covers Format, so each helper closes the other first.
  const TIP_LABELS = ['Show tooltips', 'Command buttons', 'Tooltip mode'];
  const tipTool = `document.querySelector('.ws-tool[data-tool="tooltip"]')`;
  const tipDlg = `document.querySelector('dialog.tipdlg--rich[open]')`;
  const formatOpen = () => ev(`!!(${fmtField('Number')})`);
  const modalOpen = () => ev(`${tipDlg} !== null`);
  const flyOpen = () => ev(`!!document.querySelector('#ws-toolfly:not([hidden]) .ws-toolpanel')`);
  const openFormat = async () => { if (await modalOpen()) await closeModal(false); if (!(await formatOpen())) await ev(`${fmtTool}.click()`); await waitFor(`!!(${fmtField('Number')})`, 'format panel open'); };
  const closeModal = async (apply) => {
    await ev(`document.querySelector('dialog.tipdlg--rich ${apply ? '.btn--primary' : '.dialog__foot button:nth-child(3)'}').click()`);
    await waitFor(`${tipDlg} === null`, 'modal closed'); await b.sleep(80);
  };
  const openTip = async () => { // tolerant: a chart with no tooltip controls (a table) still opens the modal, and the caller then reads null
    if (await modalOpen()) return;
    if (await formatOpen()) await ev(`${fmtTool}.click()`);
    if (!(await flyOpen())) await ev(`${tipTool}.click()`);
    await waitFor(`!!document.querySelector('#ws-toolfly .ws-tipedit__modal')`, 'Edit tooltip button');
    await ev(`document.querySelector('#ws-toolfly .ws-tipedit__modal').click()`);
    await waitFor(`${tipDlg} !== null`, 'Edit tooltip modal');
  };
  const ensure = async (label) => { if (TIP_LABELS.includes(label)) await openTip(); else await openFormat(); };
  const closeFormat = async () => { // every panel: a snapshot / a hover needs the bare chart (a flyout floats over the chart's corner)
    if (await modalOpen()) await closeModal(false);
    if (await formatOpen()) await ev(`${fmtTool}.click()`);
    if (await flyOpen()) await ev(`document.querySelector('#ws-toolfly .iconbtn[aria-label="Close editor"]')?.click()`);
    await settle(300); };
  const tipCtl = (label) => label === 'Tooltip mode' ? `${tipDlg}?.querySelector('.tipdlg__mode')`
    : `[...(${tipDlg}?.querySelectorAll('.tipdlg__check') ?? [])].find((l) => l.textContent.toLowerCase().includes(${J(label === 'Command buttons' ? 'command buttons' : label.toLowerCase())}))?.querySelector('input')`;
  const ctl = (label) => TIP_LABELS.includes(label) ? tipCtl(label) : `(${fmtField(label)})?.querySelector('input, select')`;
  const state = async (label) => { await ensure(label); const r = await ev(`(() => { const c = ${ctl(label)}; return c ? { checked: c.checked, value: c.value, disabled: c.disabled, title: c.title } : null; })()`); if (TIP_LABELS.includes(label)) await closeModal(false); return r; };
  const flip = async (label) => { await ensure(label); await ev(`${ctl(label)}.click()`); if (TIP_LABELS.includes(label)) await closeModal(true); await settle(400); };
  const pick = async (label, v) => { await ensure(label); await ev(`(() => { const s = ${ctl(label)}; s.value = ${J(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); if (TIP_LABELS.includes(label)) await closeModal(true); await settle(400); };

  // real mouse: positions of marks read from the live chart, moves and clicks through Input.dispatchMouseEvent
  const mv = (x, y) => b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  const markXY = (k, si = 0) => ev(`(() => {
    const host = document.querySelector('.ws-chart-canvas'), hr = host.getBoundingClientRect();
    const el = ${inst}.getModel().getSeriesByIndex(${si}).getData().getItemGraphicEl(${k});
    let p;
    if (el.shape && el.shape.startAngle !== undefined) { const a = (el.shape.startAngle + el.shape.endAngle) / 2, r = (el.shape.r + (el.shape.r0 || 0)) / 2; p = [el.shape.cx + Math.cos(a) * r, el.shape.cy + Math.sin(a) * r]; }
    else { const r = el.getBoundingRect(); p = [r.x + r.width / 2, r.y + r.height / 2]; }
    const m = el.getComputedTransform && el.getComputedTransform(); if (m) p = [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
    return { x: hr.x + p[0], y: hr.y + p[1] }; })()`);
  const tip = () => ev(`(() => {
    const host = document.querySelector('.ws-chart-canvas');
    const t = [...host.children].find((c) => c.tagName === 'DIV' && !c.querySelector('svg, canvas') && c.innerText.trim());
    if (!t) return null;
    const r = t.getBoundingClientRect(), cs = getComputedStyle(t);
    return { text: t.innerText, html: t.innerHTML, x: r.x, y: r.y, w: r.width, h: r.height, shown: cs.visibility !== 'hidden' && cs.opacity !== '0' && cs.display !== 'none', cls: t.className, buttons: [...t.querySelectorAll('button')].map((x) => x.textContent) }; })()`);
  const shown = async () => { const t = await tip(); return t && t.shown ? t : null; };
  const hoverMark = async (k, si = 0) => { const p = await markXY(k, si); await mv(p.x - 30, p.y); await mv(p.x, p.y); await b.sleep(250); return p; };
  const walkTo = async (from, to, steps = 14) => { for (let i = 1; i <= steps; i++) { await mv(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps); await b.sleep(25); } };
  const away = async () => { await mv(5, 5); await b.sleep(900); }; // outside the chart, past the hide delay
  const btnXY = (label) => ev(`(() => { const x = [...document.querySelectorAll('.ws-chart-canvas button')].find((e) => e.textContent === ${J(label)}); if (!x) return null; const r = x.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const chip = () => ev(`(() => { const c = document.querySelector('.ws-select'); return c ? { text: c.querySelector('.ws-select__label')?.textContent, active: [...c.querySelectorAll('.ws-select__btn.is-active')].map((x) => x.textContent) } : null; })()`);
  const clearSel = async () => { await ev(`document.querySelector('.ws-select .iconbtn[aria-label="Clear selection"]')?.click()`); await settle(400); };
  const clickMark = async (k, si = 0) => { const p = await markXY(k, si); await mv(p.x, p.y); await b.click(p.x, p.y); await settle(500); await b.sleep(200); return p; };
  const enterTip = async (from) => { // from the mark onto the tooltip, as a person would
    const t = await shown(); must(t, 'a tooltip to reach'); await walkTo(from, { x: t.x + 12, y: t.y + 12 }); await b.sleep(700); // longer than the hide delay
    return shown();
  };
  const clickBtn = async (label) => { const p = await btnXY(label); must(p, `a ${label} button`); await b.click(p.x, p.y); await settle(600); await b.sleep(200); };
  const evilIdx = REGIONS.indexOf('<b onclick=x>');

  await newSheet();
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(500);
  await chartType('Bar'); await openFormat();

  await check('Default: Show tooltips on, Command buttons off, Tooltip mode disabled with its reason; a hover shows today\'s tooltip with no buttons and nothing is stored', async () => {
    const s = await state('Show tooltips'), c = await state('Command buttons'), m = await state('Tooltip mode');
    must(s && s.checked === true && !s.disabled, J(s));
    must(c && c.checked === false && !c.disabled, J(c));
    must(m && m.value === 'responsive' && m.disabled && /command buttons/i.test(m.title), J(m));
    await closeFormat();
    await hoverMark(1);
    const t = await shown();
    must(t && /EU/.test(t.text) && t.buttons.length === 0, 'plain tooltip: ' + J(t));
    must(!/ws-tip/.test(t.cls), 'not the enterable tooltip: ' + t.cls);
    await away();
    must(!(await shown()), 'hidden after leaving');
  });

  await check('Show tooltips off: no hover tooltip on bar, line, point and pie; the marks still select and the chart is otherwise unchanged', async () => {
    await openFormat(); await flip('Show tooltips'); await closeFormat();
    must((await ev(`${inst}.getOption().tooltip[0].show`)) === false, 'tooltip off in the option');
    for (const [type, n] of [['Bar', 4], ['Line', 4], ['Pie', 4]]) {
      if (type !== 'Bar') await chartType(type);
      await settle(300);
      const p = await hoverMark(1);
      must(!(await shown()), `${type}: no tooltip on hover`);
      await mv(p.x + 2, p.y + 2); await b.sleep(300);
      must(!(await shown()), `${type}: still none`);
    }
    await chartType('Bar');
    await clickMark(1);
    const c = await chip();
    must(c && /EU/.test(c.text), 'a click still selects: ' + J(c));
    must(!(await shown()), 'and shows no tooltip');
    await clearSel();
    const nodes = await ev(`document.querySelectorAll('#ws-chart svg path, #ws-chart svg rect').length`);
    must(nodes > 4, 'the marks are drawn: ' + nodes);
    await shot('tooltips-off');
    await openFormat(); await flip('Show tooltips'); await closeFormat();
    await hoverMark(1); must(await shown(), 'back on: a tooltip again'); await away();
  });

  await check('Command buttons are gated: disabled with the reason where the chart has no selecting marks (heatmap, table) and turned on here', async () => {
    await openFormat();
    await flip('Command buttons');
    const c = await state('Command buttons'), m = await state('Tooltip mode');
    must(c.checked === true && !c.disabled, J(c));
    must(!m.disabled && m.value === 'responsive', J(m));
    await ensure('Tooltip mode');
    must(await ev(`!!${ctl('Tooltip mode')}.querySelector('option[value=hover]')`), 'On hover offered');
    await closeFormat();
  });

  // ---- On hover ---------------------------------------------------------------------------------------------------------
  await check('On hover (bar): the hover tooltip is enterable; the pointer walks onto it and it stays; Keep only applies the selection; the tooltip is gone', async () => {
    await openFormat(); await pick('Tooltip mode', 'hover'); await closeFormat();
    const p = await hoverMark(1);
    const t0 = await shown();
    must(t0 && /ws-tip/.test(t0.cls) && J(t0.buttons) === J(['Keep only', 'Exclude', 'View data']), 'buttons in the hover tooltip: ' + J(t0 && [t0.cls, t0.buttons]));
    const t = await enterTip(p);
    must(t && /EU/.test(t.text) && t.buttons.length === 3, 'after walking onto it (past the hide delay) it is still EU\'s: ' + J(t && t.text));
    await shot('hover-bar-buttons');
    const q0 = queries.length;
    await clickBtn('Keep only');
    const c = await chip();
    must(c && /region = EU/.test(c.text) && J(c.active) === J(['Keep only']), 'selection with Keep only: ' + J(c));
    must(!(await shown()), 'the tooltip is dismissed');
    must(queries.length > q0 && J(lastQuery()).includes('"EU"'), 'the view re-queried for EU: ' + J(lastQuery()).slice(0, 300));
    await clearSel(); await settle(500);
  });
  await check('On hover: Exclude, and View data (the rows of that mark, selection untouched)', async () => {
    let p = await hoverMark(2);
    await enterTip(p); await clickBtn('Exclude');
    const c = await chip();
    must(c && /region = US/.test(c.text) && J(c.active) === J(['Exclude']), 'Exclude: ' + J(c));
    await clearSel(); await settle(500);
    p = await hoverMark(0);
    await enterTip(p);
    const r0 = rowReqs.length;
    await clickBtn('View data');
    await waitFor(`!!document.querySelector('dialog.rows-dialog[open]')`, 'rows dialog');
    must(rowReqs.length === r0 + 1 && J(rowReqs.at(-1)).includes('APAC'), 'rows of that mark: ' + J(rowReqs.at(-1)).slice(0, 300));
    must((await chip()) === null, 'View data does not select the mark');
    await shot('view-data');
    await ev(`document.querySelector('dialog.rows-dialog[open] [aria-label="Close"], dialog.rows-dialog[open] .iconbtn')?.click()`);
    await ev(`document.querySelector('dialog.rows-dialog[open]')?.close()`);
    await away();
  });
  await check('a hide delay never leaves a stuck tooltip: leaving the chart hides it (also without ever entering it)', async () => {
    const p = await hoverMark(1); must(await shown(), 'shown');
    await mv(5, 5); await b.sleep(150); // inside the delay it may still be up
    await b.sleep(800);
    must(!(await shown()), 'gone after the delay');
    await hoverMark(3); const t = await shown(); must(t && t.buttons.length === 3, 'another mark: its own tooltip');
    await away(); must(!(await shown()), 'and gone again');
  });
  await check('a member named like markup is escaped in the tooltip, the buttons stay real buttons', async () => {
    await hoverMark(evilIdx);
    const t = await shown();
    must(t && t.buttons.length === 3, 'buttons: ' + J(t && t.buttons));
    must(t.text.includes('<b onclick=x>'), 'the name reads as text: ' + J(t.text));
    must(!/<b onclick/.test(t.html) && /&lt;b onclick=x&gt;/.test(t.html), 'escaped markup: ' + t.html.slice(0, 200));
    await shot('hover-escaped');
    await away();
  });
  for (const type of ['Line', 'Pie']) {
    await check(`On hover (${type}): enterable tooltip with the three buttons; Keep only selects the hovered mark`, async () => {
      await chartType(type);
      const p = await hoverMark(1);
      const t = await enterTip(p);
      must(t && t.buttons.length === 3 && /EU/.test(t.text), `${type}: ` + J(t && [t.text, t.buttons]));
      await shot(`hover-${type.toLowerCase()}-buttons`);
      await clickBtn('Keep only');
      const c = await chip();
      must(c && /region = EU/.test(c.text) && J(c.active) === J(['Keep only']), `${type}: ` + J(c));
      await clearSel(); await settle(500); await away();
    });
  }
  await check('On hover (point chart, two measures): enterable tooltip with buttons; Exclude applies', async () => {
    await dragChip('qty', `__t.zone('rows')`); await settle(500);
    await chartType('Scatter');
    const n = await ev(`${inst}.getModel().getSeriesByIndex(0).getData().count()`);
    must(n === REGIONS.length, 'one point per region: ' + n);
    const p = await hoverMark(1);
    const t = await enterTip(p);
    must(t && t.buttons.length === 3, 'scatter: ' + J(t && [t.text, t.buttons]));
    await clickBtn('Exclude');
    const c = await chip();
    must(c && /region = EU/.test(c.text) && J(c.active) === J(['Exclude']), 'scatter: ' + J(c));
    await clearSel(); await settle(500); await away();
  });

  // ---- Responsive -------------------------------------------------------------------------------------------------------
  await check('Responsive: hovering shows today\'s tooltip (no buttons); clicking a mark pins its tooltip with the buttons', async () => {
    await ev(`document.querySelector('.ws-viewbar__btn[aria-label="Format"]') && 0`);
    await ev(`(() => { const x = document.querySelector('.ws-shelf--rows .ws-pill [aria-label="Remove field"]'); return !!x; })()`);
    await openFormat();
    // back to a single-measure bar chart: remove qty
    await ev(`(() => { const pills = [...document.querySelectorAll('.ws-shelf--rows .ws-pill')]; const q = pills.find((p) => /qty/.test(p.textContent)); q?.querySelector('[aria-label^="Remove"]')?.click(); return true; })()`);
    await settle(500); await chartType('Bar');
    await openFormat(); await pick('Tooltip mode', 'responsive'); await closeFormat();
    const p = await hoverMark(1);
    const t = await shown();
    must(t && t.buttons.length === 0 && !/ws-tip/.test(t.cls), 'hover: today\'s tooltip: ' + J(t && [t.cls, t.buttons]));
    await away();
    await clickMark(1);
    const t2 = await shown();
    must(t2 && /ws-tip/.test(t2.cls) && J(t2.buttons) === J(['Keep only', 'Exclude', 'View data']) && /EU/.test(t2.text), 'pinned with buttons: ' + J(t2 && [t2.cls, t2.text, t2.buttons]));
    const c = await chip();
    must(c && /region = EU/.test(c.text) && c.active.length === 0, 'the click selected the mark as before: ' + J(c));
    await shot('responsive-pinned');
    // it stays: the pointer goes far away, and across another mark, and a second passes
    await mv(5, 5); await b.sleep(1200);
    must(await shown(), 'still pinned after the pointer left the chart');
    const other = await markXY(2); await mv(other.x, other.y); await b.sleep(400);
    const t3 = await shown(); must(t3 && /EU/.test(t3.text) && t3.buttons.length === 3, 'hovering another mark neither replaces it nor leaves a button-less one: ' + J(t3 && t3.text));
    await mv(5, 5);
  });
  await check('Responsive: the buttons of the pinned tooltip work (Keep only), and a later redraw does not pin again', async () => {
    const t = await shown(); must(t, 'pinned tooltip before');
    await clickBtn('Keep only');
    const c = await chip();
    must(c && J(c.active) === J(['Keep only']), J(c));
    must(!(await shown()), 'no tooltip after the command');
    await openFormat(); await flip('Show tooltips'); await flip('Show tooltips'); await closeFormat(); await settle(500); // two redraws
    must(!(await shown()), 'a redraw leaves no tooltip behind');
    await clearSel(); await settle(500);
  });
  await check('Responsive: Esc, a click on empty chart, and the mark again each dismiss the pin', async () => {
    await clickMark(0); must(await shown(), 'pinned');
    await b.key('Escape', { code: 'Escape', vk: 27 }); await b.sleep(250);
    must(!(await shown()), 'Esc dismisses it');
    must(await chip(), 'the selection stays (Esc only closes the tooltip)');
    await hoverMark(0); const plain = await shown();
    must(plain && plain.buttons.length === 0 && /EU|APAC/.test(plain.text), 'after Esc a hover shows the plain tooltip again, with no buttons: ' + J(plain && [plain.text, plain.buttons]));
    await away();
    await clearSel();
    await clickMark(0); must(await shown(), 'pinned again');
    const hr = await ev(`(() => { const r = document.querySelector('.ws-chart-canvas').getBoundingClientRect(); return { x: r.x + 6, y: r.y + 6 }; })()`);
    await mv(hr.x, hr.y); await b.click(hr.x, hr.y); await b.sleep(300);
    must(!(await shown()), 'a click on empty chart dismisses it');
    await clearSel();
    await clickMark(0); must(await shown(), 'pinned a third time');
    await clickMark(0); // the same mark again deselects
    must(!(await chip()) && !(await shown()), 'clicking the mark again clears the selection and the pin: ' + J(await chip()));
    await clickMark(2); must((await shown()) && /<b onclick|&lt;|US/.test((await shown()).text), 'selecting another mark pins that one');
    await clickMark(2); await clearSel();
  });
  await check('Responsive pin on a pie and a line chart', async () => {
    for (const type of ['Pie', 'Line']) {
      await chartType(type);
      await clickMark(1);
      const t = await shown();
      must(t && t.buttons.length === 3 && /EU/.test(t.text), `${type} pinned: ` + J(t && [t.text, t.buttons]));
      await shot(`responsive-${type.toLowerCase()}`);
      await clickMark(1); await settle(300);
      await clearSel(); await away();
    }
    await chartType('Bar');
  });
  await check('The PNG / SVG export never contains the tooltip (a pinned one included)', async () => {
    await clickMark(1); must(await shown(), 'pinned');
    const svg = await ev(`(async () => { const m = await import('/features/Dashboard/chart.js'); const r = await m.exportChart(document.getElementById('ws-chart'), 'svg'); return r ? await r.blob.text() : null; })()`);
    must(svg && svg.length > 500, 'an svg string: ' + (svg || '').length);
    must(!/Keep only|Exclude|View data|ws-tip/.test(svg), 'no tooltip text or buttons in the export');
    await clearSel(); await away();
  });
  await check('Command buttons are disabled with their reason on a heatmap, and a table / KPI-style chart has no tooltip controls at all (the date-part, drill and split gates are unit-tested)', async () => {
    await chartType('Heatmap'); await openFormat();
    const c = await state('Command buttons'), m = await state('Tooltip mode');
    must(c && c.disabled && /select/i.test(c.title), 'heatmap: ' + J(c));
    must(m && m.disabled, 'mode: ' + J(m));
    await closeFormat();
    await chartType('Table'); await openFormat();
    must((await state('Show tooltips')) === null, 'a table has no tooltip controls');
    await closeFormat(); await chartType('Bar');
  });
  await check('a date axis: Group dates Auto keeps the control with a note and the chart says why no buttons appear; a grain disables it with the reason; Exact brings the buttons back', async () => {
    await dragChip('placed', `__t.zone('columns')`);
    await ev(`(() => { const pills = [...document.querySelectorAll('.ws-shelf--columns .ws-pill')]; pills.find((p) => /region/.test(p.textContent))?.querySelector('[aria-label^="Remove"]')?.click(); return true; })()`);
    await settle(600); await chartType('Line'); await openFormat();
    if (!(await state('Command buttons')).checked) await flip('Command buttons');
    const auto = await state('Command buttons');
    must(auto && auto.checked && !auto.disabled && /Group dates/.test(auto.title), 'Auto: enabled with a note: ' + J(auto));
    const hintText = () => ev(`[...document.querySelectorAll('#ws-chart .ws-hint')].map((h) => h.textContent).join(' | ')`);
    must(/Command buttons are not shown.*Group dates → Exact/.test(await hintText()), 'the chart says why: ' + (await hintText()));
    await closeFormat();
    await hoverMark(1); const t = await shown();
    must(t && t.buttons.length === 0, 'the tooltip is plain: ' + J(t && t.buttons)); await away();
    await openFormat(); await pick('Group dates', 'day');
    const day = await state('Command buttons');
    must(day.disabled && /Group dates is Day.*Exact/.test(day.title), 'Day: disabled with the reason: ' + J(day));
    await pick('Group dates', 'exact');
    const exact = await state('Command buttons');
    must(!exact.disabled, 'Exact: enabled: ' + J(exact));
    await pick('Tooltip mode', 'hover');
    must(!/Command buttons are not shown/.test(await hintText()), 'no hint once the dates are not grouped: ' + (await hintText()));
    await closeFormat();
    await hoverMark(1); const t2 = await shown();
    must(t2 && t2.buttons.length === 3, 'Exact: the buttons are in the tooltip: ' + J(t2 && t2.buttons)); await away();
    await shot('date-axis-exact');
    await openFormat(); await pick('Group dates', 'auto'); await closeFormat();
  });
  await check('clicking a tooltip button does not stop an open menu from closing on the click (the click still bubbles)', async () => {
    await openFormat(); await pick('Group dates', 'exact'); await pick('Tooltip mode', 'hover'); await closeFormat();
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    must(await ev(`!!document.querySelector('.ws-charttypes')`), 'the chart-type menu is open');
        await hoverMark(3); await b.sleep(200); // the last point lies right of the open menu
    const p = await markXY(3); const t = await enterTip(p);
    must(t && t.buttons.length === 3, 'a tooltip to click: ' + J(t && t.buttons));
    await ev(`window.__docClicks = 0; document.addEventListener('click', () => { window.__docClicks++; }); true`); // a document-level click listener, like the menus' outside-click close
    await clickBtn('Exclude');
    must(await chip(), 'the command ran');
    must((await ev('window.__docClicks')) >= 1, 'the click reached document-level handlers');
    must(await ev(`!document.querySelector('.ws-charttypes') || getComputedStyle(document.querySelector('.ws-charttypes').closest('.menu__list, .menu') ?? document.body).display === 'none' || document.querySelector('.ws-charttypes').closest('[hidden]') !== null`), 'the menu closed on that click');
    await clearSel();
  });
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
