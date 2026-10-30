// Browser checks for the join safety preview ("Check this join" in the relationship dialog): the real dev app (APP_URL, default http://localhost:5180) in headless
// Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), with every /api/* call answered by a mock —
// nothing reaches a ClickHouse. Run:  node tests/live/join-check-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5180 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5180';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'join-check-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['cust_id', 'Int32', 'numeric'], ['amount', 'Float64', 'numeric']],
  customers: [['id', 'Int32', 'numeric'], ['name', 'String', 'text']],
};
const previews = [];
let previewMode = 'manyToOne', gate = null;
const side = (o) => ({ rows: 1000, nullRows: 0, keys: 1000, matchedKeys: 1000, matchedRows: 1000, maxDuplicates: 1, avgDuplicates: 1, ...o });
const MODES = {
  manyToOne: { from: side({ keys: 200, matchedKeys: 190, matchedRows: 940, maxDuplicates: 14, avgDuplicates: 5 }), to: side({ rows: 200, keys: 200, matchedKeys: 190, matchedRows: 190 }), sampleLimit: 1000000, sampled: false },
  fanout: { from: side({ nullRows: 100, keys: 100, matchedRows: 900, maxDuplicates: 9, avgDuplicates: 4.5 }), to: side({ maxDuplicates: 3, avgDuplicates: 2 }), sampleLimit: 1000000, sampled: false },
  manyToMany: { from: side({ nullRows: 100, keys: 100, maxDuplicates: 9, avgDuplicates: 4.5 }), to: side({ maxDuplicates: 3, avgDuplicates: 2 }), sampleLimit: 1000000, sampled: true },
};
const queries = [];
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders', 'customers'] };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/relationships/preview') {
    previews.push(body);
    return (async () => { if (gate) await gate; return previewMode === 'error' ? { status: 400, json: { error: "Can't relate orders.cust_id (numeric) to customers.id (text) — join keys must hold the same kind of value." } } : { json: MODES[previewMode] }; })();
  }
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
  const shot = async (name) => { const p = join(SHOTS, name); await b.screenshot(p); console.log('  screenshot', p); };

  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders', 'customers'])
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'both tables loaded');
  const dragRow = (fromT, fromC, toT, toC) => ev(`(() => { const row = (t, c) => [...document.querySelectorAll('.entity')].find((x) => x.textContent.includes(t)).querySelector('.col-row[data-column=' + JSON.stringify(c) + ']');
    const a = row(${J(fromT)}, ${J(fromC)}), z = row(${J(toT)}, ${J(toC)}); const dt = new DataTransfer();
    a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); z.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    z.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return true; })()`);
  await dragRow('orders', 'cust_id', 'customers', 'id'); // relationships are made by dragging one column onto another
  await waitFor(`document.querySelector('dialog[open] .join-check') !== null`, 'dialog with the check');
  const click = (sel) => ev(`document.querySelector(${J(sel)}).click()`);
  const text = (sel) => ev(`document.querySelector(${J(sel)})?.textContent ?? ''`);

  await check('the result area starts hidden; the button is offered with its bound explained', async () => {
    must(await ev(`document.querySelector('dialog[open] .join-check__out').children.length === 0 && document.querySelector('dialog[open] .join-check__out').getAttribute('role') === 'status'`), 'result shown before a check, or not a status region');
    must(/Check this join/.test(await text('dialog[open] .join-check__btn')), 'no button');
    must(/read-only/i.test(await text('dialog[open] .join-check__hint')), 'no hint');
  });
  await check('while checking: a busy note with an icon, and the button is disabled', async () => {
    let release; gate = new Promise((r) => { release = r; });
    await click('dialog[open] .join-check__btn');
    await waitFor(`document.querySelector('dialog[open] .join-check__note--busy svg') !== null`, 'busy note');
    must(await ev(`document.querySelector('dialog[open] .join-check__btn').disabled`), 'button not disabled while loading');
    await shot('join-check-loading.png');
    gate = null; release();
    await waitFor(`!document.querySelector('dialog[open] .join-check__btn').disabled`, 'button re-enabled');
  });
  await check('a new link gets a request naming both keys, plain-words counts and a many-to-one reading, no warning', async () => {
    must(J(previews.at(-1)) === J({ from: { db: 'shop', table: 'orders', column: 'cust_id' }, to: { db: 'shop', table: 'customers', column: 'id' } }), 'request ' + J(previews.at(-1)));
    const t = await text('dialog[open] .join-check__out');
    must(t.includes("94% of the rows in orders have a match in customers; 6% don't."), t);
    must(/many-to-one \(N:1\)/.test(t), t);
    must(await ev(`document.querySelectorAll('dialog[open] .join-check__note--warn').length`) === 0, 'unexpected warning');
    await shot('join-check-ok.png');
  });
  await check('saving still works after a check (N:1)', async () => {
    await ev(`[...document.querySelectorAll('dialog[open] .card-choice')].find((x) => x.textContent === 'N:1').click()`);
    await waitFor(`document.querySelector('.rel-badge text')?.textContent === 'N:1'`, 'badge');
  });

  previewMode = 'fanout';
  await ev(`document.querySelector('.rel-badge').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await waitFor(`document.querySelector('dialog[open] .join-check') !== null`, 'edit dialog');
  await check('editing: both sides repeat and the declared N:1 disagrees -> one combined fan-out warning with an icon', async () => {
    await click('dialog[open] .join-check__btn');
    await waitFor(`document.querySelectorAll('dialog[open] .join-check__note--warn').length >= 1`, 'warnings');
    const w = await ev(`[...document.querySelectorAll('dialog[open] .join-check__note--warn')].map((n) => ({ svg: !!n.querySelector('svg'), t: n.textContent }))`);
    must(w.every((x) => x.svg), 'a warning without an icon');
    must(w.some((x) => /many-to-many/.test(x.t) && /double-count/.test(x.t)), J(w));
    
    
    must((await text('dialog[open] .join-check__out')).includes('10% of orders rows have no cust_id'), 'no NULL note');
    must(await ev(`document.querySelectorAll('dialog[open] .join-check__note--warn').length`) === 1, 'expected ONE combined fan-out warning');
    must(/You declared N:1/.test(await text('dialog[open] .join-check__note--warn')), 'declaration not named');
    await shot('join-check-warn.png');
  });
  await check('a sampled result leads with the sampling note, words shares within the sample, and raises no amber warning', async () => {
    previewMode = 'manyToMany';
    await click('dialog[open] .join-check__btn');
    await waitFor(`document.querySelector('dialog[open] .join-check__out')?.textContent.includes('Within the sample')`, 'sampled reading');
    must((await ev(`document.querySelector('dialog[open] .join-check__note')?.textContent`)).startsWith('Based on the first 1,000,000 rows of each table, in no particular order'), 'sampling note not first note');
    must(await ev(`document.querySelectorAll('dialog[open] .join-check__note--warn').length`) === 0, 'amber warning on a sampled result');
    await shot('join-check-sampled.png');
  });
  await check('a rejected check shows the server message with an error icon and re-enables the button', async () => {
    previewMode = 'error';
    await click('dialog[open] .join-check__btn');
    await waitFor(`document.querySelector('dialog[open] .join-check__note--error svg') !== null`, 'error note');
    must(/join keys must hold the same kind of value/.test(await text('dialog[open] .join-check__note--error')), 'message');
    must(!(await ev(`document.querySelector('dialog[open] .join-check__btn').disabled`)), 'button stuck');
  });
  await check('the dialog still saves after a failed check (never blocked)', async () => {
    await ev(`[...document.querySelectorAll('dialog[open] .card-choice')].find((x) => x.textContent === '1:N').click()`);
    await waitFor(`document.querySelector('.rel-badge text')?.textContent === '1:N'`, 'badge 1:N');
  });
  previewMode = 'fanout';
  await ev(`document.querySelector('.rel-badge').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await waitFor(`document.querySelector('dialog[open] .join-check') !== null`, 'dialog again');
  await click('dialog[open] .join-check__btn');
  await waitFor(`document.querySelectorAll('dialog[open] .join-check__note--warn').length >= 1`, 'warnings again');
  for (const scheme of ['light', 'dark']) {
    await b.setScheme(scheme);
    await ev(`document.documentElement.setAttribute('data-theme', ${J(scheme)})`);
    await b.sleep(300);
    await check(`${scheme} screenshot`, async () => { await shot(`join-check-${scheme}.png`); });
  }
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
