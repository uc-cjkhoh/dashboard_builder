// Browser checks for compound join keys: the relationship dialog's "Also match on" (suggestions, selects, remove, refusals), the badge,
// the pinned key rows and the preview request. Real dev app (APP_URL, default http://localhost:5223) in headless Chromium over the
// DevTools protocol (tests/live/cdp.mjs); every /api/* call is mocked. The link is made from the keyboard (Enter on two rows).
// Run: node tests/live/compound-ui.mjs  (start the app: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5223; stop it by port)
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5223';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'compound-shots');
mkdirSync(SHOTS, { recursive: true });
const COLUMNS = {
  orders: [['id', 'Int32', 'numeric'], ['cust_id', 'Int32', 'numeric'], ['Region', 'String', 'text'], ['amount', 'Float64', 'numeric'], ['placed', 'Date', 'temporal']],
  customers: [['id', 'Int32', 'numeric'], ['region', 'String', 'text'], ['name', 'String', 'text'], ['born', 'Date', 'temporal']],
};
const previews = [];
const side = { rows: 100, nullRows: 0, keys: 100, matchedKeys: 90, matchedRows: 90, maxDuplicates: 1, avgDuplicates: 1 };
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: Object.keys(COLUMNS) };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/relationships/preview') { previews.push(body); return { json: { from: side, to: side, sampleLimit: 1000000, sampled: false } }; }
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
  const shot = async (name) => writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await b.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, 'databases listed');
  await ev(`(() => { for (const r of document.querySelectorAll('.db-row[data-db]')) if ((r.dataset.db === 'shop') !== (r.getAttribute('aria-expanded') === 'true')) r.click(); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders', 'customers']) await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'tables loaded');
  const row = (t, c) => `[...document.querySelectorAll('.entity')].find((x) => x.querySelector('.entity__table').textContent === ${J(t)}).querySelector('.col-row[data-column=' + ${J(JSON.stringify(c))} + ']')`;
  const press = (t, c, key) => ev(`(() => { const r = ${row(t, c)}; r.focus(); r.dispatchEvent(new KeyboardEvent('keydown', { key: ${J(key)}, bubbles: true, cancelable: true })); return true; })()`);
  const dlg = `document.querySelector('dialog[open]')`;
  const texts = (sel) => ev(`[...${dlg}.querySelectorAll(${J(sel)})].map((x) => x.textContent.trim())`);
  const press2 = (label) => ev(`(() => { const x = [...${dlg}.querySelectorAll('button')].find((y) => y.textContent.trim() === ${J(label)} || y.getAttribute('aria-label') === ${J(label)}); if (!x) throw new Error('no button ' + ${J(label)}); x.click(); return true; })()`);
  const pick = (which, value) => ev(`(() => { const s = ${dlg}.querySelectorAll('.key-pairs__select')[${which}]; s.value = ${J(value)}; return s.value === ${J(value)}; })()`);
  const problem = () => ev(`${dlg}.querySelector('.key-pairs__problem').hidden ? '' : ${dlg}.querySelector('.key-pairs__problem').textContent.trim()`);

  await check('the keyboard relate flow opens the dialog with "Also match on" and suggests the same-named, same-kind pair', async () => {
    await press('orders', 'cust_id', 'Enter');
    await press('customers', 'id', 'Enter');
    await waitFor(`document.querySelector('dialog[open] .key-pairs') !== null`, 'dialog with key pairs');
    must((await texts('.key-pairs legend'))[0] === 'Also match on', 'legend');
    const s = await texts('.key-pairs__suggestion');
    must(s.length === 1 && s[0] === 'Add Region = region', `suggestions: ${J(s)}`); // case-insensitive; id=id is not offered (id is the first pair's column)
    must(await ev(`${dlg}.querySelector('.key-pairs__list').hidden`), 'list should be empty');
    await shot('compound-dialog.png');
  });
  await check('the selects list only free columns of each table', async () => {
    const o = await ev(`[...${dlg}.querySelectorAll('.key-pairs__select')].map((s) => [...s.options].map((x) => x.value).filter(Boolean).join(','))`);
    must(o[0] === 'id,Region,amount,placed' && o[1] === 'region,name,born', `options: ${J(o)}`); // cust_id / customers.id are the first pair
    const ph = await ev(`[...${dlg}.querySelectorAll('.key-pairs__select')].map((x) => x.options[0].textContent)`);
    must(J(ph) === J(['orders', 'customers']), `placeholders name the table: ${J(ph)}`);
    must(await ev(`!!${dlg}.querySelector('.key-pairs__eq')`), 'the = between the selects');
    must(await ev(`[...${dlg}.querySelectorAll('.key-pairs__select')].every((x) => x.classList.contains('select--menu') && x.options[0].hidden)`), 'menu-styled selects with the prompt out of the open list');
  });
  await check('each column option keeps its name and its kind apart (only the name can ellipsise); Add pair sits under the two selects', async () => {
    const o = await ev(`[...${dlg}.querySelectorAll('.key-pairs__select')[0].options].slice(1).map((x) => [x.querySelector('.key-pairs__col')?.textContent, x.querySelector('.key-pairs__kind')?.textContent, x.title].join('|'))`);
    must(o[0] === 'id|(number)|id (number)' && o[1] === 'Region|(text)|Region (text)', `options: ${J(o)}`);
    const g = await ev(`(() => { const s = [...${dlg}.querySelectorAll('.key-pairs__select')].map((x) => x.getBoundingClientRect()); const a = ${dlg}.querySelector('.key-pairs__go').getBoundingClientRect(); return { sameLine: Math.abs(s[0].top - s[1].top) < 1, below: a.top >= s[0].bottom, right: Math.abs(a.right - s[1].right) < 1 }; })()`);
    must(g.sameLine && g.below && g.right, `layout: ${J(g)}`);
  });
  await check('the suggestion ran as the dialog opened; adding a suggested pair runs it again with the pair', async () => {
    await waitFor(`${dlg}.querySelector('.join-check__pick') !== null`, 'first suggestion');
    must(previews.length === 1 && !previews[0].pairs, `first preview: ${J(previews)}`);
    await press2('Add Region = region');
    must((await texts('.key-pairs__item span'))[0] === 'Region = region', 'chip');
    must(!(await ev(`${dlg}.querySelector('.key-pairs__suggestion')`)), 'suggestion should be gone');
    must(await ev(`${dlg}.querySelector('.join-check__note--busy') !== null && !${dlg}.querySelector('.join-check__pick')`), 'old result shown while the re-run is pending');
    await ev(`[...${dlg}.querySelectorAll('input[name=cardinality]')].find((x) => x.value === '1:1').click()`); // a pick meanwhile must not bring the old result back
    must(await ev(`!${dlg}.querySelector('.join-check__pick')`), 'a cardinality pick showed the stale result');
    await waitFor(`${dlg}.querySelector('.join-check__pick') !== null`, 'preview result');
    must(previews.length === 2 && J(previews[1].pairs) === J([{ left: 'Region', right: 'region' }]) && previews[1].from.column === 'cust_id', `preview body: ${J(previews[1])}`);
    must(/cust_id \+ Region/.test(await ev(`${dlg}.querySelector('.join-check__out').textContent`)), 'the result should name the compound key');
  });
  await check('refusals: a different kind, and a column already used, say why', async () => {
    await pick(0, 'amount'); await pick(1, 'name'); await press2('Add pair');
    must(/same kind/.test(await problem()), `kind: ${await problem()}`);
    await pick(0, 'placed'); await pick(1, 'born'); await press2('Add pair');
    must((await texts('.key-pairs__item span')).join('|') === 'Region = region|placed = born', 'a date pair should be accepted');
    await press2('Remove placed = born');
    must((await texts('.key-pairs__item span')).join('|') === 'Region = region', 'remove');
    await waitFor(`${dlg}.querySelector('.join-check__pick') !== null`, 'result after add / remove');
    must(J(previews.at(-1).pairs) === J([{ left: 'Region', right: 'region' }]), `after remove: ${J(previews.at(-1))}`);
    must(previews.length >= 3, `add + remove re-ran the check: ${previews.length}`);
  });
  await check('N:1 saves the link: the badge counts the keys and every key column is pinned', async () => {
    await ev(`[...${dlg}.querySelectorAll('input[name=cardinality]')].find((x) => x.value === 'N:1').click(); ${dlg}.querySelector('.rel-dialog__foot .btn--primary').click()`);
    await waitFor(`document.querySelector('.rel-badge text')?.textContent === 'N:1 · 2 keys'`, 'badge');
    must(await ev(`document.querySelectorAll('.entity__keys .col-row').length === 4`), 'cust_id, Region, id, region should be pinned');
    await shot('compound-linked.png');
    await ev(`document.documentElement.dataset.scheme = 'dark'`); await b.sleep(600); await shot('compound-linked-dark.png'); await ev(`delete document.documentElement.dataset.scheme`);
  });
  await check('a key column of the pair can\'t start another relationship', async () => {
    await press('orders', 'Region', 'Enter');
    await press('customers', 'name', 'Enter');
    await b.sleep(300);
    // refused with no cardinality dialog: the refusal is a toast naming the column
    must(await ev(`document.querySelector('dialog[open]') === null`), 'dialog opened for a column already in a link');
    must(/already in a relationship/.test(await ev(`document.getElementById('toast').textContent`)), 'no refusal toast for a used column');
    must(await ev(`document.querySelectorAll('.rel-link__line').length === 1`), 'a second link was drawn');
  });
  await check('editing the link shows its pair; removing it leaves a plain badge', async () => {
    await ev(`document.querySelector('.rel-link--label').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await waitFor(`document.querySelector('dialog[open] .key-pairs') !== null`, 'edit dialog');
    must((await texts('.key-pairs__item span'))[0] === 'Region = region', 'saved pair not shown');
    await ev(`[...${dlg}.querySelectorAll('button')].find((y) => y.getAttribute('aria-label') === 'Remove Region = region').click()`);
    await ev(`[...${dlg}.querySelectorAll('input[name=cardinality]')].find((x) => x.value === 'N:1').click(); ${dlg}.querySelector('.rel-dialog__foot .btn--primary').click()`);
    await waitFor(`document.querySelector('.rel-badge text')?.textContent === 'N:1'`, 'plain badge');
    must(await ev(`document.querySelectorAll('.entity__keys .col-row').length === 2`), 'only the first pair stays pinned');
  });
  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) { console.log(`FAIL harness: ${e.stack}`); failed++; } finally { if (b) await b.close(); }
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
