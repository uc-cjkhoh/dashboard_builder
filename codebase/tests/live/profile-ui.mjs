// Browser checks for the column profile (field details + distinct / null share / top values): the real dev app
// (APP_URL, default http://localhost:5180) in headless Chromium over the DevTools protocol (tests/live/cdp.mjs), with every
// /api/* call answered by a mock — nothing reaches a ClickHouse. Run:  node tests/live/profile-ui.mjs
// (start the app first: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5195 ; stop it with fuser -k 5195/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT, CHROME_BIN.
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5180';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'profile-ui-shots');
mkdirSync(SHOTS, { recursive: true });

const COLUMNS = [['city', 'Nullable(String)', 'text'], ['amount', 'Float64', 'numeric'], ['bad', 'String', 'text']];
const LONG = 'x'.repeat(100);
const requests = [];
const PROFILES = {
  city: { column: 'city', type: 'Nullable(String)', category: 'text', rows: 1000000, nulls: 12500, distinct: 4096, min: null, max: null, sampled: true, sampleLimit: 1000000,
    top: [{ value: 'Berlin', count: 410000, cut: false }, { value: 'Paris', count: 205000, cut: false }, { value: '', count: 90000, cut: false },
      { value: null, count: 12500, cut: false }, { value: LONG, count: 1, cut: true }] },
  amount: { column: 'amount', type: 'Float64', category: 'numeric', rows: 6, nulls: 0, distinct: 4, min: '5', max: '20', sampled: false, sampleLimit: 1000000,
    top: [{ value: '5', count: 2, cut: false }, { value: '7', count: 2, cut: false }, { value: '10', count: 1, cut: false }, { value: '20', count: 1, cut: false }] },
};
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders'] };
  if (path === '/api/databases/shop/tables/orders/columns') return { json: COLUMNS.map(([name, type, category]) => ({ name, type, category })) };
  const m = path.match(/^\/api\/databases\/shop\/tables\/orders\/profile$/);
  if (m) {
    requests.push(body);
    if (body.column === 'bad') return { status: 504, json: { error: 'The query ran longer than 12 seconds and was stopped.' } };
    return { json: PROFILES[body.column] };
  }
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) { try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; } }
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
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
  await waitFor(`document.querySelectorAll('.table-chip').length === 1`, 'tables listed');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.col-row').length === 3`, 'columns loaded');
  const open = (col) => ev(`(() => { document.querySelector('.col-row[data-column=${J(col)}] .col-row__profile').click(); return true; })()`);
  const text = (sel) => ev(`[...document.querySelectorAll('dialog[open] ${sel}')].map((e) => e.textContent.trim())`);

  await check('every field row has a labelled Profile button', async () => {
    const labels = await ev(`[...document.querySelectorAll('.col-row__profile')].map((x) => x.getAttribute('aria-label'))`);
    must(J(labels) === J(['Profile city', 'Profile amount', 'Profile bad']), J(labels));
    await open('city');
    await waitFor(`document.querySelector('dialog[open] .col-profile__tiles') !== null`, 'profile loaded');
  });
  await check('request is {column, limit: 10}', async () => { must(J(requests.at(-1)) === J({ column: 'city', limit: 10 }), J(requests.at(-1))); });
  await check('title, properties and tiles show the profile in words', async () => {
    must((await text('.col-profile__title'))[0] === 'city', 'title');
    const dd = await text('.col-profile__props dd');
    must(J(dd) === J(['city', 'Nullable(String)', 'text', 'dimension']), J(dd));
    const tiles = await text('.col-profile__tile');
    must(tiles[0].startsWith('Rows1,000,000'), tiles[0]);
    must(tiles[1].startsWith('Distinct (approx.)4,096'), tiles[1]);
    must(tiles[2].startsWith('Null share1.3%') && tiles[2].includes('12,500 of 1,000,000 rows'), tiles[2]);
    must((await text('.col-profile__note'))[0].includes('first 1,000,000 rows'), 'sample note');
  });
  await check('top values: text labels, counts and shares; NULL and empty named; cut value ends with an ellipsis', async () => {
    const rows = await text('.col-profile__row');
    must(rows.length === 5, `${rows.length} rows`);
    must(/^Berlin\s*410,000\s*41%$/.test(rows[0].replace(/\s+/g, ' ').replace(/(\D) (\d)/, '$1$2')) || rows[0].includes('410,000') && rows[0].includes('41%'), rows[0]);
    must(rows[2].includes('(empty)') && rows[3].includes('(NULL)'), `${rows[2]} | ${rows[3]}`);
    must(rows[4].includes('…') && rows[4].includes('0.0001') === false, rows[4]);
    const w = await ev(`[...document.querySelectorAll('dialog[open] .col-profile__fill')].map((f) => f.style.getPropertyValue('--w'))`);
    must(w[0] === '41%' && w[1] === '21%', J(w));
  });
  await b.setScheme('light'); await b.sleep(200); await shot('profile-light.png');
  await b.setScheme('dark'); await b.sleep(200); await shot('profile-dark.png');
  await b.setScheme('light');
  await check('Copy name and Copy values write the name and the plain values (stubbed clipboard)', async () => {
    await ev(`(() => { window.__clip = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { window.__clip.push(t); return Promise.resolve(); } }, configurable: true }); return true; })()`);
    await ev(`[...document.querySelectorAll('dialog[open] .btn')].find((x) => x.textContent.includes('Copy name')).click()`);
    await ev(`[...document.querySelectorAll('dialog[open] .btn')].find((x) => x.textContent.includes('Copy values')).click()`);
    await b.sleep(150);
    must(J(await ev(`window.__clip`)) === J(['city', 'Berlin\nParis']), J(await ev(`window.__clip`)));
  });
  await check('Escape closes and removes the dialog', async () => {
    await b.key('Escape', { vk: 27 });
    await waitFor(`document.querySelector('dialog') === null`, 'dialog gone');
  });
  await check('a numeric field is a measure and shows Min and Max tiles, no sample note', async () => {
    await open('amount');
    await waitFor(`document.querySelector('dialog[open] .col-profile__tiles') !== null`, 'amount loaded');
    must(J(await text('.col-profile__props dd')) === J(['amount', 'Float64', 'numeric', 'measure']), 'props');
    const labels = await text('.col-profile__tile-label');
    must(J(labels) === J(['Rows', 'Distinct (approx.)', 'Null share', 'Min', 'Max']), J(labels));
    must((await text('.col-profile__note')).length === 0, 'unexpected note');
    await shot('profile-numeric-light.png');
    await ev(`document.querySelector('dialog[open] .iconbtn').click()`);
    await waitFor(`document.querySelector('dialog') === null`, 'closed by X');
  });
  await check('opening and closing the dialog three times leaves no <dialog> behind', async () => {
    for (let i = 0; i < 3; i++) {
      await open('amount');
      await waitFor(`document.querySelector('dialog[open] .col-profile__tiles') !== null`, 'loaded');
      await ev(`[...document.querySelectorAll('dialog[open] .btn')].find((x) => x.textContent === 'Close').click()`);
      await waitFor(`document.querySelector('dialog') === null`, 'removed');
    }
    must((await ev(`document.querySelectorAll('dialog').length`)) === 0, 'dialogs left');
  });
  await check('keyboard: the Profile button takes focus and Enter opens it', async () => {
    await ev(`document.querySelector('.col-row[data-column=amount] .col-row__profile').focus()`);
    must(await ev(`document.activeElement.classList.contains('col-row__profile') && document.activeElement.closest('.col-row').dataset.column === 'amount'`), 'focus not on the Profile button');
    for (const type of ['keyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
    await waitFor(`document.querySelector('dialog[open] .col-profile__tiles') !== null`, 'opened by keyboard');
    await b.key('Escape', { vk: 27 });
    await waitFor(`document.querySelector('dialog') === null`, 'closed');
  });
  await check('a failing profile shows the error inside the dialog (icon + text) and the dialog still closes', async () => {
    await open('bad');
    await waitFor(`document.querySelector('dialog[open] .col-profile__status--error') !== null`, 'error shown');
    must((await text('.col-profile__status--error'))[0].includes('longer than 12 seconds'), 'message');
    must(await ev(`!!document.querySelector('dialog[open] .col-profile__status--error .icon')`), 'no icon');
    await b.setScheme('dark'); await b.sleep(150); await shot('profile-error-dark.png'); await b.setScheme('light');
    await b.key('Escape', { vk: 27 });
    await waitFor(`document.querySelector('dialog') === null`, 'closed');
  });
  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed  (screenshots in ${SHOTS})`);
process.exit(failed ? 1 : 0);
