// Browser check: on reload, while GET /api/connection is pending nothing of the plain "Connect" empty state shows, the sidebar is already
// the brand rail (no wide-then-narrow flash) and the loading bar runs; once it answers (disconnected) the card shows, the bar is gone, the rail stays. Real dev app (APP_URL), /api/* mocked.
import { launch } from './cdp.mjs';
const APP = process.env.APP_URL ?? 'http://localhost:5195';
let delayMs = 1500;
async function answer({ method, path }) {
  if (path === '/api/connection' && method === 'GET') { await new Promise((r) => setTimeout(r, delayMs)); return { json: { connected: false } }; }
  return null;
}
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? 'ok' : 'FAIL'} ${name}`); if (!ok) failed++; };
let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const vis = `(() => { const e = document.getElementById('canvas-empty'); const cs = getComputedStyle(e); const f = document.getElementById('conn-form');
    return { pending: document.querySelector('.app').hasAttribute('data-connecting'), empty: cs.visibility, form: !f.hidden }; })()`;
  await b.goto(APP + '/');
  await b.waitFor(`document.readyState === 'interactive' || document.readyState === 'complete'`, { label: 'dom' });
  const during = await b.evaluate(vis);
  check(`pending: data-connecting set, empty state invisible (${JSON.stringify(during)})`, during.pending && during.empty === 'hidden' && !during.form);
  const rail = `(() => { const bar = document.getElementById('app-loading'); return { side: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width), top: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')),
    bar: !bar.hidden && getComputedStyle(bar).display !== 'none', op: getComputedStyle(bar).opacity, role: bar.getAttribute('role') }; })()`;
  await new Promise((r) => setTimeout(r, 500));
  const mid = await b.evaluate(rail);
  check(`pending: sidebar is the rail, bar running (${JSON.stringify(mid)})`, mid.side === mid.top && mid.bar && Number(mid.op) > 0 && mid.role === 'progressbar');
  await b.screenshot((process.env.SHOTS_DIR ?? '/tmp') + '/connect-pending.png');
  await b.waitFor(`!document.querySelector('.app').hasAttribute('data-connecting')`, { label: 'answered' });
  const after = await b.evaluate(vis);
  check(`answered: card visible with the form (${JSON.stringify(after)})`, !after.pending && after.empty === 'visible' && after.form);
  const end = await b.evaluate(rail);
  check(`answered: bar gone, sidebar still the rail (${JSON.stringify(end)})`, !end.bar && end.side === end.top);
} catch (e) { console.log(`FAIL ${e.message}`); failed++; } finally { await b?.close?.(); }
process.exit(failed ? 1 : 0);
