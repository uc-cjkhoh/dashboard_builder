// Browser check for editing the dashboard board (P24b stage 3): move by the header and resize by the corner with REAL mouse
// events (snap to cells, a ghost while dragging, an overlapping or out-of-grid drop snaps back with a status message and changes
// nothing); keyboard arrows / Shift+arrows with the live status; inline text edit (labels, limits, Save / Cancel / Esc); Remove asks twice
// (Cancel on the second dialog keeps the widget); dragging a worksheet from the side panel onto the
// canvas; pointercancel / blur mid-drag leave no ghost. Real dev app (APP_URL), every /api/* mocked;
// any page error fails the run. A reload keeps the layout (autosave).
// Screenshots (light + dark: ghost mid-drag, a refused ghost, focus ring) go to SHOTS_DIR.
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5193';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'board-edit-shots');
mkdirSync(SHOTS, { recursive: true });
const COLUMNS = { orders: [['amount', 'Float64', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text'], ['status', 'String', 'text'], ['qty_s', 'String', 'text']] };
const VALUES = { qty_s: ['1', '2', '3'], region: ['APAC', 'EU', 'US'], channel: ['web', 'shop', 'app'], status: ['open', 'paid', 'void'] };
const queries = [];
const dimsOf = (q) => [...(q.rowDimensions ?? []), ...(q.columnDimensions ?? [])].map((d) => d.column).join();
const countBy = (col) => queries.filter((q) => dimsOf(q) === col).length;
let slowMs = 0;
async function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders'] };
  if (path === '/api/databases/shop/tables/orders/columns') return { json: COLUMNS.orders.map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/query') {
    queries.push(body);
    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    if (dims.some((d) => d.column === 'status')) return { status: 400, json: { error: 'Query rejected: status is not available.' } };
    if (body.offset !== undefined) { // a table: pages of up to 500 of 1200 rows
      const rd = body.rowDimensions ?? [], total = 1200, n = Math.max(0, Math.min(body.limit ?? 500, total - body.offset));
      return { json: { rowDimensions: rd.map((d) => d.column), columnDimensions: [], measures: (body.measures ?? []).map((_, i) => `v${i}`), total,
        rows: Array.from({ length: n }, (_, r) => ({ keys: rd.map((d) => `${VALUES[d.column]?.[(body.offset + r) % 3] ?? 'x'}-${body.offset + r}`), values: (body.measures ?? []).map(() => body.offset + r) })), truncated: false } };
    }
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: Array.from({ length: dims.length ? 3 : 1 }, (_, r) => ({ keys: dims.map((d) => VALUES[d.column][r]), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })), truncated: false } };
  }
  return null;
}

let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;
const KEY = 'dashboardbuilder.workbook.v2|mock-ch|8443|default';

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); ${code} })()`);
  const shot = (name) => b.screenshot(join(SHOTS, name));
  const connect = async () => {
    await waitFor(`document.readyState === 'complete' && !!document.getElementById('conn-connect')`, 'app loaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  };
  // widgets in the store as [x, y, w, h] by id order of creation: A = first sheet, B = second, T = text
  const cells = () => store(`return st.dashboards()[0].widgets.map((w) => [w.x, w.y, w.w, w.h]);`);
  const saved = async () => JSON.parse(await ev(`localStorage.getItem(${J(KEY)})`)).dashboards[0].widgets.map((w) => [w.x, w.y, w.w, w.h]);
  const status = () => ev(`document.getElementById('board-status').textContent`);
  const ghost = () => ev(`(() => { const g = document.querySelector('.board-ghost'); if (!g || g.hidden) return null; const r = g.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), refused: g.classList.contains('is-refused'), label: g.textContent }; })()`);
  const metrics = () => ev(`(() => { const g = document.getElementById('board-grid').getBoundingClientRect(); return { left: g.left, top: g.top, sx: (g.width + 8) / 12, sy: 72 }; })()`);
  const mouse = (type, x, y, extra = {}) => b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  let ID = {}; // A, B, T → widget ids (the DOM order follows the layout, so tests address widgets by id)
  const wsel = (k) => `.board-widget[data-widget-id="${ID[k]}"]`;
  const headPoint = (k) => ev(`(() => { const w = document.querySelector(${J(wsel(k))}); w.scrollIntoView({ block: 'center' }); const r = w.querySelector('.board-widget__title').getBoundingClientRect(); return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) }; })()`);
  const gripPoint = (k) => ev(`(() => { const w = document.querySelector(${J(wsel(k))}); w.scrollIntoView({ block: 'center' }); const r = w.querySelector('.board-widget__resize').getBoundingClientRect(); return { x: Math.round(r.left + r.width - 4), y: Math.round(r.top + r.height - 4) }; })()`);
  // press at p, move in steps by (dx, dy), optionally hold before releasing
  async function drag(p, dx, dy, { release = true } = {}) {
    await mouse('mouseMoved', p.x, p.y); await mouse('mousePressed', p.x, p.y);
    for (let s = 1; s <= 6; s++) await mouse('mouseMoved', p.x + (dx * s) / 6, p.y + (dy * s) / 6);
    if (release) await mouse('mouseReleased', p.x + dx, p.y + dy);
  }
  const keyPress = (key, vk, modifiers = 0) => b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
    .then(() => b.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }));
  const ARROW = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
  const arrow = (k, shift = false) => keyPress(k, ARROW[k], shift ? 8 : 0);
  const focusWidget = (k) => ev(`document.querySelector(${J(wsel(k))}).focus()`);
  // Remove asks twice: "Remove ..." then "Really remove ...", buttons "Remove" and "Remove for good".
  const dlgText = () => ev(`[...document.querySelectorAll('dialog[open].dialog--sm')].map((d) => d.innerText).join(' || ')`);
  const dlgBtn = (label) => ev(`[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === ${J(label)}).click()`);
  const toastText = () => ev(`document.getElementById('toast')?.innerText ?? ''`);
  const askTwice = async (sel) => { // click the X, confirm both dialogs
    await ev(`document.querySelector(${J(sel)}).click()`);
    await waitFor(`!!document.querySelector('dialog[open].dialog--sm')`, 'first confirmation');
    await dlgBtn('Remove');
    await waitFor(`[...document.querySelectorAll('dialog[open] button')].some((x) => x.textContent.trim() === 'Remove for good')`, 'second confirmation');
    await dlgBtn('Remove for good');
  };

  await b.goto(APP + '/');
  await connect();
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 1`, 'tables listed');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'orders loaded');
  await store(`
    const f = (column, category, extra = {}) => ({ db: 'shop', table: 'orders', column, category, ...extra });
    const mk = (name, chartType, dim) => { const t = st.createWorksheet(name); t.sheet = { ...st.emptySheet(), chartType, columns: [f(dim, 'text')], rows: [f('amount', 'numeric', { agg: 'sum' })] }; return t; };
    const a = mk('Revenue by region', 'bar', 'region'), c = mk('Share by channel', 'pie', 'channel'); mk('Spare', 'bar', 'channel');
    const d = st.createDashboard('Overview');
    st.setWidgets(d.id, [
      { id: st.nextWidgetId(), kind: 'sheet', sheetId: a.id, x: 0, y: 0, w: 4, h: 3 },
      { id: st.nextWidgetId(), kind: 'sheet', sheetId: c.id, x: 6, y: 0, w: 4, h: 3 },
      { id: st.nextWidgetId(), kind: 'text', heading: 'Notes', body: 'Revenue is by order date.', x: 0, y: 4, w: 6, h: 2 }]);
    return true;`);
  await waitFor(`document.querySelectorAll('.board-widget .ws-chart-canvas svg').length === 2`, 'widgets drawn');
  ID = await store(`const [a, b, t] = st.dashboards()[0].widgets; return { A: a.id, B: b.id, T: t.id };`);
  const snaps = [await cells()]; // layout after each committed edit: the last one is what the board must still show after a refused edit

  await check('widgets are focusable groups with a label, a role description and a key hint', async () => {
    const r = await ev(`(() => { const w = document.querySelector('.board-widget'); return { tab: w.tabIndex, role: w.getAttribute('role'), label: w.getAttribute('aria-label'), rd: w.getAttribute('aria-roledescription'),
      hint: document.getElementById(w.getAttribute('aria-describedby'))?.textContent }; })()`);
    must(r.tab === 0 && r.role === 'group' && r.label === 'Revenue by region' && r.rd === 'dashboard widget' && /Arrow keys move.*Shift plus arrow keys resize/.test(r.hint), J(r));
  });

  await check('drag the header to a free cell: ghost shows the target cells while dragging; the drop moves it, saves it, and announces it', async () => {
    const m = await metrics(), p = await headPoint('A');
    await drag(p, 0, 7 * m.sy, { release: false });
    const g = await ghost();
    must(g && !g.refused && g.label === '', `ghost mid-drag: ${J(g)}`);
    const m2 = await metrics(); // the canvas may have scrolled a little during the drag: compare with the live grid box
    must(Math.abs(g.y - (m2.top + 7 * m.sy)) <= 2 && Math.abs(g.x - m2.left) <= 2, `ghost at ${g.x},${g.y} want ${m2.left},${m2.top + 7 * m.sy}`);
    must(await ev(`document.querySelector('.board-widget').classList.contains('is-dragging')`), 'dragged widget not marked');
    must(J(await cells()) === J(snaps[0]), 'the store changed before the drop');
    await shot('board-drag-ghost-light.png');
    await b.setScheme('dark'); await b.sleep(300); await shot('board-drag-ghost-dark.png'); await b.setScheme('light'); await b.sleep(200);
    await mouse('mouseReleased', p.x, p.y + 7 * m.sy);
    await waitFor(`!document.querySelector('.board-ghost') || document.querySelector('.board-ghost').hidden`, 'ghost hidden after drop');
    must(J((await cells())[0]) === J([0, 7, 4, 3]), `cells ${J(await cells())}`);
    snaps.push(await cells());
    must((await status()) === 'Moved to column 1, row 8', `status: ${await status()}`);
    await waitFor(`localStorage.getItem(${J(KEY)}) !== null`, 'autosaved');
    await b.sleep(900);
    must(J((await saved())[0]) === J([0, 7, 4, 3]), `saved workbook ${J(await saved())}`);
  });

  await check('drag onto another widget snaps back with a status message: refused ghost (icon + text), nothing moves', async () => {
    const m = await metrics(), p = await headPoint('B');
    await drag(p, -6 * m.sx, 7 * m.sy, { release: false }); // B (6,0) → (0,7): where A now sits
    const g = await ghost();
    must(g && g.refused && /Can't drop here/.test(g.label), `ghost: ${J(g)}`);
    await shot('board-drag-refused-light.png');
    await mouse('mouseReleased', p.x - 6 * m.sx, p.y + 7 * m.sy);
    await waitFor(`document.querySelector('.board-ghost').hidden`, 'ghost hidden');
    must(J(await cells()) === J(snaps.at(-1)), `moved anyway: ${J(await cells())}`);
    must(/^Can't move: it would overlap “Revenue by region”\. Move or shrink that widget first\.$/.test(await status()), `status: ${await status()}`);
    must(await ev(`document.getElementById('board-status').classList.contains('is-refused') && !!document.querySelector('#board-status svg')`), 'refusal not marked with icon + text');
    must(await ev(`(() => { const n = document.querySelector('.board-widget__refusal'); return !!n && n.closest('.board-widget').getAttribute('aria-label') === 'Share by channel' && /Move or shrink/.test(n.textContent) && !!n.querySelector('svg'); })()`), 'no refusal on the widget that stayed put');
  });

  await check('a drop outside the grid snaps back: left edge, top of the dashboard', async () => {
    const m = await metrics();
    await drag(await headPoint('A'), -3 * m.sx, 0);
    must(/left edge/.test(await status()) && J(await cells()) === J(snaps.at(-1)), `left: ${await status()}`);
    await drag(await headPoint('T'), 0, -5 * m.sy);
    must(/top of the dashboard/.test(await status()) && J(await cells()) === J(snaps.at(-1)), `top: ${await status()}`);
  });

  await check('a click on the header (under the drag threshold) changes nothing', async () => {
    const p = await headPoint('B');
    await mouse('mouseMoved', p.x, p.y); await mouse('mousePressed', p.x, p.y); await mouse('mouseMoved', p.x + 2, p.y); await mouse('mouseReleased', p.x + 2, p.y);
    must(J(await cells()) === J(snaps.at(-1)) && (await ghost()) === null, 'a click moved or ghosted');
  });

  await check('resize by the bottom-right corner: snaps to cells with a ghost; too small and past the right edge snap back', async () => {
    const m = await metrics(), g0 = await gripPoint('B');
    await drag(g0, 2 * m.sx, 1 * m.sy, { release: false });
    const g = await ghost();
    must(g && !g.refused, `ghost ${J(g)}`);
    await mouse('mouseReleased', g0.x + 2 * m.sx, g0.y + m.sy);
    await waitFor(`document.querySelector('.board-ghost').hidden`, 'ghost hidden');
    must(J((await cells())[1]) === J([6, 0, 6, 4]), `cells ${J(await cells())}`);
    must((await status()) === 'Resized to 6 columns by 4 rows', await status());
    snaps.push(await cells());
    await drag(await gripPoint('B'), -5 * m.sx, 0);
    must(/at least 2 columns/.test(await status()) && J(await cells()) === J(snaps.at(-1)), `too small: ${await status()}`);
    await drag(await gripPoint('B'), 2 * m.sx, 0);
    must(/right edge/.test(await status()) && J(await cells()) === J(snaps.at(-1)), `right edge: ${await status()}`);
  });

  await check('keyboard: arrows move one cell, Shift+arrows resize; each a committed step with a live status; focus stays on the widget', async () => {
    await keyPress('Shift', 16); // keyboard modality, so :focus-visible shows on a programmatic focus
    await focusWidget('A');
    must(await ev(`getComputedStyle(document.querySelector(${J(wsel('A'))})).backgroundImage.startsWith('linear-gradient')`), 'no focus wash on a focused widget');
    await shot('board-focus-ring-light.png');
    await arrow('ArrowRight');
    await waitFor(`document.getElementById('board-status').textContent === 'Moved to column 2, row 8'`, 'moved status');
    must(await ev(`document.activeElement === document.querySelector(${J(wsel('A'))})`), 'focus lost after a keyboard move');
    must(await ev(`document.getElementById('board-status').getAttribute('role') === 'status' && document.getElementById('board-status').getAttribute('aria-live') === 'polite'`), 'status is not a polite live region');
    snaps.push(await cells());
    await arrow('ArrowDown', true);
    await waitFor(`document.getElementById('board-status').textContent === 'Resized to 4 columns by 4 rows'`, 'resized status');
    snaps.push(await cells());
    await arrow('ArrowUp', true); snaps.push(await cells());
    must((await status()) === 'Resized to 4 columns by 3 rows', await status());
    await arrow('ArrowLeft'); snaps.push(await cells());
    must((await status()) === 'Moved to column 1, row 8', await status());
    await arrow('ArrowLeft');
    must((await status()) === "Can't move: the widget is at the left edge of the dashboard." && J(await cells()) === J(snaps.at(-1)), await status());
    await focusWidget('T');
    await arrow('ArrowDown'); snaps.push(await cells()); // T (0,5): rows 5..6; touching A (row 7) is fine
    await arrow('ArrowDown'); // (0,6): rows 6..7 overlap A
    must(/^Can't move: it would overlap “Revenue by region”\. Move or shrink that widget first\.$/.test(await status()) && J((await cells())[2]) === J([0, 5, 6, 2]), `overlap: ${J(await cells())} ${await status()}`);
    must(await ev(`document.activeElement === document.querySelector(${J(wsel('T'))})`), 'focus lost after a refused step');
  });

  await check('text edit: Edit opens labelled inputs (maxLength from the limits), Save commits; Cancel and Esc discard', async () => {
    const before = await store(`return JSON.stringify(st.dashboards()[0].widgets.at(-1));`);
    await ev(`document.querySelector('.board-widget--text .board-widget__edit').click()`);
    const f = await ev(`(() => { const t = document.querySelector('.board-widget--text'); const h = t.querySelector('input'), x = t.querySelector('textarea');
      return { hl: t.querySelector(\`label[for="\${h.id}"]\`)?.textContent, bl: t.querySelector(\`label[for="\${x.id}"]\`)?.textContent, hm: h.maxLength, bm: x.maxLength, hv: h.value, bv: x.value,
        focus: document.activeElement === h, save: t.querySelector('.board-text-edit__save').textContent, cancel: t.querySelector('.board-text-edit__cancel').textContent }; })()`);
    must(f.hl === 'Heading' && f.bl === 'Text' && f.hm === 80 && f.bm === 2000 && f.hv === 'Notes' && f.bv === 'Revenue is by order date.' && f.focus && f.save === 'Save' && f.cancel === 'Cancel', J(f));
    await shot('board-text-edit-light.png');
    // Esc discards
    await b.type(' changed');
    await keyPress('Escape', 27);
    await waitFor(`!document.querySelector('.board-widget--text form')`, 'edit closed by Esc');
    must(await store(`return JSON.stringify(st.dashboards()[0].widgets.at(-1));`) === before, 'Esc saved');
    must(await ev(`document.activeElement.classList.contains('board-widget__edit')`), 'focus did not return to Edit');
    // Cancel discards
    await ev(`document.querySelector('.board-widget--text .board-widget__edit').click()`);
    await b.type('X');
    await ev(`document.querySelector('.board-text-edit__cancel').click()`);
    must(await store(`return JSON.stringify(st.dashboards()[0].widgets.at(-1));`) === before, 'Cancel saved');
    // Save commits (Enter in the heading submits)
    await ev(`document.querySelector('.board-widget--text .board-widget__edit').click()`);
    await ev(`(() => { const t = document.querySelector('.board-widget--text'); t.querySelector('input').value = 'Q3 review'; t.querySelector('textarea').value = 'Line one\\nLine two <b>x</b>'; return true; })()`);
    await ev(`document.querySelector('.board-text-edit__save').click()`);
    await waitFor(`document.querySelector('.board-widget--text .board-widget__title').textContent === 'Q3 review'`, 'heading saved');
    const w = await store(`const w = st.dashboards()[0].widgets.at(-1); return [w.heading, w.body];`);
    must(J(w) === J(['Q3 review', 'Line one\nLine two <b>x</b>']), J(w));
    must(await ev(`document.querySelector('.board-widget--text b') === null && document.querySelector('.board-widget--text .board-text__body').textContent.includes('<b>x</b>')`), 'markup interpreted');
    must((await status()) === 'Text updated.', await status());
    snaps.push(await cells()); // layout unchanged
    // an unchanged Save changes nothing
    const w0 = await store(`return JSON.stringify(st.dashboards()[0].widgets.at(-1));`);
    await ev(`document.querySelector('.board-widget--text .board-widget__edit').click()`);
    await ev(`document.querySelector('.board-text-edit__save').click()`);
    must(await store(`return JSON.stringify(st.dashboards()[0].widgets.at(-1));`) === w0, 'unchanged save');
  });

  await check('text edit validation: an over-long heading / body is refused with a message and aria-invalid; an empty heading is fine and reads "Text"', async () => {
    await ev(`document.querySelector('.board-widget--text .board-widget__edit').click()`);
    await ev(`(() => { const t = document.querySelector('.board-widget--text'); t.querySelector('input').value = 'h'.repeat(81); t.querySelector('textarea').value = 'b'.repeat(2001); t.querySelector('.board-text-edit__save').click(); return true; })()`);
    const r = await ev(`(() => { const t = document.querySelector('.board-widget--text'); return { errs: [...t.querySelectorAll('.board-text-edit__error')].map((e) => e.textContent), inv: [...t.querySelectorAll('[aria-invalid="true"]')].length,
      open: !!t.querySelector('form'), focus: document.activeElement === t.querySelector('input'), role: t.querySelector('.board-text-edit__error').getAttribute('role') }; })()`);
    must(r.errs[0] === 'The heading must be at most 80 characters.' && r.errs[1] === 'The text must be at most 2000 characters.' && r.inv === 2 && r.open && r.focus && r.role === 'alert', J(r));
    must(await store(`return st.dashboards()[0].widgets.at(-1).heading;`) === 'Q3 review', 'an invalid save went through');
    await shot('board-text-edit-error-light.png');
    await ev(`(() => { const t = document.querySelector('.board-widget--text'); t.querySelector('input').value = ''; t.querySelector('textarea').value = 'short'; t.querySelector('.board-text-edit__save').click(); return true; })()`);
    await waitFor(`document.querySelector('.board-widget--text .board-widget__title').textContent === 'Text'`, 'empty heading reads Text');
    snaps.push(await cells());
  });

  await check('a text widget resizes down to one row and its body wraps inside the width', async () => {
    await ev(`document.querySelector('.board-widget--text .board-widget__edit').click()`);
    await ev(`(() => { const t = document.querySelector('.board-widget--text'); t.querySelector('textarea').value = 'A long line of notes that has to wrap within a narrow widget because nothing may scroll sideways. '.repeat(3); t.querySelector('.board-text-edit__save').click(); return true; })()`);
    await waitFor(`!document.querySelector('.board-widget--text form')`, 'saved');
    snaps.push(await cells());
    await focusWidget('T');
    for (let i = 0; i < 3; i++) { await arrow('ArrowLeft', true); snaps.push(await cells()); }
    must((await cells())[2][2] === 3, `width ${J(await cells())}`);
    must(await ev(`(() => { const p = document.querySelector('.board-widget--text .board-text__body'); const w = document.querySelector('.board-widget--text'); return p.scrollWidth <= p.clientWidth + 1 && p.getBoundingClientRect().height > 30 && w.scrollWidth <= w.clientWidth + 1; })()`), 'text did not wrap');
    await arrow('ArrowUp', true);
    await waitFor(`/Resized to 3 columns by 1 row/.test(document.getElementById('board-status').textContent)`, 'text widget shrank to 1 row');
    snaps.push(await cells());
    await arrow('ArrowUp', true);
    must(/^Can't resize: a text widget is at least 1 row tall\.$/.test(await status()), await status());
    await arrow('ArrowDown', true); snaps.push(await cells()); // back to 2 rows: room for the body
  });

  await check('Add (button) places a widget; Remove asks twice: Cancel on the second dialog keeps it, confirming both removes it', async () => {
    await ev(`document.querySelector('.board-panel__item button').click()`);
    await waitFor(`document.querySelectorAll('.board-widget').length === 4`, 'added');
    snaps.push(await cells());
    const addedId = await store(`return st.dashboards()[0].widgets.at(-1).id;`);
    must(J((await cells()).at(-1)) === J([0, 0, 6, 4]), `Add placed it at ${J((await cells()).at(-1))}`);
    const rm = `.board-widget[data-widget-id="${addedId}"] .board-widget__remove`;
    await ev(`document.querySelector(${J(rm)}).click()`);
    await waitFor(`!!document.querySelector('dialog[open].dialog--sm')`, 'first confirmation');
    must(/^Remove .* from the dashboard\?/.test(await dlgText()) && await ev(`document.querySelectorAll('.board-widget').length === 4`), `first dialog: ${await dlgText()}`);
    await dlgBtn('Remove');
    await waitFor(`/Really remove/.test(document.querySelector('dialog[open].dialog--sm')?.innerText ?? '')`, 'second confirmation');
    must(/This can't be undone/.test(await dlgText()) && await ev(`document.querySelectorAll('.board-widget').length === 4`), `second dialog: ${await dlgText()}`);
    await dlgBtn('Cancel');
    await waitFor(`!document.querySelector('dialog[open]')`, 'dialogs closed');
    must(await ev(`document.querySelectorAll('.board-widget').length === 4`), 'Cancel on the second dialog still removed the widget');
    await askTwice(rm);
    await waitFor(`document.querySelectorAll('.board-widget').length === 3`, 'removed');
    must(!/Undo/.test(await toastText()), `toast: ${await toastText()}`);
    snaps.push(await cells());
  });

  await check('drag a worksheet from the side panel onto the canvas: ghost under the pointer, drop at that cell; an occupied cell is refused', async () => {
    let m = await metrics();
    const point = (col, row) => ({ x: Math.round(m.left + col * m.sx + 10), y: Math.round(m.top + row * m.sy + 10) });
    const fire = (type, sel, p, dt) => `document.querySelector(${J(sel)}).dispatchEvent(new DragEvent(${J(type)}, { bubbles: true, cancelable: true, dataTransfer: ${dt}, clientX: ${p?.x ?? 0}, clientY: ${p?.y ?? 0} }))`;
    // a free cell, 6 wide: columns 6..11, row 12
    const free = point(6, 12);
    await ev(`(() => { window.__dt = new DataTransfer(); ${fire('dragstart', '.board-panel__item[data-sheet-id]:last-child', null, 'window.__dt')}; ${fire('dragover', '#board-scroll', free, 'window.__dt')}; return true; })()`);
    const g = await ghost();
    must(g && !g.refused && Math.abs(g.x - (m.left + 6 * m.sx)) <= 2 && Math.abs(g.y - (m.top + 12 * m.sy)) <= 2, `panel ghost ${J(g)}`);
    must(await ev(`window.__dt.types.includes('application/x-dashboardbuilder-worksheet')`), 'drag payload type');
    await ev(`(() => { ${fire('drop', '#board-scroll', free, 'window.__dt')}; ${fire('dragend', '.board-panel__item[data-sheet-id]:last-child', null, 'window.__dt')}; return true; })()`);
    await waitFor(`document.querySelectorAll('.board-widget').length === 4`, 'dropped widget added');
    const added = await store(`const w = st.dashboards()[0].widgets.at(-1); return [w.kind, w.sheetId === st.worksheets().at(-1).id, w.x, w.y, w.w, w.h];`);
    must(J(added) === J(['sheet', true, 6, 12, 6, 4]), J(added));
    must((await ghost()) === null, 'ghost left behind after the drop');
    snaps.push(await cells());
    // occupied cell: refused, nothing added (the canvas scrolled to the new widget: measure again)
    m = await metrics();
    const busy = point(0, 7);
    await ev(`(() => { window.__dt = new DataTransfer(); ${fire('dragstart', '.board-panel__item[data-sheet-id]', null, 'window.__dt')}; ${fire('dragover', '#board-scroll', busy, 'window.__dt')}; return true; })()`);
    must((await ghost())?.refused === true, `refused ghost for an occupied cell: ${J(await ghost())} cells ${J(await cells())} m ${J(m)}`);
    await ev(`(() => { ${fire('drop', '#board-scroll', busy, 'window.__dt')}; ${fire('dragend', '.board-panel__item[data-sheet-id]', null, 'window.__dt')}; return true; })()`);
    must((await cells()).length === 4 && /^Can't place: it would overlap/.test(await status()), `occupied drop: ${await status()}`);
    // a slide-left fit: dropping at column 10 of a 6-wide widget lands at x=6
    m = await metrics();
    await ev(`(() => { window.__dt = new DataTransfer(); ${fire('dragstart', '.board-panel__item[data-sheet-id]', null, 'window.__dt')}; ${fire('drop', '#board-scroll', point(10, 20), 'window.__dt')}; return true; })()`);
    await waitFor(`document.querySelectorAll('.board-widget').length === 5`, 'second drop');
    must((await cells()).at(-1).join() === '6,20,6,4', `slid left: ${(await cells()).at(-1)}`);
    snaps.push(await cells());
    // another type of drag is ignored
    await ev(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'x'); ${fire('dragover', '#board-scroll', free, 'dt')}; return true; })()`);
    must((await ghost()) === null, 'a foreign drag showed a ghost');
  });

  await check('pointercancel, window blur and Esc mid-drag leave no ghost and change nothing; the next drag works', async () => {
    const before = await cells();
    for (const how of ['pointercancel', 'blur', 'escape']) {
      const m = await metrics(), p = await headPoint('A');
      await drag(p, m.sx * 2, -m.sy, { release: false });
      must((await ghost()) !== null, `${how}: no ghost mid-drag`);
      if (how === 'pointercancel') await ev(`document.querySelector(${J(wsel('A'))} + ' .board-widget__head').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }))`);
      else if (how === 'blur') await ev(`window.dispatchEvent(new Event('blur'))`);
      else await keyPress('Escape', 27);
      must((await ghost()) === null && await ev(`!document.querySelector('.board-widget.is-dragging') && !document.getElementById('board-grid').classList.contains('is-dragging')`), `${how}: ghost or drag state left behind: ${J(await ghost())} ${await ev(`[...document.querySelectorAll('.is-dragging')].map((x) => x.className).join('|')`)}`);
      await mouse('mouseReleased', p.x, p.y);
      must(J(await cells()) === J(before), `${how}: the layout changed`);
    }
    // and a fresh drag still works afterwards
    const p = await headPoint('A');
    await drag(p, 0, 0); // a click
    must((await ghost()) === null, 'ghost after a click');
  });

  await check('text edit saves exact content (heading + body); removing a widget (both dialogs) drops it', async () => {
    const text = () => store(`const w = st.dashboards()[0].widgets.find((x) => x.kind === 'text'); return [w.heading, w.body.slice(0, 20)];`);
    await ev(`document.querySelector('.board-widget--text .board-widget__edit').click()`);
    await ev(`(() => { const t = document.querySelector('.board-widget--text'); t.querySelector('input').value = 'Edited'; t.querySelector('textarea').value = 'New body'; t.querySelector('.board-text-edit__save').click(); return true; })()`);
    await waitFor(`document.querySelector('.board-widget--text .board-widget__title').textContent === 'Edited'`, 'saved');
    must(J(await text()) === J(['Edited', 'New body']), `saved text ${J(await text())}`);
    const all = await store(`return JSON.stringify(st.dashboards()[0].widgets);`); // to put the removed widget back afterwards (there is no Undo)
    const n = (await cells()).length;
    await askTwice(`${wsel('A')} .board-widget__remove`);
    await waitFor(`document.querySelectorAll('.board-widget').length === ${n - 1}`, 'removed');
    must(await store(`return !st.dashboards()[0].widgets.some((w) => w.id === ${J(ID.A)});`), 'the widget is still in the store');
    must(!/Undo/.test(await toastText()) && /Removed/.test(await toastText()), `toast: ${await toastText()}`);
    await store(`st.setWidgets(st.dashboards()[0].id, ${all}); return true;`); // re-setup: the same widgets, A first again
    await waitFor(`document.querySelectorAll('.board-widget').length === ${n}`, 'widgets back');
    await waitFor(`document.querySelectorAll('.board-widget .ws-chart-canvas svg').length >= 2`, 'restored widget drew');
  });

  await check('Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z do nothing to the dashboard (there is no Undo); typing in a text field keeps its own Ctrl+Z', async () => {
    await focusWidget('A');
    await arrow('ArrowDown');
    const moved = await cells();
    await keyPress('z', 90, 2); await keyPress('y', 89, 2); await keyPress('z', 90, 2 | 8);
    await b.sleep(200);
    must(J(await cells()) === J(moved), `a shortcut changed the board: ${J(await cells())} want ${J(moved)}`);
    // typing in the text editor: Ctrl+Z is the field's own
    await ev(`document.querySelector('.board-widget--text .board-widget__edit').click()`);
    await keyPress('z', 90, 2);
    must(J(await cells()) === J(moved) && await ev(`!!document.querySelector('.board-widget--text form')`), 'Ctrl+Z in a text input changed the board');
    await keyPress('Escape', 27);
  });

  await check('a drag whose widget disappears ends with no ghost; a second pointer cannot move or end a drag', async () => {
    const before = await cells();
    const beforeW = await store(`return JSON.stringify(st.dashboards()[0].widgets);`);
    // (a) a plain drag still commits on release
    let m = await metrics(), p = await headPoint('A');
    await drag(p, 0, m.sy * 3, { release: false });
    must((await ghost()) !== null, 'no ghost mid-drag');
    await mouse('mouseReleased', p.x, p.y + m.sy * 3);
    await waitFor(`document.querySelector('.board-ghost').hidden`, 'ghost hidden after release');
    must(J(await cells()) !== J(before), 'the drag was not committed');
    await store(`st.setWidgets(st.dashboards()[0].id, ${beforeW}); return true;`); // put A back where it was (there is no Undo)
    must(J(await cells()) === J(before), 'restore after the drag');
    // (b) the dragged widget is removed underneath the drag (a store change): the gesture ends, nothing is committed, the next drag works
    m = await metrics(); p = await headPoint('A');
    await drag(p, m.sx, 0, { release: false });
    await store(`const d = st.dashboards()[0]; st.setWidgets(d.id, d.widgets.filter((w) => w.id !== ${J(ID.A)})); return true;`);
    await waitFor(`document.querySelector('.board-ghost').hidden && !document.getElementById('board-grid').classList.contains('is-dragging')`, 'ghost and drag state cleared');
    await mouse('mouseReleased', p.x + m.sx, p.y);
    must(!(await cells()).some((c) => c === null) && (await cells()).length === before.length - 1, 'a stale commit resurrected the widget');
    await store(`const d = st.dashboards()[0]; st.setWidgets(d.id, ${J(await store(`return st.dashboards()[0].widgets;`))}.concat([{ id: ${J(ID.A)}, kind: 'sheet', sheetId: st.worksheets()[0].id, x: 0, y: 7, w: 4, h: 3 }])); return true;`);
    await waitFor(`!!document.querySelector(${J(wsel('A'))})`, 'A back');
    m = await metrics(); p = await headPoint('A');
    await drag(p, 0, m.sy, { release: true });
    await waitFor(`document.getElementById('board-status').textContent.startsWith('Moved to column 1, row 9')`, 'the next drag works');
    // (c) a second pointer's move / up / cancel does not touch the running drag
    m = await metrics(); p = await headPoint('A');
    await drag(p, 0, m.sy, { release: false });
    const handle = wsel('A') + ' .board-widget__head';
    await ev(`(() => { const h = document.querySelector(${J(handle)}); for (const t of ['pointermove', 'pointerup', 'pointercancel']) h.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 77, clientX: 5, clientY: 5 })); return true; })()`);
    must((await ghost()) !== null && await ev(`document.querySelector(${J(wsel('A'))}).classList.contains('is-dragging')`), 'a second pointer ended or hijacked the drag');
    await mouse('mouseReleased', p.x, p.y + m.sy);
    await waitFor(`document.querySelector('.board-ghost').hidden`, 'ghost hidden');
  });

  await check('after a reload the layout is kept (autosave)', async () => {
    const want = await cells();
    await b.sleep(900);
    await b.send('Page.reload');
    await connect();
    await waitFor(`document.querySelectorAll('.board-widget').length === ${want.length}`, 'restored');
    must(J(await cells()) === J(want), `layout after reload ${J(await cells())} want ${J(want)}`);
  });

  await check('screenshots: dark with a focused widget (focus ring)', async () => {
    await b.setScheme('dark'); await b.sleep(300);
    await ev(`document.querySelector(${J(wsel('B'))}).focus()`);
    await keyPress('Tab', 9); await keyPress('Tab', 9, 8); // move and come back so :focus-visible shows on a keyboard path
    await shot('board-edit-dark.png');
    const ring = await ev(`getComputedStyle(document.activeElement).backgroundImage`);
    must(ring.startsWith('linear-gradient'), `no focus wash on the focused widget: ${ring}`);
    await b.setScheme('light'); await b.sleep(300);
    await shot('board-edit-light.png');
  });

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
