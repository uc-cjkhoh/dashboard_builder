// Browser check for the dashboard size mode: the Size select (Automatic / presets), a fixed board is exactly its box and scrolls inside the
// panel, rows stretch to the height, the size autosaves and survives a reload, print lays out the scaled box, Automatic restores fill.
// Real dev app (APP_URL), every /api/* mocked; any page error fails the run. Screenshots go to SHOTS_DIR.
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5193';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'board-size-shots');
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
    await waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, 'databases listed');
  };
  const box = (sel) => ev(`(() => { const r = document.querySelector(${J(sel)}).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), l: r.left, t: r.top }; })()`);
  const pick = (value) => ev(`(() => { const s = document.querySelector('.board-bar__size'); s.value = ${J(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

  await b.goto(APP + '/');
  await connect();
  await ev(`(() => { for (const r of document.querySelectorAll('.db-row[data-db]')) if ((r.dataset.db === 'shop') !== (r.getAttribute('aria-expanded') === 'true')) r.click(); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 1`, 'tables listed');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'orders loaded');
  await store(`
    const f = (column, category, extra = {}) => ({ db: 'shop', table: 'orders', column, category, ...extra });
    const t = st.createWorksheet('Revenue'); t.sheet = { ...st.emptySheet(), chartType: 'bar', columns: [f('region', 'text')], rows: [f('amount', 'numeric', { agg: 'sum' })] };
    const d = st.createDashboard('Overview');
    st.setWidgets(d.id, [{ id: st.nextWidgetId(), kind: 'sheet', sheetId: t.id, x: 0, y: 0, w: 6, h: 3 }, { id: st.nextWidgetId(), kind: 'text', heading: 'Notes', body: 'n', x: 6, y: 0, w: 6, h: 3 }]);
    return true;`);
  await waitFor(`document.querySelectorAll('.board-widget .ws-chart-canvas svg').length === 1`, 'widget drawn');

  await check('Automatic by default: the board fills its panel', async () => {
    must(await ev(`document.querySelector('.board-bar__size').value`) === 'auto', 'select not Automatic');
    must(await ev(`!document.getElementById('board-grid').classList.contains('is-fixed')`), 'is-fixed set');
  });

  await check('a fixed size makes the board exactly that box; rows stretch to the height', async () => {
    await pick('800x600');
    await waitFor(`document.getElementById('board-grid').classList.contains('is-fixed')`, 'fixed class');
    const g = await box('#board-grid');
    must(g.w === 800 && g.h === 600, `grid ${J(g)}`);
    const w = await ev(`[...document.querySelectorAll('.board-widget')].map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.bottom - document.getElementById('board-grid').getBoundingClientRect().top); })`);
    must(w.every((v) => v === 600), `widgets end at the box bottom: ${J(w)}`);
    await b.sleep(300);
    await shot('board-size-fixed-light.png');
  });

  await check('a fixed 1920 x 1080 board scrolls inside the panel; the page does not scroll', async () => {
    await pick('1920x1080');
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().width === 1920`, 'width 1920');
    must(await ev(`(() => { const s = document.getElementById('board-scroll'); return s.scrollWidth > s.clientWidth && s.scrollHeight > s.clientHeight; })()`), 'panel does not scroll');
    must(await ev(`document.documentElement.scrollHeight <= window.innerHeight + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1`), 'page scrolls');
  });

  await check('the size autosaves into workbook v2 and survives a reload', async () => {
    await waitFor(`(() => { const v = localStorage.getItem(${J(KEY)}); return v && JSON.parse(v).dashboards[0].size?.width === 1920; })()`, 'autosaved');
    await b.sleep(700);
    await b.send('Page.reload');
    await connect();
    await waitFor(`document.querySelectorAll('.board-widget').length === 2`, 'widgets restored');
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().width === 1920`, 'fixed after reload');
    must(await ev(`document.querySelector('.board-bar__size').value`) === '1920x1080', 'select value');
  });

  await check('print lays the fixed box out scaled to the page width, widgets in place', async () => {
    await ev(`window.dispatchEvent(new Event('beforeprint'))`);
    await b.sleep(200);
    const g = await box('#board-grid');
    must(g.w === 1000 && g.h === Math.round(1080 * 1000 / 1920), `print grid ${J(g)}`);
    await ev(`window.dispatchEvent(new Event('afterprint'))`);
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().width === 1920`, 'back to fixed');
  });

  await check('Automatic restores the fill layout and drops the saved size', async () => {
    await pick('auto');
    await waitFor(`!document.getElementById('board-grid').classList.contains('is-fixed')`, 'automatic');
    await waitFor(`(() => { const v = JSON.parse(localStorage.getItem(${J(KEY)})); return !('size' in v.dashboards[0]); })()`, 'size dropped from the save');
  });

  const setRange = (k, v) => ev(`(() => { const i = [...document.querySelectorAll('.board-bar__rangein')].find((x) => x.getAttribute('aria-label').startsWith(${J(k)})); i.value = ${J(v)}; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await check('Range: the board is the panel width clamped to the maximum, centred; the inputs show; it autosaves', async () => {
    await pick('range');
    await waitFor(`document.getElementById('board-grid').classList.contains('is-ranged')`, 'ranged class');
    must(await ev(`!document.querySelector('.board-bar__range').hidden`), 'inputs hidden');
    await setRange('Max width', '700'); await setRange('Min width', '500');
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().width === 700`, 'width 700');
    const g = await box('#board-grid'), p = await box('#board-scroll');
    must(g.l > p.l + 16, `centred: ${J(g)} in ${J(p)}`);
    await waitFor(`(() => { const r = JSON.parse(localStorage.getItem(${J(KEY)})).dashboards[0].range; return r && r.maxWidth === 700 && r.minWidth === 500; })()`, 'range saved');
    await shot('board-size-range-light.png');
  });
  await check('Range: a minimum above the panel scrolls it; height is clamped and scrolls inside past the maximum', async () => {
    await setRange('Max width', ''); await setRange('Min width', '3000');
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().width === 3000`, 'width 3000');
    await setRange('Min width', ''); await setRange('Min height', '900'); await setRange('Max height', '1000');
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().height === 900`, 'min height 900');
    await store(`const d = st.activeDashboard(); st.setWidgets(d.id, d.widgets.map((w) => ({ ...w, h: 8 })));`); // content taller than the maximum below
    await setRange('Min height', ''); await setRange('Max height', '300');
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().height === 300`, 'max height 300');
    must(await ev(`(() => { const g = document.getElementById('board-grid'); return g.scrollHeight > g.clientHeight; })()`), 'board does not scroll inside');
    must(await ev(`(() => { const g = document.getElementById('board-grid'); return g.scrollWidth <= g.clientWidth; })()`), 'no horizontal overflow inside the ranged board (scrollbar gutter)');
    const gw = await ev(`(() => { const g = document.getElementById('board-grid'); const r = g.getBoundingClientRect(); return [...document.querySelectorAll('.board-widget')].every((e) => e.getBoundingClientRect().right <= r.left + g.clientWidth + 1); })()`);
    must(gw, 'a widget is clipped at the right edge');
  });
  await check('Range: an invalid set is refused in place and not saved', async () => {
    await setRange('Min height', '500'); // above the 300 maximum
    const inv = await ev(`[...document.querySelectorAll('.board-bar__rangegrp .board-bar__rangein')].map((i) => i.getAttribute('aria-invalid'))`);
    must(J(inv) === J(['false', 'false', 'true', 'true']), 'only the two height inputs are invalid: ' + J(inv));
    must(await ev(`/minimum height/.test(document.querySelector('.board-bar__status')?.textContent ?? document.body.textContent)`), 'the status line does not say which limit');
    await setRange('Min height', '250'); // valid again: the marks clear
    const ok = await ev(`[...document.querySelectorAll('.board-bar__rangegrp .board-bar__rangein')].map((i) => i.getAttribute('aria-invalid'))`);
    must(ok.every((v) => v === 'false'), 'aria-invalid not reset after a valid edit: ' + J(ok));
    must(await ev(`document.getElementById('board-grid').getBoundingClientRect().height === 300`), 'layout wrong after valid edit');
    await setRange('Min height', '500');
    must(await ev(`document.getElementById('board-grid').getBoundingClientRect().height === 300`), 'layout changed');
    await setRange('Max height', '');
  });
  await check('Range: visible labels name every limit (Width / Height, Min / Max)', async () => {
    const t = await ev(`[...document.querySelectorAll('.board-bar__rangegrp')].map((g) => g.textContent.replace(/\\s+/g, ' ').trim())`);
    must(J(t) === J(['WidthMinMax', 'HeightMinMax']), 'labels: ' + J(t));
  });
  await check('Range: drag and resize still land on the right cell in a scrolled ranged board', async () => {
    await setRange('Min height', ''); await setRange('Max height', '300'); await setRange('Max width', '1000'); await setRange('Min width', '');
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().height === 300`, 'height 300');
    await ev(`(() => { const g = document.getElementById('board-grid'); g.scrollTop = g.scrollHeight; return true; })()`);
    await b.sleep(200);
    const top = await ev(`document.getElementById('board-grid').scrollTop`);
    must(top > 100, 'grid did not scroll: ' + top);
    const hOf = () => store(`return st.activeDashboard().widgets[0].h;`);
    const h0 = await hOf();
    const g = await ev(`(() => { const w = document.querySelector('.board-widget'); const r = w.querySelector('.board-widget__resize').getBoundingClientRect(); const gr = document.getElementById('board-grid').getBoundingClientRect(); const h = w.getBoundingClientRect().height; return { x: Math.round(r.left + r.width - 4), y: Math.round(r.top + r.height - 4), h, gt: gr.top, gb: gr.bottom }; })()`);
    must(g.y > g.gt && g.y < g.gb, 'grip not visible after scroll: ' + J(g));
    const step = (g.h + 8) / h0, dy = -Math.round(2 * step);
    const mouse = (type, x, y) => b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    await mouse('mouseMoved', g.x, g.y); await mouse('mousePressed', g.x, g.y);
    for (let i = 1; i <= 6; i++) await mouse('mouseMoved', g.x, g.y + (dy * i) / 6);
    await mouse('mouseReleased', g.x, g.y + dy);
    await waitFor(`true`, 'settle'); await b.sleep(300);
    const h1 = await hOf();
    must(Math.abs((h0 - h1) - 2) <= 1 && h1 < h0, `resize by 2 rows from ${h0} gave ${h1} (scroll offset ignored?)`);
  });
  await check('Range: dropping a worksheet from the side panel onto a scrolled ranged board lands at the cell under the pointer', async () => {
    await store(`const d = st.activeDashboard(); st.setWidgets(d.id, d.widgets.map((w, i) => ({ ...w, h: i === 0 ? 8 : 2 })));`);
    await ev(`(() => { const g = document.getElementById('board-grid'); g.scrollTop = 250; return true; })()`);
    await b.sleep(200);
    const m = await ev(`(() => { const g = document.getElementById('board-grid'), gr = g.getBoundingClientRect(), ws = [...document.querySelectorAll('.board-widget')].map((e) => e.getBoundingClientRect());
      const step = (ws[0].height + 8) / 8; return { left: ws[1].left, top: gr.top, st: g.scrollTop, step }; })()`);
    must(m.st > 100, 'did not scroll: ' + J(m));
    const p = { x: Math.round(m.left + 10), y: Math.round(m.top - m.st + 5 * m.step + 10) }; // content row 5, column 6
    const fire = (type, sel, pt, dt) => `document.querySelector(${J(sel)}).dispatchEvent(new DragEvent(${J(type)}, { bubbles: true, cancelable: true, dataTransfer: ${dt}, clientX: ${pt?.x ?? 0}, clientY: ${pt?.y ?? 0} }))`;
    await ev(`(() => { window.__dt = new DataTransfer(); ${fire('dragstart', '.board-panel__item[data-sheet-id]', null, 'window.__dt')}; ${fire('drop', '#board-scroll', p, 'window.__dt')}; return true; })()`);
    await waitFor(`document.querySelectorAll('.board-widget').length === 3`, 'dropped widget added');
    const [x, y] = await store(`const w = st.activeDashboard().widgets.at(-1); return [w.x, w.y];`);
    must(x === 6 && y === 5, `landed at col ${x}, row ${y}; wanted 6, 5 (scroll offset ignored?)`);
    await store(`const d = st.activeDashboard(); st.setWidgets(d.id, d.widgets.slice(0, 2));`);
  });
  await check('Range: survives a reload; a fixed size wins and drops it', async () => {
    await b.sleep(700);
    await b.send('Page.reload');
    await connect();
    await waitFor(`document.querySelectorAll('.board-widget').length === 2`, 'widgets restored');
    must(await ev(`document.querySelector('.board-bar__size').value`) === 'range', 'select not Range');
    await pick('800x600');
    await waitFor(`!document.getElementById('board-grid').classList.contains('is-ranged') && document.getElementById('board-grid').getBoundingClientRect().width === 800`, 'fixed wins');
    must(await ev(`document.querySelector('.board-bar__range').hidden`), 'inputs still shown');
    await pick('auto');
  });

  await check('Custom: exact width and height; a bad pair is refused in place (size kept); valid applies, saves and survives a reload', async () => {
    await pick('custom');
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().width === 1000`, 'custom default 1000');
    const setIn = (k, v) => ev(`(() => { const i = document.querySelector('[aria-label="Custom ${k} in pixels"]'); i.value = ${J(String(v))}; i.dispatchEvent(new Event('change')); return true; })()`);
    await setIn('width', 99999);
    await b.sleep(150);
    must(await ev(`document.querySelector('[aria-label="Custom width in pixels"]').getAttribute('aria-invalid')`) === 'true', 'width not flagged');
    must(await ev(`document.getElementById('board-grid').getBoundingClientRect().width`) === 1000, 'size changed on a refused value');
    await setIn('width', 1111); await setIn('height', 555);
    await waitFor(`(() => { const r = document.getElementById('board-grid').getBoundingClientRect(); return r.width === 1111 && r.height === 555; })()`, 'custom applied');
    must(await ev(`document.querySelector('.board-bar__size').value`) === 'custom', 'select not Custom');
    await waitFor(`(() => { const v = localStorage.getItem(${J(KEY)}); const s = v && JSON.parse(v).dashboards[0].size; return s?.width === 1111 && s?.height === 555; })()`, 'autosaved');
    await shot('board-size-custom.png');
    await b.sleep(700);
    await b.send('Page.reload');
    await connect();
    await waitFor(`document.getElementById('board-grid').getBoundingClientRect().width === 1111`, 'custom after reload');
    must(await ev(`document.querySelector('[aria-label="Custom height in pixels"]').value`) === '555', 'height input not restored');
    await pick('1280x720');
    await pick('custom');
    await waitFor(`!document.querySelector('[aria-label="Custom width in pixels"]').closest('.board-bar__range').hidden`, 'preset -> Custom shows the inputs');
    must(await ev(`document.querySelector('.board-bar__size').value`) === 'custom', 'select snapped back');
    await pick('1280x720');
    must(await ev(`[...document.querySelectorAll('.board-bar__range')].every((e) => e.hidden)`), 'inputs still shown on a preset');
    await pick('auto');
  });

  await check('screenshot: dark, range', async () => {
    await pick('range'); await b.setScheme('dark'); await b.sleep(400);
    await shot('board-size-range-dark.png');
    await b.setScheme('light');
  });
  await check('screenshot: dark, fixed', async () => {
    await pick('1280x720'); await b.setScheme('dark'); await b.sleep(400);
    await shot('board-size-fixed-dark.png');
    await b.setScheme('light');
  });

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
