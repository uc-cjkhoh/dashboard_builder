// Browser check for the start screen (mocked /api). Run: node tests/live/start-screen-ui.mjs
// (app first: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5231)
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const APP = process.env.APP_URL ?? 'http://localhost:5231';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'start-screen-shots'); mkdirSync(SHOTS, { recursive: true });
const answer = ({ method, path, body }) => {
  if (path === '/api/connection/disconnect') return { json: { connected: false } };
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: body.host, port: body.port, user: body.user, secure: body.secure, allowInvalidCertificate: false } };
  if (path === '/api/databases') return { json: [] };
  return null;
};
let failed = 0;
const check = async (n, f) => { try { await f(); console.log('ok ' + n); } catch (e) { console.log(`FAIL ${n}: ${e.message}`); failed++; } };
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;
const KEY = 'dashboardbuilder.recent-workbooks';
let b;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  await b.goto(APP);
  await b.waitFor(`document.getElementById('start-screen')`, { label: 'start' });
  await check('first run: start screen visible, no recent list', async () => {
    must(await ev(`!document.getElementById('start-screen').hidden`), 'start hidden');
    must(await ev(`document.getElementById('start-recent-block').hidden`), 'recent shown');
  });
  await ev(`localStorage.setItem(${J(KEY)}, JSON.stringify([
    { host: 'ch-prod-analytics-eu-west-1.internal.example-corporation.com', port: 8443, user: 'reporting_readonly', secure: true, allowInvalidCert: false, savedAt: Date.now() - 3 * 3600000, tables: 4, worksheets: 6, dashboards: 2, stories: 1, password: 'leak' },
    { host: '10.168.49.13', port: 8443, user: 'cj_khoh', secure: true, allowInvalidCert: true, savedAt: Date.now() - 2 * 86400000, tables: 1, worksheets: 1, dashboards: 0, stories: 0 }]))`);
  await b.goto(APP);
  await b.waitFor(`document.querySelectorAll('.start__item').length === 2`, { label: '2 recent' });
  for (const scheme of ['light', 'dark']) {
    await b.setScheme(scheme);
    await ev(`document.documentElement.dataset.scheme = ${J(scheme)}`);
    await new Promise((r) => setTimeout(r, 600));
    await b.screenshot(join(SHOTS, `start-${scheme}.png`));
  }
  await check('rows show server, counts and age; long host is ellipsised', async () => {
    const t = await ev(`document.querySelectorAll('.start__meta')[0].textContent`);
    must(t === '4 tables · 6 worksheets · 2 dashboards · 1 story · 3 h ago', t);
    must(await ev(`(() => { const h = document.querySelector('.start__host'); return h.scrollWidth > h.clientWidth && document.querySelector('.start__item').scrollWidth <= document.querySelector('.start__item').clientWidth; })()`), 'no ellipsis');
  });
  await check('picking refills the form, opens Advanced for a cert opt-in, focuses the password', async () => {
    await ev(`document.querySelectorAll('.start__pick')[1].click()`);
    must(await ev(`document.getElementById('conn-host').value`) === '10.168.49.13', 'host');
    must(await ev(`document.getElementById('conn-user').value`) === 'cj_khoh', 'user');
    must(await ev(`document.getElementById('conn-allowcert').checked`), 'cert opt-in');
    must(await ev(`document.activeElement.id`) === 'conn-password', 'password not focused');
  });
  await check('connecting hides the start screen; disconnecting shows it again', async () => {
    await ev(`document.getElementById('conn-password').value = 'x'; document.getElementById('conn-form').requestSubmit()`);
    await b.waitFor(`document.getElementById('start-screen').hidden`, { label: 'start hidden' });
    await ev(`document.getElementById('conn-disconnect').click()`);
    await b.waitFor(`!document.getElementById('start-screen').hidden`, { label: 'start back' });
  });
  await check('remove forgets the entry; stored metadata holds no password', async () => {
    await ev(`document.querySelector('.start__remove').click()`);
    must(!(await ev(`localStorage.getItem(${J(KEY)})`)).includes('leak'), 'secret kept after a rewrite');
    must(await ev(`document.querySelectorAll('.start__item').length`) === 1, 'not removed');
    await ev(`document.querySelector('.start__remove').click()`);
    must(await ev(`document.getElementById('start-recent-block').hidden`), 'block still shown');
  });
  await check('no console errors', async () => must(b.consoleErrors.length === 0, b.consoleErrors.join('; ')));
} finally { await b?.close(); }
console.log(failed ? `${failed} failed` : 'all ok'); process.exit(failed ? 1 : 0);
