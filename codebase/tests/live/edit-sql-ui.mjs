// Browser check for "Edit SQL" on a Data Source card (D105): the head's Edit button opens the dialog (right-click opens nothing), the dialog
// starts on the default SELECT, a bad query is answered inside the dialog, a good one swaps the card's columns, relationship keys are
// protected, Reset to default + Save goes back to the table, and the
// worksheet query carries the SQL as `sources`. Real dev app (APP_URL, default http://localhost:5231) in headless Chromium, every /api/* call
// mocked. Run:  node tests/live/edit-sql-ui.mjs   (start the app first, stop it by port).
import { launch } from './cdp.mjs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5231';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'agg-ui-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['cust_id', 'Int32', 'numeric'], ['amount', 'Float64', 'numeric']],
  customers: [['id', 'Int32', 'numeric'], ['name', 'String', 'text']],
};
const queries = [], sourceCalls = [], translateCalls = [];
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders', 'customers'] };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/sql/translate') { // a stand-in for the real translator (covered by the .NET tests): enough rules to drive the dialog
    translateCalls.push(body);
    if (/NOPY/.test(body.sql)) return { status: 503, json: { error: 'Python 3 is not installed on this server.' } };
    if (/TRANSERR/.test(body.sql)) return { status: 400, json: { error: 'The query looks unfinished here: something is missing.', field: 'sql', line: 1, col: 27, start: 17 } };
    if (body.from === 'clickhouse' && /arrayJoin/.test(body.sql)) return { status: 400, json: { error: 'Part of this query has no equivalent in the other dialect: arrayJoin.', field: 'sql' } };
    const changes = [];
    let out;
    if (body.from === 'mysql') {
      out = body.sql.replace(/\b(NOT )?LIKE\b/g, (m, n) => { changes.push('ilike'); return `${n ?? ''}ILIKE`; }).replace(/IFNULL\(/g, 'COALESCE(').replace(/LIMIT (\d+), (\d+)/g, 'LIMIT $2 OFFSET $1')
        .replace(/(\w+) = '([A-Za-z]+)'/g, (m, c, t) => { changes.push('case-fold'); return `lowerUTF8(toString(${c})) = lowerUTF8('${t}')`; })
        .replace(/flipme = 1/g, 'flipme = 2'); // a silent change: no `changes`, same columns — only EXPLAIN SYNTAX shows it
    } else out = body.sql.replace(/toDate\(/g, 'TODATE(').replace(/COALESCE\(/g, 'IFNULL(').replace(/LIMIT (\d+) OFFSET (\d+)/g, 'LIMIT $2, $1');
    return { json: { sql: out, warnings: body.from === 'mysql' && changes.includes('case-fold') ? ["Text comparisons ignore upper/lower case, as in MySQL."] : [], changes: [...new Set(changes)] } };
  }
  if (path === '/api/source/syntax') return { json: { syntax: body.sql.replace(/\s+/g, ' ').trim() } }; // stand-in for EXPLAIN SYNTAX: layout is not meaning
  if (path === '/api/source/columns') {
    sourceCalls.push(body);
    if (/TODATE\(/.test(body.sql)) return { status: 400, json: { error: 'Unknown function TODATE.', field: 'source.sql' } }; // ClickHouse names are case-sensitive
    if (/POSERR/.test(body.sql)) return { status: 400, json: { error: "Syntax error: failed at position 14 ('POSERR') (line 3, col 3): POSERR. Expected one of: FROM.", field: 'source.sql' } };
    if (/BAD/.test(body.sql)) return { status: 400, json: { error: 'Syntax error: failed at position 5 (BAD).', field: 'source.sql' } };
    if (/noid/.test(body.sql)) return { json: { columns: [{ name: 'amount', type: 'Float64', category: 'numeric' }], truncated: false, lossy: [] } };
    return { json: { columns: [{ name: 'cust_id', type: 'Int32', category: 'numeric' }, { name: 'amount', type: 'Float64', category: 'numeric' }, { name: 'extra', type: 'String', category: 'text' }], truncated: false, lossy: [] } };
  }
  if (path === '/api/query') {
    queries.push(body);
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: [], measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: ['Ann', 'Bo', null].map((k, r) => ({ keys: dims.map(() => k), values: (body.measures ?? []).map(() => 10 * (r + 1)) })), truncated: false } };
  }
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const J = JSON.stringify;

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const settle = async (quiet = 300) => { let n = -1; for (let i = 0; i < 60 && n !== queries.length; i++) { n = queries.length; await b.sleep(quiet); } };
  const shot = async (name) => writeFileSync(join(SHOTS, name), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders', 'customers'])
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'both tables loaded');
  const dragRow = (fromT, fromC, toT, toC) => ev(`(() => { const row = (t, c) => [...document.querySelectorAll('.entity')].find((x) => x.textContent.includes(t)).querySelector('.col-row[data-column=' + JSON.stringify(c) + ']');
    const a = row(${J(fromT)}, ${J(fromC)}), z = row(${J(toT)}, ${J(toC)}); const dt = new DataTransfer();
    a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); z.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    z.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return true; })()`);
  await dragRow('orders', 'cust_id', 'customers', 'id'); // relationships are made by dragging one column onto another
  await waitFor(`document.querySelector('dialog[open] .join-choice') !== null`, 'relationship dialog open');

  const toastText = () => ev(`(document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent)`);
  const dlg = `document.querySelector('dialog[open]')`;
  await ev(`${dlg}.querySelector('.rel-dialog__foot .btn--primary').click()`);
  await waitFor(`document.querySelectorAll('.rel-badge').length === 1`, 'relationship drawn');
  const card = (t) => `([...document.querySelectorAll('.entity')].find((x) => x.querySelector('.entity__table').textContent === '${t}'))`;
  const cols = (t) => ev(`[...${card(t)}.querySelectorAll('.col-row')].map((r) => r.dataset.column)`);
  const rightClick = (t) => ev(`(() => { const c = ${card(t)}, r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 })); return true; })()`);
  const editBtn = (t) => `${card(t)}.querySelector('.entity__head > .entity__edit')`;
  const clickEdit = async (t) => { await ev(`${editBtn(t)}.click()`); await waitFor(`!!document.querySelector('dialog[open] .CodeMirror')`, 'dialog'); };
  const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); ${code} })()`);
  const cmOf = `document.querySelector('dialog[open] .CodeMirror').CodeMirror`;
  const setSql = (v) => ev(`(() => { ${cmOf}.setValue(${J(v)}); return true; })()`);
  const getSql = () => ev(`${cmOf}.getValue()`);
  const press = (label) => ev(`[...document.querySelectorAll('dialog[open] .dialog__foot .btn')].find((b) => b.textContent.trim() === ${J(label)}).click()`);
  const errorText = () => ev(`document.querySelector('dialog[open] .sql-dialog__status')?.textContent.trim() ?? ''`);

  await check('right-click on a card opens no menu; the head has an Edit button left of the title', async () => {
    await rightClick('orders');
    await new Promise((r) => setTimeout(r, 150));
    must(!(await ev(`!!document.querySelector('.ctx-menu')`)), 'a context menu opened');
    must(await ev(`(() => { const b = ${editBtn('orders')}; return !!b && b.textContent.trim() === 'Edit' && b.nextElementSibling.classList.contains('entity__title'); })()`), 'no Edit button before the title');
    const fit = await ev(`(() => { const h = ${card('orders')}.querySelector('.entity__head'); return h.scrollWidth <= h.clientWidth; })()`);
    must(fit, 'head overflows');
    await shot('edit-sql-button.png');
  });
  await check('Edit opens a dialog on the default SELECT of every column', async () => {
    await clickEdit('orders');
    const v = await getSql();
    must(v === 'SELECT\n  `cust_id`,\n  `amount`\nFROM `shop`.`orders`', `default: ${J(v)}`);
    must((await ev(`document.querySelector('dialog[open] .dialog__title').textContent`)) === 'Edit SQL · orders', 'title');
    await shot('edit-sql-dialog.png');
  });
  await check('a query the server refuses is answered inside the dialog; the card is untouched', async () => {
    await setSql('SELECT BAD'); await press('Save');
    await waitFor(`/Syntax error/.test(document.querySelector('dialog[open] .sql-dialog__status')?.textContent ?? '')`, 'error shown');
    must(/Syntax error/.test(await errorText()), `error: ${await errorText()}`);
    must(await ev(`!!document.querySelector('dialog[open]')`), 'dialog closed');
    must(J(await cols('orders')) === J(['cust_id', 'amount']), 'columns changed');
    must(!(await ev(`${card('orders')}.classList.contains('entity--sql')`)), 'marked as sql');
  });
  await check('an empty query is refused without asking the server', async () => {
    const before = sourceCalls.length;
    await setSql('   '); await press('Save');
    must(/Write a SELECT/.test(await errorText()), `error: ${await errorText()}`);
    must(sourceCalls.length === before, 'the server was asked');
  });
  const syntaxIs = () => ev(`[...document.querySelectorAll('dialog[open] .seg input')].find((r) => r.checked)?.parentElement.textContent.trim()`);
  const pickSyntax = async (label) => { await ev(`[...document.querySelectorAll('dialog[open] .seg label')].find((l) => l.textContent.trim() === ${J(label)}).querySelector('input').click()`); await waitFor(`${cmOf}.getOption('mode') === ${J(label === 'MySQL' ? 'text/x-mysql' : 'text/x-clickhouse')} && [...document.querySelectorAll('dialog[open] .seg input')].find((r) => r.checked)?.parentElement.textContent.trim() === ${J(label)} && !${cmOf}.getOption('readOnly')`, `syntax ${label}`); };
  const statusIs = (re) => waitFor(`${re}.test(document.querySelector('dialog[open] .sql-dialog__status')?.textContent ?? '')`, `status ${re}`);
  await check('the editor is tall, shows line numbers, and highlights keywords, strings, numbers and comments', async () => {
    const h = await ev(`document.querySelector('dialog[open] .sql-dialog__editor').getBoundingClientRect().height`);
    must(h >= 400, `editor height ${h}`);
    await setSql("SELECT 'a' AS s, 12 AS n, `amount` -- note\nFROM shop.orders");
    const found = await ev(`['keyword', 'string', 'number', 'comment'].filter((c) => document.querySelector('dialog[open] .cm-' + c))`);
    must(J(found) === J(['keyword', 'string', 'number', 'comment']), `token classes: ${J(found)}`);
    must(await ev(`!!document.querySelector('dialog[open] .CodeMirror-linenumber')`), 'no line numbers');
    await shot('edit-sql-highlight.png');
  });
  await check('instant syntax checks underline the problem, mark the margin and say it in words', async () => {
    await setSql('SELECT (1 FROM t');
    await waitFor(`!!document.querySelector('dialog[open] .CodeMirror-lint-mark-error') && !!document.querySelector('dialog[open] .CodeMirror-lint-marker-error')`, 'underline and margin marker');
    await statusIs(/Line 1: This '\(' is never closed/);
    await setSql('SELECT 1; SELECT 2'); await statusIs(/extra ';'/);
    await setSql('DROP TABLE t'); await statusIs(/must start with SELECT/);
    await setSql("SELECT 1 FROM url('x')"); await statusIs(/reads outside this connection/);
    await setSql("SELECT 'open"); await statusIs(/missing its closing quote/);
    await shot('edit-sql-problem.png');
  });
  await check('a clean query is checked once with ClickHouse (debounced) and the status line reports its columns', async () => {
    const before = sourceCalls.length;
    await setSql('SELECT cust_id'); await setSql('SELECT cust_id, amount'); await setSql('SELECT cust_id, amount, extra FROM shop.orders');
    await statusIs(/Valid query · 3 columns/);
    must(sourceCalls.length === before + 1, `server checks: ${sourceCalls.length - before}`);
    await shot('edit-sql-valid.png');
  });
  await check("ClickHouse's own refusal is marked on the line it names (ClickHouse syntax)", async () => {
    await pickSyntax('ClickHouse');
    await setSql('SELECT\n  POSERR');
    await statusIs(/Line 2: Syntax error/);
    must(await ev(`!!${cmOf}.lineInfo(1).gutterMarkers?.['CodeMirror-lint-markers']`), 'no margin marker on line 2');
    must(await ev(`!${cmOf}.lineInfo(0).gutterMarkers?.['CodeMirror-lint-markers']`), 'marker on line 1');
    await pickSyntax('MySQL');
  });
  await check('the footer offers MySQL and ClickHouse syntax, MySQL first and chosen by default, with the matching highlighting', async () => {
    const labels = await ev(`[...document.querySelectorAll('dialog[open] .dialog__foot .seg label')].map((l) => l.textContent.trim())`);
    must(J(labels) === J(['MySQL', 'ClickHouse']), `labels: ${J(labels)}`);
    must(await ev(`!!document.querySelector('dialog[open] .dialog__foot .seg')`), 'switch not in the footer');
    must((await syntaxIs()) === 'MySQL', `default: ${await syntaxIs()}`);
    must((await ev(`${cmOf}.getOption('mode')`)) === 'text/x-mysql', 'mode');
    await shot('edit-sql-mysql.png');
  });
  await check('in MySQL syntax the query is translated: ClickHouse is asked about the translation, and the panel shows it', async () => {
    const my = 'SELECT IFNULL(cust_id, 0) AS cust_id, amount, extra FROM shop.orders LIMIT 1, 5';
    const before = sourceCalls.length;
    await setSql(my);
    await statusIs(/Valid query · 3 columns/);
    must(sourceCalls.length === before + 1 && /COALESCE\(cust_id, 0\)/.test(sourceCalls.at(-1).sql) && /LIMIT 5 OFFSET 1/.test(sourceCalls.at(-1).sql), `describe got: ${J(sourceCalls.at(-1))}`);
    must(await ev(`!document.querySelector('dialog[open] .sql-dialog__preview').hidden && document.querySelector('dialog[open] .sql-dialog__sql').textContent.includes('COALESCE(cust_id, 0)')`), 'panel not showing the ClickHouse SQL');
    await b.sleep(600);
    await shot('edit-sql-translated.png');
  });
  await check('switching to ClickHouse shows the translation (panel hidden, ClickHouse highlighting); switching back gives exactly the MySQL text', async () => {
    const my = await getSql();
    await pickSyntax('ClickHouse');
    must(/COALESCE\(cust_id, 0\)/.test(await getSql()) && /LIMIT 5 OFFSET 1/.test(await getSql()), `ClickHouse text: ${J(await getSql())}`);
    must((await ev(`${cmOf}.getOption('mode')`)) === 'text/x-clickhouse', 'mode');
    must(await ev(`document.querySelector('dialog[open] .sql-dialog__preview').hidden`), 'panel shown in ClickHouse syntax');
    const calls = translateCalls.length;
    await pickSyntax('MySQL');
    must((await getSql()) === my, `back: ${J(await getSql())}`);
    must(translateCalls.length === calls, 'a remembered pair asked the translator again');
  });
  await check('a ClickHouse-only query can stay in ClickHouse syntax: the switch is undone with the reason', async () => {
    await pickSyntax('ClickHouse');
    await setSql('SELECT arrayJoin(extra) AS e FROM shop.orders');
    await ev(`[...document.querySelectorAll('dialog[open] .seg label')].find((l) => l.textContent.trim() === 'MySQL').querySelector('input').click()`);
    await statusIs(/Can't convert to MySQL syntax: Part of this query has no equivalent/);
    must((await syntaxIs()) === 'ClickHouse', `syntax: ${await syntaxIs()}`);
    must((await getSql()) === 'SELECT arrayJoin(extra) AS e FROM shop.orders', 'text changed');
  });
  await check("the translator's own refusal is marked at the place it names, in the MySQL text", async () => {
    await setSql('SELECT 1'); await pickSyntax('MySQL'); // (the dialog was left in ClickHouse syntax by the refusal above)
    await setSql('SELECT a FROM t WHERE TRANSERR');
    await statusIs(/Line 1: The query looks unfinished/);
    must(await ev(`!!document.querySelector('dialog[open] .CodeMirror-lint-mark-error')`), 'no underline');
    must(await ev(`!!${cmOf}.lineInfo(0).gutterMarkers?.['CodeMirror-lint-markers']`), 'no margin marker');
  });
  await check('the matching bracket is highlighted (both ends) and a stray one is flagged', async () => {
    await setSql('SELECT (1) + 2'); await ev(`${cmOf}.setCursor({ line: 0, ch: 10 })`);
    await waitFor(`document.querySelectorAll('dialog[open] .CodeMirror-matchingbracket').length === 2`, 'matching pair');
    await setSql('SELECT 1)'); await ev(`${cmOf}.setCursor({ line: 0, ch: 9 })`);
    await waitFor(`document.querySelectorAll('dialog[open] .CodeMirror-nonmatchingbracket').length === 1`, 'stray bracket');
  });
  await check('brackets and quotes close themselves, and Enter between a pair opens it out', async () => {
    await setSql(''); await ev(`${cmOf}.focus()`);
    for (const ch of 'SELECT count(') await b.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
    must((await getSql()) === 'SELECT count()', `after "(": ${J(await getSql())}`);
    await b.send('Input.dispatchKeyEvent', { type: 'char', text: "'" });
    must((await getSql()) === "SELECT count('')", `after "'": ${J(await getSql())}`); // inside the brackets, the quote closes itself
  });
  await check('Enter keeps the indent and adds one after "(" or a clause word; ")" lines up with its "("', async () => {
    const run = (code) => ev(`(() => { const cm = ${cmOf}; ${code} })()`);
    must((await run(`cm.setValue('SELECT\\n  a,'); cm.setCursor({ line: 1, ch: 4 }); cm.getOption('extraKeys').Enter(cm); return J(cm.getValue());`.replace('J(', 'JSON.stringify('))) === J('SELECT\n  a,\n  '), 'indent not kept');
    must((await run(`cm.setValue('SELECT a\\nFROM ('); cm.setCursor({ line: 1, ch: 6 }); cm.getOption('extraKeys').Enter(cm); return JSON.stringify(cm.getValue());`)) === J('SELECT a\nFROM (\n  '), `no indent after "(": ${J(await run("return JSON.stringify(cm.getValue());"))}`);
    await run(`cm.setValue('SELECT\\n  a\\nFROM ('); cm.setCursor({ line: 2, ch: 6 }); cm.getOption('extraKeys').Enter(cm); cm.focus(); return true;`);
    await b.send('Input.dispatchKeyEvent', { type: 'char', text: ')' }); // typed for real, so CodeMirror's input events run
    must((await run(`return JSON.stringify(cm.getValue());`)) === J('SELECT\n  a\nFROM (\n)'), `closing bracket not lined up: ${J(await run("return JSON.stringify(cm.getValue());"))}`);
    must((await run(`cm.setValue('SELECT\\n'); cm.setCursor({ line: 0, ch: 6 }); cm.getOption('extraKeys').Enter(cm); return JSON.stringify(cm.getValue());`)) === J('SELECT\n  \n'), 'no indent after SELECT');
  });
  await check('Format lays the query out, keeps names as typed, and Ctrl+Z undoes it', async () => {
    const original = 'select a, count(*) as n from shop.orders where amount > 1 and region in (select region from shop.regions) group by a';
    await setSql(original);
    await ev(`[...document.querySelectorAll('dialog[open] .dialog__foot .btn')].find((x) => x.textContent.trim() === 'Format').click()`);
    await waitFor(`${cmOf}.lineCount() > 8`, 'formatted');
    const out = await getSql();
    must(/^select\n  a,\n  count\(\*\) as n\nfrom\n/.test(out), `format: ${J(out)}`); // case kept: "n" is not upper-cased
    must(/\bin \(\n/.test(out), 'subquery not opened out');
    await statusIs(/Formatted/);
    await ev(`${cmOf}.undo()`);
    must((await getSql()) === original, 'undo did not restore');
    await setSql('select ( from'); await ev(`[...document.querySelectorAll('dialog[open] .dialog__foot .btn')].find((x) => x.textContent.trim() === 'Format').click()`);
    await statusIs(/Can't format yet/);
  });
  await check('a multi-line bracket folds from the margin arrow, and unfolds', async () => {
    await setSql('SELECT a\nFROM (\n  SELECT b\n  FROM t\n) AS x');
    await waitFor(`!!document.querySelector('dialog[open] .CodeMirror-foldgutter-open')`, 'fold arrow');
    const fold = `(() => { const cm = ${cmOf}; cm.foldCode(CodeMirror.Pos(1, 0), { rangeFinder: cm.state.foldGutter.options.rangeFinder }); return cm.getAllMarks().length; })()`;
    must((await ev(fold)) === 1, 'did not fold');
    must(await ev(`!!document.querySelector('dialog[open] .CodeMirror-foldmarker')`), 'no fold marker shown');
    must((await ev(fold)) === 0, 'did not unfold');
  });
  await check('dark mode: the editor reads on the dark surface', async () => {
    await setSql("SELECT 'a' AS s, 12 AS n -- note\nFROM (SELECT 1)");
    await ev(`document.documentElement.dataset.scheme = 'dark'`); await b.sleep(400); await shot('edit-sql-dark.png');
    await ev(`delete document.documentElement.dataset.scheme`);
  });
  await check('a query that drops a relationship key is refused, naming the column', async () => {
    await setSql('SELECT noid'); await press('Save');
    await waitFor(`/relationships on this card use/.test(document.querySelector('dialog[open] .sql-dialog__status')?.textContent ?? '')`, 'key error');
    must(/“cust_id”/.test(await errorText()), `error: ${await errorText()}`);
    must(J(await cols('orders')) === J(['cust_id', 'amount']), 'columns changed');
  });
  await check('a good query swaps the card to the query\'s columns, keeps the link, and marks the card', async () => {
    await setSql('SELECT IFNULL(cust_id, 0) AS cust_id, amount, extra FROM shop.orders LIMIT 1, 5'); await press('Save');
    await waitFor(`!document.querySelector('dialog[open]')`, 'dialog closed');
    await waitFor(`${card('orders')}.classList.contains('entity--sql')`, 'card marked');
    must(J(await cols('orders')) === J(['cust_id', 'amount', 'extra']), `columns: ${J(await cols('orders'))}`);
    must((await ev(`${card('orders')}.querySelector('.entity__note--sql').textContent`)) === 'Custom SQL', 'note');
    must(await ev(`document.querySelectorAll('.rel-badge').length === 1`), 'the link went away');
    must(await ev(`${card('orders')}.querySelectorAll('.col-row__profile').length === 3`), 'a SQL card has a profile button on each column');
    must((await toastText()).includes('using your SQL'), `toast: ${await toastText()}`);
    await shot('edit-sql-applied.png');
  });
  await check('reopening Edit shows the saved query; Reset to default restores the table SELECT; Cancel keeps the query', async () => {
    await clickEdit('orders');
    must((await getSql()) === 'SELECT IFNULL(cust_id, 0) AS cust_id, amount, extra FROM shop.orders LIMIT 1, 5', `saved MySQL text not shown: ${J(await getSql())}`);
    must((await syntaxIs()) === 'MySQL', 'not opened in MySQL syntax');
    await press('Reset to default');
    await waitFor(`${cmOf}.getValue().startsWith('SELECT\\n') && ${cmOf}.getValue().includes('FROM')`, 'default restored');
    await press('Cancel');
    await waitFor(`!document.querySelector('dialog[open]')`, 'dialog closed');
    must(J(await cols('orders')) === J(['cust_id', 'amount', 'extra']), 'Cancel changed the card');
  });
  await check('a worksheet over the card sends the SQL as `sources`, and its fields are the query\'s', async () => {
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
    await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet');
    await waitFor(`[...document.querySelectorAll('#ws-fields .ws-field__name')].some((n) => n.textContent === 'extra')`, 'query column listed');
    await ev(`(() => { const c = [...document.querySelectorAll('#ws-fields .ws-field')].find((c) => c.querySelector('.ws-field__name')?.textContent === 'extra');
      const t = document.querySelector('.ws-shelf--rows .ws-shelf__zone'); const dt = new DataTransfer();
      c.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      t.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); c.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return true; })()`);
    await settle(500);
    const q = queries.findLast((x) => x.sources?.length);
    must(q && q.sources[0].kind === 'sql' && q.sources[0].name === 'orders' && q.sources[0].sql === 'SELECT COALESCE(cust_id, 0) AS cust_id, amount, extra FROM shop.orders LIMIT 5 OFFSET 1', `query: ${J(q)}`);
    must(!('source' in q), 'sent as a union source');
  });
  const openEdit = clickEdit;
  const cancelEdit = async () => { await press('Cancel'); await waitFor(`!document.querySelector('dialog[open]')`, 'closed'); };
  await check('a ClickHouse comparison that would ignore case after a MySQL round trip (the translator reports case-fold) opens in ClickHouse syntax with the warning', async () => {
    await ev(`document.querySelector('.tab--model').click()`);
    await waitFor(`!!document.querySelector('.entity')`, 'data source');
    await store(`const e = [...st.entities.values()].find((x) => x.table === 'orders'); e.customSql = "SELECT cust_id, amount, extra FROM shop.orders WHERE extra = 'abc'"; delete e.customSqlMysql; return true;`);
    await openEdit('orders');
    must((await syntaxIs()) === 'ClickHouse', `opened in ${await syntaxIs()}`);
    await statusIs(/uses ClickHouse features MySQL doesn't have/);
    await cancelEdit();
  });
  await check('a round trip that silently changes a query ClickHouse reads differently (same columns, no reported change) is caught by EXPLAIN SYNTAX', async () => {
    await store(`const e = [...st.entities.values()].find((x) => x.table === 'orders'); e.customSql = 'SELECT cust_id, amount, extra FROM shop.orders WHERE flipme = 1'; delete e.customSqlMysql; return true;`);
    await openEdit('orders');
    must((await syntaxIs()) === 'ClickHouse', `opened in ${await syntaxIs()}`);
    await statusIs(/uses ClickHouse features MySQL doesn't have/);
    await cancelEdit();
    await store(`const e = [...st.entities.values()].find((x) => x.table === 'orders'); e.customSql = 'SELECT cust_id, amount, extra FROM shop.orders WHERE amount = 1'; delete e.customSqlMysql; return true;`);
    await openEdit('orders'); // the same layout change but nothing flipped: it opens in MySQL
    must((await syntaxIs()) === 'MySQL', `a clean query opened in ${await syntaxIs()}`);
    await cancelEdit();
  });
  await check('a ClickHouse LIKE (case-sensitive) would come back as ILIKE after a MySQL round trip, so that card opens in ClickHouse syntax with the warning', async () => {
    await ev(`document.querySelector('.tab--model').click()`);
    await waitFor(`!!document.querySelector('.entity')`, 'data source');
    await store(`const e = [...st.entities.values()].find((x) => x.table === 'orders'); e.customSql = "SELECT cust_id, amount, extra FROM shop.orders WHERE extra LIKE 'A%'"; delete e.customSqlMysql; return true;`);
    await openEdit('orders');
    must((await syntaxIs()) === 'ClickHouse', `opened in ${await syntaxIs()}`);
    await statusIs(/uses ClickHouse features MySQL doesn't have/);
    must((await getSql()) === "SELECT cust_id, amount, extra FROM shop.orders WHERE extra LIKE 'A%'", 'text changed');
    await cancelEdit();
  });
  await check('a card saved in ClickHouse syntax opens in MySQL syntax (translated for display), and an untranslatable one opens in ClickHouse syntax with the reason', async () => {
    await ev(`document.querySelector('.tab--model').click()`);
    await waitFor(`!!document.querySelector('.entity')`, 'data source');
    await store(`const e = [...st.entities.values()].find((x) => x.table === 'orders'); e.customSql = 'SELECT COALESCE(cust_id, 0) AS cust_id, amount, extra FROM shop.orders LIMIT 5 OFFSET 1'; delete e.customSqlMysql; return true;`);
    await openEdit('orders');
    must((await syntaxIs()) === 'MySQL', `syntax: ${await syntaxIs()}`);
    must((await getSql()) === 'SELECT IFNULL(cust_id, 0) AS cust_id, amount, extra FROM shop.orders LIMIT 1, 5', `shown: ${J(await getSql())}`);
    await cancelEdit();
    await store(`const e = [...st.entities.values()].find((x) => x.table === 'orders'); e.customSql = 'SELECT arrayJoin(extra) AS extra FROM shop.orders'; return true;`);
    await openEdit('orders');
    must((await syntaxIs()) === 'ClickHouse', `syntax: ${await syntaxIs()}`);
    must((await getSql()) === 'SELECT arrayJoin(extra) AS extra FROM shop.orders', 'text changed');
    await statusIs(/Shown in ClickHouse syntax: Part of this query has no equivalent/);
    await cancelEdit();
  });
  await check('a ClickHouse-only query that would not survive a MySQL round trip opens in ClickHouse syntax with a warning; switching gives an approximation with a warning, and nothing is damaged', async () => {
    await store(`const e = [...st.entities.values()].find((x) => x.table === 'orders'); e.customSql = 'SELECT toDate(extra) AS d FROM shop.orders'; delete e.customSqlMysql; return true;`);
    await openEdit('orders');
    must((await syntaxIs()) === 'ClickHouse', `opened in ${await syntaxIs()}`);
    await statusIs(/uses ClickHouse features MySQL doesn't have/);
    must(await ev(`document.querySelector('dialog[open] .sql-dialog__status--warn')`) !== null, 'not a warning');
    await pickSyntax('MySQL');
    must((await getSql()) === 'SELECT TODATE(extra) AS d FROM shop.orders', `approximation: ${J(await getSql())}`);
    await statusIs(/Converted as far as MySQL allows/);
    await press('Save'); await waitFor(`!document.querySelector('dialog[open]')`, 'saved');
    must(await store(`const e = [...st.entities.values()].find((x) => x.table === 'orders'); return e.customSql === 'SELECT toDate(extra) AS d FROM shop.orders' && !('customSqlMysql' in e);`), 'saving the unchanged approximation changed the query or recorded it as written');
  });
  await check('a warning about a difference in meaning shows beside "Valid query", in MySQL syntax only, and never blocks Save', async () => {
    await store(`const e = [...st.entities.values()].find((x) => x.table === 'orders'); e.customSql = 'SELECT cust_id, amount, extra FROM shop.orders'; delete e.customSqlMysql; return true;`);
    await openEdit('orders');
    await setSql("SELECT cust_id, amount, extra FROM shop.orders WHERE extra = 'abc'");
    await statusIs(/Valid query/);
    await waitFor(`!document.querySelector('dialog[open] .sql-dialog__notes').hidden && /ignore upper.lower case/.test(document.querySelector("dialog[open] .sql-dialog__notes").textContent)`, 'warning shown');
    must(await ev(`!!document.querySelector('dialog[open] .sql-dialog__notes li .sql-dialog__glyph svg')`), 'no icon on the warning');
    await setSql('SELECT cust_id FROM shop.orders'); // typing again clears it until the new text is known
    await waitFor(`document.querySelector('dialog[open] .sql-dialog__notes').hidden`, 'warning cleared');
    await setSql("SELECT cust_id, amount, extra FROM shop.orders WHERE extra = 'abc'"); await statusIs(/Valid query/);
    await waitFor(`!document.querySelector('dialog[open] .sql-dialog__notes').hidden`, 'warning back');
    await pickSyntax('ClickHouse');
    must(await ev(`document.querySelector('dialog[open] .sql-dialog__notes').hidden`), 'warning shown in ClickHouse syntax');
    await pickSyntax('MySQL');
    await statusIs(/Valid query/);
    await press('Save'); await waitFor(`!document.querySelector('dialog[open]')`, 'saved'); // a warning is not a blocker
    must(await store(`const e = [...st.entities.values()].find((x) => x.table === 'orders'); return e.customSql.includes("lowerUTF8(toString(extra)) = lowerUTF8('abc')") && e.customSqlMysql.includes("extra = 'abc'");`), 'not saved');
  });
  await check('Save in MySQL syntax stores the ClickHouse query and keeps the MySQL text; Save in ClickHouse syntax drops the MySQL text', async () => {
    await store(`const e = [...st.entities.values()].find((x) => x.table === 'orders'); e.customSql = 'SELECT cust_id, amount, extra FROM shop.orders'; delete e.customSqlMysql; return true;`);
    await openEdit('orders');
    await setSql('SELECT IFNULL(cust_id, 0) AS cust_id, amount, extra FROM shop.orders LIMIT 2, 3'); await statusIs(/Valid query/);
    await press('Save'); await waitFor(`!document.querySelector('dialog[open]')`, 'saved');
    must(await store(`const e = [...st.entities.values()].find((x) => x.table === 'orders'); return e.customSql === 'SELECT COALESCE(cust_id, 0) AS cust_id, amount, extra FROM shop.orders LIMIT 3 OFFSET 2' && e.customSqlMysql === 'SELECT IFNULL(cust_id, 0) AS cust_id, amount, extra FROM shop.orders LIMIT 2, 3';`), 'stored values');
    await openEdit('orders'); await pickSyntax('ClickHouse');
    await setSql('SELECT cust_id, amount, extra FROM shop.orders WHERE amount > 1'); await statusIs(/Valid query/);
    await press('Save'); await waitFor(`!document.querySelector('dialog[open]')`, 'saved');
    must(await store(`const e = [...st.entities.values()].find((x) => x.table === 'orders'); return e.customSql === 'SELECT cust_id, amount, extra FROM shop.orders WHERE amount > 1' && !('customSqlMysql' in e);`), 'MySQL text kept after a ClickHouse save');
  });
  await check('without a translator on the server, MySQL syntax is switched off with the reason and the dialog carries on in ClickHouse syntax', async () => {
    await openEdit('orders');
    await setSql('SELECT NOPY FROM t'); // (the stand-in answers 503 for this text)
    await statusIs(/MySQL syntax isn't available on this server/);
    must((await syntaxIs()) === 'ClickHouse', `syntax: ${await syntaxIs()}`);
    must(await ev(`[...document.querySelectorAll('dialog[open] .seg input')].find((r) => r.parentElement.textContent.trim() === 'MySQL').disabled`), 'MySQL still selectable');
    await cancelEdit();
  });
  await check('Reset to default + Save goes back to the table: its columns return and the mark clears', async () => {
    await ev(`document.querySelector('.tab--model').click()`);
    await waitFor(`!document.getElementById('model-view')?.hidden || !!document.querySelector('.entity')`, 'data source');
    await clickEdit('orders');
    await press('Reset to default');
    await waitFor(`${cmOf}.getValue().startsWith('SELECT\\n') && ${cmOf}.getValue().includes('FROM')`, 'default restored');
    await press('Save');
    await waitFor(`!document.querySelector('dialog[open]')`, 'dialog closed');
    await waitFor(`!${card('orders')}.classList.contains('entity--sql')`, 'mark cleared');
    must(J(await cols('orders')) === J(['cust_id', 'amount']), `columns: ${J(await cols('orders'))}`);
    must(await ev(`!${card('orders')}.querySelector('.entity__note--sql')`), 'note stayed');
  });
  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log('ERROR: ' + e.message); failed++;
} finally {
  await b?.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
