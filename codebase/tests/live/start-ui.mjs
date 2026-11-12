// Browser check for recent connections on the Data Source start card (mocked /api). Run: node tests/live/start-ui.mjs
// (app first: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5213)
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const APP = process.env.APP_URL ?? 'http://localhost:5213';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'start-ui-shots'); mkdirSync(SHOTS, { recursive: true });
let connectBody = null;
const answer = ({ method, path, body }) => {
  if (path === '/api/connection/disconnect') return { json: { connected: false } };
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') { connectBody = body; return { json: { connected: true, host: body.host, port: body.port, user: body.user, secure: body.secure, allowInvalidCertificate: false } }; }
  if (path === '/api/databases') return { json: [] };
  return null;
};
let failed = 0, passed = 0;
const check = async (n, f) => { try { await f(); console.log('ok ' + n); passed++; } catch (e) { console.log(`FAIL ${n}: ${e.message}`); failed++; } };
const J = JSON.stringify;
const must = (c, m) => { if (!c) throw new Error(m); };
let b;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  await b.goto(APP);
  await b.waitFor(`document.getElementById('conn-form') && !document.getElementById('conn-form').hidden`, { label: 'form' });
  await check('no recent list on first run; the start card says None yet', async () => {
    must(await ev(`document.getElementById('conn-recent').hidden`), 'list visible');
    must(await ev(`!document.getElementById('conn-recent-none').hidden`), 'None yet hidden');
  });
  await check('start card: recent connections left (288px), the connect form right, headings on one line; the sidebar is a rail', async () => {
    const r = await ev(`(() => { const box = (s) => document.querySelector(s).getBoundingClientRect(); const m = box('.start-card__main'), s = box('#start-recent-panel'), t = box('.conn-form__title'), h = box('.start-card__heading');
      return { left: s.right <= m.left + 1, side: Math.round(s.width), formInCard: Boolean(document.querySelector('.start-card__main #conn-form:not([hidden])')), sameLine: Math.abs(t.top - h.top) < 1,
        emptyHidden: !document.querySelector('.start-card__empty').getClientRects().length, rail: document.querySelector('.app').hasAttribute('data-disconnected'), tile: document.getElementById('conn-section').hidden }; })()`);
    must(r.left && r.side === 288 && r.formInCard && r.sameLine && r.emptyHidden && r.rail && r.tile, 'layout ' + JSON.stringify(r));
    must(await ev(`!document.querySelector('.sidebar .conn-recent, .sidebar #conn-form')`), 'form or recent list still in the sidebar');
  });
  await check('connecting stores a recent source without the password', async () => {
    await ev(`(() => { const s = (id, v) => { document.getElementById(id).value = v; }; s('conn-host', 'ch.example'); s('conn-port', '8443'); s('conn-user', 'ann'); s('conn-password', 'sekret'); document.getElementById('conn-form').requestSubmit(); return 1; })()`);
    await b.waitFor(`!document.getElementById('conn-summary').hidden`, { label: 'connected' });
    const raw = await ev(`localStorage.getItem('dashboardbuilder.recent-sources')`);
    must(raw && raw.includes('ch.example'), 'not stored: ' + raw);
    must(!raw.includes('sekret') && !/password/i.test(raw), 'secret stored: ' + raw);
  });
  await check('disconnect shows the list; picking refills, clears the password and focuses it', async () => {
    await ev(`(() => { document.getElementById('conn-disconnect').click(); [...document.querySelectorAll('dialog button')].find((x) => x.textContent === 'Disconnect').click(); return 1; })()`);
    await b.waitFor(`!document.getElementById('conn-recent').hidden`, { label: 'recent visible' });
    await ev(`document.getElementById('conn-user').value = 'other'; document.querySelector('.conn-recent__pick').click()`);
    must(await ev(`document.getElementById('conn-host').value`) === 'ch.example', 'host not filled');
    must(await ev(`document.getElementById('conn-user').value`) === 'ann', 'user not filled');
    must(await ev(`document.getElementById('conn-password').value`) === '', 'password not empty');
    must(await ev(`document.activeElement.id`) === 'conn-password', 'password not focused');
  });
  await check('list is hidden while connected', async () => {
    await ev(`document.getElementById('conn-password').value = 'x'; document.getElementById('conn-form').requestSubmit()`);
    await b.waitFor(`!document.getElementById('conn-summary').hidden`, { label: 'connected' });
    must(await ev(`document.getElementById('conn-recent').hidden`), 'list visible while connected');
    must(await ev(`document.getElementById('start-recent-panel').hidden`), 'start card panel visible while connected');
  });
  await check('change connection opens the start card (status row stays); Esc closes it and focuses the edit button', async () => {
    must(await ev(`!document.getElementById('conn-section').hidden && !document.querySelector('.app').hasAttribute('data-disconnected')`), 'sidebar tile missing while connected');
    await ev(`document.getElementById('conn-change').click()`);
    must(await ev(`!document.getElementById('conn-form').hidden && !document.getElementById('start-recent-panel').hidden && !document.getElementById('conn-summary').hidden && !document.getElementById('conn-cancel').hidden`), 'change did not open the card');
    must(await ev(`document.activeElement.id`) === 'conn-host', 'host not focused');
    await ev(`document.getElementById('conn-host').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    must(await ev(`document.getElementById('conn-form').hidden && document.getElementById('start-recent-panel').hidden`), 'Esc did not close');
    must(await ev(`document.activeElement.id`) === 'conn-change', 'focus not back on the edit button');
  });
  await check('remove forgets the entry', async () => {
    await ev(`(() => { document.getElementById('conn-disconnect').click(); [...document.querySelectorAll('dialog button')].find((x) => x.textContent === 'Disconnect').click(); return 1; })()`);
    await b.waitFor(`!document.getElementById('conn-recent').hidden`, { label: 'recent visible' });
    await ev(`localStorage.setItem('dashboardbuilder.recent-sources', JSON.stringify([
      { host: 'ch-prod-analytics-eu-west-1.internal.example-corporation.com', port: 8443, user: 'reporting_readonly', secure: true, allowInvalidCert: false },
      { host: '10.168.49.13', port: 8443, user: 'cj_khoh', secure: true, allowInvalidCert: true },
      { host: 'localhost', port: 8123, user: 'default', secure: false, allowInvalidCert: false }]))`);
    await b.goto(APP);
    await b.waitFor(`document.querySelectorAll('.conn-recent__item').length === 3`, { label: '3 recent' });
    for (const scheme of ['light', 'dark']) {
      await b.setScheme(scheme);
      await ev(`document.documentElement.dataset.scheme = ${J(scheme)}`);
      await new Promise((r) => setTimeout(r, 900));
      await b.screenshot(join(SHOTS, `recent-${scheme}.png`));
    }
    await check('long host is ellipsised, not overflowing', async () => {
      must(await ev(`(() => { const h = document.querySelector('.conn-recent__pick .conn-summary__host'); const li = document.querySelector('.conn-recent__item'); return h.scrollWidth > h.clientWidth && li.scrollWidth <= li.clientWidth; })()`), 'no ellipsis / overflow');
    });
    for (let i = 0; i < 3; i++) await ev(`document.querySelector('.conn-recent__item .iconbtn').click()`);
    must(await ev(`document.getElementById('conn-recent').hidden`), 'still visible');
    must(await ev(`localStorage.getItem('dashboardbuilder.recent-sources')`) === '[]', 'storage not emptied');
  });
  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) { console.log('FAIL harness: ' + e.stack); failed++; } finally { if (b) await b.close(); }
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
