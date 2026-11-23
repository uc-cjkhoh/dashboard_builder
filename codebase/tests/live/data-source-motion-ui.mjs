// Browser checks for the Data Source tab's motion: a new relationship link arrives once (and resumes, never restarts, across a
// redraw), a removed card fades out before it leaves, the data preview panel leaves with an exit, and reduced motion drops all three.
// The real dev app (APP_URL, default http://localhost:5238) in headless Chromium over the DevTools protocol (tests/live/cdp.mjs), every /api/* call mocked.
// Run: node tests/live/data-source-motion-ui.mjs  (start the app: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5238; stop it by port)
import { launch } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5238';
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
  if (path === '/api/rows') return { json: { columns: [{ name: 'cust_id', type: 'Int32' }], rows: [['1'], ['2']], truncated: false, limit: 100, columnsTruncated: false } };
  return null;
}
let failed = 0;
async function check(name, fn) { try { await fn(); console.log(`ok ${name}`); } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; } }
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;
let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });

  async function boot() {
    await b.goto(APP + '/');
    await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, 'databases listed');
    await ev(`(() => { for (const r of document.querySelectorAll('.db-row[data-db]')) if ((r.dataset.db === 'shop') !== (r.getAttribute('aria-expanded') === 'true')) r.click(); return true; })()`);
    await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
    for (const t of ['orders', 'customers']) await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
    await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'both tables loaded');
    await b.sleep(600); // the cards' entrance
  }
  const card = (t) => `[...document.querySelectorAll('.entity')].find((e) => e.querySelector('.entity__table').textContent === ${J(t)})`;
  const arrivals = () => ev(`document.getAnimations().map((a) => a.animationName).filter((n) => /^rel-/.test(n)).sort().join(',')`);
  const relate = async () => {
    await ev(`(() => { const row = (t, c) => [...document.querySelectorAll('.entity')].find((x) => x.querySelector('.entity__table').textContent === t).querySelector('.col-row[data-column=' + JSON.stringify(c) + ']');
      const a = row('orders', 'cust_id'), z = row('customers', 'id'); const dt = new DataTransfer();
      a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      z.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      z.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return true; })()`);
    await waitFor(`document.querySelector('dialog[open] .join-choice') !== null`, 'relationship dialog');
    await ev(`[...document.querySelectorAll('dialog[open] input[name=cardinality]')].find((x) => x.value === 'N:1').click(); document.querySelector('dialog[open]').querySelector('.rel-dialog__foot .btn--primary').click()`);
  };
  const removeCard = async (t) => {
    await ev(`${card(t)}.querySelector('.iconbtn--danger').click()`);
    await waitFor(`!!document.querySelector('dialog[open]')`, 'remove confirm');
    await ev(`[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === 'Remove').click()`);
  };
  const openPreview = async (t) => {
    await ev(`(() => { ${card(t)}.querySelector('.entity__menu').click(); [...document.querySelectorAll('.ctx-menu [role^="menuitem"]')].find((x) => x.textContent.trim() === 'Preview data').click(); return true; })()`);
    await waitFor(`!document.getElementById('ds-preview').hidden`, 'preview open');
    await b.sleep(400);
  };

  await boot();

  await check('a new link arrives: line, end shapes and badge each run their own animation; nothing sits on the link group', async () => {
    await relate();
    await waitFor(`!!document.querySelector('.rel-badge text')`, 'link drawn');
    must(await arrivals() === 'rel-badge-in,rel-end-in,rel-end-in,rel-line-in', `animations: ${await arrivals()}`);
    must(await ev(`!document.querySelector('.rel-link.is-arriving') === false && document.querySelectorAll('g.rel-link').length === document.querySelectorAll('g.rel-link.is-arriving').length`), 'both layers should be arriving');
    must(await ev(`document.getAnimations().every((a) => !a.effect.target.matches('g.rel-link'))`), 'an animation sits on the link group (it would fight the focus fade)');
  });
  await check('a redraw mid-arrival resumes the run: the new line carries the link\'s age as a negative delay, not a fresh start', async () => {
    const ageOf = () => ev(`parseFloat(document.querySelector('.rel-link.is-arriving')?.style.getPropertyValue('--age') ?? '-1')`);
    const a0 = await ageOf();
    await b.sleep(150);
    await ev(`document.getElementById('model-view').dispatchEvent(new Event('scroll'))`); // render() (relations.js listens to the canvas scroll): replaceChildren
    await b.sleep(60);
    const a1 = await ageOf();
    // inside the 450ms window the redrawn link is still arriving, and its --age is its real age (a restart would read ~0); past the window it is no longer arriving (-1)
    must(a1 === -1 || a1 >= 150, `age after the redraw: ${a0} -> ${a1}`);
    must(a1 === -1 || (await ev(`document.getAnimations().find((a) => a.animationName === 'rel-line-in')?.effect.getComputedTiming().delay ?? 0`)) <= -150, 'the line animation does not carry the negative delay');
  });
  await check('after the window a redraw plays nothing (zoom, drag and resize never replay it)', async () => {
    await b.sleep(700);
    await ev(`document.getElementById('model-view').dispatchEvent(new Event('scroll'))`);
    must(await arrivals() === '', `replayed: ${await arrivals()}`);
  });
  await check('removing a card: it is out of the model at once, still drawn (inert) while it fades, then gone', async () => {
    await removeCard('customers');
    await waitFor(`document.querySelectorAll('.rel-link__line').length === 0`, 'its link dropped');
    const mid = await ev(`(() => { const e = ${card('customers')}; return e ? { inert: e.inert, anims: e.getAnimations().length } : null; })()`);
    must(mid === null || (mid.inert && mid.anims >= 1), `mid-exit: ${J(mid)}`); // null: the 100ms already passed
    await waitFor(`!${card('customers')}`, 'card removed');
  });
  await check('the preview panel leaves with an exit, not a cut; closing then reopening within it keeps the panel', async () => {
    await openPreview('orders');
    await ev(`document.getElementById('ds-preview-close').click()`);
    const mid = await ev(`(() => { const p = document.getElementById('ds-preview'); return { hidden: p.hidden, inert: p.inert, anims: p.getAnimations().length }; })()`);
    must(mid.hidden === false && mid.inert === true && mid.anims >= 1, `mid-exit: ${J(mid)}`);
    await waitFor(`document.getElementById('ds-preview').hidden`, 'hidden after the exit');
    must(await ev(`!document.getElementById('ds-preview').inert && !document.getElementById('model-view').parentElement.classList.contains('has-ds-preview')`), 'inert / has-ds-preview left behind');
    // reopen inside the exit window: latest wins, the panel stays
    await openPreview('orders');
    await ev(`document.getElementById('ds-preview-close').click(); document.querySelector('.entity .entity__menu').click(); [...document.querySelectorAll('.ctx-menu [role^="menuitem"]')].find((x) => x.textContent.trim() === 'Preview data').click(); true`);
    await b.sleep(400);
    must(await ev(`!document.getElementById('ds-preview').hidden && !document.getElementById('ds-preview').inert`), 'a reopen during the exit was hidden by the late exit');
  });

  // Reduced motion: the same actions, none of the animation (and no hidden-until-delay flash).
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await boot();
  await check('reduced motion: a new link is drawn at full opacity at once, with no arrival animation', async () => {
    await relate();
    await waitFor(`!!document.querySelector('.rel-badge text')`, 'link drawn');
    must(await arrivals() === '', `animating: ${await arrivals()}`);
    must(await ev(`getComputedStyle(document.querySelector('.rel-link__line')).opacity === '1' && getComputedStyle(document.querySelector('.rel-badge')).opacity === '1'`), 'a part is not fully visible');
  });
  await check('reduced motion: a removed card and a closed preview go at once', async () => {
    await removeCard('customers');
    await waitFor(`!${card('customers')}`, 'card removed');
    await openPreview('orders');
    await ev(`document.getElementById('ds-preview-close').click()`);
    await waitFor(`document.getElementById('ds-preview').hidden`, 'preview hidden');
  });
} finally {
  await b?.close();
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');
