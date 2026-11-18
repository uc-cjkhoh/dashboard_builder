// Browser checks for proposed links shown on demand (D127, Relations/relations.js): in a model that has relationships a proposal is drawn only for the card
// the pointer or focus is on (or a clicked card), and stays in the Tab order while it rests; the one proposal of a model with no relationship yet is always drawn.
// Real dev app (APP_URL, default http://localhost:5182) in headless Chromium over the DevTools protocol (tests/live/cdp.mjs); every /api/* call is mocked.
// Run: node tests/live/proposal-reveal-ui.mjs  (start the app: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5182; stop it by port)
import { launch } from './cdp.mjs';
import { relateTables } from './model.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5182';
const J = JSON.stringify;
const COLUMNS = {
  orders: [['order_id', 'Int64', 'numeric'], ['cust_id', 'Int32', 'numeric'], ['product_id', 'Int32', 'numeric'], ['amount', 'Float64', 'numeric']],
  customers: [['id', 'Int32', 'numeric'], ['name', 'String', 'text']],
  products: [['id', 'Int32', 'numeric'], ['title', 'String', 'text']],
  shipments: [['id', 'Int32', 'numeric'], ['order_id', 'Int64', 'numeric'], ['carrier', 'String', 'text']],
};
function answer({ method, path }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/connection/ping') return { json: { connected: true, reachable: true } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: Object.keys(COLUMNS) };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) { try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; } }
const must = (c, m) => { if (!c) throw new Error(m); };

/** Open the app connected to the mock, with the shop database expanded. */
async function open(b) {
  const ev = (s) => b.evaluate(s);
  await b.mock(answer);
  await b.goto(APP + '/');
  await b.waitFor(`!!document.getElementById('conn-connect')`, { label: 'app loaded' });
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await b.waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, { label: 'databases listed' });
  await ev(`(() => { for (const r of document.querySelectorAll('.db-row[data-db]')) if ((r.dataset.db === 'shop') !== (r.getAttribute('aria-expanded') === 'true')) r.click(); return true; })()`);
  await b.waitFor(`document.querySelectorAll('.table-chip').length === ${Object.keys(COLUMNS).length}`, { label: 'tables listed' });
}
const add = async (b, tables) => {
  for (const t of tables) await b.evaluate(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  const n = await b.evaluate(`document.querySelectorAll('.entity').length`);
  await b.waitFor(`document.querySelectorAll('.entity').length >= ${n} && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, { label: 'cards loaded' });
};

let b1 = null, b2 = null;
try {
  // ---- a model with relationships: proposals wait for the pointer ----
  b1 = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined, width: 1440, height: 1100 });
  const ev = (s) => b1.evaluate(s);
  const waitFor = (s, label) => b1.waitFor(s, { label });
  const sleep = (ms) => b1.sleep(ms);
  await open(b1);
  await add(b1, ['orders', 'customers', 'products', 'shipments']);
  await relateTables(ev, waitFor, ['orders', 'cust_id', 'customers', 'id'], 'N:1');
  await relateTables(ev, waitFor, ['orders', 'product_id', 'products', 'id'], 'N:1');
  await waitFor(`document.querySelector('.rel-ghost') !== null`, 'a proposal for shipments exists');
  await sleep(6000); // the "Connected" toast leaves the canvas ground

  const ghost = `document.querySelector('.rel-ghost')`;
  const line = `document.querySelector('.rel-ghost__line')`;
  const op = (sel) => ev(`+getComputedStyle(${sel}).opacity`);
  const move = (x, y) => b1.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  const press = async (x, y) => { await b1.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }); await b1.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }); };
  const headOf = (t) => ev(`(() => { const e = [...document.querySelectorAll('.entity')].find((x) => x.querySelector('.entity__table').textContent === ${J(t)}); const r = e.querySelector('.entity__head').getBoundingClientRect(); return [r.left + 40, r.top + r.height / 2]; })()`);
  const pillAt = () => ev(`(() => { const r = ${ghost}.getBoundingClientRect(); return [r.left + 12, r.top + r.height / 2]; })()`);
  const GROUND = [900, 900]; // empty canvas ground
  const settled = async () => { await sleep(500); }; // a fade (--dur) and the hide delay

  await check('resting: the proposal is in the page but faded, not clickable, and the guide points at the card', async () => {
    await move(...GROUND); await settled();
    must(await op(ghost) === 0 && await op(line) === 0, `opacity ${await op(ghost)} / ${await op(line)}`);
    must(await ev(`getComputedStyle(${ghost}).pointerEvents`) === 'none', 'a faded pill still takes the pointer');
    must(await ev(`!${ghost}.hidden && !${ghost}.closest('[hidden]')`), 'the pill is hidden, not faded');
    must(await ev(`${ghost}.querySelector('.rel-ghost__go').getAttribute('aria-label')`).then((t) => /^Relate (shipments and orders|orders and shipments)/.test(t)), 'no accessible name');
    must(/point at a card that needs a partner/.test(await ev(`document.querySelector('.rel-guide').textContent`)), await ev(`document.querySelector('.rel-guide').textContent`));
  });
  await check('pointing at the card that needs a partner draws its proposal; leaving fades it again', async () => {
    await move(...await headOf('shipments')); await settled();
    must(await op(ghost) === 1 && await op(line) > 0, `shown? ${await op(ghost)} / ${await op(line)}`); // the dashed line rests at .8
    await move(...GROUND); await settled();
    must(await op(ghost) === 0, 'still drawn after leaving');
  });
  await check('pointing at the other card of the pair draws it too', async () => {
    await move(...await headOf('orders')); await settled();
    must(await op(ghost) === 1, `orders hover: ${await op(ghost)}`);
    await move(...GROUND); await settled();
  });
  await check('pointing at an unrelated card does not', async () => {
    await move(...await headOf('customers')); await settled();
    must(await op(ghost) === 0, `customers hover: ${await op(ghost)}`);
    await move(...GROUND); await settled();
  });
  await check('crossing the gap from the card to its pill keeps it drawn; the pill can then be used', async () => {
    await move(...await headOf('shipments')); await settled();
    const [px, py] = await pillAt();
    const top = await ev(`${ghost}.getBoundingClientRect().top`);
    await move(px, top - 8); await sleep(120); // the ground between the card and the pill (the pill sits 16px under the lower card), shorter than the hide delay
    await move(px, py); await sleep(400);
    must(await op(ghost) === 1, `pill hovered: ${await op(ghost)}`);
    must(await ev(`getComputedStyle(${ghost}).pointerEvents`) === 'auto', 'drawn pill does not take the pointer');
    await move(...GROUND); await settled();
    must(await op(ghost) === 0, 'still drawn after leaving the pill');
  });
  await check('a click on a card keeps its proposal until a click on empty ground', async () => {
    await press(...await headOf('shipments')); await move(...GROUND); await settled();
    must(await op(ghost) === 1, `pinned: ${await op(ghost)}`);
    await press(...GROUND); await settled();
    must(await op(ghost) === 0, 'a click elsewhere keeps it');
  });
  await check('Esc lets go of a clicked card', async () => {
    await press(...await headOf('shipments')); await move(...GROUND); await settled();
    must(await op(ghost) === 1, 'not pinned');
    await b1.key('Escape', { vk: 27 }); await settled();
    must(await op(ghost) === 0, 'Esc keeps it');
  });
  await check('Tab reaches the faded pill and it appears with the focus ring', async () => {
    await ev(`[...document.querySelectorAll('.entity')].find((x) => x.querySelector('.entity__table').textContent === 'shipments').querySelector('.entity__menu').focus()`);
    let got = false;
    for (let i = 0; i < 60 && !got; i++) { await b1.key('Tab', { code: 'Tab', vk: 9 }); got = await ev(`document.activeElement?.classList.contains('rel-ghost__go')`); }
    must(got, 'Tab never reached the pill');
    await sleep(450);
    must(await op(ghost) === 1 && await op(line) > 0, `focused: ${await op(ghost)} / ${await op(line)}`);
    await ev(`document.activeElement.blur()`); await settled();
    must(await op(ghost) === 0, 'still drawn after blur');
  });
  await check('relating from the revealed pill opens the dialog and the proposal goes', async () => {
    await move(...await headOf('shipments')); await settled();
    const [px, py] = await pillAt(); await move(px, py); await sleep(300);
    await press(px + 40, py);
    await waitFor(`document.querySelector('dialog[open] input[name=cardinality]') !== null`, 'relationship dialog');
    await ev(`document.querySelector('dialog[open] .rel-dialog__foot .btn--primary').click()`);
    await waitFor(`document.querySelector('.rel-ghost') === null`, 'proposal gone once related');
  });

  // ---- no relationship yet: the one proposal is drawn at rest, several wait ----
  b2 = await launch({ port: process.env.CDP_PORT2 ? Number(process.env.CDP_PORT2) : undefined, width: 1440, height: 1100 });
  const ev2 = (s) => b2.evaluate(s);
  await open(b2);
  await add(b2, ['orders', 'shipments']);
  await b2.waitFor(`document.querySelector('.rel-ghost') !== null`, { label: 'the one proposal' });
  await b2.sleep(600);
  await check('two cards, no relationship: the one proposal is drawn at rest and the guide says click it', async () => {
    must(+await ev2(`getComputedStyle(document.querySelector('.rel-ghost')).opacity`) === 1, 'idle');
    must(+await ev2(`getComputedStyle(document.querySelector('.rel-ghost__line')).opacity`) > 0, 'line idle');
    must(/click a proposed link/.test(await ev2(`document.querySelector('.rel-guide').textContent`)), await ev2(`document.querySelector('.rel-guide').textContent`));
  });
  await add(b2, ['products']); // product_id = id is a confident key, so a second card has its own proposal
  await b2.sleep(600);
  await check('three cards, no relationship: several proposals wait for the pointer', async () => {
    const n = await ev2(`document.querySelectorAll('.rel-ghost').length`);
    must(n >= 2, `only ${n} proposals`);
    const shown = await ev2(`[...document.querySelectorAll('.rel-ghost')].filter((g) => +getComputedStyle(g).opacity > 0).length`);
    must(shown === 0, `${shown} drawn at rest`);
  });
  const errs = [...b1.consoleErrors, ...b2.consoleErrors];
  await check('no console errors', async () => { must(errs.length === 0, J(errs)); });
} finally {
  await b1?.close?.();
  await b2?.close?.();
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
