// Browser checks for the column profile (field details + distinct / null value / top values): the real dev app
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

const COLUMNS = [['city', 'Nullable(String)', 'text'], ['amount', 'Float64', 'numeric'], ['bad', 'String', 'text'], ['ghost', 'Nullable(String)', 'text'], ['void', 'Nullable(String)', 'text'], ['big', 'Decimal(76, 38)', 'numeric']];
const LONG = 'x'.repeat(100);
const requests = [];
const PROFILES = {
  city: { column: 'city', type: 'Nullable(String)', category: 'text', rows: 1000000, nulls: 12500, distinct: 4096, min: null, max: null,
    top: [{ value: 'Berlin', count: 410000, cut: false }, { value: 'Paris', count: 205000, cut: false }, { value: '', count: 90000, cut: false },
      { value: null, count: 12500, cut: false }, { value: LONG, count: 1, cut: true }] },
  ghost: { column: 'ghost', type: 'Nullable(String)', category: 'text', rows: 0, nulls: 0, distinct: 0, min: null, max: null, top: [] },
  void: { column: 'void', type: 'Nullable(String)', category: 'text', rows: 40, nulls: 40, distinct: 0, min: null, max: null, top: [{ value: null, count: 40, cut: false }] },
  big: { column: 'big', type: 'Decimal(76, 38)', category: 'numeric', rows: 12345678901234, nulls: 0, distinct: 9876543210, min: '-12345678901234567890123456789.123456789012345678', max: '98765432109876543210987654321.987654321098765432',
    top: [{ value: '98765432109876543210987654321.987654321098765432109876543210', count: 7, cut: false }, { value: '1', count: 3, cut: false }] },
  amount: { column: 'amount', type: 'Float64', category: 'numeric', rows: 6, nulls: 0, distinct: 4, min: '5', max: '20',
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
  if (/\/histogram$/.test(path)) return { json: { whole: false, bins: Array.from({ length: 20 }, (_, i) => ({ x0: i * 10, x1: i * 10 + 10, count: [3, 8, 20, 50, 90, 120, 100, 70, 40, 20, 12, 8, 5, 4, 3, 2, 2, 1, 1, 1][i] })) } };
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
  await waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, 'databases listed');
  await ev(`(() => { for (const r of document.querySelectorAll('.db-row[data-db]')) if ((r.dataset.db === 'shop') !== (r.getAttribute('aria-expanded') === 'true')) r.click(); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 1`, 'tables listed');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.col-row').length === 6`, 'columns loaded');
  const open = (col) => ev(`(() => { document.querySelector('.col-row[data-column=${J(col)}] .col-row__profile').click(); return true; })()`);
  const text = (sel) => ev(`[...document.querySelectorAll('dialog[open] ${sel}')].map((e) => e.textContent.trim())`);

  await check('every field row has a labelled Profile button', async () => {
    const labels = await ev(`[...document.querySelectorAll('.col-row__profile')].map((x) => x.getAttribute('aria-label'))`);
    must(J(labels) === J(['Profile city', 'Profile amount', 'Profile bad', 'Profile ghost', 'Profile void', 'Profile big']), J(labels));
    await open('city');
    await waitFor(`document.querySelector('dialog[open] .col-profile__cell--profile') !== null`, 'profile loaded');
  });
  await check('request is {column, limit: 10}', async () => { must(J(requests.at(-1)) === J({ column: 'city', limit: 10 }), J(requests.at(-1))); });
  await check('title, properties and tiles show the profile in words', async () => {
    must((await text('.col-profile__title'))[0] === 'city', 'title');
    must((await text('.col-profile__sub'))[0] === 'shop.orders · Nullable(String) · dimension', J(await text('.col-profile__sub')));
    const tiles = await text('.col-profile__tile');
    must(tiles[0].startsWith('Rows') && tiles[0].endsWith('1,000,000'), tiles[0]); // the label, then the figure
    must(tiles[1].startsWith('Distinct (approx.)') && tiles[1].endsWith('4,096'), tiles[1]);
    must(tiles[2].startsWith('Null value') && tiles[2].endsWith('12,500') && !tiles[2].includes('%') && !tiles[2].includes('null rows'), tiles[2]);
    must((await text('.col-profile__cell--note')).join(' ').includes('first 1,000,000 rows') === false, 'no sample note');
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
    await waitFor(`document.querySelector('dialog[open] .col-profile__cell--profile') !== null`, 'amount loaded');
    must((await text('.col-profile__sub'))[0] === 'shop.orders · Float64 · measure', J(await text('.col-profile__sub')));
    const labels = await text('.col-profile__tile-label');
    must(J(labels) === J(['Rows', 'Distinct (approx.)', 'Null value', 'Min', 'Max']), J(labels));
    must((await text('.col-profile__cell--note')).length === 0, 'unexpected note');
    await shot('profile-numeric-light.png');
    await ev(`document.querySelector('dialog[open] .iconbtn').click()`);
    await waitFor(`document.querySelector('dialog') === null`, 'closed by X');
  });
  await check('opening and closing the dialog three times leaves no <dialog> behind', async () => {
    for (let i = 0; i < 3; i++) {
      await open('amount');
      await waitFor(`document.querySelector('dialog[open] .col-profile__cell--profile') !== null`, 'loaded');
      await ev(`[...document.querySelectorAll('dialog[open] .btn')].find((x) => x.textContent === 'Close').click()`);
      await waitFor(`document.querySelector('dialog') === null`, 'removed');
    }
    must((await ev(`document.querySelectorAll('dialog').length`)) === 0, 'dialogs left');
  });
  await check('keyboard: the Profile button takes focus and Enter opens it', async () => {
    await ev(`document.querySelector('.col-row[data-column=amount] .col-row__profile').focus()`);
    must(await ev(`document.activeElement.classList.contains('col-row__profile') && document.activeElement.closest('.col-row').dataset.column === 'amount'`), 'focus not on the Profile button');
    for (const type of ['keyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
    await waitFor(`document.querySelector('dialog[open] .col-profile__cell--profile') !== null`, 'opened by keyboard');
    await b.key('Escape', { vk: 27 });
    await waitFor(`document.querySelector('dialog') === null`, 'closed');
  });
  await check('no rows: the card is the reason alone (icon + words), no figures, Copy values disabled and says why', async () => {
    await open('ghost');
    await waitFor(`document.querySelector('dialog[open] .col-profile__reason') !== null`, 'reason shown');
    must((await text('.col-profile__reason'))[0] === 'This table has no rows, so there is nothing to profile.', J(await text('.col-profile__reason')));
    must((await text('.col-profile__tile')).length === 0, 'figures shown for an empty table');
    must(await ev(`!!document.querySelector('dialog[open] .col-profile__reason .icon')`), 'no icon');
    must(await ev(`[...document.querySelectorAll('dialog[open] .btn')].find((x) => x.textContent.includes('Copy values')).disabled`), 'Copy values enabled');
    must((await ev(`[...document.querySelectorAll('dialog[open] .btn')].find((x) => x.textContent.includes('Copy values')).title`)).includes('no rows'), 'tooltip');
    await b.setScheme('dark'); await b.sleep(150); await shot('profile-empty-dark.png'); await b.setScheme('light'); await b.sleep(150); await shot('profile-empty-light.png');
    await b.key('Escape', { vk: 27 });
    await waitFor(`document.querySelector('dialog') === null`, 'closed');
  });
  await check('every row NULL: the figures and the NULL band stay, with a reason under the list', async () => {
    await open('void');
    await waitFor(`document.querySelector('dialog[open] .col-profile__reason') !== null`, 'reason shown');
    must((await text('.col-profile__reason'))[0] === 'Every row is NULL, so there are no values to list and no Min or Max.', J(await text('.col-profile__reason')));
    must((await text('.col-profile__row')).length === 1, 'NULL band');
    await shot('profile-allnull-light.png');
    await b.key('Escape', { vk: 27 });
    await waitFor(`document.querySelector('dialog') === null`, 'closed');
  });
  await check('long figures: Min, Max, the counts and a long top value are shown in full, inside the card, at 1400 and 420 px', async () => {
    for (const w of [1400, 420]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
      await open('big');
      await waitFor(`document.querySelector('dialog[open] .col-profile__cell--profile') !== null`, 'big loaded');
      await b.sleep(1300);
      const bad = await ev(`(() => { const card = document.querySelector('dialog[open] .col-profile__cell--profile').getBoundingClientRect();
        return [...document.querySelectorAll('dialog[open] .col-profile__tile-value, dialog[open] .col-profile__label')].filter((e) => {
          const r = e.getBoundingClientRect(); return e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1 || r.right > card.right + 0.5 || r.left < card.left - 0.5; }).map((e) => e.textContent); })()`);
      must(bad.length === 0, `${w}px clipped: ${J(bad)}`);
      const stacked = await ev(`!!document.querySelector('dialog[open] .col-profile__group--stack')`);
      must(stacked, 'Min and Max should stack when long');
      await shot(`profile-long-${w}.png`);
      await b.send('Emulation.clearDeviceMetricsOverride');
      await ev(`document.querySelector('dialog[open] .btn--primary').click()`);
      await waitFor(`document.querySelector('dialog') === null`, 'closed');
    }
  });
  await check('two symmetric panels: Statistics on the left, Most frequent values (Top 10) on the right, equal width with one divider; stacked when narrow', async () => {
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await open('amount');
    await waitFor(`document.querySelector('dialog[open] .col-profile__cell--profile') !== null`, 'amount');
    await b.sleep(1300);
    const geo = () => ev(`(() => { const d = document.querySelector('dialog[open]'), q = (s) => d.querySelector(s).getBoundingClientRect(), body = q('.col-profile__body');
      const l = q('.col-profile__panel--stats'), r = q('.col-profile__panel--top');
      return { l: [l.left, l.width, l.top, l.height], r: [r.left, r.width, r.top, r.height], body: [body.left, body.right],
        heads: [...d.querySelectorAll('.col-profile__panel-head')].map((h) => [h.textContent, h.getBoundingClientRect().top, h.getBoundingClientRect().height]),
        statsTiles: d.querySelectorAll('.col-profile__panel--stats .col-profile__tile:not(.col-profile__tile--blank)').length, topRows: d.querySelectorAll('.col-profile__panel--top .col-profile__row').length,
        divider: getComputedStyle(d.querySelector('.col-profile__panel--top')).borderLeftWidth, gutter: [q('.col-profile__panel-head').left - l.left, q('.col-profile__panel--top .col-profile__panel-head').left - r.left] }; })()`);
    let g = await geo();
    must(Math.abs(g.l[1] - g.r[1]) < 1.5, `panel widths ${g.l[1]} vs ${g.r[1]}`);
    must(Math.abs(g.l[2] - g.r[2]) < 0.5 && Math.abs(g.l[3] - g.r[3]) < 0.5, `panels not the same top / height ${J(g)}`);
    must(g.heads.length === 2 && g.heads[0][0] === 'Statistics' && g.heads[1][0] === 'Most frequent values (Top 10)' && g.heads[0][1] === g.heads[1][1] && g.heads[0][2] === g.heads[1][2], `heads ${J(g.heads)}`);
    must(g.divider === '1px' && g.statsTiles >= 5 && g.topRows === 4, `divider ${g.divider}, stats tiles ${g.statsTiles}, rows ${g.topRows}`);
    must(g.gutter[0] === 0 && g.gutter[1] <= 1 && g.l[0] === g.body[0], `panels do not start at the body edge ${J(g)}`);
    await shot('profile-panels-1400.png');
    await b.send('Emulation.setDeviceMetricsOverride', { width: 600, height: 900, deviceScaleFactor: 1, mobile: false });
    await b.sleep(300);
    g = await geo();
    must(g.r[2] > g.l[2] + g.l[3] - 1 && Math.abs(g.l[1] - g.r[1]) < 1.5, `at 600px the panels should stack ${J(g)}`);
    await shot('profile-panels-600.png');
    await b.send('Emulation.clearDeviceMetricsOverride');
    await b.key('Escape', { vk: 27 });
    await waitFor(`document.querySelector('dialog') === null`, 'closed');
  });
  await check('a numeric field fits its dialog with no scrollbar (10 values + distribution + summary) at 1400x900, and the dialog is a golden rectangle at every window size; the distribution sits under the values on the right', async () => {
    const saved = PROFILES.amount;
    PROFILES.amount = { ...saved, rows: 6000, distinct: 400, max: '200', summary: { mean: 61.4, median: 55, stdDev: 30.2, q1: 35, q3: 80 }, top: Array.from({ length: 10 }, (_, i) => ({ value: String(5 + i * 7), count: 2000 - i * 150, cut: false })) };
    try {
      await b.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
      await open('amount');
      await waitFor(`document.querySelector('dialog[open] .col-profile__bins') !== null`, 'distribution drawn');
      await b.sleep(1300);
      const m = await ev(`(() => { const d = document.querySelector('dialog[open]'), bd = d.querySelector('.col-profile__body');
        return { over: bd.scrollHeight - bd.clientHeight, rows: d.querySelectorAll('.col-profile__panel--top .col-profile__row').length, distRight: !!d.querySelector('.col-profile__panel--top .col-profile__section--dist .col-profile__bins'), distLeft: !!d.querySelector('.col-profile__panel--stats .col-profile__section--dist'), tiles: d.querySelectorAll('.col-profile__panel--stats .col-profile__tile:not(.col-profile__tile--blank)').length }; })()`);
      must(m.over <= 0, `the body scrolls by ${m.over}px`);
      const ratio = async () => ev(`(() => { const r = document.querySelector('dialog[open]').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), phi: r.width / r.height }; })()`);
      let r = await ratio();
      must(Math.abs(r.phi - 1.618) < 0.01 && r.h === 800, `1400x900: dialog ${r.w}x${r.h} is not a golden rectangle (${r.phi.toFixed(3)})`);
      await b.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 700, deviceScaleFactor: 1, mobile: false }); await b.sleep(300);
      r = await ratio();
      must(Math.abs(r.phi - 1.618) < 0.01 && r.h <= 644, `1400x700: dialog ${r.w}x${r.h} (${r.phi.toFixed(3)}) keeps the ratio and fits the window`);
      await b.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false }); await b.sleep(300);
      r = await ratio();
      must(Math.abs(r.phi - 1.618) < 0.01 && r.w <= 1100 - 32, `1100x900: dialog ${r.w}x${r.h} (${r.phi.toFixed(3)}) stays inside the window`);
      await b.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }); await b.sleep(300);
      must(m.rows === 10 && m.distRight && !m.distLeft && m.tiles === 10, J(m));
      await shot('profile-noscroll-1400.png');
    } finally { PROFILES.amount = saved; }
    await b.send('Emulation.clearDeviceMetricsOverride');
    await b.key('Escape', { vk: 27 });
    await waitFor(`document.querySelector('dialog') === null`, 'closed');
  });
  await check('footer buttons never wrap their labels: one line each at 420 px, and the head and foot have no fill of their own', async () => {
    await b.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
    await open('city');
    await waitFor(`document.querySelector('dialog[open] .col-profile__cell--profile') !== null`, 'city');
    const r = await ev(`(() => { const d = document.querySelector('dialog[open]'); const bg = (q) => getComputedStyle(d.querySelector(q)).backgroundColor;
      return { heights: [...d.querySelectorAll('.col-profile__foot .btn')].map((x) => Math.round(x.getBoundingClientRect().height)), head: bg('.col-profile__head'), foot: bg('.col-profile__foot'), body: bg('.col-profile__body') }; })()`);
    must(r.heights.every((h) => h <= 34), `footer button heights ${J(r.heights)}`);
    must(r.head === 'rgba(0, 0, 0, 0)' && r.foot === 'rgba(0, 0, 0, 0)', `head ${r.head} / foot ${r.foot} must have no fill (the dialog surface shows through)`);
    await b.send('Emulation.clearDeviceMetricsOverride');
    await b.key('Escape', { vk: 27 });
    await waitFor(`document.querySelector('dialog') === null`, 'closed');
  });
  await check('figures: the two figures on a row are the same height and their text is centred vertically, wide and narrow', async () => {
    for (const w of [1400, 420]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const col of ['city', 'amount', 'big']) {
        await open(col);
        await waitFor(`document.querySelector('dialog[open] .col-profile__cell--profile') !== null`, col);
        const t = await ev(`[...document.querySelectorAll('dialog[open] .col-profile__tile:not(.col-profile__tile--blank)')].map((x) => { const r = x.getBoundingClientRect(), a = x.firstElementChild.getBoundingClientRect(), z = x.lastElementChild.getBoundingClientRect(); return { h: r.height, top: r.top, up: a.top - r.top, down: r.bottom - z.bottom }; })`);
        const byRow = new Map(); for (const x of t) byRow.set(Math.round(x.top), [...(byRow.get(Math.round(x.top)) ?? []), x.h]);
        for (const hs of byRow.values()) must(Math.max(...hs) - Math.min(...hs) < 0.5, `${col} at ${w}px: two figures on one row differ in height ${J(hs.map((h) => Math.round(h)))}`);
        const tallest = Math.min(...t.map((x) => x.up));
        must(t.every((x) => Math.abs(x.up - x.down) < 1.5), `${col} at ${w}px: text not centred ${J(t.map((x) => [Math.round(x.up), Math.round(x.down)]))}`);
        must(tallest >= 15.5, `${col} at ${w}px: a tile has less than 16px above its text`);
        await b.key('Escape', { vk: 27 });
        await waitFor(`document.querySelector('dialog') === null`, 'closed ' + col);
      }
    }
    await b.send('Emulation.clearDeviceMetricsOverride');
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
