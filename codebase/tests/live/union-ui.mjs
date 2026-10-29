// Browser check for the table union: the real dev app (APP_URL, default http://localhost:5220) in headless Chromium over the
// DevTools protocol (tests/live/cdp.mjs), every /api/* call mocked. Run:  node tests/live/union-ui.mjs
//   (start the app: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5220 ; stop: fuser -k 5220/tcp)
// Env: APP_URL, SHOTS_DIR, CDP_PORT, CHROME_BIN.
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5220';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'union-ui-shots');
mkdirSync(SHOTS, { recursive: true });

const TABLES = ['sales_2023', 'sales_2024', 'sales_2025', 'a4', 'a5', 'a6'];
const unionReqs = [];
let unionReply = null;
const UNION = { columns: [{ name: 'Source table', type: 'String' }, { name: 'id', type: 'UInt64' }, { name: 'region', type: 'String' }],
  rows: [['sales_2023', '1', 'EU'], ['sales_2024', '2', null]], truncated: false, limit: 20, columnsTruncated: false };
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: TABLES };
  if (path === '/api/union') { unionReqs.push(body); return unionReply ?? { json: UNION }; }
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
  const ud = `document.querySelector('dialog.union-dialog[open]')`;
  const rd = `document.querySelector('dialog.rows-dialog[open]')`;
  const go = `[...${ud}.querySelectorAll('button')].find((x) => x.textContent === 'Show rows')`;
  const tick = (t) => ev(`(() => { const c = [...${ud}.querySelectorAll('input')].find((x) => x.value === ${J(t)}); c.checked = !c.checked; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === ${TABLES.length}`, 'tables listed');

  await check('Union opens a dialog listing the tables, Show rows disabled until two are ticked', async () => {
    await ev(`document.getElementById('union-open').click()`);
    await waitFor(`${ud} !== null`, 'dialog open');
    must(await ev(`${ud}.querySelectorAll('input').length`) === TABLES.length, 'one checkbox per table');
    must(await ev(`${go}.disabled`) === true, 'disabled with none');
    must(await ev(`${ud}.querySelector('.union-dialog__hint').textContent`) === 'Pick 2 to 5 tables.', 'hint');
    await tick('sales_2023');
    must(await ev(`${go}.disabled`) === true, 'disabled with one');
    await tick('sales_2024');
    must(await ev(`${go}.disabled`) === false, 'enabled with two');
    await shot('union-pick-light.png');
  });
  await check('a sixth table cannot be ticked once five are', async () => {
    for (const t of ['sales_2025', 'a4', 'a5']) await tick(t);
    must(await ev(`[...${ud}.querySelectorAll('input')].find((x) => x.value === 'a6').disabled`) === true, 'sixth disabled');
    await tick('a5'); await tick('a4'); await tick('sales_2025');
    must(await ev(`${go}.disabled`) === false, 'two still ticked');
  });
  await check('Show rows posts the union and shows the stacked rows with the source first', async () => {
    await ev(`${go}.click()`);
    await waitFor(`${rd} !== null && ${rd}.querySelectorAll('tbody tr').length === 2`, 'rows rendered');
    must(J(unionReqs.at(-1)) === J({ db: 'shop', tables: ['sales_2023', 'sales_2024'], limit: 20 }), `request: ${J(unionReqs.at(-1))}`);
    const heads = await ev(`[...${rd}.querySelectorAll('th')].map((t) => t.textContent)`);
    must(J(heads) === J(['Source tableString', 'idUInt64', 'regionString']), `heads: ${J(heads)}`);
    must(await ev(`${ud}`) === null, 'pick dialog closed');
    await shot('union-rows-light.png');
  });
  await check('a server refusal shows its sentence in the dialog', async () => {
    await b.key('Escape', { vk: 27 }); await waitFor(`${rd} === null`, 'closed');
    unionReply = { status: 400, json: { error: 'These tables share no column with the same name and kind of values.', field: 'tables' } };
    await ev(`document.getElementById('union-open').click()`);
    await waitFor(`${ud} !== null`, 'open'); await tick('a4'); await tick('a5'); await ev(`${go}.click()`);
    await waitFor(`${rd} !== null && ${rd}.querySelector('.rows-dialog__status--error') !== null`, 'error shown');
    must((await ev(`${rd}.querySelector('.rows-dialog__status--error').textContent`)).includes('share no column'), 'message');
    unionReply = null;
  });
  await check('dark scheme renders the pick dialog', async () => {
    await b.key('Escape', { vk: 27 }); await waitFor(`${rd} === null`, 'closed');
    await b.setScheme('dark');
    await ev(`document.documentElement.setAttribute('data-scheme', 'dark')`);
    await ev(`document.getElementById('union-open').click()`);
    await waitFor(`${ud} !== null`, 'open');
    await shot('union-pick-dark.png');
  });
  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) { console.log(`FAIL harness: ${e.stack}`); failed++; }
finally { if (b) await b.close(); }
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
