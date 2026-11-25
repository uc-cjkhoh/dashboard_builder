// Browser check (D162): a lost session sends the UI back to the connect card at once, and a hung ping cannot freeze that.
//   1. An API call comes back 409 "Not connected" and the ping says the session is gone -> the cards are cleared and the connect form is
//      showing within a few seconds, not after the 30 s timer.
//   2. A ping that never answers is given up on (20 s), counts as one failed probe ("checking"), and the next probe still runs.
// Real dev app (APP_URL, default http://localhost:5188) in headless Chromium over the DevTools protocol (tests/live/cdp.mjs); every /api/*
// call is mocked. Run: node tests/live/session-lost-ui.mjs  (start the app: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5188; stop it by port)
import { launch } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5188';
const COLUMNS = {
  orders: [['cust_id', 'Int32', 'numeric'], ['amount', 'Float64', 'numeric']],
  customers: [['id', 'Int32', 'numeric'], ['name', 'String', 'text']],
};
let session = { connected: false };
let pingMode = 'ok';          // ok | gone | hang
let columnsStatus = 200;      // 409 = the session is gone, as ApiControllerBase.NotConnected answers
const never = () => new Promise(() => {});
async function answer({ method, path, body }) {
  if (path === '/api/connection/ping') {
    if (pingMode === 'hang') return never();
    if (pingMode === 'gone') { session = { connected: false }; return { json: { connected: false } }; }
    return { json: { connected: true, reachable: true } };
  }
  if (path === '/api/connection' && method === 'GET') return { json: session };
  if (path === '/api/connection') {
    session = { connected: true, host: body.host, port: body.port, user: body.user, secure: true, allowInvalidCert: false };
    return { json: session };
  }
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: Object.keys(COLUMNS) };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) {
    if (columnsStatus === 409 && m[1] === 'customers') return { status: 409, json: { error: 'Not connected to a ClickHouse server.' } };
    return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  }
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
  const waitFor = (s, label, timeout) => b.waitFor(s, { label, timeout });
  await b.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  const connectAndAddCard = async () => {
    await b.goto(APP + '/');
    await ev(`(() => { localStorage.clear(); return true; })()`); // the first scenario's workbook would restore on reconnect
    await b.goto(APP + '/');
    await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, 'databases listed');
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
    await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'orders card loaded');
  };
  const goneUi = `document.querySelector('.app').hasAttribute('data-disconnected') && document.querySelectorAll('.entity').length === 0 && !document.getElementById('conn-form').hidden`;

  await check('a 409 on an action sends the UI back to the connect card within seconds, cards cleared', async () => {
    session = { connected: false }; pingMode = 'ok'; columnsStatus = 200;
    await connectAndAddCard();
    pingMode = 'gone'; columnsStatus = 409; // the session expired: the next action fails, and so does the probe it triggers
    const t0 = Date.now();
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'customers' } }))`);
    await waitFor(goneUi, 'connect card showing, cards gone', 8000);
    const took = Date.now() - t0;
    must(took < 8000, `took ${took} ms`); // the 30 s timer is not what did this
    must(await ev(`document.body.textContent.includes('Your session ended')`), 'no "session ended" toast');
  });

  await check('a ping that never answers is given up on, then the next probe still runs', async () => {
    session = { connected: false }; pingMode = 'ok'; columnsStatus = 200;
    await connectAndAddCard();
    pingMode = 'hang';
    await ev(`document.dispatchEvent(new Event('visibilitychange'))`); // a probe starts and never gets an answer
    await waitFor(`document.getElementById('conn-summary').dataset.health === 'checking'`, 'the timed-out probe counted as a failed one', 30000);
    pingMode = 'gone';
    await ev(`document.dispatchEvent(new Event('visibilitychange'))`); // would be skipped forever if `pinging` had stayed set
    await waitFor(goneUi, 'connect card showing after the next probe', 8000);
  });
} catch (e) { console.log(`FAIL harness: ${e.stack}`); failed++; } finally { if (b) await b.close(); }
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
