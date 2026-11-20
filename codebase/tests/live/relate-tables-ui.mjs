// Browser checks for relating tables in few steps (D127): proposed links, "Needs a partner" as a plain label (no table picker, no ☰ Relate item),
// a proposed link's compound key pre-filled, and dragging two more columns of related tables (one more key pair).
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
  await waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, 'databases listed');
  await ev(`(() => { for (const r of document.querySelectorAll('.db-row[data-db]')) if ((r.dataset.db === 'shop') !== (r.getAttribute('aria-expanded') === 'true')) r.click(); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 5`, 'tables listed');
  const add = async (t, n) => {
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
    await waitFor(`document.querySelectorAll('.entity').length === ${n} && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, `${t} loaded`);
    await pause(400);
  };
  const card = (t) => `[...document.querySelectorAll('.entity')].find((x) => x.querySelector('.entity__table').textContent === ${J(t)})`;
  const row = (t, c) => `${card(t)}.querySelector('.col-row[data-column=' + ${J(JSON.stringify(c))} + ']')`;
  const act = (c, label) => `(() => { ${c}.querySelector('.entity__menu').click(); const it = [...document.querySelectorAll('.ctx-menu [role^="menuitem"]')].find((x) => x.textContent.trim() === '${label}'); if (!it) throw new Error('no menu item ${label}'); it.click(); return true; })()`; // the card's ☰ menu (D129)
  const dlg = `document.querySelector('dialog[open]')`;
  const confirm = () => ev(`(() => { [...${dlg}.querySelectorAll('button')].find((y) => y.textContent.trim() === 'Confirm').click(); return true; })()`);
  const rels = () => ev(`document.querySelectorAll('.rel-link[data-rel]:not(.rel-link--label)').length`);
  const toastText = () => ev(`document.getElementById('toast').textContent`);
  // HTML5 drag and drop with one DataTransfer, as the browser would hand it from dragstart to drop
  const drag = (src, dst) => ev(`(() => { const s = ${src}, d = ${dst}; const dt = new DataTransfer();
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire(s, 'dragstart'); fire(d, 'dragover'); fire(d, 'drop'); fire(s, 'dragend'); return true; })()`);

  await add('orders', 1);
  await add('customers', 2);
  await check('two tables: both need a partner (a plain label) and a proposed link offers the key the names point to', async () => {
    must(await ev(`${card('orders')}.querySelector('.entity__need').tagName === 'SPAN' && !${card('orders')}.querySelector('.entity__need').hidden`), 'need label');
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
    await waitFor(`!document.querySelector('dialog[open]') && document.querySelectorAll('.rel-link[data-rel]:not(.rel-link--label)').length === 1`, 'saved');
    must(await ev(`document.querySelector('.rel-ghost') === null`), 'ghost gone');
  });
  await check('dragging two more columns of related tables adds a key pair to that relationship', async () => {
    await drag(row('orders', 'region'), row('customers', 'region'));
    await waitFor(`/Added region = region to orders → customers \\(2 keys\\)/.test(document.getElementById('toast').textContent)`, 'toast');
    must(await rels() === 1, 'still one relationship');
    must(await ev(`[...document.querySelectorAll('.rel-badge text')].some((t) => t.textContent === 'N:1 · 2 keys')`), 'badge counts keys');
    must(await ev(`!!${card('customers')}.querySelector('.entity__keys .col-row[data-column="region"]')`), 'region pinned');
    await shot('3-extend-by-drag.png');
  });
  await check('from the keyboard, a refused pair between related tables still says why', async () => {
    await ev(`(() => { const r = ${row('orders', 'amount')}; r.focus(); r.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
    await ev(`${row('customers', 'name')}.focus()`); // text vs number: refused with the reason
    must(/Can't relate/.test(await ev(`document.querySelector('.rel-keyhint').textContent`)), 'refusal hint');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  });
  await check('removing a relationship asks twice: Cancel on either dialog keeps it; confirming both removes it', async () => {
    const btn = (t) => `[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === ${J(t)})`;
    const bodyText = () => ev(`document.querySelector('dialog[open] .dialog__body')?.textContent ?? ''`);
    const openDelete = async () => { // the relationship's edit dialog, then its Delete button, which opens the first confirm
      await ev(`document.querySelector('.rel-link[data-rel=' + JSON.stringify(${J('')} + document.querySelector('.rel-link:not(.rel-link--label)').dataset.rel) + '] .rel-link__hit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
      await waitFor(`!!${dlg}?.querySelector('.btn--danger')`, 'edit dialog');
      await ev(`${dlg}.querySelector('.btn--danger').click()`);
      await waitFor(`/^Remove the .* relationship\\?/.test(document.querySelector('dialog[open] .dialog__body')?.textContent ?? '')`, 'first confirm');
    };
    await openDelete();
    await ev(`${btn('Cancel')}.click()`);
    await waitFor(`!document.querySelector('dialog[open]')`, 'first confirm cancelled');
    must(await rels() === 1, 'Cancel on the first dialog removed the relationship');
    await openDelete();
    await ev(`${btn('Remove')}.click()`);
    await waitFor(`(document.querySelector('dialog[open] .dialog__body')?.textContent ?? '').startsWith('Really remove the ')`, 'second confirm');
    must(/This can't be undone\.$/.test(await bodyText()), `second dialog text: ${await bodyText()}`);
    must(await ev(`!${btn('Remove')} && !!${btn('Remove for good')}`), 'second dialog button');
    must(await rels() === 1, 'the relationship was removed before the second confirm');
    await ev(`${btn('Cancel')}.click()`);
    await waitFor(`!document.querySelector('dialog[open]')`, 'second confirm cancelled');
    must(await rels() === 1, 'Cancel on the second dialog removed the relationship');
    await openDelete();
    await ev(`${btn('Remove')}.click()`);
    await waitFor(`(document.querySelector('dialog[open] .dialog__body')?.textContent ?? '').startsWith('Really remove the ')`, 'second confirm again');
    await ev(`${btn('Remove for good')}.click()`);
    await waitFor(`document.querySelectorAll('.rel-link[data-rel]:not(.rel-link--label)').length === 0`, 'removed');
    await drag(row('orders', 'region'), row('customers', 'region')); // relate the two tables again, on other columns than the removed link's
    await waitFor(`!!${dlg}?.querySelector('.rel-dialog__sub')`, 'dialog');
    await confirm();
    await waitFor(`document.querySelectorAll('.rel-link[data-rel]:not(.rel-link--label)').length === 1`, 'related again');
    must(await rels() === 1, 'one relationship per table pair');
    await drag(row('orders', 'customer_id'), row('customers', 'id')); // back to two keys for the next checks
    await waitFor(`[...document.querySelectorAll('.rel-badge text')].some((t) => / · 2 keys$/.test(t.textContent))`, 'two keys');
  });
  await add('stores', 3);
  await check('a card that needs a partner gets a proposed link; its dialog opens with the key the names point to', async () => {
    await waitFor(`document.querySelector('[aria-label^="Relate stores and orders"], [aria-label^="Relate orders and stores"]') !== null`, 'proposed link');
    await pause(500); await shot('4-needs-a-partner-proposal.png');
    await ev(`document.querySelector('[aria-label^="Relate stores and orders"], [aria-label^="Relate orders and stores"]').click()`);
    await waitFor(`${dlg}?.querySelector('.rel-dialog__sub')?.textContent === 'stores → orders'`, 'dialog');
    await confirm();
    await waitFor(`document.querySelectorAll('.rel-link[data-rel]:not(.rel-link--label)').length === 2`, 'saved');
  });
  await add('sales', 4);
  await add('stock', 5);
  await check('a proposed link opens the dialog with every same-named key already matched', async () => {
    await shot('5-before-relate.png');
    await waitFor(`document.querySelector('[aria-label^="Relate sales and stock"], [aria-label^="Relate stock and sales"]') !== null`, 'proposed link');
    await ev(`document.querySelector('[aria-label^="Relate sales and stock"], [aria-label^="Relate stock and sales"]').click()`);
    await waitFor(`${dlg}?.querySelector('.rel-dialog__sub')?.textContent === 'sales → stock'`, 'dialog');
    const chips = await ev(`[...${dlg}.querySelectorAll('.key-pairs__item span')].map((x) => x.textContent)`);
    must(J(chips) === J(['sku_code = sku_code']), J(chips));
    const sug = await ev(`[...${dlg}.querySelectorAll('.key-pairs__suggestion')].map((x) => x.textContent.trim())`);
    must(J(sug) === J(['Add day = day']), J(sug));
    await waitFor(`${dlg}.querySelector('.join-check__pick') !== null`, 'suggestion');
    await ev(`${dlg}.querySelector('.rel-sec--pairs').scrollIntoView({ block: 'end' })`);
    await pause(500); await shot('6-relate-compound.png');
    await confirm();
    await waitFor(`document.querySelectorAll('.rel-link[data-rel]:not(.rel-link--label)').length === 3`, 'saved');
    must(await ev(`[...document.querySelectorAll('.rel-badge text')].some((t) => /2 keys/.test(t.textContent) && t.closest('[data-rel]'))`), 'badge');
    await pause(300);
    await shot('7-final-model.png');
  });
  await check('the ☰ menu and the card head hold no relate action or table picker', async () => {
    await ev(`${card('sales')}.querySelector('.entity__menu').click()`);
    const items = await ev(`[...document.querySelectorAll('.ctx-menu [role^="menuitem"]')].map((x) => x.textContent.trim())`);
    must(!items.some((t) => /relate/i.test(t)), J(items));
    await b.key('Escape', { vk: 27 });
    must(await ev(`document.querySelector('.rel-pick') === null`), 'no picker');
  });
  void toastText;
} catch (e) { console.log(`FAIL harness: ${e.stack}`); failed++; } finally { if (b) await b.close(); }
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
