// Browser check for the connection panel fine-tuning (mocked /api). Run: node tests/live/connection-ui.mjs
// (app first: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5181)
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const APP = process.env.APP_URL ?? 'http://localhost:5181';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'connection-ui-shots'); mkdirSync(SHOTS, { recursive: true });
let session = { connected: false };
const answer = ({ method, path, body }) => {
  if (path === '/api/connection/disconnect') { session = { connected: false }; return { json: session }; }
  if (path === '/api/connection' && method === 'GET') return { json: session };
  if (path === '/api/connection') {
    if (body.password === 'bad') return { status: 502, json: { error: 'Could not connect.' } };
    session = { connected: true, host: body.host, port: body.port, user: body.user, secure: body.secure, allowInvalidCertificate: body.allowInvalidCert };
    return { json: session };
  }
  if (path === '/api/databases') return { json: ['alpha', 'beta'] };
  return null;
};
let failed = 0, passed = 0;
const check = async (n, f) => { try { await f(); console.log('ok ' + n); passed++; } catch (e) { console.log(`FAIL ${n}: ${e.message}`); failed++; } };
const must = (c, m) => { if (!c) throw new Error(m); };
let b;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const fill = (host, pw) => ev(`(() => { const s = (id, v) => { document.getElementById(id).value = v; }; s('conn-host', ${JSON.stringify(host)}); s('conn-port', '8443'); s('conn-user', 'ann'); s('conn-password', ${JSON.stringify(pw)}); document.getElementById('conn-form').requestSubmit(); return 1; })()`);
  await b.goto(APP);
  await b.waitFor(`document.getElementById('conn-form') && !document.getElementById('conn-form').hidden`, { label: 'form' });
  await check('status pill, meta line and workbook status are gone', async () => {
    must(await ev(`!document.getElementById('conn-status') && !document.getElementById('conn-meta') && !document.getElementById('wb-status')`), 'still in the DOM');
  });
  await check('failure shows through the toast, form stays open', async () => {
    await fill('Ch.Example.com', 'bad');
    await b.waitFor(`document.getElementById('toast') && /Could not connect/.test(document.getElementById('toast').textContent)`, { label: 'toast' });
    must(await ev(`!document.getElementById('conn-form').hidden && document.getElementById('conn-summary').hidden`), 'form closed');
  });
  await check('connecting collapses the form into a compact summary', async () => {
    await fill('Ch.Example.com', 'ok');
    await b.waitFor(`!document.getElementById('conn-summary').hidden`, { label: 'summary' });
    must(await ev(`document.getElementById('conn-form').hidden`), 'form not collapsed');
    must(await ev(`document.getElementById('conn-host-label').textContent`) === 'Ch.Example.com', 'host label');
    must(await ev(`document.getElementById('conn-summary').getBoundingClientRect().height`) <= 34, 'summary not compact');
    must((await ev(`document.getElementById('conn-host-label').title`)).includes('ann'), 'tooltip lacks user');
    must(await ev(`document.getElementById('conn-change').getAttribute('aria-expanded')`) === 'false', 'aria-expanded');
  });
  await check('edit toggles the form open and closed', async () => {
    await ev(`document.getElementById('conn-change').click()`);
    must(await ev(`!document.getElementById('conn-form').hidden && document.getElementById('conn-host').value`) === 'Ch.Example.com', 'host blank in form');
    await ev(`document.getElementById('conn-change').click()`);
    must(await ev(`document.getElementById('conn-form').hidden`), 'not collapsed again');
  });
  await check('after a reload the form still shows the connected host', async () => {
    await b.goto(APP);
    await b.waitFor(`!document.getElementById('conn-summary').hidden`, { label: 'summary after reload' });
    must(await ev(`document.getElementById('conn-form').hidden`), 'form open by default after login');
    await ev(`document.getElementById('conn-change').click()`);
    must(await ev(`document.getElementById('conn-host').value`) === 'Ch.Example.com', 'host blank after reload');
  });
  await check('picking a recent connection shows its entered host', async () => {
    await ev(`document.getElementById('conn-disconnect').click()`);
    await b.waitFor(`!document.getElementById('conn-recent').hidden`, { label: 'recent' });
    await ev(`document.getElementById('conn-host').value = ''; document.querySelector('.conn-recent__pick').click()`);
    must(await ev(`document.getElementById('conn-host').value`) === 'Ch.Example.com', 'host not shown');
  });
  await check('database select matches the inputs', async () => {
    await ev(`document.getElementById('conn-password').value = 'ok'; document.getElementById('conn-form').requestSubmit()`);
    await b.waitFor(`!document.getElementById('schema-section').hidden`, { label: 'schema' });
    const r = await ev(`(() => { const cs = (e) => getComputedStyle(e); const s = cs(document.getElementById('db-select')); document.getElementById('conn-change').click(); const i = cs(document.getElementById('conn-host'));
      return JSON.stringify({ sh: s.height, ih: i.height, sr: s.borderRadius, ir: i.borderRadius, sb: s.borderTopWidth, ib: i.borderTopWidth, sp: s.paddingLeft, ip: i.paddingLeft, sf: s.fontSize, iff: i.fontSize, ap: s.appearance, bi: s.backgroundImage.includes('gradient') }); })()`);
    const o = JSON.parse(r);
    must(o.sh === o.ih && o.sr === o.ir && o.sb === o.ib && o.sp === o.ip && o.sf === o.iff, 'mismatch ' + r);
    must(o.ap === 'none' && o.bi, 'no custom chevron ' + r);
    for (const scheme of ['light', 'dark']) {
      await b.setScheme(scheme);
      await ev(`document.documentElement.dataset.scheme = ${JSON.stringify(scheme)}`);
      await new Promise((r2) => setTimeout(r2, 900));
      await b.screenshot(join(SHOTS, `connection-${scheme}.png`));
    }
  });
  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) { console.log('FAIL harness: ' + e.stack); failed++; } finally { if (b) await b.close(); }
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
