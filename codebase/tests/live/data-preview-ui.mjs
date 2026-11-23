// Browser checks for the Data Source's data preview (Canvas/data-preview.js): the first rows of one card in a panel docked under the
// canvas, opened by Preview data in a card's ☰ menu and by saving Edit SQL (D128). The real dev app (APP_URL, default http://localhost:5236) in
// headless Chromium over the DevTools protocol (tests/live/cdp.mjs), every /api/* call mocked.
// Run:  node tests/live/data-preview-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5236 ; stop it with fuser -k 5236/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT, CHROME_BIN.
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5236';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'data-preview-shots');
mkdirSync(SHOTS, { recursive: true });

const COLS = [['id', 'UInt64', 'numeric'], ['region', 'String', 'text'], ['amount', 'Float64', 'numeric'], ['note', 'Nullable(String)', 'text']].map(([name, type, category]) => ({ name, type, category }));
const SQL_COLS = [{ name: 'region', type: 'String', category: 'text' }, { name: 'total', type: 'Float64', category: 'numeric' }];
const rowsBodies = [];
const TOTAL = 250;
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/connection/ping') return { json: { connected: true, reachable: true } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders', 'customers'] };
  if (/^\/api\/databases\/shop\/tables\/\w+\/columns$/.test(path)) return { json: COLS };
  if (path === '/api/source/columns') return { json: { columns: body?.kind === 'union' ? COLS : SQL_COLS, truncated: false, lossy: [] } };
  if (path === '/api/source/syntax') return { json: { syntax: body?.sql ?? '' } };
  if (path === '/api/sql/translate') return { json: { sql: body.sql, warnings: [], changes: [] } };
  if (path === '/api/rows') {
    rowsBodies.push(body);
    if (body.source) return { json: { columns: SQL_COLS.map(({ name, type }) => ({ name, type })), rows: [['North', '120.5'], ['South', null]], truncated: false, limit: body.limit, columnsTruncated: false } };
    const off = body.offset ?? 0, n = Math.max(0, Math.min(body.limit, TOTAL - off)); // a 250-row table: pages 1 and 2 full, page 3 has 50
    return { json: { columns: COLS.map(({ name, type }) => ({ name, type })), truncated: off + n < TOTAL, rows: Array.from({ length: n }, (_, j) => j + off).map((i) => [String(i + 1), i % 2 ? 'North' : 'South', String(i * 1.5), i % 3 ? 'Delivered to the loading dock at the back of the building, signed for by the night shift' : null]), limit: body.limit, columnsTruncated: false } };
  }
  if (path === '/api/union') { rowsBodies.push(body); } if (path === '/api/union') return { json: { columns: [{ name: 'Source table', type: 'String' }, ...COLS.map(({ name, type }) => ({ name, type }))], rows: [['orders', '1', 'North', '2', 'a'], ['customers', '7', 'South', '3', null]], truncated: false, limit: body.limit, columnsTruncated: false } };
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const shot = async (name) => writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, 'databases listed');
  await ev(`(() => { for (const r of document.querySelectorAll('.db-row[data-db]')) if ((r.dataset.db === 'shop') !== (r.getAttribute('aria-expanded') === 'true')) r.click(); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders', 'customers']) await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: '${t}' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'both tables loaded');
  await b.sleep(1000); // entrance animation

  const card = (t) => `[...document.querySelectorAll('.entity')].find((e) => e.querySelector('.entity__table').textContent === '${t}')`;
  const act = (c, label) => `(() => { ${c}.querySelector('.entity__menu').click(); const it = [...document.querySelectorAll('.ctx-menu [role^="menuitem"]')].find((x) => x.textContent.trim() === '${label}'); if (!it) throw new Error('no menu item ${label}'); it.click(); return true; })()`; // the card's ☰ menu (D129)
  const panel = `document.getElementById('ds-preview')`;
  const state = () => ev(`(() => ({ hidden: ${panel}.hidden, title: document.getElementById('ds-preview-title').textContent,
    summary: document.getElementById('ds-preview-summary').textContent, rows: ${panel}.querySelectorAll('.rows-table tbody tr').length,
    ground: document.getElementById('model-view').clientHeight, panelH: ${panel}.getBoundingClientRect().height,
    previewed: [...document.querySelectorAll('.entity--previewed')].map((e) => e.querySelector('.entity__table').textContent),
    pageScroll: document.scrollingElement.scrollHeight - innerHeight }))()`);
  const groundFull = await ev(`document.getElementById('model-view').clientHeight`);

  await check('closed at first; every card has a ☰ menu with Preview data', async () => {
    const s = await state();
    must(s.hidden, 'panel shows before any card is picked');
    must(await ev(`document.querySelectorAll('.entity .entity__menu').length`) === 2, '☰ buttons');
    await ev(`${card('orders')}.querySelector('.entity__menu').click()`);
    const items = await ev(`[...document.querySelectorAll('.ctx-menu [role^="menuitem"]')].map((x) => x.textContent.trim())`);
    must(JSON.stringify(items) === JSON.stringify(['Edit SQL', 'Preview data']), JSON.stringify(items));
    await b.key('Escape', { vk: 27 });
    await waitFor(`!document.querySelector('.ctx-menu')`, 'menu closed');
  });

  await check('a card\'s ☰ Preview data opens the panel on that card; the ground shrinks above it, the page never scrolls', async () => {
    await ev(act(card('orders'), 'Preview data'));
    await waitFor(`${panel}.querySelectorAll('.rows-table tbody tr').length > 0`, 'rows shown');
    const s = await state();
    must(!s.hidden && s.title === 'shop.orders', JSON.stringify(s));
    must(s.rows === 100 && s.summary === 'Rows 1–100 — more exist', s.summary);
    must(Math.abs(s.ground + s.panelH - groundFull) <= 1, `ground ${s.ground} + panel ${s.panelH} vs ${groundFull}`);
    must(s.pageScroll === 0, `page scrolls ${s.pageScroll}`);
    must(s.previewed.join() === 'orders', `outlined ${s.previewed}`);
    await ev(`${card('orders')}.querySelector('.entity__menu').click()`);
    must(await ev(`[...document.querySelectorAll('.ctx-menu [role="menuitemcheckbox"]')].find((x) => x.textContent.trim() === 'Preview data')?.getAttribute('aria-checked')`) === 'true', 'Preview data not ticked');
    await b.key('Escape', { vk: 27 });
    await waitFor(`!document.querySelector('.ctx-menu')`, 'menu closed');
    must(JSON.stringify(rowsBodies.at(-1)) === JSON.stringify({ db: 'shop', table: 'orders', limit: 100, offset: 0 }), JSON.stringify(rowsBodies.at(-1)));
    await shot('open.png');
  });

  await check('the rows start on the 16px gutter under the title', async () => {
    const x = await ev(`(() => { const t = document.getElementById('ds-preview-title').getBoundingClientRect().left;
      const c = ${panel}.querySelector('.rows-table td'); const r = document.createRange(); r.selectNodeContents(c); return [t, r.getBoundingClientRect().left]; })()`);
    must(Math.abs(x[0] - x[1]) <= 1, `title ${x[0]} vs first cell text ${x[1]}`);
  });


  const th = (name) => `[...${panel}.querySelectorAll('.rows-table th')].find((h) => h.querySelector('.rows-table__name').textContent === '${name}')`;
  const colW = (name) => ev(`Math.round(${th(name)}.getBoundingClientRect().width)`);
  const mouse = (type, x, y) => b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });

  await check('a light grid: one-line headers, types in the tooltip, zebra stripes (every second row --surface-2), columns fit their content, numbers right-aligned after the first', async () => {
    const g = await ev(`(() => { const t = ${panel}.querySelector('.rows-table'); const h = ${th('amount')}; const cs = (e) => getComputedStyle(e);
      const tds = t.tBodies[0].rows; return { headH: Math.round(t.tHead.getBoundingClientRect().height), rowH: Math.round(tds[0].getBoundingClientRect().height),
        typeW: ${th('amount')}.querySelector('.rows-table__type').getBoundingClientRect().width, title: h.title,
        even: cs(tds[1].cells[1]).backgroundColor, odd: cs(tds[0].cells[1]).backgroundColor,
        idAlign: cs(tds[0].cells[0]).textAlign, amtAlign: cs(tds[0].cells[2]).textAlign, headAmtAlign: cs(h).textAlign,
        tableW: Math.round(t.getBoundingClientRect().width), scrollW: ${panel}.querySelector('.ds-preview__scroll').clientWidth }; })()`);
    must(g.headH <= g.rowH + 2, `header ${g.headH}px vs row ${g.rowH}px — two lines?`);
    must(g.typeW <= 1 && g.title === 'amount · Float64', JSON.stringify(g));
    must(g.even !== g.odd && g.even !== 'rgba(0, 0, 0, 0)', `every second row should carry the --surface-2 stripe: even ${g.even}, odd ${g.odd}`); // D130: zebra stripes (canvas.md)
    const lines = await ev(`(() => { const t = ${panel}.querySelector('.rows-table'); const w = (e) => getComputedStyle(e).borderRightWidth;
      return [...t.tHead.rows[0].cells, ...t.tBodies[0].rows[5].cells].map(w); })()`);
    must(lines.every((x) => x === '1px'), `column lines ${lines}`);
    const hd = await ev(`(() => { const h = getComputedStyle(${th('region')}); const c = getComputedStyle(${panel}.querySelector('.rows-table td')); return [h.fontWeight, h.backgroundColor, c.backgroundColor]; })()`);
    must(hd[0] === '700' && hd[1] !== hd[2], `header ${hd}`);
    must(g.idAlign === 'left' && g.amtAlign === 'right' && g.headAmtAlign === 'right', JSON.stringify(g));
    const cut = await ev(`[...${panel}.querySelectorAll('.rows-table__name')].filter((n) => { const r = document.createRange(); r.selectNodeContents(n); return r.getBoundingClientRect().width > n.clientWidth + 0.01; }).map((n) => n.textContent)`);
    must(cut.length === 0, `headers cut: ${cut}`);
    must(await colW('note') === 320, `long text column ${await colW('note')}px, want the 320 automatic cap`);
    must(await colW('region') < 120, `region ${await colW('region')}px — stretched?`);
    must(g.tableW < g.scrollW, `table ${g.tableW} fills the panel ${g.scrollW}`);
  });

  await check('drag a header’s right border: the column grows by the distance dragged', async () => {
    const w0 = await colW('region');
    const r = await ev(`(() => { const r = ${th('region')}.querySelector('.rows-table__grip').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    must(await ev(`getComputedStyle(${th('region')}.querySelector('.rows-table__grip')).cursor`) === 'col-resize', 'no col-resize cursor');
    await mouse('mouseMoved', r[0], r[1]); await mouse('mousePressed', r[0], r[1]);
    for (let i = 1; i <= 4; i++) await mouse('mouseMoved', r[0] + i * 15, r[1]);
    await mouse('mouseReleased', r[0] + 60, r[1]);
    const w1 = await colW('region');
    must(Math.abs(w1 - w0 - 60) <= 1, `${w0} → ${w1}, want +60`);
    must((await state()).pageScroll === 0, 'page scrolls');
    await shot('resized.png');
  });

  await check('→ on the grip widens 8px; the width survives Refresh; double-click goes back to automatic', async () => {
    const w0 = await colW('region');
    await ev(`${th('region')}.querySelector('.rows-table__grip').focus()`);
    await b.key('ArrowRight', { vk: 39 });
    const w1 = await colW('region');
    must(w1 - w0 === 8, `${w0} → ${w1}`);
    const before = rowsBodies.length;
    await ev(`document.getElementById('ds-preview-refresh').click()`);
    await waitFor(`${panel}.querySelectorAll('.rows-table tbody tr').length === 100`, 'rows again');
    await b.sleep(200);
    must(rowsBodies.length === before + 1, 'no re-read');
    must(await colW('region') === w1, `after Refresh ${await colW('region')}, want ${w1}`);
    const r = await ev(`(() => { const r = ${th('region')}.querySelector('.rows-table__grip').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    for (const n of [1, 2]) {
      await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r[0], y: r[1], button: 'left', buttons: 1, clickCount: n });
      await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r[0], y: r[1], button: 'left', buttons: 0, clickCount: n });
    }
    const wd = await colW('region');
    must(wd < 120 && wd !== w1, `double-click left ${wd}`);
    await ev(`${th('region')}.querySelector('.rows-table__grip').focus()`);
    await b.key('ArrowRight', { vk: 39 }); await b.key('ArrowRight', { vk: 39 });
    must(await colW('region') === wd + 16, 'arrows after reset');
    await b.key('Delete', { vk: 46 });
    must(await colW('region') === wd, `Delete left ${await colW('region')}, want ${wd}`);
  });

  await check('the header stays put while the rows scroll', async () => {
    const d = await ev(`(() => { const s = ${panel}.querySelector('.ds-preview__scroll'); s.scrollTop = 600;
      return Math.round(${panel}.querySelector('.rows-table thead th').getBoundingClientRect().top - s.getBoundingClientRect().top); })()`);
    must(d === 0, `header ${d}px off the top`);
    await shot('scrolled.png');
    await b.setScheme('dark'); await b.sleep(300); await shot('dark.png'); await b.setScheme('light');
    await ev(`${panel}.querySelector('.ds-preview__scroll').scrollTop = 0`);
  });


  const pg = () => ev(`(() => ({ pager: !document.getElementById('ds-preview-pager').hidden, page: 'Page ' + document.getElementById('ds-preview-page').value,
    prev: !document.getElementById('ds-preview-prev').disabled, next: !document.getElementById('ds-preview-next').disabled,
    summary: document.getElementById('ds-preview-summary').textContent, first: ${panel}.querySelector('.rows-table tbody td')?.textContent,
    rows: ${panel}.querySelectorAll('.rows-table tbody tr').length, focus: document.activeElement?.id }))()`);
  const settle = (want) => waitFor(`'Page ' + document.getElementById('ds-preview-page').value === '${want}' && ${panel}.querySelector('.rows-dialog__status')?.textContent !== 'Loading rows…' && !document.getElementById('ds-preview-scroll').hasAttribute('aria-busy')`, want);
  await check('pages of 100: Page 1 first; Next shows rows 101–200, then the last 50; Previous goes back', async () => {
    let p = await pg();
    must(p.pager && p.page === 'Page 1' && !p.prev && p.next && p.first === '1', JSON.stringify(p));
    const wNote = await colW('note');
    await ev(`document.getElementById('ds-preview-next').click()`); await settle('Page 2');
    p = await pg();
    must(p.page === 'Page 2' && p.summary === 'Rows 101–200 — more exist' && p.first === '101' && p.rows === 100 && p.prev && p.next, JSON.stringify(p));
    must(rowsBodies.at(-1).offset === 100, JSON.stringify(rowsBodies.at(-1)));
    must(await colW('note') === wNote, 'columns jumped between pages');
    await ev(`document.getElementById('ds-preview-next').focus()`);
    for (const type of ['keyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) }); // Enter on the focused button
    await settle('Page 3');
    p = await pg();
    must(p.summary === 'Rows 201–250' && p.rows === 50 && p.prev && !p.next, JSON.stringify(p));
    must(p.focus === 'ds-preview-prev', `focus on ${p.focus} after the last page`);
    await shot('page3.png');
    await ev(`document.getElementById('ds-preview-prev').click()`); await settle('Page 2');
    p = await pg();
    must(p.first === '101' && p.next, JSON.stringify(p));
  });

  const typePage = async (text, key = 'Enter') => {
    await ev(`(() => { const i = document.getElementById('ds-preview-page'); i.focus(); i.value = ''; return true; })()`);
    await b.type(text);
    const vk = key === 'Enter' ? 13 : 27;
    for (const type of ['keyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: vk, ...(type === 'keyDown' && key === 'Enter' ? { text: '\r' } : {}) });
  };
  await check('type a page number and Enter goes there; a bad one is refused with a message; Escape puts the page back', async () => {
    await typePage('3'); await settle('Page 3');
    let p = await pg();
    must(p.first === '201' && rowsBodies.at(-1).offset === 200 && !p.next, JSON.stringify(p));
    const before = rowsBodies.length;
    await typePage('1002'); await b.sleep(200);
    const err = await ev(`(() => ({ invalid: document.getElementById('ds-preview-page').getAttribute('aria-invalid'), msg: document.getElementById('ds-preview-page-error')?.textContent.trim(), role: document.getElementById('ds-preview-page-error')?.getAttribute('role') }))()`);
    must(err.invalid === 'true' && err.msg === 'Enter a page from 1 to 1,001.' && err.role === 'alert', JSON.stringify(err));
    must(rowsBodies.length === before, 'a bad page was read');
    await shot('page-error.png');
    await typePage('5', 'Escape'); await b.sleep(100);
    must(await ev(`document.getElementById('ds-preview-page').value`) === '3', 'Escape did not restore');
    await typePage('9'); await settle('Page 9');
    p = await pg();
    must(p.summary === 'No rows on this page' && p.prev && !p.next && rowsBodies.at(-1).offset === 800, JSON.stringify(p));
    must(!(await ev(`!!document.getElementById('ds-preview-page-error')`)), 'error stayed');
    await typePage('2'); await settle('Page 2');
    must((await pg()).first === '101', 'page 2');
  });

  await check('Refresh keeps the page; another card starts on Page 1', async () => {
    await ev(`document.getElementById('ds-preview-refresh').click()`); await b.sleep(300);
    let p = await pg();
    must(p.page === 'Page 2' && p.first === '101' && rowsBodies.at(-1).offset === 100, JSON.stringify(p));
    await ev(act(card('customers'), 'Preview data'));
    await waitFor(`document.getElementById('ds-preview-title').textContent === 'shop.customers'`, 'switched');
    await settle('Page 1');
    p = await pg();
    must(p.first === '1' && !p.prev && rowsBodies.at(-1).offset === 0, JSON.stringify(p));
    await ev(act(card('orders'), 'Preview data'));
    await waitFor(`document.getElementById('ds-preview-title').textContent === 'shop.orders'`, 'back');
    await settle('Page 1');
  });

  await check('Preview data on another card switches; pressed again it closes and the ground is whole again', async () => {
    await ev(act(card('customers'), 'Preview data'));
    await waitFor(`document.getElementById('ds-preview-title').textContent === 'shop.customers'`, 'switched');
    must((await state()).previewed.join() === 'customers', 'outline did not move');
    await ev(act(card('customers'), 'Preview data'));
    await waitFor(`document.getElementById('ds-preview').hidden`, 'hidden after its exit (~100ms)');
    const s = await state();
    must(s.hidden && s.previewed.length === 0 && s.ground === groundFull, JSON.stringify(s));
  });

  await check('saving Edit SQL opens the panel on that card with the query\'s rows (D128)', async () => {
    await ev(act(card('orders'), 'Edit SQL'));
    await waitFor(`!!document.querySelector('.sql-dialog[open] .CodeMirror') || !!document.querySelector('.sql-dialog[open] textarea')`, 'SQL dialog open');
    await b.sleep(300);
    await ev(`(() => { const q = 'SELECT region, sum(amount) AS total FROM shop.orders GROUP BY region'; const cm = document.querySelector('.sql-dialog[open] .CodeMirror');
      if (cm) cm.CodeMirror.setValue(q); else { const t = document.querySelector('.sql-dialog[open] textarea'); t.value = q; t.dispatchEvent(new Event('input')); } return true; })()`);
    await b.sleep(1200); // the live check settles
    await ev(`[...document.querySelectorAll('.sql-dialog[open] button')].find((x) => x.textContent === 'Save').click()`);
    await waitFor(`!document.querySelector('.sql-dialog[open]') && !${panel}.hidden && ${panel}.querySelectorAll('.rows-table tbody tr').length === 2`, 'panel shows the query rows');
    const s = await state();
    must(s.title === 'shop.orders' && s.summary === 'Custom SQL · Rows 1–2', JSON.stringify(s));
    must(rowsBodies.at(-1).source?.kind === 'sql' && /GROUP BY region/.test(rowsBodies.at(-1).source.sql), JSON.stringify(rowsBodies.at(-1)));
    must(await ev(`${panel}.querySelector('.rows-table__null')?.textContent`) === 'NULL', 'NULL cell');
    await b.sleep(300); // columns sized once the fonts are in
    // every number shows whole: its text fits its cell's content box (a sub-pixel overflow would end it in an ellipsis, "12…")
    const clipped = await ev(`(() => { const r = document.createRange(); return [...${panel}.querySelectorAll('.rows-table td.is-num')].filter((td) => {
      r.selectNodeContents(td); const s = getComputedStyle(td); return r.getBoundingClientRect().width > td.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) + 0.01; }).map((td) => td.textContent); })()`);
    must(await ev(`${panel}.querySelectorAll('.rows-table td.is-num').length`) === 2 && clipped.length === 0, 'clipped numbers: ' + JSON.stringify(clipped));
    // the how-to pill stays above the panel, toast or not (a toast is showing now)
    const lift = await ev(`(() => { const g = document.querySelector('.rel-guide:not(.rel-keyhint)'); return g && !g.hidden ? Math.round(${panel}.getBoundingClientRect().top - g.getBoundingClientRect().bottom) : null; })()`);
    must(lift === null || lift >= 15, 'how-to pill over the panel: ' + lift);
    await shot('after-sql.png');
  });

  await check('Reset to default + Save goes back to the table and the panel re-reads it', async () => {
    const before = rowsBodies.length;
    await ev(act(card('orders'), 'Edit SQL'));
    await waitFor(`!!document.querySelector('.sql-dialog[open]')`, 'SQL dialog open');
    await b.sleep(300);
    const reset = await ev(`(() => { const r = [...document.querySelectorAll('.sql-dialog[open] button')].find((x) => /^Reset/.test(x.textContent)); if (!r) return false; r.click(); return true; })()`);
    must(reset, 'no Reset button');
    await b.sleep(800);
    await ev(`[...document.querySelectorAll('.sql-dialog[open] button')].find((x) => x.textContent === 'Save').click()`);
    await waitFor(`!document.querySelector('.sql-dialog[open]') && ${panel}.querySelectorAll('.rows-table tbody tr').length === 100`, 'table rows again');
    must(rowsBodies.length === before + 1, `${rowsBodies.length - before} row reads, want 1`);
    must(!rowsBodies.at(-1).source, 'still sent a source');
    must(!/Custom SQL/.test((await state()).summary), 'summary still says Custom SQL');
  });

  await check('↑ grows the panel 16px from its top edge; the ground keeps at least 160px', async () => {
    const h0 = (await state()).panelH;
    await ev(`document.getElementById('ds-preview-grip').focus()`);
    await b.key('ArrowUp', { vk: 38 });
    const h1 = (await state()).panelH;
    must(Math.abs(h1 - h0 - 16) <= 1, `${h0} → ${h1}`);
    for (let i = 0; i < 60; i++) await b.key('ArrowUp', { vk: 38 });
    must((await state()).ground >= 160, `ground ${(await state()).ground}`);
  });

  await check('a union card reads /api/union and shows its stacked rows', async () => {
    await ev(`document.dispatchEvent(new CustomEvent('source:add', { detail: { source: { kind: 'union', db: 'shop', name: 'Union: orders + customers', tables: ['orders', 'customers'] } } }))`);
    await waitFor(`!!${card('Union: orders + customers')} && ${card('Union: orders + customers')}.querySelector('.entity__status').hidden`, 'union loaded');
    await ev(act(card('Union: orders + customers'), 'Preview data'));
    await waitFor(`document.getElementById('ds-preview-title').textContent === 'Union: orders + customers' && ${panel}.querySelectorAll('.rows-table tbody tr').length === 2`, 'union rows');
    must(await ev(`document.getElementById('ds-preview-pager').hidden`), 'a union shows a pager');
    must(!('offset' in rowsBodies.at(-1)), 'union read sent an offset');
  });

  await check('removing the card it shows closes the panel; another tab hides it', async () => {
    await ev(act(card('orders'), 'Preview data'));
    await waitFor(`document.getElementById('ds-preview-title').textContent === 'shop.orders'`, 'on orders');
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    await b.sleep(400);
    const onSheet = await ev(`${panel}.hidden`);
    await ev(`(() => { const d = [...document.querySelectorAll('#tabs *')].find((x) => x.textContent.trim() === 'Data Source' && x.children.length === 0); (d?.closest('button,[role=tab]') ?? d)?.click(); return !!d; })()`);
    await b.sleep(400);
    must(onSheet, 'shown on a worksheet');
    must(!(await ev(`${panel}.hidden`)), 'not back on the Data Source');
    await ev(`${card('orders')}.querySelector('.iconbtn--danger').click()`);
    await waitFor(`!!document.querySelector('dialog[open]')`, 'remove confirm'); // removing a card asks once
    await ev(`[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === 'Remove').click()`);
    await b.sleep(300);
    const s = await state();
    must(s.hidden && s.ground === groundFull, JSON.stringify(s));
  });
} catch (e) {
  console.log(`FAIL setup: ${e.message}`); failed++;
} finally {
  await b?.close();
}
console.log(`\n${passed} passed, ${failed} failed — screenshots in ${SHOTS}`);
process.exit(failed ? 1 : 0);
