// Browser checks for the Data Source polish: one Tab stop in the table list (arrow keys inside), Enter / Down in the table search,
// the on-canvas mark on a table chip, the profile icon half-shown on card hover, the Union dialog's search and X, Esc on Edit SQL (asks when edited).
// Every /api/* call is mocked. Run: APP_URL=http://localhost:5278 node tests/live/ds-ux-medium-ui.mjs (start the app with dotnet run --urls on that port; stop it by port).
import { launch } from './cdp.mjs'; export { launch };
export const APP = process.env.APP_URL ?? 'http://localhost:5278';
export const SHOTS = (process.env.SHOTS_DIR ?? '/tmp/ds-ux-shots') + '/'; (await import('node:fs')).mkdirSync(SHOTS, { recursive: true });
const T = (n, t, c) => ({ name: n, type: t, category: c });
export const COLUMNS = {
  orders: [T('order_id','UInt64','numeric'),T('customer_id','UInt32','numeric'),T('product_id','UInt32','numeric'),T('amount','Decimal(18, 2)','numeric'),T('status','LowCardinality(String)','text'),T('created_at','DateTime64(3, \'UTC\')','temporal'),T('note','Nullable(String)','text'),T('region_code','FixedString(2)','text'),T('qty','Int16','numeric'),T('is_gift','Bool','numeric'),T('tags','Array(String)','text'),T('shipped_on','Date','temporal')],
  customers: [T('id','UInt32','numeric'),T('name','String','text'),T('email','String','text'),T('signup_date','Date','temporal'),T('country','LowCardinality(String)','text')],
  products: [T('id','UInt32','numeric'),T('sku','String','text'),T('price','Float64','numeric'),T('category','String','text')],
  order_line_items_archive_2023_partitioned_by_month: [T('id','UInt64','numeric'),T('order_id','UInt64','numeric')],
};
for (let i = 0; i < 30; i++) COLUMNS['events_' + String(i).padStart(2,'0')] = [T('id','UInt64','numeric'), T('ts','DateTime','temporal')];
export const side = (o) => ({ rows: 1000, nullRows: 0, keys: 1000, matchedKeys: 1000, matchedRows: 1000, maxDuplicates: 1, avgDuplicates: 1, ...o });
export const calls = [];
export function answer({ method, path, body }) {
  calls.push(method + ' ' + path);
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection/ping') return { json: { connected: true } };
  if (path === '/api/connection/disconnect') return { json: { connected: false } };
  if (path === '/api/connection') { if (body.password === 'bad') return { status: 502, json: { error: 'Authentication failed: password is incorrect, or there is no user with such name.' } };
    return { json: { connected: true, host: body.host, port: Number(body.port), user: body.user, secure: body.secure, allowInvalidCert: body.allowInvalidCert } }; }
  if (path === '/api/databases') return { json: ['analytics', 'default', 'shop', 'system'] };
  if (path === '/api/databases/shop/tables') return { json: Object.keys(COLUMNS) };
  if (/^\/api\/databases\/\w+\/tables$/.test(path)) return { json: [] };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]] };
  const d = path.match(/columns\/(\w+)\/distinct$/); if (d) return { json: { values: ['a','b','c'], truncated: false } };
  if (path === '/api/rows') { const cols = COLUMNS[body.table ?? body.source?.name ?? 'orders'] ?? COLUMNS.orders;
    return { json: { columns: cols.map(c=>({name:c.name,type:c.type})), rows: Array.from({length: 40}, (_, r) => cols.map((c,i)=> c.category==='numeric'? String(r*7+i) : c.category==='temporal' ? '2024-03-0'+(r%9+1)+' 10:00:00' : (r%5===0? null : 'val_'+r))), truncated: true, limit: 100, columnsTruncated: false } }; }
  if (/\/profile$/.test(path)) return { json: { column: body.column, type: 'UInt32', category: 'numeric', rows: 120000, nulls: 12, distinct: 4300, min: '1', max: '99812', sampled: false, sampleLimit: 1000000, top: [{ value: '5', count: 220, cut: false }, { value: '7', count: 180, cut: false }] } };
  if (/\/histogram$/.test(path)) return { json: { bins: [{ x0: 0, x1: 10, count: 4 }, { x0: 10, x1: 20, count: 2 }], whole: false } };
  if (path === '/api/relationships/preview') return { json: { from: side({ keys: 200, matchedKeys: 190, matchedRows: 940, maxDuplicates: 14, avgDuplicates: 5 }), to: side({ rows: 200, keys: 200, matchedKeys: 190, matchedRows: 190 }), sampleLimit: 1000000, sampled: false } };
  if (path === '/api/query') return { json: { rowDimensions: [], columnDimensions: [], measures: [], rows: [], truncated: false } };
  return null;
}
export const J = JSON.stringify;
export async function start({ width = 1400, height = 900, connect = true, db = true } = {}) {
  const b = await launch({ width, height });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const shot = (name) => b.screenshot(SHOTS + name + '.png');
  await b.goto(APP + '/');
  await b.waitFor(`!!document.getElementById('conn-connect')`, { label: 'loaded' });
  if (connect) {
    await ev(`(() => { document.getElementById('conn-host').value = 'ch.internal'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return 1; })()`);
    await b.waitFor(`document.getElementById('db-select').options.length > 1`, { label: 'dbs' });
    if (db) { await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return 1; })()`);
      await b.waitFor(`document.querySelectorAll('.table-chip').length > 5`, { label: 'tables' }); }
  }
  return { b, ev, shot };
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const res = []; const ok = (n, c, d='') => { res.push((c?'ok   ':'FAIL ')+n+(d?'  '+d:'')); };
const { b, ev, shot } = await start();
const chip = (t) => `document.querySelector('.table-chip[data-table=${J(t)}]')`;
// 9 one tab stop
const stops = await ev(`[...document.querySelectorAll('#table-list button')].filter(x=>x.tabIndex===0).map(x=>x.getAttribute('aria-label')).join('|')`);
ok('9 one tab stop in the list', stops === 'Add orders to the canvas', stops);
await ev(`document.getElementById('table-search').focus()`);
await b.key('Tab',{code:'Tab',vk:9}); const a1 = await ev(`document.activeElement.getAttribute('aria-label')`);
await b.key('Tab',{code:'Tab',vk:9}); const a2 = await ev(`document.activeElement.textContent.trim() || document.activeElement.getAttribute('aria-label')`);
ok('9 Tab from search: list, then past it (Union)', a1 === 'Add orders to the canvas' && a2 === 'Union', a1 + ' > ' + a2);
await ev(`${chip('orders')}.querySelector('.table-chip__add').focus()`);
await b.key('ArrowDown',{code:'ArrowDown',vk:40}); await b.key('ArrowDown',{code:'ArrowDown',vk:40});
ok('9 Down moves to the next table', await ev(`document.activeElement.getAttribute('aria-label')`) === 'Add products to the canvas', await ev(`document.activeElement.getAttribute('aria-label')`));
await b.key('ArrowLeft',{code:'ArrowLeft',vk:37});
ok('9 Left goes to the eye', await ev(`document.activeElement.getAttribute('aria-label')`) === 'Preview rows of products');
await b.key('End',{code:'End',vk:35});
ok('9 End goes to the last table (eye kept)', await ev(`document.activeElement.getAttribute('aria-label')`) === 'Preview rows of events_29', await ev(`document.activeElement.getAttribute('aria-label')`));
ok('9 tab stop follows focus', await ev(`[...document.querySelectorAll('#table-list button')].filter(x=>x.tabIndex===0).length`) === 1);
// 10 Enter in search
await ev(`(()=>{const s=document.getElementById('table-search'); s.focus(); s.value='custom'; s.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
await b.key('Enter',{code:'Enter',vk:13}); await sleep(700);
ok('10 Enter adds the one match', await ev(`document.querySelectorAll('.entity').length`) === 1);
await ev(`(()=>{const s=document.getElementById('table-search'); s.value='ord'; s.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
await b.key('Enter',{code:'Enter',vk:13}); await sleep(400);
ok('10 Enter with two matches adds nothing', await ev(`document.querySelectorAll('.entity').length`) === 1);
await b.key('ArrowDown',{code:'ArrowDown',vk:40});
ok('10 Down from search enters the list', await ev(`document.activeElement.getAttribute('aria-label')`) === 'Add orders to the canvas');
await ev(`(()=>{const s=document.getElementById('table-search'); s.value=''; s.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
// 8 placed marker
ok('8 placed chip says so', await ev(`${chip('customers')}.classList.contains('table-chip--placed') && ${chip('customers')}.querySelector('.table-chip__add').getAttribute('aria-label')`) === 'customers is on the canvas — show it');
ok('8 other chips unchanged', await ev(`!${chip('orders')}.classList.contains('table-chip--placed') && ${chip('orders')}.title`) === 'Drag orders onto the canvas');
await shot('v2-placed');
await ev(`document.querySelector('.entity .iconbtn--danger').click()`); await sleep(300);
ok('8 removing the card clears the mark', await ev(`!${chip('customers')}.classList.contains('table-chip--placed')`));
await ev(`document.querySelector('#toast .toast__action').click()`); await sleep(500);
ok('8 undo marks it again', await ev(`${chip('customers')}.classList.contains('table-chip--placed')`));
// 13 profile half-shown on card hover
const row = JSON.parse(await ev(`JSON.stringify(document.querySelector('.entity__head').getBoundingClientRect())`));
await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x + 40, y: row.y + 10 }); await sleep(400);
ok('13 profile icon half-shown while over the card', await ev(`getComputedStyle(document.querySelector('.col-row__profile')).opacity`) === '0.5', await ev(`getComputedStyle(document.querySelector('.col-row__profile')).opacity`));
await shot('v2-profile');
await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1300, y: 800 }); await sleep(400);
ok('13 hidden away from the card', await ev(`getComputedStyle(document.querySelector('.col-row__profile')).opacity`) === '0');
// 14 union
await ev(`document.getElementById('union-open').click()`); await sleep(500);
ok('14 union opens on its search box', await ev(`document.activeElement.getAttribute('aria-label')`) === 'Search tables' && await ev(`!!document.querySelector('dialog[open] .union-dialog__search input')`));
await ev(`document.querySelector('dialog[open] input[value="orders"]').click()`);
await b.type('events_0'); await sleep(200);
ok('14 search filters, ticked rows stay ticked', await ev(`[...document.querySelectorAll('dialog[open] .union-dialog__item')].filter(l=>!l.hidden).length`) === 10 && await ev(`document.querySelector('dialog[open] input[value="orders"]').checked`));
await shot('v2-union');
await b.key('Escape',{code:'Escape',vk:27}); await sleep(200);
ok('14 Esc in the search clears it, dialog stays', await ev(`!!document.querySelector('dialog[open]') && document.querySelector('dialog[open] .union-dialog__search input').value === ''`));
await ev(`document.querySelector('dialog[open] .union-dialog__top .iconbtn').click()`); await sleep(200);
ok('14 the X closes it', !(await ev(`!!document.querySelector('dialog[open]')`)));
// 15 edit SQL esc
const openEdit = () => ev(`(() => { document.querySelector('.entity__menu').click(); [...document.querySelectorAll('.ctx-menu [role^="menuitem"]')].find((x) => x.textContent.trim() === 'Edit SQL').click(); return true; })()`); // via the card's ☰ menu (D129)
await openEdit(); await sleep(1500);
await b.key('Escape',{code:'Escape',vk:27}); await sleep(400);
ok('15 Esc closes an untouched Edit SQL', !(await ev(`!!document.querySelector('dialog[open]')`)));
await openEdit(); await sleep(1500);
await b.type(' -- note'); await sleep(200);
await b.key('Escape',{code:'Escape',vk:27}); await sleep(400);
const conf = await ev(`[...document.querySelectorAll('dialog[open]')].map(d=>d.innerText.slice(0,60)).join(' || ')`);
ok('15 Esc after an edit asks first', /Discard your changes/.test(conf), conf);
await shot('v2-discard');
await ev(`[...document.querySelectorAll('dialog[open] button')].find(x=>x.textContent==='Cancel' && x.closest('.dialog--sm')).click()`); await sleep(300);
ok('15 keeping the edits leaves Edit SQL open', await ev(`document.querySelectorAll('dialog[open]').length`) === 1);
await b.key('Escape',{code:'Escape',vk:27}); await sleep(400);
await ev(`[...document.querySelectorAll('dialog[open] button')].find(x=>x.textContent==='Discard').click()`); await sleep(400);
ok('15 Discard closes it', await ev(`document.querySelectorAll('dialog[open]').length`) === 0);
await b.close();
console.log(res.join("\n")); if (res.some((r) => r.startsWith("FAIL"))) process.exitCode = 1;
