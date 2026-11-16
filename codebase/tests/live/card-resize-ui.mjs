// Browser checks for resizing a Data Source card's column list by dragging its top or bottom edge (Canvas/card-height.js): the real dev app
// (APP_URL, default http://localhost:5236) in headless Chromium over the DevTools protocol (tests/live/cdp.mjs), every /api/* call mocked.
// Run:  node tests/live/card-resize-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5236 ; stop it with fuser -k 5236/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT, CHROME_BIN.
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5236';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'card-resize-shots');
mkdirSync(SHOTS, { recursive: true });

const COLUMNS = {
  wide: Array.from({ length: 40 }, (_, i) => [`col_${i}`, 'Int32', 'numeric']),
  small: [['id', 'Int32', 'numeric'], ['name', 'String', 'text']],
};
function answer({ method, path }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['wide', 'small'] };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const shot = async (name) => writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const send = (type, x, y, extra = {}) => b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, ...extra });
  const drag = async (x, y, dy) => {
    await send('mouseMoved', x, y); await send('mousePressed', x, y);
    for (let i = 1; i <= 6; i++) await send('mouseMoved', x, y + (dy * i) / 6, { buttons: 1 });
    await send('mouseReleased', x, y + dy);
  };

  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['wide', 'small']) await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: '${t}' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'both tables loaded');
  await b.sleep(1200); // entrance animation

  const card = (t) => `[...document.querySelectorAll('.entity')].find((e) => e.querySelector('.entity__table').textContent === '${t}')`;
  const rect = (t) => ev(`(() => { const r = ${card(t)}.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom }; })()`);
  const listH = (t) => ev(`${card(t)}.querySelector('.entity__cols').getBoundingClientRect().height`);

  await check('the edge strip is what the pointer finds at the top and bottom edge, with an ns-resize cursor', async () => {
    const r = await rect('wide');
    for (const [y, edge] of [[r.top + 2, 'top'], [r.bottom - 2, 'bottom']]) {
      const hit = await ev(`(() => { const el = document.elementFromPoint(${r.left + r.width / 2}, ${y}); return el.className + '|' + getComputedStyle(el).cursor; })()`);
      must(hit === `entity__resize entity__resize--${edge}|ns-resize`, `${edge}: ${hit}`);
    }
  });

  await check('dragging the bottom edge down grows the list; the top stays', async () => {
    const r0 = await rect('wide'), h0 = await listH('wide');
    must(Math.abs(h0 - 240) < 1, `default list ${h0}`);
    await drag(r0.left + r0.width / 2, r0.bottom - 3, 160);
    const r1 = await rect('wide'), h1 = await listH('wide');
    must(Math.abs(h1 - 400) < 1, `list ${h1}`);
    must(Math.abs(r1.top - r0.top) < 1, `top moved ${r0.top}→${r1.top}`);
    await shot('bottom-grown.png');
  });

  await check('dragging the top edge up grows the list; the bottom stays', async () => {
    // first give the card room above it
    const head = await rect('wide');
    await drag(head.left + 40, head.top + 20, 200);
    await b.sleep(600); // the card's entrance animation replays when a head drag ends
    const r0 = await rect('wide'), h0 = await listH('wide');
    await drag(r0.left + r0.width / 2, r0.top + 3, -80);
    const r1 = await rect('wide'), h1 = await listH('wide');
    must(Math.abs(h1 - (h0 + 80)) < 1, `list ${h0}→${h1}`);
    must(Math.abs(r1.bottom - r0.bottom) < 1, `bottom moved ${r0.bottom}→${r1.bottom}`);
  });

  await check('dragging the top edge down shrinks to the minimum, not below; the bottom stays', async () => {
    const r0 = await rect('wide');
    await drag(r0.left + r0.width / 2, r0.top + 3, 3000); // the bottom edge of a 1600px list is off-screen; the top one is not
    const r1 = await rect('wide');
    must(Math.abs(r1.bottom - r0.bottom) < 1, `bottom moved ${r0.bottom}→${r1.bottom}`);
    must(Math.abs((await listH('wide')) - 64) < 1, `list ${await listH('wide')}`);
  });

  await check('keyboard: ↓ on the bottom edge grows the list by 8px', async () => {
    const h0 = await listH('wide');
    await ev(`${card('wide')}.querySelector('.entity__resize--bottom').focus()`);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    must(Math.abs((await listH('wide')) - (h0 + 8)) < 1, `list ${h0}→${await listH('wide')}`);
  });

  await check('the list never grows past its columns', async () => {
    const r0 = await rect('wide');
    await drag(r0.left + r0.width / 2, r0.bottom - 3, 3000);
    const full = await ev(`${card('wide')}.querySelector('.entity__cols').scrollHeight`);
    const h = await listH('wide');
    must(Math.abs(h - full) < 1, `list ${h} vs content ${full}`);
  });

  await check('double-click an edge goes back to the default height', async () => {
    const r = await rect('wide');
    const x = r.left + r.width / 2, y = r.top + 3; // the top edge: a long list's bottom may be off-screen
    await send('mouseMoved', x, y);
    for (const n of [1, 2]) { await send('mousePressed', x, y, { clickCount: n }); await send('mouseReleased', x, y, { clickCount: n }); }
    must(Math.abs((await listH('wide')) - 240) < 1, `list ${await listH('wide')}`);
    must(!(await ev(`${card('wide')}.classList.contains('entity--sized')`)), 'still sized');
  });

  await check('a short table cannot grow past its two rows', async () => {
    const h0 = await listH('small'), r0 = await rect('small');
    await drag(r0.left + r0.width / 2, r0.bottom - 3, 200);
    must(Math.abs((await listH('small')) - h0) < 1, `list ${h0}→${await listH('small')}`);
  });

  await check('no edge strips while collapsed', async () => {
    await ev(`${card('wide')}.querySelector('.entity__toggle').click()`);
    must(await ev(`[...${card('wide')}.querySelectorAll('.entity__resize')].every((g) => getComputedStyle(g).display === 'none')`), 'strips still shown');
    await ev(`${card('wide')}.querySelector('.entity__toggle').click()`);
  });

  await check('hover shows the accent line (screenshot)', async () => {
    const r = await rect('wide');
    await send('mouseMoved', r.left + r.width / 2, r.bottom - 3);
    await b.sleep(600);
    const op = await ev(`getComputedStyle(${card('wide')}.querySelector('.entity__resize--bottom'), '::after').opacity`);
    must(Number(op) > 0.9, `line opacity ${op}`);
    await shot('bottom-hover.png');
  });
} catch (e) {
  console.log(`FAIL setup: ${e.message}`); failed++;
} finally {
  await b?.close();
}
console.log(`\n${passed} passed, ${failed} failed — screenshots in ${SHOTS}`);
process.exit(failed ? 1 : 0);
