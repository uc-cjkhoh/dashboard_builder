// Browser checks for Data Source zoom (wheel on an empty spot) and pan (drag an empty spot): the real dev app (APP_URL, default http://localhost:5236) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/agg-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5236 ; stop it with fuser -k 5236/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5236';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'canvas-zoom-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['cust_id', 'Int32', 'numeric'], ['amount', 'Float64', 'numeric']],
  customers: [['id', 'Int32', 'numeric'], ['name', 'String', 'text']],
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
  await waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, 'databases listed');
  await ev(`(() => { for (const r of document.querySelectorAll('.db-row[data-db]')) if ((r.dataset.db === 'shop') !== (r.getAttribute('aria-expanded') === 'true')) r.click(); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders', 'customers'])
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'both tables loaded');
  const send = (type, x, y, extra = {}) => b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, ...extra });
  // The headless shell does not deliver CDP mouseWheel events to the page, so the wheel is a dispatched WheelEvent at the point (the handler is the unit under test).
  const wheel = (x, y, deltaY) => ev(`(() => { const t = document.elementFromPoint(${x}, ${y}); t.dispatchEvent(new WheelEvent('wheel', { clientX: ${x}, clientY: ${y}, deltaY: ${deltaY}, bubbles: true, cancelable: true })); return true; })()`);
  const view = await ev(`(() => { const r = document.getElementById('model-view').getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height }; })()`);
  const cardW = () => ev(`document.querySelector('.entity').getBoundingClientRect().width`);
  const cardRect = () => ev(`(() => { const r = document.querySelector('.entity').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width }; })()`);
  const empty = { x: view.left + view.w - 60, y: view.top + view.h * 0.6 }; // far from every card and from the how-to pill at the foot
  const w0 = await cardW();
  must(await ev(`document.elementFromPoint(${empty.x}, ${empty.y}) === document.getElementById('model-view')`), 'test point is not an empty spot');

  const drag = async (x, y, dx, dy) => {
    await send('mouseMoved', x, y); await send('mousePressed', x, y);
    for (let i = 1; i <= 6; i++) await send('mouseMoved', x + (dx * i) / 6, y + (dy * i) / 6, { buttons: 1 });
    await send('mouseReleased', x + dx, y + dy);
  };
  // Back to a known view: zoomed right out, the first card 40px in from the view's top-left.
  const reset = async () => {
    for (let i = 0; i < 12; i++) await wheel(empty.x, empty.y, 500);
    const r = await cardRect();
    await drag(empty.x, empty.y, view.left + 40 - r.left, view.top + 40 - r.top);
  };
  await check('the wheel on an empty spot zooms the cards in and out', async () => {
    await wheel(empty.x, empty.y, -300);
    const zin = await cardW();
    must(zin > w0 * 1.3, `zoom in: ${w0} -> ${zin}`);
    await wheel(empty.x, empty.y, 900);
    const zout = await cardW();
    must(zout < w0, `zoom out: ${w0} -> ${zout}`);
    await shot('zoomed-out.png');
  });
  await check('zoom stops at the limits', async () => {
    for (let i = 0; i < 12; i++) await wheel(empty.x, empty.y, -500);
    const hi = (await cardW()) / w0;
    for (let i = 0; i < 12; i++) await wheel(empty.x, empty.y, 500);
    const lo = (await cardW()) / w0;
    must(Math.abs(hi - 2) < 0.02 && Math.abs(lo - 0.25) < 0.02, `ratios ${hi} ${lo}`);
    for (let i = 0; i < 12; i++) await wheel(empty.x, empty.y, -500);
    await wheel(empty.x, empty.y, 500); // back near 1 for the next checks is not needed: reset below
  });
  await check('the wheel over a card does not zoom', async () => {
    const before = await cardW();
    const c = await ev(`(() => { const r = document.querySelector('.entity__head').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await wheel(c.x, c.y, -300);
    must(Math.abs((await cardW()) - before) < 0.5, 'card changed size');
  });
  await check('the point under the pointer stays put while zooming', async () => {
    await reset();
    await wheel(view.left + 30, view.top + 30, -300); await wheel(view.left + 30, view.top + 30, -300); // about a spot just outside the card's corner: the card stays in view
    // put the pointer on the first card's top-left corner, zoom, and the corner must not move
    const r0 = await cardRect();
    const p = { x: r0.left - 6, y: r0.top - 6 }; // just outside the corner: still an empty spot
    must(await ev(`document.elementFromPoint(${p.x}, ${p.y}) === document.getElementById('model-view')`), 'corner point not empty');
    await wheel(p.x, p.y, -200);
    const r1 = await cardRect();
    must(Math.abs(r1.left - r0.left) < 4 && Math.abs(r1.top - r0.top) < 4, `corner moved ${J(r0)} -> ${J(r1)}`);
  });
  await check('dragging an empty spot moves the cards by the pointer distance, though nothing overflows the view', async () => {
    await reset(); // zoomed right out: all cards fit, nothing to scroll
    must(await ev(`getComputedStyle(document.getElementById('model-view')).overflow === 'hidden'`), 'the ground should not be a scroll area');
    const r0 = await cardRect();
    await drag(empty.x, empty.y, -120, -60);
    must(await ev(`document.getElementById('model-view').classList.contains('canvas--panning') === false`), 'panning class stuck');
    const r1 = await cardRect();
    must(Math.abs(r1.left - r0.left + 120) < 1 && Math.abs(r1.top - r0.top + 60) < 1, `moved ${r1.left - r0.left}, ${r1.top - r0.top} for a (-120, -60) drag`);
    await shot('panned.png');
  });
  await check('the ground pans without limit: a card can be dragged far off screen and back', async () => {
    const r0 = await cardRect();
    await drag(empty.x, empty.y, -700, 0);
    const far = await cardRect();
    must(far.left < r0.left - 650, `card at ${far.left} after a -700px pan from ${r0.left}`);
    await drag(empty.x - 700, empty.y, 700, 0);
    const back = await cardRect();
    must(Math.abs(back.left - r0.left) < 1, `card back at ${back.left}, was ${r0.left}`);
  });
  await check('the dots sit on the card lattice at every zoom: a card\'s top-left corner lands on a dot', async () => {
    for (const dy of [0, -200, 300]) {
      if (dy) await wheel(empty.x, empty.y, dy);
      const g = await ev(`(() => { const c = document.getElementById('model-view'), cs = getComputedStyle(c), v = c.getBoundingClientRect(), e = document.querySelector('.entity').getBoundingClientRect();
        const [bx, by] = cs.backgroundPosition.split(' ').map(parseFloat), cell = parseFloat(cs.backgroundSize); return { dx: e.left - v.left - bx - cell / 2, dy: e.top - v.top - by - cell / 2, cell }; })()`);
      must(Math.abs(g.dx) < 0.1 && Math.abs(g.dy) < 0.1, `the corner is ${g.dx.toFixed(2)}, ${g.dy.toFixed(2)} px off the dot centre (cell ${g.cell})`);
    }
  });
  await check('the dot grid moves with the pan', async () => {
    const bg = await ev(`document.getElementById('model-view').style.getPropertyValue('--pan-x')`);
    must(/^-?\d/.test(bg), `--pan-x is "${bg}"`);
  });
  await check('a card drag moves the card by the pointer distance at any zoom', async () => {
    await reset();
    await wheel(view.left + 30, view.top + 30, -600); // zoomed in a little, the card still in view
    const z = (await cardW()) / w0;
    const r0 = await cardRect();
    const h = await ev(`(() => { const r = document.querySelector('.entity__head').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`);
    await send('mouseMoved', h.x, h.y); await send('mousePressed', h.x, h.y);
    for (let i = 1; i <= 5; i++) await send('mouseMoved', h.x + i * 24, h.y + i * 8, { buttons: 1 });
    await send('mouseReleased', h.x + 120, h.y + 40);
    const r1 = await cardRect();
    must(Math.abs((r1.left - r0.left) - 120) <= 8 * z + 1, `moved ${r1.left - r0.left}px for a 120px drag at zoom ${z}`);
  });
  await check('links are still drawn after zooming', async () => {
    await shot('zoomed-in.png');
    must(await ev(`document.querySelectorAll('.rel-svg').length === 2`), 'overlay layers missing');
  });
  // ---- overview: Fit button, keyboard ------------------------------------------------------------------
  const clickFit = () => ev(`(() => { document.querySelector('.canvas__fit').click(); return true; })()`);
  const readout = async () => `${Math.round(((await cardW()) / w0) * 100)}%`; // the zoom, read off a card's width
  const key = (k, extra = '') => ev(`(() => { const c = document.getElementById('model-view'); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: ${J(k)}, bubbles: true, cancelable: true${extra} })); return true; })()`);
  const inView = async () => ev(`(() => { const v = document.getElementById('model-view').getBoundingClientRect();
    return [...document.querySelectorAll('.entity')].map((e) => { const r = e.getBoundingClientRect(); return { l: r.left - v.left, t: r.top - v.top, r: v.right - r.right, b: v.bottom - r.bottom }; }); })()`);
  await check('one Fit button shows with cards; the − / + steps and the percentage readout are gone', async () => {
    await reset();
    must(await ev(`!document.querySelector('.canvas__fit').hidden && document.querySelector('.canvas__fit').getAttribute('aria-label').startsWith('Fit all cards')`), 'Fit hidden with two cards');
    must(await ev(`!document.querySelector('.canvas__zoom') && !document.querySelector('.canvas__zoom-value')`), 'the zoom pill is back');
  });
  await check('Fit shows every card inside the view, from far zoomed in and from far panned away', async () => {
    await reset();
    for (let i = 0; i < 4; i++) await key('+');
    await drag(empty.x, empty.y, -500, -300);
    await clickFit();
    for (const m of await inView()) must(m.l >= 15 && m.t >= 15 && m.r >= 15 && m.b >= 15, `a card is outside the margin after Fit: ${J(m)}`);
    must(Number.parseInt(await readout(), 10) <= 100, `Fit zoomed past 100% (${await readout()})`);
    await shot('fit.png');
  });
  await check('keys on the focused ground: arrows pan, + and − zoom, 0 resets to 100 %, F fits', async () => {
    must(await ev(`document.getElementById('model-view').tabIndex === 0`), 'the ground is not focusable');
    await reset();
    const r0 = await cardRect();
    await key('ArrowRight');
    const r1 = await cardRect();
    must(Math.abs(r1.left - r0.left + 64) < 1, `ArrowRight moved the cards ${r1.left - r0.left}px, expected -64`);
    await key('ArrowDown', ', shiftKey: true');
    const r2 = await cardRect();
    must(Math.abs(r2.top - r1.top + 256) < 1, `Shift+ArrowDown moved the cards ${r2.top - r1.top}px, expected -256`);
    await key('0');
    must((await readout()) === '100%', `0 gave ${await readout()}`);
    await key('+');
    must((await readout()) === '125%', `+ gave ${await readout()}`);
    await key('-');
    await key('-');
    must((await readout()) === '80%', `− − gave ${await readout()}`);
    await key('F');
    for (const m of await inView()) must(m.l >= 15 && m.t >= 15 && m.r >= 15 && m.b >= 15, `F left a card outside: ${J(m)}`);
  });
  await check('keys typed on a card do not pan or zoom the ground', async () => {
    const before = await readout(), r0 = await cardRect();
    await ev(`(() => { const e = document.querySelector('.entity'); e.focus(); e.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); e.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true })); return true; })()`);
    const r1 = await cardRect();
    must((await readout()) === before && Math.abs(r1.left - r0.left) < 0.5 && Math.abs(r1.top - r0.top) < 0.5, 'the ground moved for a key on a card');
  });
  await check('links re-measure after Fit (the overlay layers stay)', async () => {
    await clickFit();
    must(await ev(`document.querySelectorAll('.rel-svg').length === 2`), 'overlay layers missing');
  });
  await check('the Appearance card opens upward from the dock: clear of Fit, inside the window', async () => {
    await ev(`document.getElementById('scheme-btn').click()`); await b.sleep(450);
    const r = await ev(`(() => { const f = document.querySelector('.canvas__fit').getBoundingClientRect(), s = document.getElementById('scheme-btn').getBoundingClientRect(), c = document.getElementById('scheme-list').getBoundingClientRect(); return { covers: c.left < f.right && c.right > f.left && c.top < f.bottom && c.bottom > f.top, above: c.bottom <= s.top, inside: c.top >= 0 && c.right <= innerWidth }; })()`);
    await ev(`document.getElementById('scheme-btn').click()`); await b.sleep(450);
    must(!r.covers && r.above && r.inside, `the card is not above the dock and inside the window: ${J(r)}`);
  });
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
