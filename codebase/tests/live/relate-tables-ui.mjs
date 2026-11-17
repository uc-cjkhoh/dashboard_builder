// Browser checks for relating tables in few steps (D127): proposed links, "Needs a partner" as a button and the table picker, the card's
// link button dragged onto another card (compound key pre-filled), and dragging two more columns of related tables (one more key pair, Undo).
// Real dev app (APP_URL, default http://localhost:5223) in headless Chromium over the DevTools protocol (tests/live/cdp.mjs); /api/* is mocked.
// Run: node tests/live/relate-tables-ui.mjs  (start the app: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5223; stop it by port)
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5223';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'relate-shots');
mkdirSync(SHOTS, { recursive: true });
const COLUMNS = {
  orders: [['id', 'Int32', 'numeric'], ['customer_id', 'Int32', 'numeric'], ['store_id', 'Int32', 'numeric'], ['region', 'String', 'text'], ['amount', 'Float64', 'numeric']],
  customers: [['id', 'Int32', 'numeric'], ['region', 'String', 'text'], ['name', 'String', 'text']],
  stores: [['store_id', 'Int32', 'numeric'], ['city', 'String', 'text'], ['opened', 'Date', 'temporal']],
  sales: [['store_id', 'Int32', 'numeric'], ['sku_code', 'String', 'text'], ['day', 'Date', 'temporal'], ['qty', 'Int32', 'numeric']],
  stock: [['store_id', 'Int32', 'numeric'], ['sku_code', 'String', 'text'], ['day', 'Date', 'temporal'], ['on_hand', 'Int32', 'numeric']],
};
const side = { rows: 100, nullRows: 0, keys: 100, matchedKeys: 90, matchedRows: 90, maxDuplicates: 1, avgDuplicates: 1 };
function answer({ method, path }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: Object.keys(COLUMNS) };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/relationships/preview') return { json: { from: side, to: { ...side, maxDuplicates: 1 }, sampleLimit: 1000000, sampled: false } };
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) { try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; } }
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;
let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined, width: 1440, height: 860 });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const shot = async (name) => writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  await b.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 5`, 'tables listed');
  const add = async (t, n) => {
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
    await waitFor(`document.querySelectorAll('.entity').length === ${n} && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, `${t} loaded`);
    await pause(400);
  };
  const card = (t) => `[...document.querySelectorAll('.entity')].find((x) => x.querySelector('.entity__table').textContent === ${J(t)})`;
  const row = (t, c) => `${card(t)}.querySelector('.col-row[data-column=' + ${J(JSON.stringify(c))} + ']')`;
  const dlg = `document.querySelector('dialog[open]')`;
  const confirm = () => ev(`(() => { [...${dlg}.querySelectorAll('button')].find((y) => y.textContent.trim() === 'Confirm').click(); return true; })()`);
  const rels = () => ev(`document.querySelectorAll('.rel-note').length`);
  const toastText = () => ev(`document.getElementById('toast').textContent`);
  // HTML5 drag and drop with one DataTransfer, as the browser would hand it from dragstart to drop
  const drag = (src, dst) => ev(`(() => { const s = ${src}, d = ${dst}; const dt = new DataTransfer();
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire(s, 'dragstart'); fire(d, 'dragover'); fire(d, 'drop'); fire(s, 'dragend'); return true; })()`);

  await add('orders', 1);
  await add('customers', 2);
  await check('two tables: both need a partner (a button) and a proposed link offers the key the names point to', async () => {
    must(await ev(`${card('orders')}.querySelector('.entity__need').tagName === 'BUTTON' && !${card('orders')}.querySelector('.entity__need').hidden`), 'need button');
    await waitFor(`document.querySelector('.rel-ghost') !== null`, 'proposed link');
    must(await ev(`document.querySelector('.rel-ghost__go').textContent.trim()`) === 'Relate on customer_id = id', 'ghost text');
    must(await ev(`document.querySelectorAll('.rel-ghost__line').length`) === 1, 'dashed line');
    await shot('1-proposed-link.png');
  });
  await check('clicking the proposal opens the dialog filled in (N:1 from the names); Confirm draws the link and the proposal goes', async () => {
    // a real mouse press and release (not element.click()), so the canvas's own pointer handlers run too
    const at = await ev(`(() => { const r = document.querySelector('.rel-ghost__go').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await waitFor(`${dlg}?.querySelector('.rel-dialog__sub') != null`, 'dialog');
    must(await ev(`${dlg}.querySelector('.rel-dialog__sub').textContent`) === 'orders → customers', 'tables');
    must(await ev(`${dlg}.querySelector('input[name=cardinality]:checked').value`) === 'N:1', 'cardinality');
    await waitFor(`${dlg}.querySelector('.join-check__pick') !== null`, 'suggestion');
    await pause(500); await shot('2-dialog-from-proposal.png');
    await confirm();
    await waitFor(`!document.querySelector('dialog[open]') && document.querySelectorAll('.rel-note').length === 1`, 'saved');
    must(await ev(`document.querySelector('.rel-ghost') === null`), 'ghost gone');
  });
  await check('dragging two more columns of related tables adds a key pair to that relationship, with Undo', async () => {
    await drag(row('orders', 'region'), row('customers', 'region'));
    await waitFor(`/Added region = region to orders → customers \\(2 keys\\)/.test(document.getElementById('toast').textContent)`, 'toast');
    must(await rels() === 1, 'still one relationship');
    must(await ev(`[...document.querySelectorAll('.rel-badge text')].some((t) => t.textContent === 'N:1 · 2 keys')`), 'badge counts keys');
    must(await ev(`!!${card('customers')}.querySelector('.entity__keys .col-row[data-column="region"]')`), 'region pinned');
    await shot('3-extend-by-drag.png');
    await ev(`[...document.querySelectorAll('#toast button')].find((x) => x.textContent === 'Undo').click()`);
    await waitFor(`[...document.querySelectorAll('.rel-badge text')].some((t) => t.textContent === 'N:1')`, 'undo');
    await drag(row('orders', 'region'), row('customers', 'region')); // put it back for the next shots
    await waitFor(`[...document.querySelectorAll('.rel-badge text')].some((t) => t.textContent === 'N:1 · 2 keys')`, 'again');
  });
  await check('from the keyboard, a refused pair between related tables still says why', async () => {
    await ev(`(() => { const r = ${row('orders', 'amount')}; r.focus(); r.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
    await ev(`${row('customers', 'name')}.focus()`); // text vs number: refused with the reason
    must(/Can't relate/.test(await ev(`document.querySelector('.rel-keyhint').textContent`)), 'refusal hint');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  });
  await check('Undo of a removed relationship is skipped once the two tables are related again (one per table pair)', async () => {
    const before = await ev(`document.querySelector('.rel-note').dataset.rel`);
    await ev(`document.querySelector('.rel-link[data-rel=' + JSON.stringify(${J('')} + document.querySelector('.rel-note').dataset.rel) + '] .rel-link__hit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await waitFor(`!!${dlg}?.querySelector('.btn--danger')`, 'edit dialog');
    await ev(`${dlg}.querySelector('.btn--danger').click()`);
    await waitFor(`document.querySelectorAll('.rel-note').length === 0`, 'removed');
    const undo = await ev(`(() => { const u = [...document.querySelectorAll('#toast button')].find((x) => x.textContent === 'Undo'); window.__undo = u; return !!u; })()`);
    must(undo, 'undo offered');
    await drag(row('orders', 'region'), row('customers', 'region')); // relate the two tables again, on other columns than the removed link's
    await waitFor(`!!${dlg}?.querySelector('.rel-dialog__sub')`, 'dialog');
    await confirm();
    await waitFor(`document.querySelectorAll('.rel-note').length === 1`, 'related again');
    await ev(`(() => { const t = document.getElementById('toast'); t.hidden = false; t.append(window.__undo); window.__undo.click(); return true; })()`);
    await pause(200);
    must(await rels() === 1, `two relationships for one table pair (was ${before})`);
    await drag(row('orders', 'customer_id'), row('customers', 'id')); // back to two keys for the next checks
    await waitFor(`[...document.querySelectorAll('.rel-badge text')].some((t) => / · 2 keys$/.test(t.textContent))`, 'two keys');
  });
  await add('stores', 3);
  await check('"Needs a partner" opens "Relate stores to", the likeliest table first with its key', async () => {
    await ev(`${card('stores')}.querySelector('.entity__need').click()`);
    await waitFor(`${dlg}?.classList.contains('rel-pick')`, 'picker');
    must(await ev(`${dlg}.querySelector('#rel-pick-title').textContent`) === 'Relate stores to', 'title');
    const items = await ev(`[...${dlg}.querySelectorAll('.rel-pick__item')].map((x) => [x.querySelector('.rel-pick__name').textContent, x.querySelector('.rel-pick__key').textContent, x.disabled])`);
    must(J(items) === J([['orders', 'store_id = store_id', false], ['customers', 'No matching columns', true]]), J(items));
    await pause(500); await shot('4-needs-a-partner-picker.png');
    await ev(`${dlg}.querySelector('.rel-pick__item').click()`);
    await waitFor(`${dlg}?.querySelector('.rel-dialog__sub')?.textContent === 'stores → orders'`, 'dialog');
    await confirm();
    await waitFor(`document.querySelectorAll('.rel-note').length === 2`, 'saved');
  });
  await add('sales', 4);
  await add('stock', 5);
  await check('dragging the link button of a card onto another card opens the dialog with every same-named key already matched', async () => {
    await shot('5-before-handle-drag.png');
    await drag(`${card('sales')}.querySelector('.entity__relate')`, `${card('stock')}.querySelector('.entity__title')`);
    await waitFor(`${dlg}?.querySelector('.rel-dialog__sub')?.textContent === 'sales → stock'`, 'dialog');
    const chips = await ev(`[...${dlg}.querySelectorAll('.key-pairs__item span')].map((x) => x.textContent)`);
    must(J(chips) === J(['sku_code = sku_code']), J(chips));
    const sug = await ev(`[...${dlg}.querySelectorAll('.key-pairs__suggestion')].map((x) => x.textContent.trim())`);
    must(J(sug) === J(['Add day = day']), J(sug));
    await waitFor(`${dlg}.querySelector('.join-check__pick') !== null`, 'suggestion');
    await ev(`${dlg}.querySelector('.rel-sec--pairs').scrollIntoView({ block: 'end' })`);
    await pause(500); await shot('6-handle-drag-compound.png');
    await confirm();
    await waitFor(`document.querySelectorAll('.rel-note').length === 3`, 'saved');
    must(await ev(`[...document.querySelectorAll('.rel-badge text')].some((t) => /2 keys/.test(t.textContent) && t.closest('[data-rel]'))`), 'badge');
    await pause(300);
    await shot('7-final-model.png');
  });
  await check('the link button opens the picker from the keyboard; an already related table opens its relationship', async () => {
    await ev(`${card('sales')}.querySelector('.entity__relate').click()`);
    await waitFor(`${dlg}?.classList.contains('rel-pick')`, 'picker');
    const first = await ev(`[...${dlg}.querySelectorAll('.rel-pick__item')][0].textContent`);
    must(/stock.*Related/.test(first), first);
    must(await ev(`document.activeElement.classList.contains('rel-pick__item')`), 'focus in list');
    await ev(`${dlg}.querySelector('.rel-pick__item').click()`);
    await waitFor(`${dlg}?.querySelector('.rel-dialog__sub')?.textContent === 'sales → stock' && !!${dlg}.querySelector('.btn--danger')`, 'edit dialog');
    await ev(`${dlg}.querySelector('[aria-label=Close]').click()`);
    await ev(`${card('stores')}.querySelector('.entity__relate').click()`); // two candidates: the picker
    await waitFor(`${dlg}?.classList.contains('rel-pick')`, 'picker');
    must(await ev(`[...${dlg}.querySelectorAll('button')].some((x) => x.textContent === 'Cancel')`), 'cancel');
  });
  void toastText;
} catch (e) { console.log(`FAIL harness: ${e.stack}`); failed++; } finally { if (b) await b.close(); }
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
