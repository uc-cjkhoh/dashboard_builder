// Browser check for Clean… (query-time cleaning): the real dev app (APP_URL, default http://localhost:5226) in
// headless Chromium over the DevTools protocol (tests/live/cdp.mjs), every /api/* call mocked. Run:  node tests/live/clean-ui.mjs
//   (start the app: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5226 ; stop: fuser -k 5226/tcp)
// Env: APP_URL, SHOTS_DIR, CDP_PORT, CHROME_BIN.
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5226';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'clean-ui-shots');
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
  const sd = `document.querySelector('dialog.clean-dialog[open]')`;
  const go = `[...${ud}.querySelectorAll('button')].find((x) => x.textContent === 'Show rows')`;
  const tick = (side, name) => ev(`(() => { const c = [...${ud}.querySelectorAll('.unpivot-dialog__list')[${side}].querySelectorAll('input')].find((x) => x.value === ${J(name)}); c.checked = !c.checked; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); ${code}; })()`);

  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');


  const sel = (q) => `${sd}.querySelector(${J(q)})`;
  const set = (q, v) => ev(`(() => { const e = ${sel(q)}; e.value = ${J(v)}; e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true; })()`);
  const menu = (name) => ev(`(() => { const c = [...document.querySelectorAll('#ws-fields .ws-field')].find((x) => x.querySelector('.ws-field__name')?.textContent === ${J(name)}); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); return [...document.querySelectorAll('.ctx-menu .menu__item')].map((x) => x.textContent.trim()); })()`);
  const calcs = () => ev(`(async () => { const st = await import('/features/Core/store.js'); return JSON.stringify(st.calculations.map((c) => [c.name, c.formula])); })()`);
  const create = `${sd}.querySelector('.dialog__foot .btn--primary')`;
  await check('Clean… is offered on text and number fields, not on ids it cannot clean', async () => {
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'sales' } }))`);
    await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'sales loaded');
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
    await waitFor(`document.querySelectorAll('#ws-fields .ws-field').length >= 5`, 'fields');
    must((await menu('tags')).includes('Clean…'), 'text');
    await b.key('Escape', { vk: 27 });
    must((await menu('q1')).includes('Clean…'), 'number');
    await b.key('Escape', { vk: 27 });
  });
  await check('text: trim, replace empty, read as date each add one calculated field', async () => {
    await menu('tags'); await ev(`[...document.querySelectorAll('.ctx-menu .menu__item')].find((x) => x.textContent.trim() === 'Clean…').click()`);
    await waitFor(`${sd} !== null`, 'dialog');
    must(await ev(`${sel('select')}.options.length`) === 4, 'four operations');
    must(await ev(`${sel('code')}.textContent`) === 'tags (trimmed) = TRIM([shop.sales.tags])', 'preview');
    await shot('clean-dialog-light.png');
    await ev(`${create}.click()`); await waitFor(`${sd} === null`, 'closed');
    await menu('tags'); await ev(`[...document.querySelectorAll('.ctx-menu .menu__item')].find((x) => x.textContent.trim() === 'Clean…').click()`);
    await waitFor(`${sd} !== null`, 'dialog');
    await set('select', 'nullTo'); await set('input[type=text]', 'n/a');
    await ev(`${create}.click()`); await waitFor(`${sd} === null`, 'closed');
    await menu('tags'); await ev(`[...document.querySelectorAll('.ctx-menu .menu__item')].find((x) => x.textContent.trim() === 'Clean…').click()`);
    await waitFor(`${sd} !== null`, 'dialog');
    await set('select', 'date');
    await ev(`${create}.click()`); await waitFor(`${sd} === null`, 'closed');
    const c = await calcs();
    must(c === J([['tags (trimmed)', 'TRIM([shop.sales.tags])'], ['tags (filled)', "IFNULL([shop.sales.tags], 'n/a')"], ['tags (date)', 'DATE([shop.sales.tags])']]), c);
    await waitFor(`[...document.querySelectorAll('.calc-group__list .ws-field__name')].length === 3`, 'fields appear');
  });
  await check('recode validates as you type and makes a CASE field', async () => {
    await menu('tags'); await ev(`[...document.querySelectorAll('.ctx-menu .menu__item')].find((x) => x.textContent.trim() === 'Clean…').click()`);
    await waitFor(`${sd} !== null`, 'dialog');
    await set('select', 'recode');
    must(await ev(`${create}.disabled`) === true, 'disabled with nothing listed');
    await set('textarea', 'oops');
    must((await ev(`${sel('.grp-error')}.textContent`)).startsWith('Line 1'), 'line error');
    await set('textarea', 'NY = New York\nCA = California');
    must(await ev(`${create}.disabled`) === false, 'enabled');
    await shot('clean-recode-light.png');
    await ev(`${create}.click()`); await waitFor(`${sd} === null`, 'closed');
    const c = JSON.parse(await calcs()).at(-1);
    must(c[0] === 'tags (recoded)' && c[1] === "CASE [shop.sales.tags] WHEN 'NY' THEN 'New York' WHEN 'CA' THEN 'California' ELSE [shop.sales.tags] END", J(c));
  });
  await check('number field: only Replace missing, with a number', async () => {
    await menu('q1'); await ev(`[...document.querySelectorAll('.ctx-menu .menu__item')].find((x) => x.textContent.trim() === 'Clean…').click()`);
    await waitFor(`${sd} !== null`, 'dialog');
    must(await ev(`${sel('select')}.options.length`) === 1, 'one operation');
    await set('input[type=text]', 'abc');
    must(await ev(`${create}.disabled`) === true, 'rejects text');
    await set('input[type=text]', '0');
    must(await ev(`[...${sd}.querySelectorAll('[id]')].filter((e) => /\\s/.test(e.id)).length`) === 0, 'ids have no spaces');
    await ev(`${sel('input[type=text]')}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
    await waitFor(`${sd} === null`, 'Enter creates');
    must(JSON.parse(await calcs()).at(-1)[1] === 'IFNULL([shop.sales.q1], 0)', 'formula');
  });
  await check('dark scheme renders the dialog', async () => {
    await b.setScheme('dark');
    await ev(`document.documentElement.setAttribute('data-scheme', 'dark')`);
    await menu('tags'); await ev(`[...document.querySelectorAll('.ctx-menu .menu__item')].find((x) => x.textContent.trim() === 'Clean…').click()`);
    await waitFor(`${sd} !== null`, 'dialog');
    await set('select', 'recode'); await set('textarea', 'NY = New York');
    await shot('clean-dialog-dark.png');
  });
  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) { console.log(`FAIL harness: ${e.stack}`); failed++; }
finally { if (b) await b.close(); }
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
