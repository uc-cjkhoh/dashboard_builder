// Browser checks for expandable table cards in the worksheet field pane (Core/edge-resize.js): hover a card's bottom border, click and drag to
// set its height; the height is remembered per table; double-click the border (or never dragging) leaves it automatic; Alt+↑/↓ on the header
// does the same from the keyboard. Real dev app (APP_URL, default http://localhost:5180) in headless Chromium, every /api/* call mocked. Run:
//   node tests/live/edge-resize-ui.mjs   (start the app first: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5180 ; stop it by port)
import { launch } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5180';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'edge-resize-shots');
mkdirSync(SHOTS, { recursive: true });

const COLUMNS = {
  orders: Array.from({ length: 40 }, (_, i) => [i % 4 ? `col_${i}` : `amt_${i}`, i % 4 ? 'String' : 'Int32', i % 4 ? 'text' : 'numeric']),
  customers: Array.from({ length: 5 }, (_, i) => [`c_${i}`, i ? 'String' : 'Int32', i ? 'text' : 'numeric']),
};
function answer({ method, path }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders', 'customers'] };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) { try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; } }
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined, height: 900 });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const shot = async (n) => writeFileSync(join(SHOTS, n), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const mouse = (type, x, y, buttons = 0) => b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0 });

  async function open() {
    await b.goto(APP + '/');
    await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
    await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
    await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
    for (const t of ['orders', 'customers']) await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
    await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'tables loaded');
    // the worksheet only lists tables that are in a relationship (a reload may restore it)
    if (!(await ev(`document.querySelectorAll('.rel-badge').length`))) {
    await ev(`(() => { const row = (t, c) => [...document.querySelectorAll('.entity')].find((x) => x.textContent.includes(t)).querySelector('.col-row[data-column=' + JSON.stringify(c) + ']');
      const a = row('orders', 'amt_0'), z = row('customers', 'c_0'); const dt = new DataTransfer();
      a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); z.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      z.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return true; })()`);
    await waitFor(`document.querySelector('dialog[open] .join-choice') !== null`, 'relationship dialog');
    await ev(`document.querySelector('dialog[open] .rel-dialog__foot .btn--primary').click()`);
    await waitFor(`document.querySelectorAll('.rel-badge').length === 1`, 'relationship drawn');
    }
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden && document.querySelectorAll('#ws-fields .ws-fieldset').length === 2`, 'two table cards');
    await b.sleep(800); // let the pane's entrance motion finish before the mouse moves over it
  }
  const card = (i = 0) => `document.querySelectorAll('#ws-fields .ws-fieldset')[${i}]`;
  const rect = (i = 0) => ev(`(() => { const r = ${card(i)}.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, h: r.height }; })()`);
  const height = async (i = 0) => (await rect(i)).h;
  const drag = async (i, dy) => {
    const r = await rect(i), x = r.left + 40, y = r.bottom - 2;
    await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 1);
    for (let s = 1; s <= 6; s++) await mouse('mouseMoved', x, y + (dy * s) / 6, 1);
    await mouse('mouseReleased', x, y + dy);
  };
  const stored = () => ev(`localStorage.getItem('dashboardbuilder.fields.heights')`);

  await open();
  await ev(`localStorage.removeItem('dashboardbuilder.fields.heights')`);
  const h0 = await height(0);

  await check('hovering the bottom border lights it and shows the resize cursor; the middle of the card does not', async () => {
    const r = await rect(0);
    await mouse('mouseMoved', r.left + 40, r.top + 60);
    must(!(await ev(`${card(0)}.classList.contains('is-edge')`)), 'edge lit in the middle');
    await mouse('mouseMoved', r.left + 40, r.bottom - 2);
    must(await ev(`${card(0)}.classList.contains('is-edge')`), 'edge not lit');
    must((await ev(`getComputedStyle(${card(0)}).cursor`)) === 'ns-resize', 'cursor ' + await ev(`getComputedStyle(${card(0)}).cursor`));
    await shot('edge-hover.png');
    await mouse('mouseMoved', r.left + 40, r.top + 60);
    must(!(await ev(`${card(0)}.classList.contains('is-edge')`)), 'edge stayed lit');
  });
  await check('dragging inside the card changes nothing', async () => {
    const r = await rect(0);
    await mouse('mouseMoved', r.left + 40, r.top + 80); await mouse('mousePressed', r.left + 40, r.top + 80, 1);
    await mouse('mouseMoved', r.left + 40, r.top + 140, 1); await mouse('mouseReleased', r.left + 40, r.top + 140);
    must(!(await ev(`${card(0)}.classList.contains('is-sized')`)), 'sized');
    must(Math.abs((await height(0)) - h0) < 1, 'height moved');
  });
  await check('dragging the border up makes the card shorter and it keeps that height', async () => {
    await drag(0, -50);
    const h = await height(0);
    must(Math.abs(h - (h0 - 50)) <= 2, `height ${h} vs ${h0 - 50}`);
    must(await ev(`${card(0)}.classList.contains('is-sized')`), 'not sized');
    must(!(await ev(`document.body.classList.contains('is-resizing-y')`)), 'body still resizing');
    await shot('edge-shrunk.png');
  });
  await check('the other card takes the freed room', async () => {
    const r0 = await rect(0), r1 = await rect(1);
    must(r1.top >= r0.bottom, 'overlap');
  });
  await check('dragging the border down makes it taller', async () => {
    const before = await height(0);
    await drag(0, 20);
    const h = await height(0);
    must(Math.abs(h - (before + 20)) <= 2, `height ${h} vs ${before + 20}`);
  });
  await check('a card never grows past its content', async () => {
    const before = await height(1);
    await drag(1, 200);
    const max = await ev(`(() => { const c = ${card(1)}; return c.scrollHeight + c.offsetHeight - c.clientHeight; })()`);
    must((await height(1)) <= max + 1, `grew past its content: ${await height(1)} > ${max} (was ${before})`);
    await ev(`${card(1)}.dispatchEvent(new Event('x'))`);
  });
  await check('it never shrinks below the two-row minimum', async () => {
    const r = await rect(0);
    await drag(0, -(r.h) - 20);
    const min = await ev(`parseFloat(getComputedStyle(${card(0)}).minHeight)`);
    must(min > 40 && Math.abs((await height(0)) - min) <= 1, `height ${await height(0)} min ${min}`);
  });
  await check('the height is remembered per table and survives a reload', async () => {
    await drag(0, 80);
    const h = await height(0);
    const saved = JSON.parse(await stored());
    must(Math.abs(saved['table:shop.orders'] - h) <= 2, 'stored ' + J(saved));
    await open();
    must(Math.abs((await height(0)) - h) <= 2, `after reload ${await height(0)} vs ${h}`);
    must(await ev(`${card(0)}.classList.contains('is-sized')`), 'card not sized after reload');
  });
  await check('double-clicking the border returns the card to automatic sizing', async () => {
    const r = await rect(0), x = r.left + 40, y = r.bottom - 2;
    await mouse('mouseMoved', x, y);
    for (const n of [1, 2]) { await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: n }); await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: n }); }
    must(!(await ev(`${card(0)}.classList.contains('is-sized')`)), 'still sized');
    must(!('table:shop.orders' in JSON.parse(await stored())), 'still stored ' + await stored());
    must(Math.abs((await height(0)) - h0) <= 2, `height ${await height(0)} vs ${h0}`);
  });
  await check('Alt+ArrowUp / Alt+ArrowDown on the card header resize it in 16px steps', async () => {
    await ev(`${card(0)}.querySelector('summary').focus()`);
    const before = await height(0);
    const alt = (key, vk) => b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 1 });
    await alt('ArrowUp', 38); await alt('ArrowUp', 38);
    must(Math.abs((await height(0)) - (before - 32)) <= 2, `after two ups ${await height(0)} vs ${before - 32}`);
    await alt('ArrowDown', 40);
    must(Math.abs((await height(0)) - (before - 16)) <= 2, `after a down ${await height(0)} vs ${before - 16}`);
    must(await ev(`${card(0)}.open`), 'the header toggled the card');
  });
  await check('a collapsed card has no grip', async () => {
    await ev(`${card(1)}.open = false`);
    await b.sleep(100);
    const r = await rect(1);
    await mouse('mouseMoved', r.left + 40, r.bottom - 2);
    must(!(await ev(`${card(1)}.classList.contains('is-edge')`)), 'collapsed card lit');
  });
  await b.setScheme('dark'); await mouse('mouseMoved', 10, 10); const rr = await rect(0); await mouse('mouseMoved', rr.left + 40, rr.bottom - 2); await b.sleep(200); await shot('edge-hover-dark.png'); await b.setScheme('light');
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
