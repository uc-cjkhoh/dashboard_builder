// Browser checks for a union / unpivot used as a data source (T02-16, T02-31/32): the real dev app (APP_URL, default
// http://localhost:5221) in headless Chromium over the DevTools protocol (tests/live/cdp.mjs), every /api/* call mocked —
// no ClickHouse, no credentials. Run:  node tests/live/union-source-ui.mjs
//   (start the app: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5221 ; stop: fuser -k 5221/tcp)
// Env: APP_URL, SHOTS_DIR (screenshots), CDP_PORT, CHROME_BIN. The browser is always closed in the finally block.
import { launch } from './cdp.mjs';
import { PAGE_CHIP } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5221';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'union-source-ui-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const TABLES = {
  orders: [['region', 'String', 'text'], ['amount', 'Float64', 'numeric'], ['q1', 'Int32', 'numeric'], ['q2', 'Int32', 'numeric']],
  returns: [['region', 'String', 'text'], ['amount', 'Float64', 'numeric']],
};
const REGIONS = ['APAC', 'EU', 'US'];
const queries = [], sourceReqs = [];
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: Object.keys(TABLES) };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && TABLES[m[1]]) return { json: TABLES[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/source/columns') {
    sourceReqs.push(body);
    const cols = body.kind === 'union'
      ? [['Source table', 'String', 'text'], ['region', 'String', 'text'], ['amount', 'Float64', 'numeric']]
      : [['region', 'String', 'text'], ['Field', 'String', 'text'], ['Value', 'Int32', 'numeric']];
    return { json: { columns: cols.map(([name, type, category]) => ({ name, type, category })), truncated: false, lossy: body.name.includes('lossy') ? ['amount'] : [] } };
  }
  if (path === '/api/query') {
    queries.push(body);
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    const n = dims.length ? REGIONS.length : 1;
    return { json: {
      rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: Array.from({ length: n }, (_, r) => ({ keys: dims.map(() => REGIONS[r]), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })),
      truncated: false } };
  }
  return null;
}

let failed = 0, passed = 0;
async function check(name, fn) { try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; } }
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const J = JSON.stringify;

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined, width: 1400, height: 900 });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const shot = async (name) => { try { writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } };
  const settle = async (quiet = 300) => { let n = -1; for (let i = 0; i < 60 && n !== queries.length; i++) { n = queries.length; await b.sleep(quiet); } };
  const lastQuery = () => queries[queries.length - 1];

  const installHelpers = () => ev(`(() => {
    window.__t = {
      chip: ${PAGE_CHIP},
      drag(chip, target) {
        const dt = new DataTransfer();
        chip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        chip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      },
      in: (group, name) => [...document.querySelectorAll('#ws-fields .ws-table')].find((g) => g.querySelector('.ws-group__name')?.textContent === group)
        ?.querySelectorAll('.ws-field') && [...[...document.querySelectorAll('#ws-fields .ws-table')].find((g) => g.querySelector('.ws-group__name')?.textContent === group).querySelectorAll('.ws-field')].find((c) => c.querySelector('.ws-field__name')?.textContent === name),
      zone: (kind) => document.querySelector('.ws-shelf--' + kind + ' .ws-shelf__zone'),
    };
    return true; })()`);
  const U = 'shop.Union: orders + returns', P = 'shop.Unpivot: orders';
  const dragIn = (group, name, kind) => ev(`(() => { const c = __t.in(${J(group)}, ${J(name)}); if (!c) throw new Error('no chip ${name} in ${group}'); __t.drag(c, __t.zone(${J(kind)})); return true; })()`);
  const dragChip = (name, kind) => ev(`(() => { const c = __t.chip(${J(name)}); if (!c) throw new Error('no field chip ${name}'); __t.drag(c, __t.zone(${J(kind)})); return true; })()`);
  const clearShelves = () => ev(`(async () => { const st = await import('/features/Core/store.js'); const w = st.activeWorksheet(); st.updateSheet(w.id, { ...st.emptySheet(), chartType: 'bar' }); return true; })()`);
  const dialogBtn = (text) => `[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === ${J(text)})`;
  const cards = () => ev(`[...document.querySelectorAll('.entity')].map((c) => c.querySelector('.entity__title').textContent)`);
  const loaded = (n) => waitFor(`document.querySelectorAll('.entity').length === ${n} && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, `${n} cards loaded`);

  // ---- setup: connect, pick the database, add the two tables ----------------------------------------------------
  const connect = async () => {
    await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
    await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
    await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  };
  await b.goto(APP + '/');
  await ev(`localStorage.clear()`);
  await b.goto(APP + '/');
  await connect();
  for (const t of ['orders', 'returns']) await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await loaded(2);
  // Two table cards with no relationship are held out of worksheets, so relate them first (drag one column onto the other).
  await ev(`(() => { const row = (t) => [...document.querySelectorAll('.entity')].find((x) => x.querySelector('.entity__table').textContent === t).querySelector('.col-row[data-column=region]');
    const a = row('orders'), z = row('returns'); const dt = new DataTransfer();
    a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); z.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    z.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return true; })()`);
  await waitFor(`document.querySelector('dialog[open] .join-choice') !== null`, 'relationship dialog');
  await ev(`[...document.querySelectorAll('dialog[open] .card-choice')].find((x) => x.textContent === '1:1').click(); document.querySelector('dialog[open]').querySelector('.rel-dialog__foot .btn--primary').click()`);
  await waitFor(`document.querySelector('dialog[open]') === null`, 'dialog closed');

  await check('the Union dialog adds a union entity to the model, read from /api/source/columns', async () => {
    await ev(`document.getElementById('union-open').click()`);
    await waitFor(`!!document.querySelector('dialog.union-dialog[open]')`, 'union dialog');
    must(await ev(`${dialogBtn('Add to model')}.disabled`) === true, 'Add to model is enabled before two tables are ticked');
    await ev(`(() => { for (const c of document.querySelectorAll('.union-dialog__item input')) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
    must(await ev(`${dialogBtn('Add to model')}.disabled`) === false, 'Add to model stays disabled with two tables');
    await ev(`${dialogBtn('Add to model')}.click()`);
    await loaded(3);
    must(J(await cards()) === J(['orders', 'returns', 'Union: orders + returns']), `cards: ${J(await cards())}`);
    must(J(sourceReqs[0]) === J({ kind: 'union', db: 'shop', name: 'Union: orders + returns', tables: ['orders', 'returns'] }), `source request: ${J(sourceReqs[0])}`);
  });

  await check('the union card lists its shared columns with no join keys, a note says how they match', async () => {
    const card = `[...document.querySelectorAll('.entity--source')][0]`;
    must(J(await ev(`[...${card}.querySelectorAll('.col-row__name')].map((n) => n.textContent)`)) === J(['Source table', 'region', 'amount']), 'column names');
    must(await ev(`${card}.querySelectorAll('.col-row__profile').length`) === 0, 'a source card has profile buttons');
    must((await ev(`${card}.querySelector('.entity__note').textContent`)) === 'Columns shared by name and kind.', 'note text');
    await shot('union-card-light.png');
  });

  await check('Compare columns on the union card lists what the union leaves out, in light and dark', async () => {
    const card = `[...document.querySelectorAll('.entity--source')][0]`;
    must(await ev(`${card}.querySelector('.entity__diff-out').hidden`) === true, 'list shown before the click');
    await ev(`${card}.querySelector('.entity__diff-btn').click()`);
    await waitFor(`${card}.querySelector('.entity__diff-sum') !== null`, 'comparison loaded');
    const text = await ev(`${card}.querySelector('.entity__diff-out').textContent`);
    must(/2 columns are left out: 2 not in every table, 0 of unlike kinds/.test(text), `summary: ${text}`);
    must(/q1: only in orders \(not in returns\)/.test(text) && /q2: only in orders/.test(text), `list: ${text}`);
    await shot('union-diff-light.png');
    await ev(`document.documentElement.dataset.scheme = 'dark'`);
    await new Promise((r) => setTimeout(r, 800)); // let the colour transitions settle before the shot
    await shot('union-diff-dark.png');
    await ev(`document.documentElement.dataset.scheme = 'light'`);
    await ev(`${card}.querySelector('.entity__diff-btn').click()`);
    must(await ev(`${card}.querySelector('.entity__diff-out').hidden`) === true, 'second click did not hide');
  });

  await check('an unpivot is added the same way: kept column, then Field and Value', async () => {
    await ev(`document.getElementById('unpivot-open').click()`);
    await waitFor(`!!document.querySelector('dialog.unpivot-dialog[open]') && document.querySelectorAll('.unpivot-dialog__list input').length > 0`, 'unpivot dialog loaded');
    await ev(`(() => { const sel = document.querySelector('.unpivot-dialog select'); sel.value = 'orders'; sel.dispatchEvent(new Event('change')); return true; })()`);
    await waitFor(`document.querySelectorAll('.unpivot-dialog__list')[0].querySelectorAll('input').length === 4`, 'orders columns');
    const tick = (side, name) => ev(`(() => { const c = [...document.querySelectorAll('.unpivot-dialog__list')[${side}].querySelectorAll('input')].find((x) => x.value === ${J(name)}); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await tick(0, 'q1'); await tick(0, 'q2'); await tick(1, 'region');
    await ev(`${dialogBtn('Add to model')}.click()`);
    await loaded(4);
    must(J(sourceReqs[1]) === J({ kind: 'unpivot', db: 'shop', name: 'Unpivot: orders', table: 'orders', columns: ['q1', 'q2'], keep: ['region'] }), `source request: ${J(sourceReqs[1])}`);
    const names = await ev(`[...document.querySelectorAll('.entity--source')][1].querySelectorAll('.col-row__name')`.replace(/$/, '.length') );
    must(names === 3, `columns: ${names}`);
    must((await ev(`[...document.querySelectorAll('.entity--source')][1].querySelector('.entity__note').textContent`)) === 'Field and Value from 2 columns.', 'unpivot note');
    await shot('model-sources-light.png');
  });

  await check('a source takes no relationship: dropping a table column on its row says so', async () => {
    await ev(`(() => {
      const row = (card, col) => [...document.querySelectorAll('.entity')].find((c) => c.querySelector('.entity__table').textContent === card).querySelector('.col-row[data-column="' + col + '"]');
      const from = row('orders', 'region'), to = row('Union: orders + returns', 'region');
      const dt = new DataTransfer();
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true; })()`);
    await waitFor(`!document.getElementById('toast').hidden && /can't be related/.test(document.getElementById('toast').textContent)`, 'refusal toast');
    must(await ev(`document.querySelectorAll('.rel-link__line').length`) === 1, 'a link was drawn to the source (only orders-returns should exist)');
  });

  // ---- a worksheet over the union ---------------------------------------------------------------------------------
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await installHelpers();
  await waitFor(`!!__t.chip('Source table')`, 'field pane lists the union columns');

  await check('the field pane lists the union as a table: its shared columns, Source table first among the dimensions', async () => {
    const groups = await ev(`[...document.querySelectorAll('#ws-fields .ws-table .ws-group__name')].map((g) => g.textContent)`);
    must(J(groups) === J(['shop.orders', 'shop.returns', U, P]), `field groups: ${J(groups)}`);
    const names = await ev(`[...__t.in(${J(U)}, 'Source table').closest('.ws-table').querySelectorAll('.ws-field__name')].map((n) => n.textContent)`);
    must(J(names) === J(['Source table', 'region', 'amount']), `union fields: ${J(names)}`);
  });

  await check('region x amount over the union sends one bounded query with the source and no joins', async () => {
    await dragIn(U, 'region', 'rows'); await dragIn(U, 'amount', 'columns');
    await settle(400);
    const q = lastQuery();
    must(q && q.source, `no source in the last query: ${J(q)}`);
    must(J(q.source) === J({ kind: 'union', db: 'shop', name: 'Union: orders + returns', tables: ['orders', 'returns'] }), `source: ${J(q.source)}`);
    must(J(q.from) === J({ db: 'shop', table: 'Union: orders + returns' }), `from: ${J(q.from)}`);
    must(q.joins.length === 0, 'joins');
    must(q.rowDimensions[0].table === 'Union: orders + returns' && q.measures[0].table === 'Union: orders + returns', 'field tables');
    must(q.limit <= 5000, 'limit is bounded');
    await waitFor(`!!document.querySelector('#ws-chart canvas, #ws-chart svg')`, 'chart drawn');
    await shot('worksheet-union-light.png');
  });

  await check('a field of a real table beside the union is refused with a clear message and sends no query', async () => {
    const before = queries.length;
    await dragIn('shop.orders', 'q1', 'columns');
    await settle(400);
    const text = await ev(`document.getElementById('ws-chart').textContent`);
    must(/can't be combined with another table/.test(text), `message: ${text}`);
    must(queries.length === before, 'a query was sent for the mixed view');
  });

  await check('a filter on a union field lists its members from a one-dimension query over the source', async () => {
    await clearShelves();
    await dragIn(U, 'region', 'rows');
    await settle(400);
    queries.length = 0;
    await ev(`(() => { __t.drag(__t.in(${J(U)}, 'region'), document.querySelector('.ws-tool[aria-label^="Filters"]')); return true; })()`);
    await waitFor(`!!document.querySelector('[data-ctx^="filter:"]')`, 'filter pill');
    await ev(`document.querySelector('[data-ctx^="filter:"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))`);
    await ev(`[...document.querySelectorAll('.ctx-menu [role=menuitemradio]')].find((o) => o.textContent.trim() === 'in').click()`);
    await waitFor(`document.querySelector('select.ws-pill__in') !== null && document.querySelector('select.ws-pill__in').options.length === 3`, 'members listed');
    const members = queries.find((q) => (q.measures ?? []).length === 0 && q.limit === 201);
    must(members && members.source?.kind === 'union' && members.rowDimensions[0].column === 'region' && members.joins.length === 0, `member query: ${J(members)}`);
    queries.length = 0;
    await ev(`(() => { const s = document.querySelector('select.ws-pill__in'); s.options[1].selected = true; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await settle(400);
    const q = lastQuery();
    must(q.filters.length === 1 && q.filters[0].op === 'in' && J(q.filters[0].values) === J(['EU']) && q.source.kind === 'union', `filtered query: ${J(q)}`);
  });

  await check('the unpivot reads as its own table: Field and Value are fields, the query carries its source', async () => {
    await clearShelves();
    await waitFor(`[...document.querySelectorAll('#ws-fields .ws-field')].some((c) => c.querySelector('.ws-field__name')?.textContent === 'Field')`, 'Field chip');
    await dragIn(P, 'Field', 'rows'); await dragIn(P, 'Value', 'columns');
    await settle(400);
    const q = lastQuery();
    must(q.source?.kind === 'unpivot' && J(q.source.columns) === J(['q1', 'q2']) && J(q.source.keep) === J(['region']), `source: ${J(q.source)}`);
    must(q.measures[0].column === 'Value' && q.rowDimensions[0].column === 'Field' && q.joins.length === 0, 'fields');
    await shot('worksheet-unpivot-light.png');
  });

  await check('histogram over a union field says it reads one table and sends nothing', async () => {
    await ev(`(async () => { const st = await import('/features/Core/store.js'); const w = st.activeWorksheet(); st.updateSheet(w.id, { ...w.sheet, chartType: 'histogram' }); return true; })()`);
    await settle(400);
    const text = await ev(`document.getElementById('ws-chart').textContent`);
    must(/can't read a union or unpivot/.test(text), `message: ${text}`);
  });

  await check('the sources are saved with the workbook and come back after a reload, with the worksheet', async () => {
    await ev(`(async () => { const st = await import('/features/Core/store.js'); const w = st.activeWorksheet(); st.updateSheet(w.id, { ...w.sheet, chartType: 'bar' }); return true; })()`);
    await b.sleep(900); // autosave is debounced (500 ms)
    const saved = await ev(`(() => { const k = Object.keys(localStorage).find((x) => /workbook/i.test(x)); return k ? localStorage.getItem(k) : null; })()`);
    must(saved && saved.includes('"source"') && saved.includes('Union: orders + returns') && saved.includes('Unpivot: orders'), 'workbook has no sources');
    const entities = JSON.parse(saved).entities.filter((e) => e.source);
    must(entities.length === 2 && entities.every((e) => e.joinKeys.length === 0), `saved sources: ${J(entities)}`);
    sourceReqs.length = 0; queries.length = 0;
    await b.goto(APP + '/');
    await connect();
    await loaded(4);
    must(J(await cards()) === J(['orders', 'returns', 'Union: orders + returns', 'Unpivot: orders']), `restored cards: ${J(await cards())}`);
    must(sourceReqs.length >= 2 && sourceReqs.every((r) => r.name.startsWith('Union') || r.name.startsWith('Unpivot')), `source columns were fetched ${sourceReqs.length} times`);
    await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet restored');
    await settle(500);
    must(lastQuery()?.source?.kind === 'unpivot', `restored worksheet query: ${J(lastQuery())}`);
  });

  const scheme = (t) => ev(`import('/features/Core/scheme.js').then((m) => m.setSchemePref(${J(t)}))`).then(() => b.sleep(600));
  await check('dark theme: the model with both sources, and a worksheet over the unpivot', async () => {
    await scheme('dark');
    must(await ev(`getComputedStyle(document.body).backgroundColor`) !== 'rgb(255, 255, 255)', 'dark scheme not applied');
    await ev(`document.querySelector('.tab--model .tab__label').click()`);
    await b.sleep(400);
    await shot('model-sources-dark.png');
    await ev(`document.querySelector('.tab--worksheet .tab__label').click()`);
    await b.sleep(900);
    await shot('worksheet-unpivot-dark.png');
    await scheme('light');
  });

  await check('alignment: card head, note, names and badges line up; no siblings touch (>= 4px)', async () => {
    await ev(`document.querySelector('.tab--model .tab__label').click()`);
    await waitFor(`!document.getElementById('model-view').hidden`, 'model view shown');
    await b.sleep(300);
    const r = await ev(`(() => {
      const card = document.querySelector('.entity--source');
      const x = (el) => Math.round(el.getBoundingClientRect().left * 10) / 10;
      const gapY = (a, c) => Math.round((c.getBoundingClientRect().top - a.getBoundingClientRect().bottom) * 10) / 10;
      const title = card.querySelector('.entity__title'), note = card.querySelector('.entity__note'), name = card.querySelector('.col-row__name');
      const tcs = getComputedStyle(title), noteCs = getComputedStyle(note), rowCs = getComputedStyle(card.querySelector('.col-row'));
      const textLeft = (el) => { const r = document.createRange(); r.selectNodeContents(el); return Math.round(r.getBoundingClientRect().left * 10) / 10; };
      const type = card.querySelector('.col-row__type'), close = card.querySelector('.entity__head > .iconbtn:last-child svg');
      const rows = [...card.querySelectorAll('.col-row')];
      const cards = [...document.querySelectorAll('.entity')].map((c) => c.getBoundingClientRect());
      let minGap = 1e9;
      for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i], c = cards[j];
        const dx = Math.max(c.left - a.right, a.left - c.right), dy = Math.max(c.top - a.bottom, a.top - c.bottom);
        minGap = Math.min(minGap, Math.max(dx, dy));
      }
      return { title: textLeft(title), note: textLeft(note), name: textLeft(name), typeRight: Math.round(type.getBoundingClientRect().right * 10) / 10, closeRight: Math.round(close.getBoundingClientRect().right * 10) / 10,
        rowGap: rows.length > 1 ? gapY(rows[0], rows[1]) : 0, noteToRow: gapY(note, rows[0]), minCardGap: minGap };
    })()`);
    console.log('  alignment:', J(r));
    must(Math.abs(r.title - r.name) <= 1, `title text ${r.title} vs column names ${r.name}`);
    must(Math.abs(r.note - r.name) <= 1, `note text ${r.note} vs column names ${r.name}`);
    must(r.minCardGap >= 4, `cards touch: ${r.minCardGap}`);
    must(r.noteToRow >= 0, `note overlaps the first row: ${r.noteToRow}`);
  });

  await check('a union whose columns were read as Float64 shows a second one-line note', async () => {
    await ev(`document.dispatchEvent(new CustomEvent('source:add', { detail: { source: { kind: 'union', db: 'shop', name: 'Union: lossy', tables: ['orders', 'returns'] } } }))`);
    await loaded(5);
    const notes = await ev(`[...document.querySelectorAll('.entity--source')].pop().querySelectorAll('.entity__note')`.replace(/$/, '.length') );
    must(notes === 2, `notes: ${notes}`);
    must((await ev(`document.querySelector('.entity__note-lossy').textContent`)) === 'Types differ: read as Float64, large values may round.', 'lossy text');
    must(await ev(`document.querySelectorAll('.entity__note-lossy').length`) === 1, 'only the lossy card has it');
    await shot('union-lossy-note-light.png');
  });

  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
