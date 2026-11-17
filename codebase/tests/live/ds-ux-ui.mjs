// Browser checks for the Data Source UX fixes: connect form focus, a + card revealed, the Needs a partner badge never clips a title,
// the dialog's start cardinality + "Use N:1", refusals as info toasts, two confirmations (no Undo) for removing a card / relationship, "hold text" wording.
// Every /api/* call is mocked. Run: APP_URL=http://localhost:5278 node tests/live/ds-ux-ui.mjs (start the app with dotnet run --urls on that port; stop it by port).
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
let { b, ev, shot } = await start({ connect: false });
await sleep(300);
ok('7 host focused on load', await ev(`document.activeElement.id`) === 'conn-host', await ev(`document.activeElement.id||document.activeElement.tagName`));
await b.close();
({ b, ev, shot } = await start({ width: 1280, height: 720 }));
for (const t of ['orders','customers','products','events_00','events_01']) { await ev(`[...document.querySelector('.table-chip[data-table=${J(t)}]').querySelectorAll('button')].at(-1).click()`); await sleep(500); }
await sleep(800);
const inView = await ev(`(()=>{const v=document.getElementById('model-view').getBoundingClientRect(); const e=[...document.querySelectorAll('.entity')].find(x=>x.querySelector('.entity__table').textContent==='events_01').getBoundingClientRect(); return e.top>=v.top && e.top < v.bottom-40})()`);
ok('3 last + added card revealed', inView); await shot('v-reveal');
const clipped = await ev(`[...document.querySelectorAll('.entity')].filter(e=>{const t=e.querySelector('.entity__title'); return t.scrollWidth>t.clientWidth}).map(e=>e.querySelector('.entity__table').textContent).join(',')`);
ok('2 no short title clipped with badge', clipped === '', clipped);
const dragRow = (fromT, fromC, toT, toC) => ev(`(() => { const row = (t, c) => [...document.querySelectorAll('.entity')].find((x) => x.querySelector('.entity__table').textContent === t).querySelector('.col-row[data-column=' + JSON.stringify(c) + ']');
  const a = row(${J(fromT)}, ${J(fromC)}), z = row(${J(toT)}, ${J(toC)}); const dt = new DataTransfer();
  a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); z.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  z.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return 1; })()`);
const pressed = () => ev(`document.querySelector('dialog[open] input[name=cardinality]:checked')?.value`);
await dragRow('orders','customer_id','customers','id'); await b.waitFor(`document.querySelector('dialog[open]')`);
ok('1 FK->PK starts on N:1', await pressed() === 'N:1', await pressed());
await ev(`document.querySelector('dialog[open] input[name=cardinality][value="1:N"]').click()`); // pick 1:N
await sleep(700); // the suggestion ran as the dialog opened; picking 1:N re-reads it
ok('1 Use N:1 offered when choice differs', await ev(`document.querySelector('dialog[open] .join-check__use')?.textContent`) === 'Use N:1');
await shot('v-use');
await ev(`document.querySelector('dialog[open] .join-check__use').click()`); await sleep(200);
ok('1 Use N:1 selects N:1 and goes away', await pressed() === 'N:1' && !(await ev(`!!document.querySelector('dialog[open] .join-check__use')`)));
await ev(`document.querySelector('dialog[open] .rel-dialog__foot .btn--primary').click()`); await sleep(700);
ok('1 saved N:1', await ev(`document.querySelector('.rel-badge text')?.textContent`) === 'N:1');
const wOrders = await ev(`[...document.querySelectorAll('.entity')].find(e=>e.querySelector('.entity__table').textContent==='orders').offsetWidth`);
ok('2 linked card back to its natural width', wOrders === 312, String(wOrders));
// link anchor on card edge after width refit
const anchorOk = await ev(`(()=>{const d=document.querySelector('.rel-link__line').getAttribute('d').match(/-?[\\d.]+/g).map(Number); const o=[...document.querySelectorAll('.entity')].find(e=>e.querySelector('.entity__table').textContent==='orders').getBoundingClientRect(); const c=document.getElementById('model-view').getBoundingClientRect(); return Math.abs(d[0]-(o.right-c.left))<3 || Math.abs(d[0]-(o.left-c.left))<3 })()`);
ok('2 link starts on the refit card edge', anchorOk);
// dup -> info toast
await dragRow('customers','id','orders','customer_id'); await sleep(300);
ok('4 already-related toast is info', await ev(`document.getElementById('toast').className`) === 'toast toast--info', await ev(`document.getElementById('toast').className`));
// remove cards / relationship: two confirmations, no Undo
const dlgBtn = (label) => ev(`[...document.querySelectorAll('dialog[open] button')].find(x=>x.textContent.trim()===${J(label)})?.click()`);
const dlgText = () => ev(`[...document.querySelectorAll('dialog[open].dialog--sm')].map(d=>d.innerText).join(' || ')`);
const nDlg = () => ev(`document.querySelectorAll('dialog[open]').length`);
const nRels = () => ev(`document.querySelectorAll('.rel-link__line').length`);
const hasCard = (t) => ev(`[...document.querySelectorAll('.entity')].some(e=>e.querySelector('.entity__table').textContent===${J(t)})`);
const removeCard = (t) => ev(`[...document.querySelectorAll('.entity')].find(e=>e.querySelector('.entity__table').textContent===${J(t)}).querySelector('.iconbtn--danger').click()`);
const addCard = async (t) => { await ev(`[...document.querySelector('.table-chip[data-table=${J(t)}]').querySelectorAll('button')].at(-1).click()`); await sleep(700); };
const noUndoToast = () => ev(`!document.querySelector('#toast .toast__action')`);
// remove linked card: first dialog, second dialog, Cancel on the second keeps it
await removeCard('customers'); await sleep(300);
const c1 = await dlgText();
ok('5 remove linked card asks first', /Remove shop\.customers and its relationship\(s\)\?/.test(c1), c1);
await dlgBtn('Remove'); await sleep(300);
const c2 = await dlgText();
ok('5 a second dialog asks again, "for good"', /Really remove shop\.customers\? This can't be undone\./.test(c2) && await ev(`!![...document.querySelectorAll('dialog[open].dialog--sm button')].find(x=>x.textContent.trim()==='Remove for good')`), c2);
await shot('v-confirm-twice');
await dlgBtn('Cancel'); await sleep(300);
ok('5 cancelling the second dialog keeps the card + relationship', await nDlg() === 0 && await hasCard('customers') && await nRels() === 1);
await removeCard('customers'); await sleep(300); await dlgBtn('Remove'); await sleep(300); await dlgBtn('Remove for good'); await sleep(400);
ok('5 both confirmed: card + its relationship gone, no Undo on the toast', !(await hasCard('customers')) && await nRels() === 0 && await noUndoToast(), await ev(`document.getElementById('toast').innerText`));
// put the card and its N:1 relationship back by hand (there is no Undo)
await addCard('customers');
await dragRow('orders','customer_id','customers','id'); await b.waitFor(`document.querySelector('dialog[open]')`); await sleep(700);
await ev(`document.querySelector('dialog[open] .rel-dialog__foot .btn--primary').click()`); await sleep(700);
ok('5 card re-added and relationship re-created as N:1', await hasCard('customers') && await nRels() === 1 && await ev(`document.querySelector('.rel-badge text')?.textContent`) === 'N:1');
// relationship delete: Delete in the cardinality dialog, then two confirmations
const openRel = async () => { await ev(`document.querySelector('.rel-link').dispatchEvent(new MouseEvent('click', { bubbles: true }))`); await sleep(400); };
await openRel(); await dlgBtn('Delete'); await sleep(300);
const r1 = await dlgText();
ok('5 rel delete asks first', /Remove the .* relationship\?/.test(r1) && await nRels() === 1, r1);
await dlgBtn('Remove'); await sleep(300);
ok('5 rel delete asks a second time', /Really remove the .* relationship\? This can't be undone\./.test(await dlgText()));
await dlgBtn('Cancel'); await sleep(300);
ok('5 cancelling the second dialog keeps the relationship', await nDlg() === 0 && await nRels() === 1);
await openRel(); await dlgBtn('Delete'); await sleep(300); await dlgBtn('Remove'); await sleep(300); await dlgBtn('Remove for good'); await sleep(400);
ok('5 both confirmed: relationship gone, no Undo on the toast', await nRels() === 0 && await noUndoToast(), await ev(`document.getElementById('toast').innerText`));
// unlinked card: asked twice too
await removeCard('products'); await sleep(300);
ok('5 unlinked remove still asks first', /Remove shop\.products from the canvas\?/.test(await dlgText()));
await dlgBtn('Remove'); await sleep(300);
ok('5 unlinked remove asks a second time', /Really remove shop\.products\?/.test(await dlgText()));
await dlgBtn('Remove for good'); await sleep(400);
ok('5 unlinked card gone, no Undo on the toast', !(await hasCard('products')) && await noUndoToast());
await addCard('products'); // the grammar check below needs it
// grammar
await dragRow('products','sku','orders','product_id'); await sleep(500);
const txt = await ev(`document.querySelector('dialog[open] .type-warning__hint')?.textContent`);
ok('grammar: hold text', /hold text and/.test(txt), txt);
await b.close();
console.log(res.join("\n")); if (res.some((r) => r.startsWith("FAIL"))) process.exitCode = 1;
