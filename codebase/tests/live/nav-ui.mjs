// Browser check for the navigation button widget (T08-17, T08-18, T08-25, T08-26): Add button, the inline edit form (label,
// tooltip, target; validation messages; Escape discards), a click goes to a worksheet tab and to another dashboard, a closed target
// leaves the button unlinked and disabled, autosave holds the target by tab index, a reload restores it. Real dev app
// (APP_URL), every /api/* mocked; any page error fails the run. Screenshots (light + dark) go to SHOTS_DIR.
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5225';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'nav-shots');
mkdirSync(SHOTS, { recursive: true });
const KEY = 'dashboardbuilder.workbook.v2|mock-ch|8443|default';

async function answer({ method, path }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  return null;
}

let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); ${code} })()`);
  const shot = (name) => b.screenshot(join(SHOTS, name));
  const connect = async () => {
    await waitFor(`document.readyState === 'complete' && !!document.getElementById('conn-connect')`, 'app loaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  };
  const click = (sel) => ev(`document.querySelector(${J(sel)}).click()`);
  const active = () => store(`const v = st.currentView(); return { ...v, name: st.tabById(v.id)?.name };`);
  const setVal = (sel, v) => ev(`(() => { const e = document.querySelector(${J(sel)}); e.value = ${J(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const btn = () => ev(`(() => { const x = document.querySelector('.board-widget--nav .board-nav__btn'); return x ? { text: x.textContent, title: x.title, disabled: x.getAttribute('aria-disabled') === 'true', nativeDisabled: x.disabled, aria: x.getAttribute('aria-label') } : null; })()`);

  await b.goto(APP + '/');
  await connect();
  await store(`const s = st.createWorksheet('Sales'); const d2 = st.createDashboard('Details'); const d = st.createDashboard('Overview'); st.switchTab(d.id); return true;`);
  await waitFor(`!document.getElementById('board-view').hidden && !!document.querySelector('.board-panel__add-nav')`, 'dashboard shown');

  await check('Add button adds an unlinked 4 x 2 button, disabled, named Go to', async () => {
    await click('.board-panel__add-nav');
    await waitFor(`!!document.querySelector('.board-widget--nav .board-nav__btn')`, 'button drawn');
    const w = await store(`return st.dashboards().find((d) => d.name === 'Overview').widgets[0];`);
    must(w.kind === 'nav' && w.w === 4 && w.h === 2 && w.target === null, J(w));
    const x = await btn();
    must(x.text === 'Go to' && x.disabled && !x.nativeDisabled && /not linked/.test(x.aria) && /Use Edit to choose one/.test(x.title), J(x));
    must(await ev(`document.querySelector('.board-widget--nav .board-widget__empty').textContent.trim() === 'Pick a tab with Edit.'`), 'no quiet hint under the unlinked button');
  });

  await check('Edit: an empty label is refused in words, Escape discards', async () => {
    await click('.board-widget--nav .board-widget__edit');
    await waitFor(`!!document.querySelector('.board-widget--nav form')`, 'form');
    await setVal('.board-widget--nav input[id$="-label"]', '');
    await click('.board-widget--nav .board-text-edit__save');
    const e1 = await ev(`document.querySelector('.board-widget--nav .board-text-edit__error').textContent`);
    must(/required/.test(e1), `label error: ${e1}`);
    await setVal('.board-widget--nav input[id$="-label"]', 'Changed');
    await ev(`document.querySelector('.board-widget--nav input[id$="-label"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`!document.querySelector('.board-widget--nav form')`, 'form closed');
    must((await btn()).text === 'Go to', 'Escape kept the edit');
  });

  await check('Edit: label, tooltip and a worksheet target save; the target list omits this dashboard', async () => {
    await click('.board-widget--nav .board-widget__edit');
    const opts = await ev(`[...document.querySelectorAll('.board-widget--nav select option')].map((o) => o.textContent)`);
    must(J(opts) === J(['Nowhere yet', 'Worksheet: Sales', 'Dashboard: Details']), J(opts));
    const sid = await store(`return st.worksheets()[0].id;`);
    await setVal('.board-widget--nav input[id$="-label"]', 'See sales');
    await setVal('.board-widget--nav input[id$="-tip"]', 'Open the Sales worksheet');
    await setVal('.board-widget--nav select', sid);
    await click('.board-widget--nav .board-text-edit__save');
    await waitFor(`!document.querySelector('.board-widget--nav form')`, 'saved');
    const x = await btn();
    must(x.text === 'See sales' && x.title === 'Open the Sales worksheet' && !x.disabled && /goes to Sales/.test(x.aria), J(x));
    must(await ev(`!document.querySelector('.board-widget--nav .board-widget__empty')`), 'the hint stayed after linking');
  });

  await check('screenshots: light and dark', async () => {
    await shot('nav-light.png'); await b.setScheme('dark'); await b.sleep(300); await shot('nav-dark.png'); await b.setScheme('light'); await b.sleep(200);
  });

  await check('a click goes to the worksheet tab', async () => {
    await click('.board-widget--nav .board-nav__btn');
    await waitFor(`true`, 'x');
    const a = await active();
    must(a.kind === 'worksheet' && a.name === 'Sales', J(a));
    await store(`st.switchTab(st.dashboards().find((d) => d.name === 'Overview').id); return true;`);
    await waitFor(`!!document.querySelector('.board-widget--nav')`, 'back on the dashboard');
  });

  await check('retarget to another dashboard: a click opens it; autosave holds the target by tab index', async () => {
    const did = await store(`return st.dashboards().find((d) => d.name === 'Details').id;`);
    await click('.board-widget--nav .board-widget__edit');
    await setVal('.board-widget--nav select', did);
    await click('.board-widget--nav .board-text-edit__save');
    await waitFor(`/goes to Details/.test(document.querySelector('.board-nav__btn').getAttribute('aria-label'))`, 'relinked');
    await b.sleep(900);
    const saved = JSON.parse(await ev(`localStorage.getItem(${J(KEY)})`));
    const w = saved.dashboards.find((d) => d.name === 'Overview').widgets[0];
    const idx = saved.dashboards.findIndex((d) => d.name === 'Details');
    must(w.kind === 'nav' && J(w.target) === J({ kind: 'dashboard', index: idx }) && w.label === 'See sales', J(w));
    await click('.board-widget--nav .board-nav__btn');
    await waitFor(`true`, 'x');
    must((await active()).name === 'Details', 'did not open Details');
    await store(`st.switchTab(st.dashboards().find((d) => d.name === 'Overview').id); return true;`);
    await waitFor(`!!document.querySelector('.board-widget--nav')`, 'back');
  });

  await check('a reload restores the button and its target', async () => {
    await b.send('Page.reload');
    await connect();
    await store(`st.switchTab(st.dashboards().find((d) => d.name === 'Overview').id); return true;`);
    await waitFor(`!!document.querySelector('.board-widget--nav .board-nav__btn')`, 'restored');
    const x = await btn();
    must(x.text === 'See sales' && !x.disabled && /goes to Details/.test(x.aria), J(x));
  });

  await check('closing the target unlinks the button (disabled, in words)', async () => {
    await store(`st.closeTab(st.dashboards().find((d) => d.name === 'Details').id); return true;`);
    await waitFor(`document.querySelector('.board-nav__btn').getAttribute('aria-disabled') === 'true'`, 'unlinked');
    must(/not linked/.test((await btn()).aria), J(await btn()));
    const focusable = await ev(`(() => { const x = document.querySelector('.board-nav__btn'); x.focus(); return document.activeElement === x; })()`);
    must(focusable, 'the unlinked button cannot take keyboard focus');
  });

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
