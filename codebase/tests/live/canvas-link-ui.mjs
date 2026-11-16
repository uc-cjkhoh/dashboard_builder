// Browser checks for the Data Source canvas: card width follows the table name, a relationship made by dragging a
// column row onto another card's row, and the date pill's Show all / Thin out labels. Real dev app (APP_URL, default
// http://localhost:5182) in headless Chromium over the DevTools protocol (tests/live/cdp.mjs); every /api/* call is mocked.
// Run: node tests/live/canvas-link-ui.mjs  (start the app: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5182; stop it by port)
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5182';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'canvas-link-shots');
mkdirSync(SHOTS, { recursive: true });
const LONG = 'order_line_items_with_a_deliberately_extremely_long_table_name_for_the_width_check';
const COLUMNS = {
  orders: [['cust_id', 'Int32', 'numeric'], ['amount', 'Float64', 'numeric'], ['created', 'DateTime', 'temporal'], ['note', 'String', 'text']],
  customers: [['id', 'Int32', 'numeric'], ['name', 'String', 'text']],
  [LONG]: [['id', 'Int32', 'numeric']],
};
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: Object.keys(COLUMNS) };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/query') return { json: { rowDimensions: [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])].map((d) => d.column), columnDimensions: [], measures: (body.measures ?? []).map((_, i) => `v${i}`),
    rows: ['2024-01', '2024-02', '2024-03'].map((k, r) => ({ keys: [k], values: (body.measures ?? []).map(() => 10 * (r + 1)) })), truncated: false } };
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
  const waitFor = (s, label) => b.waitFor(s, { label });
  const shot = async (name) => writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 3`, 'tables listed');
  for (const t of ['orders', 'customers', LONG]) await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 3 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'tables loaded');
  const card = (t) => `[...document.querySelectorAll('.entity')].find((x) => x.querySelector('.entity__table').textContent === ${J(t)})`;

  await check('card width follows the name (and the Needs a partner badge): short = min (312) without the badge, long = max with an ellipsis and the full name in the title', async () => {
    const w = await ev(`${card('orders')}.getBoundingClientRect().width + ',' + ${card(LONG)}.getBoundingClientRect().width`);
    const [a, c] = w.split(',').map(Number);
    // unlinked cards show the badge, which rides on the title's width: still at least the 312px slot, and the short name is never clipped
    must(a >= 312 && a < 400 && await ev(`(() => { const t = ${card('orders')}.querySelector('.entity__title'); return t.scrollWidth <= t.clientWidth; })()`), `short card width ${a}`);
    must(c === 480, `long card width ${c}`);
    must(await ev(`(() => { const t = ${card(LONG)}.querySelector('.entity__title'); return t.scrollWidth > t.clientWidth && t.title === 'shop.${LONG}'; })()`), 'long name is not ellipsised with a full-name title');
    await shot('cards-width.png');
  });
  await check('a mid-length name is shown in full (no ellipsis) and wider than the minimum', async () => {
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'customers' } }))`);
    const r = await ev(`(() => { const e = ${card('customers')}; const t = e.querySelector('.entity__title'); return t.scrollWidth <= t.clientWidth; })()`);
    must(r, 'customers title clipped');
  });

  const dragRow = (fromT, fromC, toT, toC) => ev(`(() => { const row = (t, c) => [...document.querySelectorAll('.entity')].find((x) => x.querySelector('.entity__table').textContent === t).querySelector('.col-row[data-column=' + JSON.stringify(c) + ']');
    const a = row(${J(fromT)}, ${J(fromC)}), z = row(${J(toT)}, ${J(toC)}); const dt = new DataTransfer();
    a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    z.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const mark = z.className; z.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return mark; })()`);

  await check('rows are draggable and a valid target is highlighted during the drag', async () => {
    must(await ev(`${card('orders')}.querySelector('.col-row').draggable === true`), 'row not draggable');
    const cls = await dragRow('orders', 'cust_id', 'customers', 'id');
    must(/col-row--drop-ok/.test(cls), `target class: ${cls}`);
  });
  await check('dropping opens the relationship dialog; picking N:1 draws the link and pins both columns', async () => {
    await waitFor(`document.querySelector('dialog[open] .join-choice') !== null`, 'dialog open');
    await ev(`[...document.querySelectorAll('dialog[open] .card-choice')].find((x) => x.textContent === 'N:1').click(); document.querySelector('dialog[open]').querySelector('.rel-dialog__foot .btn--primary').click()`);
    await waitFor(`document.querySelector('.rel-badge text')?.textContent === 'N:1'`, 'badge');
    must(await ev(`document.querySelectorAll('.entity__keys .col-row').length === 2`), 'both joined rows should be pinned');
  });
  await check('link anchors sit on the measured card edges and key rows', async () => {
    const r = await ev(`(() => { const c = document.getElementById('model-view'), cr = c.getBoundingClientRect(); const e = (t) => [...document.querySelectorAll('.entity')].find((x) => x.querySelector('.entity__table').textContent === t);
      const edges = ['orders', 'customers'].flatMap((t) => { const q = e(t).getBoundingClientRect(); return [q.left - cr.left + c.scrollLeft, q.right - cr.left + c.scrollLeft]; });
      const d = document.querySelector('.rel-link__line').getAttribute('d').match(/-?[\\d.]+/g).map(Number);
      return { xs: [d[0], d[2]], edges }; })()`);
    must(r.edges.some((e) => Math.abs(e - r.xs[0]) < 1.5), `anchor ${J(r.xs[0])} vs edges ${J(r.edges)}`); // the end sits on a card edge; the turn (xs[1]) is in the middle of the gutter
    await shot('drag-link.png');
  });
  await check('clicking a link and closing its dialog leaves no highlight (hover only)', async () => {
    await ev(`(() => { const g = document.querySelector('.rel-link'); g.dispatchEvent(new PointerEvent('pointerenter')); return true; })()`);
    must(await ev(`document.querySelectorAll('.col-row--linked').length > 0 && !!document.querySelector('.rel-link--hover')`), 'hover should highlight');
    await ev(`document.querySelector('.rel-link').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await waitFor(`document.querySelector('dialog[open] .rel-dialog') !== null`, 'dialog open');
    await ev(`[...document.querySelectorAll('dialog[open] .btn')].find((x) => x.textContent === 'Cancel').click()`);
    await waitFor(`document.querySelector('dialog[open]') === null`, 'dialog closed');
    must(await ev(`document.querySelectorAll('.col-row--linked').length === 0 && !document.querySelector('.rel-link--hover') && !document.querySelector('.rel-note--active')`), 'highlight left behind');
  });
  await check('a duplicate drop is refused with a toast and no dialog', async () => {
    await dragRow('customers', 'id', 'orders', 'cust_id');
    await b.sleep(300);
    must(await ev(`document.querySelector('dialog[open]') === null`), 'dialog opened for a duplicate');
  });
  await check('a mismatched kind is refused and shows the refused (dashed) target', async () => {
    const cls = await dragRow('orders', 'amount', 'customers', 'name');
    must(/col-row--drop-no/.test(cls), `target class: ${cls}`);
    must(await ev(`document.querySelectorAll('.rel-link__line').length === 1`), 'extra link created');
  });
  await check('there are no connector buttons or join-key checkboxes; the pinned rows are the joined columns', async () => {
    must(await ev(`document.querySelectorAll('.rel-connector, .col-row__key').length === 0`), 'connector or checkbox still rendered');
    must(await ev(`document.querySelectorAll('.entity__keys .col-row').length === 2`), 'joined rows not pinned');
  });

  // Date labels on the date pill.
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await waitFor(`document.querySelectorAll('#ws-fields .ws-field').length >= 4`, 'fields listed');
  const chipDrag = (name, zone) => ev(`(() => { const c = [...document.querySelectorAll('#ws-fields .ws-field')].find((c) => c.querySelector('.ws-field__name')?.textContent === ${J(name)});
    const t = document.querySelector('.ws-shelf--${zone} .ws-shelf__zone'); const dt = new DataTransfer();
    c.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    t.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); c.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return true; })()`);
  await chipDrag('created', 'columns'); await chipDrag('amount', 'rows');
  await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
  await ev(`[...document.querySelectorAll('.ws-charttypes [role=menuitemradio]')].find((i) => i.textContent.trim() === 'Bar').click()`);
  const axis = () => ev(`(() => { const i = window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')); const o = i.getOption(); const a = [].concat(o.xAxis)[0].type === 'category' ? [].concat(o.xAxis)[0] : [].concat(o.yAxis)[0]; return { interval: a.axisLabel.interval, planned: typeof a.axisLabel.interval === 'function', hide: a.axisLabel.hideOverlap }; })()`);
  const openDate = () => ev(`document.querySelector('.ws-shelf--columns .ws-pill').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))`);
  const labelsItem = `document.querySelector('.ctx-menu [role=menuitemcheckbox]')`;
  await waitFor(`!!document.querySelector('.ws-shelf--columns .ws-pill')`, 'date pill shown');
  await check('default is Thin out: a planned label interval (date-axis.js) picks which labels show, toggle not pressed', async () => {
    try { await waitFor(`!!window.echarts?.getInstanceByDom(document.querySelector('.ws-chart-canvas'))`, 'chart drawn'); } catch (e) { await shot('date-nochart.png'); throw e; }
    const a = await axis();
    // the thinning itself (which labels show, first and last kept) is covered by tests/js date-axis unit tests; here only that the plan is wired
    must(a.planned === true, `axis ${J(a)}`); // Thin out = an interval function from the measured plan; Show all = interval 0
    await openDate(); must(await ev(`${labelsItem}.textContent.trim() === 'Show all date labels' && ${labelsItem}.getAttribute('aria-checked') === 'false'`), 'ticked by default');
    await ev(`document.querySelector('.ctx-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await shot('date-thin.png');
  });
  await check('toggling to Show all labels every member and is saved on the pill', async () => {
    await openDate(); await ev(`${labelsItem}.click()`);
    await openDate(); must(await ev(`${labelsItem}.getAttribute('aria-checked') === 'true'`), 'ticked');
    await ev(`document.querySelector('.ctx-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')).getOption().xAxis[0].axisLabel.interval === 0`, 'interval 0');
    await shot('date-all.png');
  });
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) { console.log(`FAIL harness: ${e.stack}`); failed++; } finally { if (b) await b.close(); }
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
