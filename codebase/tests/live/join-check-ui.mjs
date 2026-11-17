// Browser checks for the relationship suggestion (the data's cardinality and evidence, run as the relationship dialog opens): the real dev app (APP_URL, default http://localhost:5180) in headless
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
  let release; gate = new Promise((r) => { release = r; }); // hold the first answer so the busy state can be seen
  await dragRow('orders', 'cust_id', 'customers', 'id'); // relationships are made by dragging one column onto another
  await waitFor(`document.querySelector('dialog[open] .join-check') !== null`, 'dialog with the check');
  const click = (sel) => ev(`document.querySelector(${J(sel)}).click()`);
  const text = (sel) => ev(`document.querySelector(${J(sel)})?.textContent ?? ''`);
  const pick = (c) => ev(`[...document.querySelectorAll('dialog[open] input[name=cardinality]')].find((x) => x.value === ${J(c)}).click()`);

  await check('the suggestion runs as the dialog opens (no button): a busy note with an icon, the re-check button disabled', async () => {
    await waitFor(`document.querySelector('dialog[open] .join-check__note--busy svg') !== null`, 'busy note');
    must(previews.length === 1, `previews sent: ${previews.length}`);
    must(await ev(`document.querySelector('dialog[open] .join-check__rerun').disabled`), 're-check not disabled while loading');
    must(await ev(`document.querySelector('dialog[open] .join-check__out').getAttribute('role') === 'status'`), 'not a status region');
    must(/bounded sample/i.test(await text('dialog[open] .join-check__hint')), 'no hint');
    await shot('join-check-loading.png');
    gate = null; release();
    await waitFor(`!document.querySelector('dialog[open] .join-check__rerun').disabled`, 're-check re-enabled');
  });
  await check('a new link: request names both keys; the suggestion reads N:1 with reasons and a counts table, no warning', async () => {
    must(J(previews.at(-1)) === J({ from: { db: 'shop', table: 'orders', column: 'cust_id' }, to: { db: 'shop', table: 'customers', column: 'id' } }), 'request ' + J(previews.at(-1)));
    must((await text('dialog[open] .join-check__pick')) === 'N:1 · many-to-one', await text('dialog[open] .join-check__pick'));
    const t = await text('dialog[open] .join-check__out');
    must(t.includes("94% of the rows in orders have a match in customers; 6% don't."), t);
    const tags = await ev(`[...document.querySelectorAll('dialog[open] .join-check__tag')].map((x) => x.textContent).join(',')`);
    must(tags === 'Many,One,Match,Match', tags);
    must(/cust_id repeats in orders: up to 14 rows for one key/.test(t), t);
    must(await ev(`document.querySelectorAll('dialog[open] .join-check__table tbody tr').length`) === 7, 'counts table rows');
    must(/orders\.cust_id/.test(await text('dialog[open] .join-check__table thead')), 'table head');
    must(await ev(`document.querySelectorAll('dialog[open] .join-check__note--warn').length`) === 0, 'unexpected warning');
    await shot('join-check-ok.png');
  });
  await check('the dialog is up to 1216px wide in golden ratio, two equal panels, the left panel reads Join, Cardinality, Totals, Also match on with Join and Cardinality as 2 x 2 radio cards (no hints, content vertically centred), the suggestion panel stacks suggestion / evidence / counts and keeps 16px clear of its scrollbar', async () => {
    const g = await ev(`(() => { const r = (q) => { const b = document.querySelector('dialog[open] ' + q).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width }; };
      const p = document.querySelector('dialog[open] .rel-dialog__right'), pr = p.getBoundingClientRect();
      return { dlg: r(''), left: r('.rel-dialog__left').width, divider: pr.left, bar: pr.left + p.clientWidth, main: r('.join-check__main'), ev: r('.join-check__evidence'), table: r('.join-check__table'), out: r('.join-check__out'),
        joinTop: r('.join-choice legend').top, titleTop: r('.join-check__title').top, vh: innerHeight }; })()`);
    must(g.dlg.width === Math.min(1216, 1400 - 32), `dialog width ${g.dlg.width}`);
    must(Math.abs(g.dlg.width / (g.dlg.bottom - g.dlg.top) - 1.618) < 0.01 || g.dlg.bottom - g.dlg.top >= g.vh - 33, `not golden ratio: ${J(g.dlg)}`);
    const order = await ev(`[...document.querySelectorAll('dialog[open] .rel-dialog__left > .rel-sec')].map((s) => s.querySelector('legend')?.textContent)`);
    must(J(order) === J(['Join', 'Cardinality', 'Totals', 'Also match on']), `section order ${J(order)}`);
    const grids = await ev(`[...document.querySelectorAll('dialog[open] .choice-cards')].map((g) => { const c = [...g.children].map((x) => x.getBoundingClientRect()); return { n: c.length, cols: new Set(c.map((x) => Math.round(x.left))).size, border: getComputedStyle(g.children[0]).borderTopWidth }; })`);
    must(grids.length === 2 && grids.every((x) => x.n === 4 && x.cols === 2 && x.border === '1px'), `not 2 x 2 cards: ${J(grids)}`);
    const off = await ev(`[...document.querySelectorAll('dialog[open] .choice-card')].map((c) => { const m = (e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; };
      return Math.max(Math.abs(m(c.querySelector('input')) - m(c)), Math.abs(m(c.querySelector('.choice-card__text')) - m(c))); })`);
    must(off.every((d) => d < 1), `card radio / text not vertically centred: ${J(off)}`);
    must(await ev(`document.querySelectorAll('dialog[open] .choice-card__hint').length`) === 0, 'a card still shows a hint');
    must(Math.abs(g.divider - (g.dlg.left + g.dlg.width / 2)) < 1, `divider not centred: ${J(g)}`);
    must(g.ev.top >= g.main.bottom && g.table.top >= g.ev.bottom, `groups not stacked: ${J(g)}`);
    must(g.bar - g.out.right >= 16, `content within 16px of the scrollbar: ${J(g)}`);
    must(Math.abs(g.joinTop - g.titleTop) < 1, `"Suggestion" not level with "Join": ${J(g)}`);
    must(await ev(`[...document.querySelectorAll('dialog[open] .join-check__table thead th')].every((th) => th.scrollWidth <= th.clientWidth)`), 'a column head is cut off');
    await ev(`(() => { const p = document.querySelector('dialog[open] .rel-dialog__right'); p.scrollTop = p.scrollHeight; return 1; })()`);
    await shot('join-check-evidence.png');
    await ev(`(() => { document.querySelector('dialog[open] .rel-dialog__right').scrollTop = 0; return 1; })()`);
  });
  await check('the comparison follows the chosen cardinality without a new query: Use N:1 when it differs, "Matches your choice" when not', async () => {
    const before = previews.length;
    await pick('1:N');
    must((await text('dialog[open] .join-check__use')) === 'Use N:1', 'no Use N:1');
    await click('dialog[open] .join-check__use');
    must(await ev(`document.querySelector('dialog[open] input[name=cardinality]:checked')?.value`) === 'N:1', 'Use did not select');
    must(/Matches your choice/.test(await text('dialog[open] .join-check__suggest')), 'no match note');
    must(previews.length === before, 'a cardinality pick re-queried');
  });
  await check('the re-check button runs the query again; a cardinality pick while it runs keeps the busy note (no stale result)', async () => {
    const before = previews.length;
    let release2; gate = new Promise((r) => { release2 = r; });
    await click('dialog[open] .join-check__rerun');
    await waitFor(`document.querySelector('dialog[open] .join-check__note--busy') !== null`, 'busy');
    await pick('1:1');
    must(await ev(`document.querySelector('dialog[open] .join-check__note--busy') !== null && !document.querySelector('dialog[open] .join-check__pick')`), 'stale result shown during a re-run');
    await pick('N:1');
    gate = null; release2();
    await waitFor(`!document.querySelector('dialog[open] .join-check__rerun').disabled && !!document.querySelector('dialog[open] .join-check__pick')`, 'result again');
    must(previews.length === before + 1, 'no new request');
  });
  await check('saving still works (N:1)', async () => {
    await ev(`document.querySelector('dialog[open]').querySelector('.rel-dialog__foot .btn--primary').click()`);
    await waitFor(`document.querySelector('.rel-badge text')?.textContent === 'N:1'`, 'badge');
  });

  previewMode = 'fanout';
  await ev(`document.querySelector('.rel-badge').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await waitFor(`document.querySelector('dialog[open] .join-check') !== null`, 'edit dialog');
  await check('editing: the check runs on open; both sides repeat and the chosen N:1 disagrees -> one combined fan-out warning with an icon', async () => {
    await waitFor(`document.querySelectorAll('dialog[open] .join-check__note--warn').length >= 1`, 'warnings');
    const w = await ev(`[...document.querySelectorAll('dialog[open] .join-check__note--warn')].map((n) => ({ svg: !!n.querySelector('svg'), t: n.textContent }))`);
    must(w.every((x) => x.svg), 'a warning without an icon');
    must(w.some((x) => /many-to-many/.test(x.t) && /double-count/.test(x.t)), J(w));
    
    
    must((await text('dialog[open] .join-check__out')).includes('10% of orders rows have no cust_id'), 'no NULL note');
    must(await ev(`document.querySelectorAll('dialog[open] .join-check__note--warn').length`) === 1, 'expected ONE combined fan-out warning');
    must(await ev(`document.querySelectorAll('dialog[open] .join-check__main > .join-check__note').length`) === 1, 'notes not combined into one card');
    must(await ev(`document.querySelector('dialog[open] .join-check__main').firstElementChild.classList.contains('join-check__suggest')`), 'suggestion not on top');
    must(await ev(`[...document.querySelectorAll('dialog[open] .join-check__line')].every((l) => !!l.querySelector('svg'))`), 'a note line without an icon');
    must(/You chose N:1/.test(await text('dialog[open] .join-check__note--warn')), 'declaration not named');
    await shot('join-check-warn.png');
  });
  await check('a sampled result: the suggestion on top, then one notes card led by the sampling note; shares worded within the sample, no amber warning', async () => {
    previewMode = 'manyToMany';
    await click('dialog[open] .join-check__rerun');
    await waitFor(`document.querySelector('dialog[open] .join-check__out')?.textContent.includes('Within the sample')`, 'sampled reading');
    const kids = await ev(`[...document.querySelector('dialog[open] .join-check__main').children].map((c) => c.className)`);
    must(kids.length === 2 && /join-check__suggest/.test(kids[0]) && /join-check__notes/.test(kids[1]), `not suggestion then one notes card: ${J(kids)}`);
    must((await ev(`document.querySelector('dialog[open] .join-check__notes .join-check__line')?.textContent`) ?? '').startsWith('Based on the first 1,000,000 rows of each table, in no particular order'), 'sampling note not the first line of the notes card');
    must((await text('dialog[open] .join-check__label')) === 'Suggested cardinality, from a sample', 'label not qualified');
    must(!/is unique in/.test(await text('dialog[open] .join-check__out')), 'a sampled side called unique');
    must(await ev(`document.querySelectorAll('dialog[open] .join-check__note--warn').length`) === 0, 'amber warning on a sampled result');
    await shot('join-check-sampled.png');
  });
  await check('a rejected check shows the server message with an error icon and re-enables the re-check button', async () => {
    previewMode = 'error';
    await click('dialog[open] .join-check__rerun');
    await waitFor(`document.querySelector('dialog[open] .join-check__note--error svg') !== null`, 'error note');
    must(/join keys must hold the same kind of value/.test(await text('dialog[open] .join-check__note--error')), 'message');
    must(!(await ev(`document.querySelector('dialog[open] .join-check__rerun').disabled`)), 'button stuck');
  });
  await check('the dialog still saves after a failed check (never blocked)', async () => {
    await ev(`[...document.querySelectorAll('dialog[open] input[name=cardinality]')].find((x) => x.value === '1:N').click(); document.querySelector('dialog[open]').querySelector('.rel-dialog__foot .btn--primary').click()`);
    await waitFor(`document.querySelector('.rel-badge text')?.textContent === '1:N'`, 'badge 1:N');
  });
  previewMode = 'fanout';
  await ev(`document.querySelector('.rel-badge').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await waitFor(`document.querySelector('dialog[open] .join-check') !== null`, 'dialog again');
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
