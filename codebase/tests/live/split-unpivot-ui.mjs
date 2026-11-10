// Browser check for Unpivot (T02-32 preview) and Split (T02-31): the real dev app (APP_URL, default http://localhost:5224) in
// headless Chromium over the DevTools protocol (tests/live/cdp.mjs), every /api/* call mocked. Run:  node tests/live/split-unpivot-ui.mjs
//   (start the app: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5224 ; stop: fuser -k 5224/tcp)
// Env: APP_URL, SHOTS_DIR, CDP_PORT, CHROME_BIN.
import { launch } from './cdp.mjs';
import { CALC_NAMES } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5224';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'split-unpivot-ui-shots');
mkdirSync(SHOTS, { recursive: true });

const COLS = [['id', 'UInt64', 'numeric'], ['q1', 'Int32', 'numeric'], ['q2', 'Int32', 'numeric'], ['q3', 'Int32', 'numeric'], ['tags', 'String', 'text']];
const unpivotReqs = [];
let unpivotReply = null;
const UNPIVOT = { columns: [{ name: 'id', type: 'UInt64' }, { name: 'Field', type: 'String' }, { name: 'Value', type: 'Int32' }],
  rows: [['1', 'q1', '10'], ['1', 'q2', null]], truncated: false, limit: 20, columnsTruncated: false };
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['sales', 'orders'] };
  if (/\/tables\/(sales|orders)\/columns$/.test(path)) return { json: COLS.map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/unpivot') { unpivotReqs.push(body); return unpivotReply ?? { json: UNPIVOT }; }
  if (path === '/api/query') return { json: { rowDimensions: [], columnDimensions: [], measures: [], rows: [], truncated: false } };
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
  const shot = async (name) => { try { writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } };
  const ud = `document.querySelector('dialog.unpivot-dialog[open]')`;
  const rd = `document.querySelector('dialog.rows-dialog[open]')`;
  const sd = `document.querySelector('dialog.split-dialog[open]')`;
  const go = `[...${ud}.querySelectorAll('button')].find((x) => x.textContent === 'Show rows')`;
  const tick = (side, name) => ev(`(() => { const c = [...${ud}.querySelectorAll('.unpivot-dialog__list')[${side}].querySelectorAll('input')].find((x) => x.value === ${J(name)}); c.checked = !c.checked; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); ${code}; })()`);

  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');

  await check('Unpivot lists the columns twice, Show rows disabled until two are ticked', async () => {
    await ev(`document.getElementById('unpivot-open').click()`);
    await waitFor(`${ud} !== null && ${ud}.querySelectorAll('input').length === ${COLS.length * 2}`, 'dialog with columns');
    must(await ev(`${go}.disabled`) === true, 'disabled with none');
    must((await ev(`${ud}.querySelector('.union-dialog__hint').textContent`)) === 'Pick 2 to 50 columns to turn into rows.', 'hint');
    await tick(0, 'q1'); must(await ev(`${go}.disabled`) === true, 'disabled with one');
    await tick(0, 'q2'); must(await ev(`${go}.disabled`) === false, 'enabled with two');
    must((await ev(`${ud}.querySelector('.union-dialog__hint').textContent`)) === '2 columns become rows.', 'ready line');
    await shot('unpivot-pick-light.png');
  });
  await check('a column ticked on one side is disabled on the other; mixed kinds are refused', async () => {
    must(await ev(`[...${ud}.querySelectorAll('.unpivot-dialog__list')[1].querySelectorAll('input')].find((x) => x.value === 'q1').disabled`) === true, 'q1 not keepable');
    await tick(0, 'tags');
    must(await ev(`${go}.disabled`) === true, 'text + numbers refused');
    must((await ev(`${ud}.querySelector('.union-dialog__hint').textContent`)).includes('same kind'), 'kind hint');
    await tick(0, 'tags');
    must(await ev(`${go}.disabled`) === false, 'enabled again');
  });
  await check('Show rows posts the unpivot and shows Field and Value', async () => {
    await tick(1, 'id');
    await ev(`${go}.click()`);
    await waitFor(`${rd} !== null && ${rd}.querySelectorAll('tbody tr').length === 2`, 'rows rendered');
    must(J(unpivotReqs.at(-1)) === J({ db: 'shop', table: 'sales', columns: ['q1', 'q2'], keep: ['id'], limit: 20 }), `request: ${J(unpivotReqs.at(-1))}`);
    const heads = await ev(`[...${rd}.querySelectorAll('th')].map((t) => t.textContent)`);
    must(J(heads) === J(['idUInt64', 'FieldString', 'ValueInt32']), `heads: ${J(heads)}`);
    must(await ev(`${ud} !== null`), 'pick dialog stays open under the preview');
    await shot('unpivot-rows-light.png');
  });
  await check('closing the preview returns to the Unpivot dialog with the picks kept', async () => {
    await ev(`[...${rd}.querySelectorAll('.dialog__foot button')].find((x) => x.textContent === 'Close').click()`); // (the harness's synthetic Escape also reaches the dialog beneath) await waitFor(`${rd} === null`, 'preview closed');
    must(await ev(`${ud} !== null`), 'unpivot dialog still open');
    must(J(await ev(`[...${ud}.querySelectorAll('input')].filter((x) => x.checked).map((x) => x.value)`)) === J(['q1', 'q2', 'id']), 'picks kept');
    await ev(`${ud}.querySelector('button').click()`); await waitFor(`${ud} === null`, 'closed');
  });
  await check('a server refusal shows its sentence', async () => {
    await b.key('Escape', { vk: 27 }); await waitFor(`${rd} === null`, 'closed');
    unpivotReply = { status: 400, json: { error: "'q2' has a different kind of values from 'q1', so they can't share one Value column.", field: 'columns[1]' } };
    await ev(`document.getElementById('unpivot-open').click()`);
    await waitFor(`${ud} !== null && ${ud}.querySelectorAll('input').length === ${COLS.length * 2}`, 'open');
    await tick(0, 'q1'); await tick(0, 'q2'); await ev(`${go}.click()`);
    await waitFor(`${rd} !== null && ${rd}.querySelector('.rows-dialog__status--error') !== null`, 'error shown');
    unpivotReply = null;
    await b.key('Escape', { vk: 27 }); await waitFor(`${rd} === null`, 'closed');
  });

  await check('Split… makes one calculated field per piece from a text field', async () => {
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'sales' } }))`);
    await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'sales loaded');
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
    await waitFor(`document.querySelectorAll('#ws-fields .ws-field').length >= 5`, 'fields');
    const menu = (name) => ev(`(() => { const c = [...document.querySelectorAll('#ws-fields .ws-field')].find((x) => x.querySelector('.ws-field__name')?.textContent === ${J(name)}); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); return [...document.querySelectorAll('.ctx-menu .menu__item')].map((x) => x.textContent.trim()); })()`);
    must(!(await menu('q1')).some((t) => t.startsWith('Split')), 'no Split on a number field');
    await b.key('Escape', { vk: 27 });
    must((await menu('tags')).some((t) => t.startsWith('Split')), 'Split on a text field');
    await ev(`[...document.querySelectorAll('.ctx-menu .menu__item')].find((x) => x.textContent.trim().startsWith('Split')).click()`);
    await waitFor(`${sd} !== null`, 'split dialog');
    must(await ev(`${sd}.querySelectorAll('li').length`) === 2, 'two pieces by default');
    await ev(`(() => { const p = ${sd}.querySelector('input[type=number]'); p.value = '3'; p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    must(await ev(`[...${sd}.querySelectorAll('li')].map((l) => l.textContent).join('|')`) === 'tags 1|tags 2|tags 3', 'names');
    await shot('split-dialog-light.png');
    await ev(`(() => { const n = ${sd}.querySelectorAll('input[type=text]')[1]; n.value = 'Country, ,Town'; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    must(await ev(`[...${sd}.querySelectorAll('li')].map((l) => l.textContent).join('|')`) === 'Country|tags 2|Town', 'given names');
    await ev(`(() => { const n = ${sd}.querySelectorAll('input[type=text]')[1]; n.value = 'A,B,C,D'; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    must(await ev(`${sd}.querySelector('.grp-error').textContent`) === '4 names for 3 pieces.', 'too many names');
    await ev(`(() => { const n = ${sd}.querySelectorAll('input[type=text]')[1]; n.value = ''; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await ev(`(() => { const p = ${sd}.querySelector('input[type=number]'); p.value = '11'; p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    must(await ev(`${sd}.querySelector('.dialog__foot .btn--primary').disabled`) === true, 'create disabled over 10');
    await ev(`(() => { const p = ${sd}.querySelector('input[type=number]'); p.value = '3'; p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await ev(`${sd}.querySelector('.dialog__foot .btn--primary').click()`);
    await waitFor(`${sd} === null`, 'closed');
    const calcs = await ev(`(async () => { const st = await import('/features/Core/store.js'); return JSON.stringify(st.calculations.map((c) => [c.name, c.formula])); })()`);
    must(calcs === J([['tags 1', 'SPLIT([shop.sales.tags], \',\', 1)'], ['tags 2', 'SPLIT([shop.sales.tags], \',\', 2)'], ['tags 3', 'SPLIT([shop.sales.tags], \',\', 3)']]), calcs);
    await waitFor(`${CALC_NAMES}.length === 3`, 'fields appear in Calculated fields');
  });
  await check('dark scheme renders the dialogs', async () => {
    await b.setScheme('dark');
    await ev(`document.documentElement.setAttribute('data-scheme', 'dark')`);
    await ev(`document.getElementById('unpivot-open').click()`);
    await waitFor(`${ud} !== null`, 'open');
    await shot('unpivot-pick-dark.png');
  });
  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) { console.log(`FAIL harness: ${e.stack}`); failed++; }
finally { if (b) await b.close(); }
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
