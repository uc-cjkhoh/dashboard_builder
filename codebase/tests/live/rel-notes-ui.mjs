// Browser check for the Relationships card height: it is as tall as its text (opening a dropdown grows it) and scrolls inside only
// once it would pass the bottom of the Data Source. Real dev app (APP_URL, default http://localhost:5231) in headless Chromium, every
// /api/* call mocked. Run:  node tests/live/rel-notes-ui.mjs   (start the app first, stop it by port).
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5231';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'agg-ui-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['cust_id', 'Int32', 'numeric'], ['amount', 'Float64', 'numeric']],
  customers: [['id', 'Int32', 'numeric'], ['name', 'String', 'text'], ['alt_id', 'Int32', 'numeric']], // alt_id: a column can be in one relationship only
  order_line_items_with_a_deliberately_long_table_name: [['cust_id', 'Int32', 'numeric']],
};
const queries = [];
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders', 'customers'] };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/query') {
    queries.push(body);
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: [], measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: ['Ann', 'Bo', null].map((k, r) => ({ keys: dims.map(() => k), values: (body.measures ?? []).map(() => 10 * (r + 1)) })), truncated: false } };
  }
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const J = JSON.stringify;

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const settle = async (quiet = 300) => { let n = -1; for (let i = 0; i < 60 && n !== queries.length; i++) { n = queries.length; await b.sleep(quiet); } };
  const shot = async (name) => writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders', 'customers'])
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'both tables loaded');
  const dragRow = (fromT, fromC, toT, toC) => ev(`(() => { const row = (t, c) => [...document.querySelectorAll('.entity')].find((x) => x.textContent.includes(t)).querySelector('.col-row[data-column=' + JSON.stringify(c) + ']');
    const a = row(${J(fromT)}, ${J(fromC)}), z = row(${J(toT)}, ${J(toC)}); const dt = new DataTransfer();
    a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); z.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    z.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return true; })()`);
  await dragRow('orders', 'cust_id', 'customers', 'id'); // relationships are made by dragging one column onto another
  await waitFor(`document.querySelector('dialog[open] .join-choice') !== null`, 'relationship dialog open');

  const dlg = `document.querySelector('dialog[open]')`;
  await ev(`${dlg}.querySelector('.rel-dialog__foot .btn--primary').click()`);
  await waitFor(`!!document.querySelector('.rel-notes') && !document.querySelector('.rel-notes').hidden`, 'card shown');
  const m = () => ev(`(() => { const c = document.querySelector('.rel-notes'), l = c.querySelector('.rel-notes__list'), v = c.parentElement.getBoundingClientRect(), r = c.getBoundingClientRect();
    return { card: Math.round(r.height), gapBottom: Math.round(v.bottom - r.bottom), scrolls: l.scrollHeight > l.clientHeight + 1, listScroll: l.scrollHeight, listClient: l.clientHeight }; })()`);
  await check('a closed dropdown: the card fits its rows, no scrollbar', async () => {
    const x = await m();
    must(!x.scrolls && x.card < 200, `card ${J(x)}`);
  });
  const closedH = (await m()).card;
  await check('opening the dropdown grows the card, still no scrollbar', async () => {
    await ev(`document.querySelector('.rel-note__more > summary').click()`); await b.sleep(300);
    const x = await m();
    must(x.card > closedH && !x.scrolls, `grew ${closedH} -> ${J(x)}`);
    await shot('rel-notes-open.png');
  });
  await check('clicking the card header collapses it to the header and opens it again', async () => {
    const vis = `(() => { const l = document.querySelector('.rel-notes__list'); return l.getClientRects().length > 0 && l.checkVisibility(); })()`;
    await ev(`document.querySelector('.rel-notes > summary').click()`); await b.sleep(300);
    const shut = await m(), shown = await ev(vis);
    must(shut.card <= 42 && !shown, `collapsed ${J(shut)} list visible ${shown}`);
    await ev(`document.querySelector('.rel-notes > summary').click()`); await b.sleep(300);
    const back = await m();
    must(back.card > shut.card && await ev(vis), `reopened ${J(back)}`);
  });
  await check('a long table name ellipsises in the card: the width stays 288px and the whole link is a tooltip', async () => {
    const LONG = 'order_line_items_with_a_deliberately_long_table_name';
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(LONG)} } }))`);
    await waitFor(`document.querySelectorAll('.entity').length === 3 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'long table loaded');
    await dragRow(LONG, 'cust_id', 'customers', 'alt_id');
    await waitFor(`document.querySelector('dialog[open] .join-choice') !== null`, 'second relationship dialog');
    await ev(`${dlg}.querySelector('.rel-dialog__foot .btn--primary').click()`);
    await waitFor(`document.querySelectorAll('.rel-note').length === 2`, 'two notes');
    const x = await ev(`(() => { const c = document.querySelector('.rel-notes'), r = c.getBoundingClientRect(), v = c.parentElement.getBoundingClientRect();
      const t = [...c.querySelectorAll('.rel-note__title')].find((e) => e.textContent.startsWith('order_line_items'));
      return { w: Math.round(r.width), right: Math.round(v.right - r.right), cut: t.scrollWidth > t.clientWidth, tip: t.title, text: t.textContent }; })()`);
    must(x.w === 288 && x.right === 16, `card ${J(x)}`);
    must(x.cut && x.tip === x.text && /order_line_items.* → customers$/.test(x.tip), `title ${J(x)}`);
    await shot('rel-notes-long-name.png');
  });
  await check('many long entries: the card stops 16px above the bottom of the Data Source and the list scrolls inside', async () => {
    await ev(`(() => { const ul = document.querySelector('.rel-notes__list'); const li = ul.firstElementChild; for (let i = 0; i < 12; i++) { const c = li.cloneNode(true); c.querySelector('details').open = true; ul.append(c); } return true; })()`);
    await b.sleep(300);
    const x = await m();
    must(x.scrolls && x.gapBottom === 16, `long ${J(x)}`);
    await shot('rel-notes-long.png');
  });
  await check('the card never goes past the bottom in a short window', async () => {
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 520, deviceScaleFactor: 1, mobile: false }); await b.sleep(300);
    const x = await m();
    must(x.gapBottom >= 16 - 1 && x.scrolls, `short ${J(x)}`);
  });
  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log('ERROR: ' + e.message); failed++;
} finally {
  await b?.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
