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
function translate(sql, from, to, fold) { // the real script, as the server starts it: python3 -I, the request on stdin, one JSON answer on stdout
  return new Promise((resolve) => {
    const child = spawn(process.env.PYTHON ?? 'python3', ['-I', SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'], timeout: 20000 });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve({ ok: false, error: 'python3 did not start' }));
    child.on('close', () => { try { resolve(JSON.parse(out)); } catch { resolve({ ok: false, error: 'translator gave no answer' }); } });
    child.stdin.end(JSON.stringify({ sql, from, to, ...(fold ? { fold } : {}) }));
  });
}
const columnsOf = async (sql) => { try { return (await ch(`DESCRIBE TABLE (${sql})`)).split('\n').map((l) => { const [name, type] = l.split('\t'); return { name, type }; }); } catch { return null; } };
const syntaxOf = async (sql) => { try { return (await ch(`EXPLAIN SYNTAX ${sql}`)).replace(/\\n/g, '\n').replace(/\\'/g, "'"); } catch { return null; } };

// MySQL -> ClickHouse as the app does it: `col = col` comparisons come back as probes, ClickHouse describes the two columns, and the pairs that are both text are folded (SqlController).
const isText = (t) => { let x = t.trim(); while (/^(Nullable|LowCardinality)\(/.test(x)) x = x.replace(/^[A-Za-z]+\(/, '').slice(0, -1).trim(); return x === 'String' || /^(FixedString|Enum8|Enum16)\(/.test(x); };
async function translateTyped(sql) {
  const first = await translate(sql, 'mysql', 'clickhouse');
  if (!first.ok || !first.probes?.length) return first;
  const text = [];
  for (const p of first.probes) { const cols = await columnsOf(p.sql); if (cols?.length === 2 && cols.every((c) => isText(c.type))) text.push(p.id); }
  return text.length ? translate(sql, 'mysql', 'clickhouse', text) : first;
}
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
      ['STR_TO_DATE unpadded month and day', `SELECT STR_TO_DATE('2024-3-5', '%Y-%m-%d') = CAST('2024-03-05' AS DATE)`, '1'],
      ['STR_TO_DATE padded month and day', `SELECT STR_TO_DATE('2024-03-05', '%Y-%m-%d') = CAST('2024-03-05' AS DATE)`, '1'],
      ['STR_TO_DATE unpadded hour', `SELECT STR_TO_DATE('2024-03-05 7:05', '%Y-%m-%d %H:%i')`, '2024-03-05 07:05:00'],
      ['STR_TO_DATE unpadded 12-hour %r', `SELECT STR_TO_DATE('2024-03-05 2:07:09 PM', '%Y-%m-%d %r')`, '2024-03-05 14:07:09'],
      ['STR_TO_DATE %T with a date', `SELECT STR_TO_DATE('2024-03-05 07:05:09', '%Y-%m-%d %T')`, '2024-03-05 07:05:09'],
      ['STR_TO_DATE of only a time is refused (MySQL answers a TIME)', `SELECT STR_TO_DATE('07:05:09', '%T')`, '(refused'],
      ['STR_TO_DATE touching codes %Y%m%d', `SELECT STR_TO_DATE('20240305', '%Y%m%d') = CAST('2024-03-05' AS DATE)`, '1'],
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
  // ---- common MySQL functions (MySQL's documented results) ----
  ...(() => {
    const c = (label, sql, expected) => [`fn: ${label}`, `SELECT ${sql}`, expected];
    const D = `'2024-03-05'`, DT = `'2024-03-05 14:07:09'`;
    return [
      c('CONCAT', `CONCAT('a', 'b', 'c')`, 'abc'), c('CONCAT with NULL is NULL', `CONCAT('a', NULL)`, '\\N'), c('CONCAT_WS skips NULL', `CONCAT_WS('-', 'a', NULL, 'b')`, 'a-b'), c('CONCAT_WS single', `CONCAT_WS(',', 'x')`, 'x'),
      c('LENGTH counts bytes', `LENGTH('héllo')`, '6'), c('CHAR_LENGTH counts characters', `CHAR_LENGTH('héllo')`, '5'), c('UPPER LOWER non-ASCII', `CONCAT(UPPER('aé'), '|', LOWER('AÉ'))`, 'AÉ|aé'),
      c('TRIM LTRIM RTRIM', `CONCAT('[', TRIM('  a  '), LTRIM('  a'), RTRIM('a  '), ']')`, '[aaa]'), c('LEFT RIGHT', `CONCAT(LEFT('abcdef', 2), '|', RIGHT('abcdef', 2))`, 'ab|ef'),
      c('SUBSTRING', `SUBSTRING('abcdef', 2, 3)`, 'bcd'), c('SUBSTR negative start', `SUBSTR('abcdef', -3)`, 'def'), c('MID', `MID('abcdef', 2, 2)`, 'bc'), c('SUBSTRING FROM', `SUBSTRING('abcdef' FROM 3)`, 'cdef'),
      c('SUBSTRING_INDEX 2', `SUBSTRING_INDEX('a,b,c', ',', 2)`, 'a,b'), c('SUBSTRING_INDEX -1', `SUBSTRING_INDEX('a,b,c', ',', -1)`, 'c'),
      c('REPLACE', `REPLACE('abcabc', 'b', 'X')`, 'aXcaXc'), c('REVERSE', `REVERSE('abc')`, 'cba'), c('REPEAT', `REPEAT('ab', 3)`, 'ababab'),
      c('LPAD', `LPAD('5', 3, '0')`, '005'), c('RPAD', `RPAD('5', 3, '0')`, '500'), c('LPAD truncates', `LPAD('abcdef', 3, '0')`, 'abc'),
      c('LOCATE', `LOCATE('b', 'abcb')`, '2'), c('LOCATE from', `LOCATE('b', 'abcb', 3)`, '4'), c('INSTR', `INSTR('abc', 'b')`, '2'), c('POSITION IN', `POSITION('b' IN 'abc')`, '2'),
      c('FIND_IN_SET', `FIND_IN_SET('b', 'a,b,c')`, '2'), c('FIND_IN_SET missing', `FIND_IN_SET('z', 'a,b')`, '0'), c('FIELD', `FIELD('b', 'a', 'b', 'c')`, '2'), c('ELT', `ELT(2, 'a', 'b', 'c')`, 'b'),
      c('REGEXP', `'abc' REGEXP '^a'`, '1'), c('RLIKE no match', `'abc' RLIKE 'z'`, '0'), c('REGEXP ignores case', `'abc' REGEXP '^A'`, '1'), c('REGEXP_LIKE ignores case', `REGEXP_LIKE('abc', '^A')`, '1'),
      c('REGEXP_REPLACE', `REGEXP_REPLACE('abc123', '[0-9]+', '#')`, 'abc#'), c('REGEXP_SUBSTR', `REGEXP_SUBSTR('abc123', '[0-9]+')`, '123'),
      c('ASCII', `ASCII('A')`, '65'), c('HEX number', `HEX(255)`, 'FF'), c('HEX text', `HEX('abc')`, '616263'), c('UNHEX', `UNHEX('4D')`, 'M'), c('FORMAT is refused (no thousands separator in ClickHouse)', `FORMAT(1234.567, 2)`, '(refused'), c('STRCMP', `STRCMP('a', 'b')`, '-1'),
      c('MD5 is a hex text', `MD5('a')`, '0cc175b9c0f1b6a831c399e269772661'), c('SHA1 is a hex text', `SHA1('a')`, '86f7e437faa5a7fce15d1ddcb9eaeaea377667b8'), c('CAST AS CHAR', `CAST(5 AS CHAR)`, '5'),
      c('ABS', `ABS(-5)`, '5'), c('CEIL', `CEIL(1.2)`, '2'), c('CEILING', `CEILING(1.2)`, '2'), c('FLOOR negative', `FLOOR(-1.2)`, '-2'), c('ROUND half away from zero', `ROUND(2.5)`, '3'), c('ROUND negative half', `ROUND(-2.5)`, '-3'),
      c('ROUND digits', `ROUND(2.567, 1)`, '2.6'), c('ROUND negative digits', `ROUND(1234.567, -2)`, '1200'), c('TRUNCATE', `TRUNCATE(1.999, 1)`, '1.9'), c('TRUNCATE negative number', `TRUNCATE(-1.999, 1)`, '-1.9'), c('TRUNCATE negative digits', `TRUNCATE(1234, -2)`, '1200'),
      c('MOD()', `MOD(10, 3)`, '1'), c('MOD operator', `10 MOD 3`, '1'), c('% sign follows the dividend', `-7 % 3`, '-1'), c('POW', `POW(2, 3)`, '8'), c('POWER', `POWER(2, 3)`, '8'), c('SQRT', `SQRT(16)`, '4'),
      c('LOG base', `LOG(10, 100)`, '2'), c('LOG10', `LOG10(100)`, '2'), c('LOG2', `LOG2(8)`, '3'), c('LN', `LN(1)`, '0'), c('EXP', `EXP(0)`, '1'), c('SIGN', `SIGN(-5)`, '-1'), c('PI rounded', `ROUND(PI(), 3)`, '3.142'),
      c('GREATEST', `GREATEST(1, 3, 2)`, '3'), c('LEAST', `LEAST(1, 3, 2)`, '1'), c('GREATEST with NULL is NULL', `GREATEST(1, NULL, 2)`, '\\N'), c('LEAST with NULL is NULL', `LEAST(1, NULL, 2)`, '\\N'),
      c('BIT_COUNT', `BIT_COUNT(255)`, '8'), c('bit and', `5 & 3`, '1'), c('bit or', `5 | 3`, '7'), c('bit xor', `5 ^ 3`, '6'), c('shift left', `1 << 3`, '8'), c('shift right', `16 >> 2`, '4'), c('~ is unsigned 64-bit', `~5`, '18446744073709551610'),
      c('IF', `IF(1 > 0, 'a', 'b')`, 'a'), c('IF NULL is false', `IF(NULL, 'a', 'b')`, 'b'), c('IFNULL', `IFNULL(NULL, 'x')`, 'x'), c('NULLIF', `NULLIF(1, 1)`, '\\N'), c('ISNULL', `ISNULL(NULL)`, '1'),
      c('<=> both NULL', `NULL <=> NULL`, '1'), c('<=> NULL and 1', `1 <=> NULL`, '0'), c('COALESCE', `COALESCE(NULL, NULL, 3)`, '3'), c('CASE', `CASE WHEN 1 > 2 THEN 'a' WHEN 2 > 1 THEN 'b' END`, 'b'),
      c('IN', `1 IN (1, 2)`, '1'), c('NOT IN', `3 NOT IN (1, 2)`, '1'), c('BETWEEN', `5 BETWEEN 1 AND 10`, '1'), c('NULL IN is NULL', `NULL IN (1, 2)`, '\\N'), c('TRUE + TRUE', `TRUE + TRUE`, '2'), c('XOR', `1 XOR 0`, '1'), c('NOT', `NOT 1`, '0'), c('! operator', `!1`, '0'),
      c('COUNT(*)', `COUNT(*) FROM numbers(5)`, '5'), c('SUM', `SUM(number) FROM numbers(5)`, '10'), c('AVG', `AVG(number) FROM numbers(5)`, '2'), c('MIN MAX', `CONCAT(MIN(number), MAX(number)) FROM numbers(5)`, '04'),
      c('GROUP_CONCAT ORDER BY SEPARATOR', `GROUP_CONCAT(number ORDER BY number SEPARATOR ',') FROM numbers(5)`, '0,1,2,3,4'), c('COUNT DISTINCT', `COUNT(DISTINCT number % 2) FROM numbers(5)`, '2'),
      c('STDDEV_POP', `STDDEV_POP(number) FROM numbers(5)`, '1.4142135623730951'), c('VAR_POP', `VAR_POP(number) FROM numbers(5)`, '2'), c('VARIANCE', `VARIANCE(number) FROM numbers(5)`, '2'), c('STD', `STD(number) FROM numbers(5)`, '1.4142135623730951'),
      c('DATE()', `DATE(${DT})`, '2024-03-05'), c('YEAR of text', `YEAR(${D})`, '2024'), c('MONTH of text', `MONTH(${D})`, '3'), c('DAY of text', `DAY(${D})`, '5'), c('DAYOFMONTH', `DAYOFMONTH(${D})`, '5'),
      c('DAYOFWEEK Sunday=1', `DAYOFWEEK(${D})`, '3'), c('WEEKDAY Monday=0', `WEEKDAY(${D})`, '1'), c('DAYOFYEAR', `DAYOFYEAR(${D})`, '65'), c('WEEK', `WEEK(${D})`, '9'), c('WEEKOFYEAR', `WEEKOFYEAR(${D})`, '10'), c('YEARWEEK', `YEARWEEK(${D})`, '202409'),
      c('QUARTER', `QUARTER(${D})`, '1'), c('HOUR of text', `HOUR(${DT})`, '14'), c('MINUTE of text', `MINUTE(${DT})`, '7'), c('SECOND of text', `SECOND(${DT})`, '9'), c('MONTHNAME', `MONTHNAME(${D})`, 'March'), c('DAYNAME', `DAYNAME(${D})`, 'Tuesday'),
      c('ADDDATE days', `ADDDATE('2024-01-31', 1)`, '2024-02-01'), c('ADDDATE interval', `ADDDATE('2024-01-31', INTERVAL 1 MONTH)`, '2024-02-29'), c('SUBDATE days', `SUBDATE('2024-03-01', 1)`, '2024-02-29'),
      c('TO_DAYS', `TO_DAYS(${D})`, '739315'), c('FROM_DAYS', `FROM_DAYS(739315)`, '2024-03-05'), c('EXTRACT YEAR', `EXTRACT(YEAR FROM ${D})`, '2024'), c('EXTRACT MONTH', `EXTRACT(MONTH FROM ${D})`, '3'),
      c('TIMESTAMP()', `TIMESTAMP(${D})`, '2024-03-05 00:00:00'), c('MAKEDATE', `MAKEDATE(2024, 60)`, '2024-02-29'), c('TIMESTAMPADD', `TIMESTAMPADD(DAY, 1, '2024-01-31')`, '2024-02-01'),
      c('CURDATE = CURRENT_DATE', `CURDATE() = CURRENT_DATE`, '1'), c('NOW is after 2020', `NOW() >= CAST('2020-01-01' AS DATETIME)`, '1'),
      // ---- edge cases of the mapped functions: NULL columns, signs, case, ordering ----
      c('CONCAT_WS skips a NULL column', `CONCAT_WS('-', a, b, c) FROM (SELECT 'x' AS a, NULL AS b, 'z' AS c) t`, 'x-z'), c('CONCAT_WS of numbers', `CONCAT_WS(',', 1, 2.5, 'a')`, '1,2.5,a'),
      c('GREATEST with a NULL column', `GREATEST(a, b) FROM (SELECT 1 AS a, NULL AS b) t`, '\\N'), c('LEAST of text', `LEAST('b', 'a', 'c')`, 'a'),
      c('FIND_IN_SET ignores case', `FIND_IN_SET('B', 'a,b,c')`, '2'), c('FIND_IN_SET with NULL is NULL', `FIND_IN_SET(a, 'a,b') FROM (SELECT NULL AS a) t`, '\\N'),
      c('FIELD with NULL is 0', `FIELD(a, 'a', 'b') FROM (SELECT NULL AS a) t`, '0'), c('FIELD ignores case', `FIELD('B', 'a', 'b')`, '2'), c('FIELD numbers', `FIELD(3, 1, 2, 3)`, '3'),
      c('ELT out of range is NULL', `ELT(5, 'a', 'b')`, '\\N'), c('ELT zero is NULL', `ELT(0, 'a', 'b')`, '\\N'),
      c('STRCMP ignores case, less', `STRCMP('a', 'B')`, '-1'), c('STRCMP ignores case, equal', `STRCMP('A', 'a')`, '0'), c('STRCMP greater', `STRCMP('b', 'a')`, '1'), c('STRCMP with NULL is NULL', `STRCMP(a, 'a') FROM (SELECT NULL AS a) t`, '\\N'),
      c('LOWER(x) = upper-case text', `LOWER('abc') = 'ABC'`, '1'), c('UPPER(x) = lower-case text', `UPPER('abc') = 'abc'`, '1'),
      c('REGEXP_REPLACE $1 groups', `REGEXP_REPLACE('abc123', '([a-z]+)([0-9]+)', '$2-$1')`, '123-abc'), c('REGEXP_REPLACE ignores case', `REGEXP_REPLACE('ABC', 'b', 'x')`, 'AxC'),
      c('REGEXP_SUBSTR no match is NULL', `REGEXP_SUBSTR('abc', '[0-9]+')`, '\\N'), c('NOT REGEXP', `'abc' NOT REGEXP 'z'`, '1'), c("REGEXP_LIKE match type 'c' is case-sensitive", `REGEXP_LIKE('abc', '^A', 'c')`, '0'),
      c('SHA2 256', `SHA2('a', 256)`, 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'), c('SHA2 odd length is refused', `SHA2('a', 100)`, '(refused'),
      c('bit and with a negative', `-1 & 255`, '255'), c('~0', `~0`, '18446744073709551615'), c('shift left past 8 bits', `255 << 8`, '65280'), c('BIT_COUNT of -1', `BIT_COUNT(-1)`, '64'),
      c('DAYOFWEEK Sunday', `DAYOFWEEK('2024-03-03')`, '1'), c('DAYOFWEEK Saturday', `DAYOFWEEK('2024-03-02')`, '7'), c('WEEKDAY Sunday', `WEEKDAY('2024-03-03')`, '6'),
      c('MONTHNAME of a DATE', `MONTHNAME(CAST('2024-03-05' AS DATE))`, 'March'), c('DAYNAME of a DATETIME', `DAYNAME(CAST('2024-03-05 10:00:00' AS DATETIME))`, 'Tuesday'),
      c('ROUND small half', `ROUND(0.5)`, '1'), c('ROUND negative digits of a negative', `ROUND(-2.567, 2)`, '-2.57'), c('CAST negative half AS SIGNED', `CAST(-2.5 AS SIGNED)`, '-3'),
      c('GROUP_CONCAT default separator', `GROUP_CONCAT(number ORDER BY number) FROM numbers(5)`, '0,1,2,3,4'), c('GROUP_CONCAT DESC', `GROUP_CONCAT(number ORDER BY number DESC) FROM numbers(5)`, '4,3,2,1,0'),
      c('GROUP_CONCAT DISTINCT', `GROUP_CONCAT(DISTINCT number % 2 ORDER BY number % 2) FROM numbers(5)`, '0,1'), c('GROUP_CONCAT skips NULL', `GROUP_CONCAT(x ORDER BY x) FROM (SELECT 1 AS x UNION ALL SELECT NULL UNION ALL SELECT 2) t`, '1,2'),
      c('GROUP_CONCAT of only NULLs is NULL', `GROUP_CONCAT(x) FROM (SELECT NULL AS x) t`, '\\N'), c('GROUP_CONCAT two sort keys', `GROUP_CONCAT(a ORDER BY b DESC, c DESC) FROM (SELECT 'x' AS a, 1 AS b, 2 AS c UNION ALL SELECT 'y', 2, 1 UNION ALL SELECT 'z', 2, 3) t`, 'z,y,x'),
      c('GROUP_CONCAT DISTINCT sorted by another column is refused', `GROUP_CONCAT(DISTINCT a ORDER BY b) FROM (SELECT 'x' AS a, 1 AS b UNION ALL SELECT 'x', 2) t`, '(refused'),
      c('GROUP_CONCAT empty separator', `GROUP_CONCAT(number ORDER BY number SEPARATOR '') FROM numbers(3)`, '012'), c('GROUP_CONCAT of text', `GROUP_CONCAT(n ORDER BY n SEPARATOR ' | ') FROM (SELECT 'b' AS n UNION ALL SELECT 'a') t`, 'a | b'),
      // ---- column = column: case-insensitive for text columns, left alone for the rest (the types come from ClickHouse) ----
      c('JOIN ON two text columns ignores case', `COUNT(*) FROM (SELECT 'A' AS x) a JOIN (SELECT 'a' AS y) b ON a.x = b.y`, '1'), c('WHERE text col = text col', `COUNT(*) FROM (SELECT 'A' AS x, 'a' AS y) t WHERE t.x = t.y`, '1'),
      c('WHERE text col != text col', `COUNT(*) FROM (SELECT 'A' AS x, 'a' AS y) t WHERE t.x != t.y`, '0'), c('JOIN ON two number columns', `COUNT(*) FROM (SELECT 1 AS x) a JOIN (SELECT 1 AS y) b ON a.x = b.y`, '1'),
      c('JOIN ON different text values', `COUNT(*) FROM (SELECT 'A' AS x) a JOIN (SELECT 'b' AS y) b ON a.x = b.y`, '0'),
      // ---- less common functions: a name ClickHouse also has may mean something else there ----
      c('INET_ATON', `INET_ATON('192.168.1.1')`, '3232235777'), c('INET_NTOA', `INET_NTOA(3232235777)`, '192.168.1.1'), c('BIN', `BIN(5)`, '101'), c('OCT (ClickHouse has no such function: a loud failure)', `OCT(8)`, '(ClickHouse'), c('CONV (ClickHouse has no such function: a loud failure)', `CONV('ff', 16, 10)`, '(ClickHouse'),
      c('TIME_TO_SEC (ClickHouse has no such function: a loud failure)', `TIME_TO_SEC('01:02:03')`, '(ClickHouse'), c('SEC_TO_TIME (ClickHouse has no such function: a loud failure)', `SEC_TO_TIME(3723)`, '(ClickHouse'), c('TO_BASE64', `TO_BASE64('abc')`, 'YWJj'), c('FROM_BASE64', `FROM_BASE64('YWJj')`, 'abc'),
      c('CHAR of two codes', `CHAR(65, 66)`, 'AB'), c('ORD (ClickHouse has no such function: a loud failure)', `ORD('A')`, '(ClickHouse'), c('CRC32', `CRC32('a')`, '3904355907'), c('BIT_LENGTH', `BIT_LENGTH('a')`, '8'), c('OCTET_LENGTH counts bytes', `OCTET_LENGTH('é')`, '2'),
      c('INSERT text function is refused', `INSERT('Quadratic', 3, 4, 'What')`, '(refused'), c('TRIM LEADING', `TRIM(LEADING 'x' FROM 'xxabc')`, 'abc'), c('TRIM BOTH', `TRIM(BOTH 'x' FROM 'xabcx')`, 'abc'), c('TRIM TRAILING', `TRIM(TRAILING 'x' FROM 'abcxx')`, 'abc'),
      c('CAST negative AS UNSIGNED', `CAST(-1 AS UNSIGNED)`, '18446744073709551615'), c('CONVERT to SIGNED', `CONVERT('5', SIGNED)`, '5'), c('RADIANS', `ROUND(RADIANS(180), 4)`, '3.1416'), c('DEGREES', `DEGREES(PI())`, '180'),
      c('ATAN2', `ROUND(ATAN2(1, 1), 4)`, '0.7854'), c('x % 0 is NULL', `7 % 0`, '\\N'), c('SUM DISTINCT', `SUM(DISTINCT number % 3) FROM numbers(10)`, '3'), c('STDDEV_SAMP', `ROUND(STDDEV_SAMP(number), 4) FROM numbers(5)`, '1.5811'),
      c('VAR_SAMP', `VAR_SAMP(number) FROM numbers(5)`, '2.5'), c('BIT_AND aggregate', `BIT_AND(number + 1) FROM numbers(3)`, '0'), c('BIT_OR aggregate', `BIT_OR(number) FROM numbers(4)`, '3'), c('ANY_VALUE', `ANY_VALUE(number) FROM numbers(1)`, '0'),
      c('COUNT DISTINCT two columns', `COUNT(DISTINCT a, b) FROM (SELECT 1 AS a, 2 AS b UNION ALL SELECT 1, 2 UNION ALL SELECT 1, 3) t`, '2'),
      c('JSON_LENGTH (ClickHouse has no such function: a loud failure)', `JSON_LENGTH('[1,2,3]')`, '(ClickHouse'), c('JSON_VALID (ClickHouse has no such function: a loud failure)', `JSON_VALID('{"a":1}')`, '(ClickHouse'), c('JSON_TYPE (ClickHouse has no such function: a loud failure)', `JSON_TYPE('[1]')`, '(ClickHouse'), c('JSON_CONTAINS_PATH (ClickHouse has no such function: a loud failure)', `JSON_CONTAINS_PATH('{"a":1}', 'one', '$.a')`, '(ClickHouse'),
      c('LOG of a non-positive is NULL', `LOG(0)`, '\\N'), c('SQRT of a negative is NULL', `SQRT(-1)`, '\\N'), c('CEILING of a negative', `CEILING(-1.5)`, '-1'), c('1/0 is NULL', `1 / 0`, '\\N'),
      c('IS TRUE', `1 IS TRUE`, '1'), c('IS NOT NULL', `NULL IS NOT NULL`, '0'), c('NOT LIKE', `'abc' NOT LIKE 'a%'`, '0'), c('LIKE underscore', `'abc' LIKE 'a_c'`, '1'),
      c('REPLACE ignores case? no: it is case-sensitive', `REPLACE('ABC', 'b', 'x')`, 'ABC'), c('LOCATE ignores case', `LOCATE('B', 'abc')`, '2'), c('INSTR ignores case', `INSTR('abc', 'B')`, '2'), c('LEFT of NULL', `LEFT(NULL, 2)`, '\\N'),
      c('REPEAT zero', `REPEAT('a', 0)`, ''), c('SUBSTRING zero start is empty', `SUBSTRING('abc', 0)`, ''), c('SUBSTRING past the end', `SUBSTRING('abc', 5)`, ''), c('LPAD with NULL', `LPAD(NULL, 3, 'x')`, '\\N'),
      c('CAST AS SIGNED', `CAST('5' AS SIGNED) + 1`, '6'), c('CAST AS DATE', `CAST('2024-03-05' AS DATE)`, '2024-03-05'), c('CAST float AS SIGNED rounds', `CAST(2.5 AS SIGNED)`, '3'),
    ];
  })(),
  ['ORDER BY puts NULL first (ascending)', "SELECT x FROM (SELECT 1 AS x UNION ALL SELECT NULL UNION ALL SELECT 0) ORDER BY x LIMIT 1", '\\N'],
];
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null; // run only the cases whose label matches (while working on one group)
let failed = 0;
console.log('Part 1 — MySQL -> ClickHouse (the translated SQL must return what MySQL returns)');
for (const [label, mysql, expected] of cases) {
  if (ONLY && !ONLY.test(label)) continue;
  const r = await translateTyped(mysql);
  let got;
  if (!r.ok) got = `(refused: ${r.error})`;
  else { try { got = (await ch(r.sql)).split('\n')[0]; } catch (e) { got = `(ClickHouse: ${e.message})`; } }
  const ok = String(expected).startsWith('(refused') ? got.startsWith('(refused') : String(expected).startsWith('(ClickHouse') ? got.startsWith('(ClickHouse') : got === expected; // '(ClickHouse' = a loud failure is the documented answer
  if (!ok) failed++;
  console.log(`${ok ? 'ok       ' : 'DIFFERENT'} ${label.padEnd(52)} MySQL ${String(expected).padEnd(11)} ClickHouse ${got}${ok ? '' : `\n          ${r.sql ?? ''}`}`);
}
// ---- Part 1b: typical MySQL queries (joins, CTEs, windows, subqueries, the common functions) must translate and be accepted AND run by ClickHouse -------------------------
// (no MySQL to compare with: the check is that the translated text is valid and executes on a real server; the value cases above say it means the right thing)
const corpus = [
 "SELECT database, COUNT(*) AS n FROM system.tables GROUP BY database HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 5",
 "SELECT t.name, d.engine FROM system.tables t INNER JOIN system.databases d ON t.database = d.name WHERE t.database = 'system' LIMIT 5",
 "SELECT t.name FROM system.tables t LEFT JOIN system.databases d ON t.database = d.name WHERE d.name IS NULL LIMIT 5",
 "SELECT name, CASE WHEN total_rows > 1000 THEN 'big' WHEN total_rows > 10 THEN 'mid' ELSE 'small' END AS size FROM system.tables WHERE database = 'system' LIMIT 5",
 "SELECT name FROM system.tables WHERE name LIKE '%log%' AND database NOT IN ('information_schema') LIMIT 5",
 "SELECT database, ROUND(AVG(total_rows), 2) AS avg_rows, MAX(total_rows) AS mx FROM system.tables GROUP BY database ORDER BY avg_rows DESC LIMIT 3",
 "WITH big AS (SELECT name, database FROM system.tables WHERE total_rows > 100) SELECT b.database, COUNT(*) FROM big b JOIN system.databases d ON b.database = d.name GROUP BY b.database LIMIT 5",
 "SELECT name, ROW_NUMBER() OVER (PARTITION BY database ORDER BY name) AS rn FROM system.tables LIMIT 5",
 "SELECT DISTINCT engine FROM system.tables WHERE engine IS NOT NULL ORDER BY engine LIMIT 5",
 "SELECT UPPER(name) AS n, LENGTH(name) AS len, SUBSTRING(name, 1, 3) AS p FROM system.databases LIMIT 5",
 "SELECT CONCAT(database, '.', name) AS full, IFNULL(engine, 'n/a') AS e FROM system.tables LIMIT 5",
 "SELECT name FROM system.tables WHERE metadata_modification_time >= DATE_SUB(NOW(), INTERVAL 365 DAY) LIMIT 5",
 "SELECT DATE_FORMAT(metadata_modification_time, '%Y-%m') AS ym, COUNT(*) AS n FROM system.tables GROUP BY ym ORDER BY ym LIMIT 5",
 "SELECT YEAR(metadata_modification_time) AS y, QUARTER(metadata_modification_time) AS q, COUNT(*) FROM system.tables GROUP BY y, q LIMIT 5",
 "SELECT name FROM system.tables WHERE database IN (SELECT name FROM system.databases WHERE name LIKE 's%') LIMIT 5",
 "SELECT a.name, b.name FROM system.tables a JOIN system.tables b ON a.database = b.database AND a.name <> b.name LIMIT 3",
 "SELECT database, GROUP_CONCAT(name ORDER BY name SEPARATOR ',') AS names FROM system.tables WHERE database = 'system' GROUP BY database",
 "SELECT name, total_rows / NULLIF(total_bytes, 0) AS ratio FROM system.tables WHERE total_bytes IS NOT NULL LIMIT 5",
 "SELECT name, IF(total_rows > 0, 'yes', 'no') AS has_rows FROM system.tables LIMIT 5",
 "SELECT COUNT(DISTINCT engine) AS engines, SUM(total_rows) AS rows FROM system.tables",
 "SELECT name FROM system.tables WHERE name REGEXP '^query' LIMIT 5",
 "SELECT name, FIND_IN_SET(name, 'one,query_log,two') AS pos FROM system.tables WHERE database = 'system' LIMIT 5",
 "SELECT x.name FROM (SELECT name FROM system.databases) x ORDER BY x.name LIMIT 3",
 "SELECT name FROM system.tables WHERE database = 'system' UNION ALL SELECT name FROM system.databases LIMIT 5",
 "SELECT database, COUNT(*) AS n FROM system.tables WHERE database != 'system' GROUP BY database ORDER BY n DESC, database LIMIT 5",
 "SELECT name, DATEDIFF(NOW(), metadata_modification_time) AS days FROM system.tables LIMIT 3",
 "SELECT name, TIMESTAMPDIFF(HOUR, metadata_modification_time, NOW()) AS hrs FROM system.tables LIMIT 3",
 "SELECT name FROM system.tables WHERE total_rows BETWEEN 1 AND 100000 LIMIT 5",
 "SELECT name, COALESCE(comment, '') AS c FROM system.tables WHERE comment <> '' LIMIT 3",
 "SELECT `name`, `engine` FROM `system`.`tables` LIMIT 3",
 "SELECT t.* FROM system.tables t LIMIT 2",
 "SELECT COUNT(*) FROM system.columns c JOIN system.tables t ON c.table = t.name AND c.database = t.database",
 "SELECT name FROM system.tables ORDER BY total_rows DESC LIMIT 5, 5",
 "SELECT TRIM(name) AS n, LOWER(engine) AS e FROM system.tables WHERE LOWER(engine) = 'view' LIMIT 3",
 "SELECT name FROM system.tables WHERE engine = 'View' LIMIT 3",
 "SELECT name FROM system.databases WHERE name IN ('SYSTEM', 'default')",
 "SELECT ABS(-5), CEIL(1.2), FLOOR(1.8), POW(2, 3), SQRT(16), MOD(10, 3), GREATEST(1, 2), LEAST(3, 4) FROM system.one",
 "SELECT CAST(total_rows AS CHAR) AS s, CAST('5' AS SIGNED) AS n FROM system.tables LIMIT 2",
];
let rejected = 0;
console.log('\nPart 1b — typical MySQL queries: translated, described and run by ClickHouse');
for (const q of corpus) {
  if (ONLY && !ONLY.test(q)) continue;
  const r = await translateTyped(q);
  if (!r.ok) { rejected++; console.log(`REFUSED   ${q.slice(0, 90)}\n          ${r.error}`); continue; }
  try { await ch(`DESCRIBE TABLE (${r.sql})`); await ch(`SELECT * FROM (${r.sql}) LIMIT 1`); }
  catch (e) { rejected++; console.log(`REJECTED  ${q.slice(0, 90)}\n          ${r.sql.slice(0, 200)}\n          ${e.message}`); }
}
console.log(rejected ? `${rejected} of ${corpus.length} typical MySQL queries did not run` : `all ${corpus.length} typical MySQL queries ran`);
failed += rejected;

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
  'SELECT upper(name) FROM system.tables LIMIT 3',
  'SELECT lowerUTF8(name) FROM system.tables LIMIT 3',
  'SELECT count() FROM system.tables ORDER BY count() DESC',
  'SELECT dummy FROM system.one',
  'SELECT a, b FROM (SELECT 1 AS a, 2 AS b)',
];
if (process.env.SKIP_PART2) { console.log(failed ? `\n${failed} case(s) DIFFERENT from MySQL` : '\nall Part 1 cases match MySQL'); process.exit(failed ? 1 : 0); }
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
