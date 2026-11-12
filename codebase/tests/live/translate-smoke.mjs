// Smoke test of the MySQL <-> ClickHouse translator (D106) against a real ClickHouse server: run it after upgrading ClickHouse or sqlglot, and before a deploy
// that touches Tools/sql_translate.py. The browser tests mock the translator and the .NET tests pin its text; only this one asks the server whether the SQL it
// writes still MEANS what MySQL's rules say. Read-only: SELECT, DESCRIBE and EXPLAIN SYNTAX on system tables.
//
//   CH_HOST=… CH_PORT=8443 CH_USER=… CH_PASSWORD=… NODE_EXTRA_CA_CERTS=/path/to/ca.pem node tests/live/translate-smoke.mjs
//   (env as for calc-smoke.mjs; the password is never printed; PYTHON overrides python3; set PLAIN_HTTP=1 for http://)
//
// Part 1 — MySQL -> ClickHouse: each case's translated SQL must return the value MySQL's documented rules give (not run on MySQL: there is none). Exit 1 on any difference.
// Part 2 — ClickHouse -> MySQL -> ClickHouse: how many typical ClickHouse queries the dialog would open in MySQL syntax (round trip kept) and why the others open in
//          ClickHouse syntax. Informational: the false-alarm rate is a number to watch, not a failure.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { meaningKept } from '../../src/DashboardBuilder/Features/Core/sql-roundtrip.js';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
if (!CH_HOST || !CH_PORT || !CH_USER || CH_PASSWORD === undefined) { console.error('set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (and NODE_EXTRA_CA_CERTS for a private CA)'); process.exit(2); }
const SCRIPT = fileURLToPath(new URL('../../src/DashboardBuilder/Tools/sql_translate.py', import.meta.url));
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');
const base = `${process.env.PLAIN_HTTP ? 'http' : 'https'}://${CH_HOST}:${CH_PORT}/`;

async function ch(sql) { // one statement, TSV; the server's own guards (readonly=2, 12 s) as in the app
  const res = await fetch(`${base}?default_format=TSV&readonly=2&max_execution_time=12`, { method: 'POST', headers: { Authorization: auth }, body: sql, signal: AbortSignal.timeout(30000) });
  const text = (await res.text()).replace(/\n$/, '');
  if (!res.ok) throw new Error(text.split('\n')[0].slice(0, 200));
  return text;
}
function translate(sql, from, to) { // the real script, as the server starts it: python3 -I, the request on stdin, one JSON answer on stdout
  return new Promise((resolve) => {
    const child = spawn(process.env.PYTHON ?? 'python3', ['-I', SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'], timeout: 20000 });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve({ ok: false, error: 'python3 did not start' }));
    child.on('close', () => { try { resolve(JSON.parse(out)); } catch { resolve({ ok: false, error: 'translator gave no answer' }); } });
    child.stdin.end(JSON.stringify({ sql, from, to }));
  });
}
const columnsOf = async (sql) => { try { return (await ch(`DESCRIBE TABLE (${sql})`)).split('\n').map((l) => { const [name, type] = l.split('\t'); return { name, type }; }); } catch { return null; } };
const syntaxOf = async (sql) => { try { return (await ch(`EXPLAIN SYNTAX ${sql}`)).replace(/\\n/g, '\n').replace(/\\'/g, "'"); } catch { return null; } };

console.log(`server ${(await ch('SELECT version()'))} · translator ${SCRIPT.split('/').slice(-3).join('/')}\n`);

// ---- Part 1 --------------------------------------------------------------------------------------------------------------------------------------------------
const D = (s) => `CAST('${s}' AS DATE)`, T = (s) => `CAST('${s}' AS DATETIME)`;
const dbCount = await ch('SELECT count() FROM system.databases');
const cases = [
  ['DATEDIFF a-b in days', `SELECT DATEDIFF(${D('2024-01-10')}, ${D('2024-01-01')})`, '9'],
  ['DATEDIFF negative', `SELECT DATEDIFF(${D('2024-01-01')}, ${D('2024-01-10')})`, '-9'],
  ['DATEDIFF ignores the time part', `SELECT DATEDIFF(${T('2024-01-02 00:01:00')}, ${T('2024-01-01 23:59:00')})`, '1'],
  ['TIMESTAMPDIFF HOUR 10:59->11:01 (whole hours)', `SELECT TIMESTAMPDIFF(HOUR, ${T('2024-01-01 10:59:00')}, ${T('2024-01-01 11:01:00')})`, '0'],
  ['TIMESTAMPDIFF HOUR 10:00->12:30', `SELECT TIMESTAMPDIFF(HOUR, ${T('2024-01-01 10:00:00')}, ${T('2024-01-01 12:30:00')})`, '2'],
  ['TIMESTAMPDIFF HOUR negative (truncates toward zero)', `SELECT TIMESTAMPDIFF(HOUR, ${T('2024-01-01 12:30:00')}, ${T('2024-01-01 11:00:00')})`, '-1'],
  ['TIMESTAMPDIFF MINUTE', `SELECT TIMESTAMPDIFF(MINUTE, ${T('2024-01-01 10:59:30')}, ${T('2024-01-01 11:01:00')})`, '1'],
  ['TIMESTAMPDIFF SECOND', `SELECT TIMESTAMPDIFF(SECOND, ${T('2024-01-01 10:59:30')}, ${T('2024-01-01 11:01:00')})`, '90'],
  ['TIMESTAMPDIFF DAY (whole days)', `SELECT TIMESTAMPDIFF(DAY, ${T('2024-01-01 10:00:00')}, ${T('2024-01-02 09:00:00')})`, '0'],
  ['TIMESTAMPDIFF WEEK', `SELECT TIMESTAMPDIFF(WEEK, ${D('2024-01-01')}, ${D('2024-01-14')})`, '1'],
  ['TIMESTAMPDIFF MONTH 01-31->02-29', `SELECT TIMESTAMPDIFF(MONTH, ${D('2024-01-31')}, ${D('2024-02-29')})`, '0'],
  ['TIMESTAMPDIFF MONTH 01-31->03-31', `SELECT TIMESTAMPDIFF(MONTH, ${D('2024-01-31')}, ${D('2024-03-31')})`, '2'],
  ['TIMESTAMPDIFF QUARTER', `SELECT TIMESTAMPDIFF(QUARTER, ${D('2024-01-01')}, ${D('2024-06-30')})`, '1'],
  ['TIMESTAMPDIFF YEAR 2023-03-01->2024-02-29', `SELECT TIMESTAMPDIFF(YEAR, ${D('2023-03-01')}, ${D('2024-02-29')})`, '0'],
  ['DATE_ADD month end', `SELECT DATE_ADD(${D('2024-01-31')}, INTERVAL 1 MONTH)`, '2024-02-29'],
  ['DATE_SUB day', `SELECT DATE_SUB(${D('2024-03-01')}, INTERVAL 1 DAY)`, '2024-02-29'],
  ['LIKE ignores case', "SELECT 'abc' LIKE 'A%'", '1'],
  ['NOT LIKE ignores case', "SELECT 'abc' NOT LIKE 'A%'", '0'],
  ['LIKE ignores case beyond ASCII', "SELECT 'élan' LIKE 'É%'", '1'],
  ['= ignores case', "SELECT name FROM system.databases WHERE name = 'SYSTEM'", 'system'],
  ['<> ignores case', `SELECT count() FROM system.databases WHERE name <> 'SYSTEM'`, String(Number(dbCount) - 1)],
  ['literal on the left', "SELECT name FROM system.databases WHERE 'SYSTEM' = name", 'system'],
  ['IN ignores case', "SELECT name FROM system.databases WHERE name IN ('SYSTEM', 'No_Such_Db')", 'system'],
  ['NOT IN ignores case', `SELECT count() FROM system.databases WHERE name NOT IN ('SYSTEM', 'No_Such_Db')`, String(Number(dbCount) - 1)],
  ['= on a non-text column still works', "SELECT dummy FROM system.one WHERE dummy = '0'", '0'],
  ['= on an Enum column', "SELECT count() FROM system.settings WHERE type = 'bool'", await ch("SELECT count() FROM system.settings WHERE type = 'Bool'")],
  ['DIV by zero is NULL', 'SELECT 5 DIV 0', '\\N'],
  ['/ by zero is NULL', 'SELECT 5 / 0', '\\N'],
  ['% by zero is NULL', 'SELECT 5 % 0', '\\N'],
  ['DIV', 'SELECT 7 DIV 2', '3'],
  ['ORDER BY puts NULL first (ascending)', "SELECT x FROM (SELECT 1 AS x UNION ALL SELECT NULL UNION ALL SELECT 0) ORDER BY x LIMIT 1", '\\N'],
];
let failed = 0;
console.log('Part 1 — MySQL -> ClickHouse (the translated SQL must return what MySQL returns)');
for (const [label, mysql, expected] of cases) {
  const r = await translate(mysql, 'mysql', 'clickhouse');
  let got;
  if (!r.ok) got = `(refused: ${r.error})`;
  else { try { got = (await ch(r.sql)).split('\n')[0]; } catch (e) { got = `(ClickHouse: ${e.message})`; } }
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'ok       ' : 'DIFFERENT'} ${label.padEnd(52)} MySQL ${String(expected).padEnd(11)} ClickHouse ${got}${ok ? '' : `\n          ${r.sql ?? ''}`}`);
}
// the canary for the fault that made hours go through elapsed seconds: say so if a newer server has fixed age('hour')
const hourAge = await ch("SELECT age('hour', toDateTime('2024-01-01 10:59:00'), toDateTime('2024-01-01 11:01:00'))");
console.log(`\nnote: age('hour', 10:59 -> 11:01) is ${hourAge} on this server (MySQL counts 0 whole hours)${hourAge === '0' ? ' — age() looks correct for hours here; the elapsed-seconds form is still right' : ' — age() is NOT usable for hours here; the translator uses elapsed seconds'}`);

// ---- Part 2 --------------------------------------------------------------------------------------------------------------------------------------------------
const typical = [
  "SELECT name, engine FROM system.tables WHERE database = 'system' LIMIT 5",
  'SELECT count() FROM system.tables',
  'SELECT database, count() AS n FROM system.tables GROUP BY database ORDER BY n DESC LIMIT 3',
  "SELECT ifNull(engine, 'none') AS e FROM system.tables LIMIT 3",
  "SELECT name FROM system.databases WHERE name IN ('system', 'default')",
  "SELECT name FROM system.databases WHERE name LIKE 's%'",
  'SELECT name, toDate(metadata_modification_time) AS d FROM system.tables LIMIT 3',
  'SELECT uniq(database) FROM system.tables',
  "SELECT name FROM system.tables WHERE database != 'system' ORDER BY name LIMIT 5",
  'SELECT database, sum(total_rows) AS rows FROM system.tables GROUP BY database HAVING rows > 0 ORDER BY rows DESC LIMIT 3',
  "SELECT name FROM system.tables WHERE total_rows > 10 AND database = 'system'",
  'SELECT DISTINCT engine FROM system.tables',
  'SELECT a.name FROM system.tables AS a INNER JOIN system.databases AS b ON a.database = b.name LIMIT 3',
  'SELECT name, round(total_bytes / 1024, 2) AS kb FROM system.tables WHERE total_bytes IS NOT NULL LIMIT 3',
  "SELECT count() FROM system.tables WHERE database NOT IN ('system', 'INFORMATION_SCHEMA')",
  'SELECT name FROM system.tables WHERE database = currentDatabase()',
  'SELECT name FROM system.tables ORDER BY name LIMIT 5',
  'SELECT dummy FROM system.one',
  'SELECT a, b FROM (SELECT 1 AS a, 2 AS b)',
];
console.log('\nPart 2 — ClickHouse -> MySQL -> ClickHouse: would the dialog open each query in MySQL syntax?');
const tally = {};
for (const q of typical) {
  const toMy = await translate(q, 'clickhouse', 'mysql');
  let v;
  if (!toMy.ok) v = { kept: false, reason: 'no MySQL form' };
  else {
    const back = await translate(toMy.sql, 'mysql', 'clickhouse');
    if (!back.ok) v = { kept: false, reason: 'no way back' };
    else if (back.sql === q) v = meaningKept({ ch: q, back: back.sql });
    else {
      const [cb, ca] = await Promise.all([columnsOf(q), columnsOf(back.sql)]);
      const [sb, sa] = cb && ca ? await Promise.all([syntaxOf(q), syntaxOf(back.sql)]) : [null, null];
      v = meaningKept({ ch: q, back: back.sql, changes: back.changes, columnsBefore: cb, columnsAfter: ca, syntaxBefore: sb, syntaxAfter: sa });
    }
  }
  tally[v.reason] = (tally[v.reason] ?? 0) + 1;
  console.log(`${v.kept ? 'MySQL     ' : 'ClickHouse'}  ${v.reason.padEnd(13)} ${q}`);
}
const kept = typical.length - Object.entries(tally).filter(([k]) => !['same', 'ok', 'ok-no-explain'].includes(k)).reduce((n, [, c]) => n + c, 0);
console.log(`\n${kept} of ${typical.length} open in MySQL syntax; the rest open in ClickHouse syntax with a note (${Object.entries(tally).map(([k, c]) => `${k}: ${c}`).join(', ')})`);
console.log(failed ? `\n${failed} case(s) DIFFERENT from MySQL` : '\nall Part 1 cases match MySQL');
process.exit(failed ? 1 : 0);
