// Browser check: the sidebar database <select> matches the app's other controls (height, edge, radius, padding,
// type, focus ring, disabled look) in light and dark. Run:  node tests/live/db-select-ui.mjs  (APP_URL default http://localhost:5232)
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5232';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'db-select-shots');
mkdirSync(SHOTS, { recursive: true });
function answer({ method, path }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop', 'a_rather_long_database_name_that_overflows'] };
  if (/\/api\/databases\/[^/]+\/tables$/.test(path)) return { json: ['sales'] };
  return null;
}
let failed = 0;
const check = (name, ok, msg = '') => { console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : ': ' + msg}`); if (!ok) failed++; };
const PROPS = ['height', 'paddingTop', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderRadius', 'backgroundColor', 'color', 'fontSize', 'fontFamily', 'fontWeight', 'lineHeight'];
const b = await launch();
try {
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  await b.goto(APP + '/');
  await b.waitFor(`!!document.getElementById('conn-connect')`);
  // reference controls: a .select and an .input in the same glass sidebar (on-screen siblings), plus the connection host field
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await b.waitFor(`document.getElementById('db-select').options.length > 1`);
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await b.waitFor(`document.querySelectorAll('.table-chip').length === 1`);
  // A plain reference .select appended in the sidebar, styled by the shared .select rule only.
  await ev(`(() => { const r = document.createElement('select'); r.className = 'select'; r.id = 'ref-select'; r.innerHTML = '<option>ref</option>'; document.querySelector('.sidebar').append(r); return true; })()`);
  const styles = (sel) => ev(`(() => { const c = getComputedStyle(document.querySelector(${JSON.stringify(sel)})); return JSON.stringify(Object.fromEntries(${JSON.stringify(PROPS)}.map((p) => [p, c[p]]))); })()`).then(JSON.parse);
  for (const scheme of ['light', 'dark']) {
    await b.setScheme(scheme); await b.sleep(250);
    const d = await styles('#db-select');
    const conn = await styles('#table-search');
    console.log(scheme, JSON.stringify(d));
    check(`${scheme}: height is --ctl-h (32px)`, d.height === '32px', d.height);
    check(`${scheme}: radius 8px, 1px border`, d.borderRadius === '8px' && d.borderTopWidth === '1px', `${d.borderRadius} ${d.borderTopWidth}`);
    check(`${scheme}: font size 14 or 16`, ['14px', '16px'].includes(d.fontSize), d.fontSize);
    for (const p of ['height', 'borderTopColor', 'borderRadius', 'fontSize', 'fontFamily', 'backgroundColor', 'color'])
      check(`${scheme}: db-select ${p} matches table-search input`, d[p] === conn[p], `${d[p]} vs ${conn[p]}`);
    // the open list uses the same surface/ink as the closed control (native popups otherwise ignore the theme)
    const o = await ev(`(() => { const c = getComputedStyle(document.querySelector('#db-select option')); return JSON.stringify([c.backgroundColor, c.color]); })()`);
    check(`${scheme}: option list uses control surface and ink`, o === JSON.stringify([d.backgroundColor, d.color]), `${o} vs ${d.backgroundColor} ${d.color}`);
    // focus ring
    await ev(`document.getElementById('db-select').focus()`);
    const ring = (id) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.focus(); const c = getComputedStyle(e); return JSON.stringify([c.boxShadow, c.outlineStyle, c.borderTopColor]); })()`);
    const fs = await ring('db-select'), fi = await ring('table-search');
    check(`${scheme}: focus ring matches table-search input`, fs === fi, `${fs} vs ${fi}`);
    await ev(`document.getElementById('db-select').focus()`);
    await b.sleep(250);
    await b.screenshot(join(SHOTS, `db-select-${scheme}.png`), { x: 0, y: 0, width: 420, height: 520 });
    // disabled look
    await ev(`document.getElementById('db-select').disabled = true`);
    const dis = await ev(`getComputedStyle(document.getElementById('db-select')).opacity`);
    await ev(`document.getElementById('db-select').disabled = false`);
    check(`${scheme}: disabled looks disabled (opacity < 1)`, Number(dis) < 1, dis);
  }
} finally { await b.close(); }
console.log(failed ? `${failed} failed` : 'all passed'); process.exitCode = failed ? 1 : 0;
