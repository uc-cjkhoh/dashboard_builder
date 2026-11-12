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
  // ---- tier 2: date formats (MySQL's documented output for 2024-03-05 14:07:09.123456, a Tuesday) ----
  ...(() => {
    const dt = `CAST('2024-03-05 14:07:09.123456' AS DATETIME(6))`;
    const f = (fmt, expected, label = `DATE_FORMAT ${fmt}`, value = dt) => [label, `SELECT DATE_FORMAT(${value}, '${fmt}')`, expected];
    return [
      f('%Y-%m-%d %H:%i:%s', '2024-03-05 14:07:09'), f('%W %M %e, %Y', 'Tuesday March 5, 2024'), f('%a %b %c', 'Tue Mar 3'), f('%l:%i %p', '2:07 PM'),
      f('%h:%i:%s %p', '02:07:09 PM'), f('%r', '02:07:09 PM'), f('%T', '14:07:09'), f('%D', '5th'), f('%U %u %V %v %X %x', '09 10 09 10 2024 2024'),
      f('%j %w %y %f', '065 2 24 123456'), f('%f %e', '000000 5', 'DATE_FORMAT %f on a plain DATETIME, %e unpadded', `CAST('2024-03-05 14:07:09' AS DATETIME)`), f('%%', '%'), f('%q', 'q', 'DATE_FORMAT unknown code stands for itself'), f('%i', '07', 'DATE_FORMAT %i is minutes, not the month name'),
      f('%D', '1st', 'DATE_FORMAT %D 1st', `CAST('2024-03-01 00:00:00' AS DATETIME)`), f('%D', '22nd', 'DATE_FORMAT %D 22nd', `CAST('2024-03-22 00:00:00' AS DATETIME)`),
      f('%D', '11th', 'DATE_FORMAT %D 11th', `CAST('2024-03-11 00:00:00' AS DATETIME)`), f('%k', '4', 'DATE_FORMAT %k hour without a leading zero', `CAST('2024-03-05 04:00:00' AS DATETIME)`),
      f('%l %p', '12 AM', 'DATE_FORMAT %l at midnight', `CAST('2024-03-05 00:30:00' AS DATETIME)`), f('%V %X', '52 2024', 'DATE_FORMAT week 52 of 2024', `CAST('2024-12-30 10:00:00' AS DATETIME)`),
      f('%v %x', '01 2025', 'DATE_FORMAT week 1 of 2025', `CAST('2024-12-30 10:00:00' AS DATETIME)`),
      ['DATE_FORMAT of a text date', `SELECT DATE_FORMAT('2024-03-05', '%d.%m.%Y')`, '05.03.2024'],
      ['FROM_UNIXTIME(n, fmt)', `SELECT FROM_UNIXTIME(UNIX_TIMESTAMP('2024-01-01 12:34:56'), '%Y-%m-%d %H:%i:%s')`, '2024-01-01 12:34:56'],
      ['FROM_UNIXTIME(UNIX_TIMESTAMP(x)) round trip', `SELECT FROM_UNIXTIME(UNIX_TIMESTAMP('2024-01-01 12:34:56'))`, '2024-01-01 12:34:56'],
      ['UNIX_TIMESTAMP(date) is local midnight', `SELECT UNIX_TIMESTAMP(CAST('2024-01-01' AS DATE)) = UNIX_TIMESTAMP('2024-01-01 00:00:00')`, '1'],
      // STR_TO_DATE
      ['STR_TO_DATE with a time format', `SELECT STR_TO_DATE('05/03/2024 14:07', '%d/%m/%Y %H:%i')`, '2024-03-05 14:07:00'],
      ['STR_TO_DATE date-only is a DATE', `SELECT STR_TO_DATE('2024-03-05', '%Y-%m-%d') = CAST('2024-03-05' AS DATE)`, '1'],
      ['STR_TO_DATE month names', `SELECT STR_TO_DATE('05 Mar 2024', '%d %b %Y')`, '2024-03-05'],
      ['STR_TO_DATE %r', `SELECT STR_TO_DATE('2024-03-05 02:07:09 PM', '%Y-%m-%d %r')`, '2024-03-05 14:07:09'],
      ['STR_TO_DATE unpadded %e/%c', `SELECT STR_TO_DATE('5/3/2024', '%e/%c/%Y')`, '2024-03-05'],
      ['STR_TO_DATE of nonsense is NULL', `SELECT STR_TO_DATE('nope', '%Y-%m-%d')`, '\\N'],
      ['STR_TO_DATE %y is refused', `SELECT STR_TO_DATE('24-03-05', '%y-%m-%d')`, '(refused'],
      // LAST_DAY, JSON
      ['LAST_DAY of a text date', `SELECT LAST_DAY('2024-02-10')`, '2024-02-29'], ['LAST_DAY of a datetime', `SELECT LAST_DAY(CAST('2023-02-10 10:00:00' AS DATETIME))`, '2023-02-28'],
      ...(() => {
        const J = `'{"a":"x","n":2,"f":true,"z":null,"e":"","o":{"k":1},"arr":[10,"y"]}'`;
        const u = (path, expected, label = `JSON_UNQUOTE(JSON_EXTRACT ${path})`) => [label, `SELECT JSON_UNQUOTE(JSON_EXTRACT(${J}, '${path}'))`, expected];
        return [u('$.a', 'x'), u('$.n', '2'), u('$.f', 'true'), u('$.z', 'null'), u('$.zz', '\\N', 'JSON_UNQUOTE of a missing key is NULL'), u('$.e', '', 'JSON_UNQUOTE of an empty text'),
          u('$.arr[0]', '10'), u('$.arr[1]', 'y'), u('$.o.k', '1'),
          ['JSON_EXTRACT of a missing key is NULL', `SELECT JSON_EXTRACT(${J}, '$.zz')`, '\\N'], ['-> of a missing key is NULL', `SELECT ${J}->'$.zz'`, '\\N'], ['JSON_EXTRACT of JSON null is the text null', `SELECT JSON_EXTRACT(${J}, '$.z')`, 'null'],
          ['->> operator', `SELECT ${J}->>'$.a'`, 'x'], ['->> of a number', `SELECT ${J}->>'$.n'`, '2'], ['JSON_VALUE of a number', `SELECT JSON_VALUE(${J}, '$.n')`, '2'],
          ['JSON_EXTRACT keeps the quotes of a text', `SELECT JSON_EXTRACT(${J}, '$.a')`, '"x"'], ['JSON_EXTRACT of a number', `SELECT JSON_EXTRACT(${J}, '$.n')`, '2'],
          ['JSON wildcard path is refused', `SELECT ${J}->>'$.arr[*]'`, '(refused']];
      })(),
      // dates as text, intervals
      ['DATEDIFF of text dates', `SELECT DATEDIFF('2024-01-10', '2024-01-01')`, '9'], ['TIMESTAMPDIFF of text dates', `SELECT TIMESTAMPDIFF(DAY, '2024-01-01', '2024-01-10 10:00:00')`, '9'],
      ['TIMESTAMPDIFF MICROSECOND', `SELECT TIMESTAMPDIFF(MICROSECOND, CAST('2024-01-01 10:00:00.000100' AS DATETIME(6)), CAST('2024-01-01 10:00:00.000350' AS DATETIME(6)))`, '250'],
      ['DATE_ADD of a text date', `SELECT DATE_ADD('2024-01-31', INTERVAL 1 DAY)`, '2024-02-01'],
      ['DATE_ADD with a column as the amount', `SELECT DATE_ADD(CAST('2024-01-31' AS DATE), INTERVAL number DAY) FROM system.numbers WHERE number = 2 LIMIT 1`, '2024-02-02'],
      ['INTERVAL with a column amount', `SELECT CAST('2024-01-31' AS DATE) + INTERVAL number MONTH FROM system.numbers WHERE number = 1 LIMIT 1`, '2024-02-29'],
      ['YEAR_MONTH clamps the month end once (Feb 29 + 1y2m)', `SELECT DATE_ADD(CAST('2024-02-29' AS DATE), INTERVAL '1-2' YEAR_MONTH)`, '2025-04-29'],
      ['YEAR_MONTH subtract', `SELECT DATE_SUB(CAST('2024-03-31' AS DATE), INTERVAL '1-1' YEAR_MONTH)`, '2023-02-28'], ['YEAR_MONTH negative', `SELECT DATE_ADD(CAST('2024-03-31' AS DATE), INTERVAL '-1-2' YEAR_MONTH)`, '2023-01-31'],
      ['DAY_MINUTE', `SELECT DATE_ADD(CAST('2024-01-31 10:00:00' AS DATETIME), INTERVAL '1 02:03' DAY_MINUTE)`, '2024-02-01 12:03:00'],
      ['DAY_HOUR with a short value leaves out the days', `SELECT DATE_ADD(CAST('2024-01-31 10:00:00' AS DATETIME), INTERVAL '5' DAY_HOUR)`, '2024-01-31 15:00:00'],
      ['HOUR_MINUTE as an operator', `SELECT CAST('2024-01-31 10:00:00' AS DATETIME) + INTERVAL '02:03' HOUR_MINUTE`, '2024-01-31 12:03:00'],
      // LIKE ... ESCAPE, modifiers, hints
      ['LIKE ESCAPE: escaped underscore matches itself', `SELECT 'a_b' LIKE 'a#_b' ESCAPE '#'`, '1'], ['LIKE ESCAPE: ... and not another character', `SELECT 'axb' LIKE 'a#_b' ESCAPE '#'`, '0'],
      ['LIKE ESCAPE: escaped percent', `SELECT '50%' LIKE '50#%' ESCAPE '#'`, '1'], ['LIKE ESCAPE: ... not a wildcard', `SELECT '500' LIKE '50#%' ESCAPE '#'`, '0'],
      ['LIKE ESCAPE: a backslash is an ordinary character', String.raw`SELECT 'a\\b' LIKE 'a\\b' ESCAPE '#'`, '1'],
      ['SQL_CALC_FOUND_ROWS is dropped', `SELECT count() FROM (SELECT SQL_CALC_FOUND_ROWS number FROM numbers(5) LIMIT 2) AS s`, '2'],
      ['STRAIGHT_JOIN is an inner join', `SELECT count() FROM numbers(3) AS a STRAIGHT_JOIN numbers(3) AS b ON a.number = b.number`, '3'],
      ['FOR UPDATE is dropped', `SELECT number FROM numbers(1) FOR UPDATE`, '0'],
      ['WITH RECURSIVE (ClickHouse 26.8)', `WITH RECURSIVE c AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM c WHERE n < 5) SELECT sum(n) FROM c`, '15'],
      ['a user variable is refused', `SELECT @x := 1`, '(refused'], ['a system variable is refused', `SELECT @@sql_mode`, '(refused'],
    ];
  })(),
  ['ORDER BY puts NULL first (ascending)', "SELECT x FROM (SELECT 1 AS x UNION ALL SELECT NULL UNION ALL SELECT 0) ORDER BY x LIMIT 1", '\\N'],
];
let failed = 0;
console.log('Part 1 — MySQL -> ClickHouse (the translated SQL must return what MySQL returns)');
for (const [label, mysql, expected] of cases) {
  const r = await translate(mysql, 'mysql', 'clickhouse');
  let got;
  if (!r.ok) got = `(refused: ${r.error})`;
  else { try { got = (await ch(r.sql)).split('\n')[0]; } catch (e) { got = `(ClickHouse: ${e.message})`; } }
  const ok = String(expected).startsWith('(refused') ? got.startsWith('(refused') : got === expected;
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
  "SELECT formatDateTime(metadata_modification_time, '%Y-%m') AS m FROM system.tables LIMIT 3",
  "SELECT dateDiff('day', metadata_modification_time, now()) AS age_days FROM system.tables LIMIT 3",
  'SELECT metadata_modification_time + INTERVAL 1 DAY AS d FROM system.tables LIMIT 3',
  "SELECT formatDateTime(metadata_modification_time, '%H:%i') AS hm FROM system.tables LIMIT 3",
  "SELECT formatDateTime(metadata_modification_time, '%M') AS month_name FROM system.tables LIMIT 3",
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
