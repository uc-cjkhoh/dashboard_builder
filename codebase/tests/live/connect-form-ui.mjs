// Browser checks for the beginner-test fixes in the connection form and schema browser (mocked /api, nothing reaches ClickHouse).
// Run: node tests/live/connect-form-ui.mjs   (app first: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5249)
import { launch } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5249';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'connect-form-shots'); mkdirSync(SHOTS, { recursive: true });
let session = { connected: false };
const COLS = ['id', 'amount', 'region', 'note', 'created', 'flag', 'qty', 'price', 'city', 'code', 'tag'];
const TYPES = ['UInt64', 'Decimal(10, 2)', 'LowCardinality(String)', 'Nullable(String)', 'DateTime', 'Bool', 'Int32', 'Float64', 'String', 'FixedString(3)', 'Date'];
const ROWS = { columns: COLS.map((name, i) => ({ name, type: TYPES[i] })), rows: [COLS.map((c, i) => `${c}-value-${i}-long text`)], truncated: false, limit: 100, columnsTruncated: false };
const PROFILE = { column: 'region', type: 'LowCardinality(String)', category: 'text', rows: 100, nulls: 5, distinct: 4, min: null, max: null, sampled: false, sampleLimit: 1000000,
  top: [{ value: 'Central', count: 40, cut: false }, { value: 'South', count: 30, cut: false }, { value: '', count: 20, cut: false }, { value: null, count: 5, cut: false }, { value: 'East', count: 5, cut: false }] };
const answer = ({ method, path, body }) => {
  if (path === '/api/connection/disconnect') { session = { connected: false }; return { json: session }; }
  if (path === '/api/connection' && method === 'GET') return { json: session };
  if (path === '/api/connection') {
    if (body.password === 'wrongpw') return { status: 401, json: { error: 'Wrong user name or password.', field: 'password' } };
    if (body.password === 'closed') return { status: 502, json: { error: "Can't reach h:1. Check the host and port, and that the server is running.", field: 'host' } };
    if (body.password === 'tls') return { status: 502, json: { error: 'The server did not answer as secure HTTPS. Turn Secure (TLS) off for an HTTP port such as 8123.' } };
    session = { connected: true, host: body.host, port: body.port, user: body.user, secure: body.secure, allowInvalidCertificate: body.allowInvalidCert };
    return { json: session };
  }
  if (path === '/api/databases') return { json: ['INFORMATION_SCHEMA', 'default', 'information_schema', 'shop', 'system'] };
  if (/\/api\/databases\/[^/]+\/tables$/.test(path)) return { json: ['orders'] };
  if (/\/columns$/.test(path)) return { json: COLS.map((name, i) => ({ name, type: TYPES[i], category: 'text' })) };
  if (path === '/api/rows') return { json: ROWS };
  if (/\/profile$/.test(path)) return { json: PROFILE };
  return null;
};
let failed = 0;
const check = async (n, f) => { try { await f(); console.log('ok ' + n); } catch (e) { console.log(`FAIL ${n}: ${e.message}`); failed++; } };
const must = (c, m) => { if (!c) throw new Error(m); };
let b;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const submit = (host, pw) => ev(`(() => { const s = (id, v) => { document.getElementById(id).value = v; }; s('conn-host', ${JSON.stringify(host)}); s('conn-port', '8443'); s('conn-user', 'ann'); s('conn-password', ${JSON.stringify(pw)}); document.getElementById('conn-form').requestSubmit(); return 1; })()`);
  await b.goto(APP);
  await b.waitFor(`document.getElementById('conn-form') && !document.getElementById('conn-form').hidden`, { label: 'form' });

  await check('Secure and Trust are visible switches (no Advanced), host placeholder fits', async () => {
    must(await ev(`!document.getElementById('conn-advanced')`), 'Advanced still there');
    must(await ev(`['conn-secure', 'conn-allowcert'].every((id) => { const e = document.getElementById(id); return e.getAttribute('role') === 'switch' && e.offsetParent !== null; })`), 'switches not visible');
    const ph = await ev(`(() => { const h = document.getElementById('conn-host'); const c = document.createElement('canvas').getContext('2d'); c.font = getComputedStyle(h).font; return [c.measureText(h.placeholder).width, h.clientWidth]; })()`);
    must(ph[0] <= ph[1], `placeholder ${ph[0]}px in ${ph[1]}px`);
  });
  await check('no certificate warning on a first visit', async () => {
    must(await ev(`document.getElementById('conn-allowcert-warn').hidden`), 'warning shown');
    must(await ev(`document.getElementById('conn-allowcert').checked && document.getElementById('conn-secure').checked`), 'defaults changed');
  });
  await check('Secure off clears Trust, Secure on restores it', async () => {
    await ev(`document.getElementById('conn-secure').click()`);
    must(await ev(`document.getElementById('conn-allowcert-row').hidden && !document.getElementById('conn-allowcert').checked`), 'trust not cleared/hidden');
    await ev(`document.getElementById('conn-secure').click()`);
    must(await ev(`!document.getElementById('conn-allowcert-row').hidden && document.getElementById('conn-allowcert').checked`), 'trust not restored');
  });
  await check('the note shows once the user is about to connect with Trust on', async () => {
    await submit('', 'x'); // invalid host: a connect attempt
    must(await ev(`!document.getElementById('conn-allowcert-warn').hidden`), 'note missing');
  });
  await check('wrong password: message under Password, no toast needed', async () => {
    await submit('ch.example', 'wrongpw');
    await b.waitFor(`document.querySelector('#conn-password').getAttribute('aria-invalid') === 'true'`, { label: 'password invalid' });
    must(await ev(`document.querySelector('.form-field:has(#conn-password) .field-error').textContent.trim()`) === 'Wrong user name or password.', 'text');
    must(await ev(`!document.getElementById('conn-form').hidden`), 'form closed');
  });
  await check('unreachable host: message under Host', async () => {
    await submit('ch.example', 'closed');
    await b.waitFor(`document.querySelector('#conn-host').getAttribute('aria-invalid') === 'true'`, { label: 'host invalid' });
  });
  await check('TLS mismatch: a plain line above Connect, icon + text', async () => {
    await submit('ch.example', 'tls');
    await b.waitFor(`!document.getElementById('conn-error').hidden`, { label: 'inline error' });
    must(/Turn Secure \(TLS\) off/.test(await ev(`document.getElementById('conn-error').textContent`)), 'text');
    must(await ev(`!!document.querySelector('#conn-error svg')`), 'no icon');
    await b.screenshot(join(SHOTS, 'form-error.png'));
  });
  await check('connected card shows host, user and port', async () => {
    await submit('ch.example', 'ok');
    await b.waitFor(`!document.getElementById('conn-summary').hidden`, { label: 'summary' });
    must(await ev(`document.getElementById('conn-detail-label').textContent`) === 'ann · :8443', 'detail');
  });
  await check('databases: user ones first, System group after, still selectable', async () => {
    await b.waitFor(`document.getElementById('db-select').options.length > 1`, { label: 'dbs' });
    const r = await ev(`JSON.stringify({ top: [...document.getElementById('db-select').children].map((c) => c.tagName === 'OPTGROUP' ? 'G:' + c.label + ':' + [...c.children].map((o) => o.value).join(',') : c.value) })`);
    must(r === JSON.stringify({ top: ['', 'default', 'shop', 'G:System:INFORMATION_SCHEMA,information_schema,system'] }), r);
  });
  await check('table rows: Preview and Add are visible at rest', async () => {
    await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return 1; })()`);
    await b.waitFor(`document.querySelectorAll('.table-chip').length === 1`, { label: 'tables' });
    must(await ev(`[...document.querySelectorAll('.table-chip .iconbtn')].every((e) => getComputedStyle(e).opacity === '1')`), 'hidden at rest');
    await b.screenshot(join(SHOTS, 'schema-light.png'));
  });
  await check('after a reload the last database and its tables come back', async () => {
    await b.goto(APP);
    await b.waitFor(`document.querySelectorAll('.table-chip').length === 1`, { label: 'tables after reload' });
    must(await ev(`document.getElementById('db-select').value`) === 'shop', 'db not restored');
  });
  await check('preview: friendly kinds with the raw type in the tooltip, wide enough for 11 columns', async () => {
    await ev(`document.querySelector('.table-chip__peek').click()`);
    await b.waitFor(`document.querySelectorAll('dialog[open] th').length === 11`, { label: 'preview' });
    const r = JSON.parse(await ev(`JSON.stringify({ kinds: [...document.querySelectorAll('dialog[open] .rows-table__type')].map((e) => e.textContent), tip: document.querySelector('dialog[open] .rows-table__type').title, w: document.querySelector('dialog[open]').getBoundingClientRect().width })`));
    must(r.kinds.slice(0, 6).join('|') === 'whole number|number|text|text|date & time|true/false', r.kinds.join('|'));
    must(r.tip === 'UInt64', r.tip);
    must(r.w >= 1000, `dialog ${r.w}px`);
    await b.screenshot(join(SHOTS, 'preview-wide.png'));
    await ev(`document.querySelector('dialog[open] .btn--primary').click()`);
  });
  await check('column profile: friendly kind, frequent-value labels >= 4.5:1 in light and dark', async () => {
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
    await b.waitFor(`document.querySelectorAll('.col-row').length === 11`, { label: 'card' });
    for (const scheme of ['light', 'dark']) {
      await b.setScheme(scheme);
      await ev(`document.querySelector('.col-row[data-column="region"] .col-row__profile').click()`);
      await b.waitFor(`document.querySelector('dialog[open] .col-profile__cell--top') !== null`, { label: 'profile' });
      await b.sleep(900);
      const r = JSON.parse(await ev(`(() => {
        const px = document.createElement('canvas').getContext('2d');
        const rgb = (c) => { px.clearRect(0, 0, 1, 1); px.fillStyle = '#000'; px.fillStyle = c; px.fillRect(0, 0, 1, 1); const d = px.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]]; };
        const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
        const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
        const out = [...document.querySelectorAll('dialog[open] .col-profile__row')].map((row) => { const l = getComputedStyle(row.querySelector('.col-profile__label')).color; const bg = rgb(getComputedStyle(row).backgroundColor); const fill = rgb(getComputedStyle(row.querySelector('.col-profile__fill')).backgroundColor);
          return Math.min(cr(rgb(l), bg), cr(rgb(l), fill)); });
        return JSON.stringify({ min: Math.min(...out), out, sub: document.querySelector('dialog[open] .col-profile__sub').textContent });
      })()`));
      must(r.sub.endsWith('· text'), r.sub);
      await b.screenshot(join(SHOTS, `profile-${scheme}.png`));
      must(r.min >= 4.5, `${scheme}: ${JSON.stringify(r.out.map((x) => +x.toFixed(2)))}`);
      await ev(`document.querySelector('dialog[open] .btn--primary').click()`);
      await b.waitFor(`document.querySelector('dialog') === null`, { label: 'closed' });
    }
    await b.setScheme('light');
  });
  await check('Theme button opens the theme dialog directly (no one-item menu)', async () => {
    must(await ev(`!document.getElementById('settings-list') && document.getElementById('settings-btn').getAttribute('aria-label') === 'Theme'`), 'still a menu');
    await ev(`document.getElementById('settings-btn').click()`);
    await b.waitFor(`document.querySelector('dialog[open]') !== null`, { label: 'theme dialog' });
    await b.key('Escape'); await b.sleep(200);
    await ev(`document.querySelectorAll('dialog[open]').forEach((d) => d.close())`);
  });
  await check('Disconnect asks first and says the workbook comes back', async () => {
    await ev(`document.getElementById('conn-disconnect').click()`);
    must(/saved in this browser and comes back when you reconnect/.test(await ev(`document.querySelector('dialog[open] .dialog__body').textContent`)), 'text');
    await ev(`[...document.querySelectorAll('dialog button')].find((x) => x.textContent === 'Cancel').click()`);
    must(await ev(`!document.getElementById('conn-summary').hidden`), 'disconnected after Cancel');
    await ev(`document.getElementById('conn-disconnect').click(); [...document.querySelectorAll('dialog button')].find((x) => x.textContent === 'Disconnect').click()`);
    await b.waitFor(`!document.getElementById('conn-summary').hidden === false`, { label: 'disconnected' });
  });
  console.log(failed ? `${failed} FAILED` : 'all ok');
} finally { await b?.close(); }
process.exit(failed ? 1 : 0);
