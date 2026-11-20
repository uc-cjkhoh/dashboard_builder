// Browser check: a late table list from a connection that is gone never shows (Schema/schema.js, the epoch guard). The first server's `shop` tables
// answer only after the user has disconnected and connected to a second server whose `shop` has other tables; the tree must show the second's.
// Real dev app (APP_URL, default http://localhost:5187) in headless Chromium over the DevTools protocol (tests/live/cdp.mjs); every /api/* call is mocked.
// Run: node tests/live/schema-latest-ui.mjs  (start the app: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5187; stop it by port)
import { launch } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5187';
let phase = 'A', release = null;
const gate = new Promise((r) => { release = r; });
async function answer({ method, path }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection/disconnect') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') {
    if (phase === 'A') { await gate; return { json: ['old_table'] }; } // the first server answers late
    return { json: ['new_table'] };
  }
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) { try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; } }
const must = (c, m) => { if (!c) throw new Error(m); };
let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  await b.goto(APP + '/');
  await b.waitFor(`!!document.getElementById('conn-connect')`, { label: 'app loaded' });
  const connect = () => ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await connect();
  await b.waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, { label: 'databases listed (first server)' });
  await check('a late answer from a connection that is gone never lists its tables', async () => {
    await ev(`(() => { document.getElementById('conn-disconnect').click(); [...document.querySelectorAll('dialog button')].find((x) => x.textContent === 'Disconnect').click(); return 1; })()`);
    await b.waitFor(`document.querySelectorAll('.db-row[data-db]').length === 0`, { label: 'tree cleared on disconnect' }).catch(async (e) => { console.log(await ev(`JSON.stringify({ dlg: document.querySelectorAll('dialog[open]').length, rows: document.querySelectorAll('.db-row').length, dis: !!document.getElementById('conn-disconnect'), hidden: document.getElementById('conn-disconnect')?.hidden, sec: document.getElementById('schema-section')?.hidden })`)); throw e; });
    phase = 'B';
    await b.waitFor(`!!document.getElementById('conn-connect')`, { label: 'form back' });
    await connect();
    await b.waitFor(`document.querySelectorAll('.table-chip[data-table="new_table"]').length === 1`, { label: 'second server tables listed' });
    release(); // now the first server answers
    await b.sleep(600);
    const names = await ev(`[...document.querySelectorAll('.table-chip')].map((c) => c.dataset.table)`);
    must(JSON.stringify(names) === JSON.stringify(['new_table']), `tables listed: ${JSON.stringify(names)}`);
  });
} catch (e) { console.log(`FAIL harness: ${e.stack}`); failed++; } finally { if (b) await b.close(); }
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
