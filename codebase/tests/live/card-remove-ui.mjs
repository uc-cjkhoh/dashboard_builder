// Browser check: removing a card leaves no ghost behind. The card is out of the store before relations.js redraws, so a card that is leaving
// is not offered a proposed link and is not counted (a card left alone needs no partner). Real dev app (APP_URL, default
// http://localhost:5187) in headless Chromium over the DevTools protocol (tests/live/cdp.mjs); every /api/* call is mocked.
// Run: node tests/live/card-remove-ui.mjs  (start the app: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5187; stop it by port)
import { launch } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5187';
const COLUMNS = {
  orders: [['cust_id', 'Int32', 'numeric'], ['amount', 'Float64', 'numeric']],
  customers: [['id', 'Int32', 'numeric'], ['name', 'String', 'text']],
};
function answer({ method, path }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: Object.keys(COLUMNS) };
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
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  await b.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, 'databases listed');
  await ev(`(() => { for (const r of document.querySelectorAll('.db-row[data-db]')) if ((r.dataset.db === 'shop') !== (r.getAttribute('aria-expanded') === 'true')) r.click(); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders', 'customers']) await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'tables loaded');
  const card = (t) => `[...document.querySelectorAll('.entity')].find((x) => x.querySelector('.entity__table').textContent === ${J(t)})`;
  const press = (t, c, key) => ev(`(() => { const r = ${card(t)}.querySelector('.col-row[data-column=' + ${J(JSON.stringify(c))} + ']'); r.focus(); r.dispatchEvent(new KeyboardEvent('keydown', { key: ${J(key)}, bubbles: true, cancelable: true })); return true; })()`);
  const confirm = (re) => ev(`(() => { [...document.querySelector('dialog.dialog--sm[open]').querySelectorAll('button')].find((y) => ${re}.test(y.textContent.trim())).click(); return true; })()`);
  await check('two related cards: remove one: its link goes at once and no proposal to the leaving card is drawn, and the one left asks for no partner', async () => {
    await press('orders', 'cust_id', 'Enter');
    await press('customers', 'id', 'Enter');
    await waitFor(`document.querySelector('dialog[open] .join-choice') !== null`, 'dialog open');
    await ev(`document.querySelector('dialog[open] .rel-dialog__foot .btn--primary').click()`);
    await waitFor(`document.querySelectorAll('.rel-link__line').length === 1`, 'link drawn');
    await ev(`${card('customers')}.querySelector('.iconbtn--danger').click()`);
    await waitFor(`!!document.querySelector('dialog.dialog--sm[open]')`, 'first confirm');
    await confirm(/^Remove$/);
    await waitFor(`!!document.querySelector('dialog.dialog--sm[open]') && /Really remove/.test(document.querySelector('dialog.dialog--sm[open]').textContent)`, 'second confirm');
    await confirm(/^Remove for good$/);
    // the card is still fading out (entity.el.inert); the model already lacks it
    await waitFor(`document.querySelector('dialog.dialog--sm') === null`, 'confirm closed');
    const state = await ev(`(() => ({ ghosts: document.querySelectorAll('.rel-ghost, .rel-ghost__line').length, links: document.querySelectorAll('.rel-link__line').length,
      cards: document.querySelectorAll('.entity').length, need: !${card('orders')}.querySelector('.entity__need').hidden }))()`);
    must(state.ghosts === 0, `a proposal to the card that is leaving: ${J(state)}`);
    must(state.links === 0 && !state.need, `state right after removal (a single card needs no partner): ${J(state)}`);
    await waitFor(`document.querySelectorAll('.entity').length === 1`, 'the card left');
    must(await ev(`document.querySelectorAll('.rel-ghost, .rel-ghost__line').length === 0`), 'ghost after the card left');
  });
} catch (e) { console.log(`FAIL harness: ${e.stack}`); failed++; } finally { if (b) await b.close(); }
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
