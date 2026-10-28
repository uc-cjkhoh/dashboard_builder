// Live smoke for the type cast (T02-34): the dev app (APP_URL, default http://localhost:5180) against a real
// ClickHouse. Creates test_cj.bk_cast straight over HTTPS (the app stays read-only) and drops it in `finally`.
// Expectations are pinned by hand from the fixture rows below, not from the code under test.
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5180';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');
const DB = 'test_cj', T = 'bk_cast';

async function ch(sql) {
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?default_format=JSONCompact`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 400)}`);
}
const write = (sql) => { assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_cast(_edge)?\b/); return ch(sql); };

let cookie = '';
async function app(method, path, body) {
  const res = await fetch(`${APP}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}
const ref = (column, extra = {}) => ({ db: DB, table: T, column, ...extra });
async function q(req, label) {
  const r = await app('POST', '/api/query', { from: { db: DB, table: T }, ...req });
  assert.equal(r.status, 200, `${label}: ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}
async function bad(req, label, fieldRe) {
  const r = await app('POST', '/api/query', { from: { db: DB, table: T }, ...req });
  assert.equal(r.status, 400, `${label}: expected 400, got ${r.status} ${r.text.slice(0, 200)}`);
  assert.match(r.json?.field ?? '', fieldRe, `${label}: field ${r.json?.field}`);
  console.log(`ok ${label} -> 400 "${r.json.error}"`);
}
const pairs = (res) => res.rows.map((r) => [r.keys[0], r.values[0]]);
let n = 0;
const ok = (name) => console.log(`ok ${++n} ${name}`);

async function main() {
  await write(`DROP TABLE IF EXISTS test_cj.bk_cast`);
  await write(`DROP TABLE IF EXISTS test_cj.bk_cast_edge`);
  await write(`CREATE TABLE test_cj.bk_cast (id UInt32, grp String, s_num Nullable(String), s_date Nullable(String), n Int32, d Date, flag Bool) ENGINE = MergeTree ORDER BY id`);
  await write(`INSERT INTO test_cj.bk_cast VALUES
    (1,'a','10','2024-01-15',5,'2024-03-01',true),
    (2,'a','2.5','2024-01-20 10:30:00',7,'2024-03-02',false),
    (3,'b','abc','junk',7,'2024-03-03',true),
    (4,'b','','',3,'2024-03-04',false),
    (5,'b','1e3','2024-02-02',3,'2024-03-05',true),
    (6,'a',NULL,NULL,1,'2024-03-06',false)`);
  const conn = await app('POST', '/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);

  // text -> number: 10 + 2.5 + 1000 = 1012.5; 'abc', '' and NULL never fail the query, they drop out of the sum
  let r = await q({ measures: [ref('s_num', { agg: 'sum', cast: 'number' })] }, 'sum');
  assert.equal(r.rows[0].values[0], 1012.5); ok('sum of a text column cast to number = 1012.5 (bad values are NULL, not errors)');
  r = await q({ measures: [ref('s_num', { agg: 'max', cast: 'number' }), ref('s_num', { agg: 'countNonNull', cast: 'number' })] }, 'max');
  assert.deepEqual(r.rows[0].values, [1000, 3]); ok('max = 1000 and 3 values parse');
  // the same column un-cast still refuses sum (text)
  await bad({ measures: [ref('s_num', { agg: 'sum' })] }, 'sum of the text column without a cast', /measures\[0\]/);

  // number -> text: grouping by the text form
  r = await q({ rowDimensions: [ref('n', { cast: 'text' })], measures: [{ ...ref('id'), agg: 'count' }] }, 'n text');
  assert.deepEqual(pairs(r).sort(), [['1', 1], ['3', 2], ['5', 1], ['7', 2]]); ok('Int32 cast to text groups by its text');

  // text -> date, grouped by month: Jan (rows 1,2), Feb (5), and the unparseable / empty / NULL rows together as NULL
  r = await q({ rowDimensions: [ref('s_date', { cast: 'date', datePart: 'month' })], measures: [{ ...ref('id'), agg: 'count' }] }, 'date month');
  const m = Object.fromEntries(pairs(r).map(([k, v]) => [String(k), v]));
  assert.equal(m['2024-01-01'], 2); assert.equal(m['2024-02-01'], 1); assert.equal(m['null'], 3);
  ok('text cast to date groups by month; unparseable text is NULL');

  // filters on a cast column
  r = await q({ filters: [ref('s_num', { op: '>', value: '5', cast: 'number' })], measures: [{ ...ref('id'), agg: 'count' }] }, 'filter >');
  assert.equal(r.rows[0].values[0], 2); ok('filter s_num (as number) > 5 keeps 2 rows');
  r = await q({ filters: [ref('s_date', { op: 'between', values: ['2024-01-01', '2024-01-31'], cast: 'date' })], measures: [{ ...ref('id'), agg: 'count' }] }, 'filter date');
  assert.equal(r.rows[0].values[0], 2); ok('filter s_date (as date) in January keeps 2 rows');
  r = await q({ filters: [ref('n', { op: 'contains', value: '7', cast: 'text' })], measures: [{ ...ref('id'), agg: 'count' }] }, 'filter contains');
  assert.equal(r.rows[0].values[0], 2); ok('text-match filter on an Int32 cast to text keeps 2 rows');
  r = await q({ filters: [ref('n', { op: 'in', values: ['3', '7'], cast: 'text' })], measures: [{ ...ref('id'), agg: 'count' }] }, 'filter in');
  assert.equal(r.rows[0].values[0], 4); ok('in-filter on text form keeps 4 rows');

  // top-N ranked by a cast measure: b sums to 1000, a to 12.5
  r = await q({ rowDimensions: [ref('grp')], measures: [{ ...ref('id'), agg: 'count' }],
    filters: [ref('grp', { op: 'top', value: '1', topBy: ref('s_num', { agg: 'sum', cast: 'number' }) })] }, 'top');
  assert.deepEqual(pairs(r), [['b', 3]]); ok('top 1 group ranked by sum(s_num as number) is b');

  // boolean -> number
  r = await q({ measures: [ref('flag', { agg: 'sum', cast: 'number' })] }, 'bool');
  assert.equal(r.rows[0].values[0], 3); ok('Bool cast to number sums to 3');

  // ---- the nastiest data: one string column, one id per value (pinned by hand, see the comments) ----
  await write(`CREATE TABLE test_cj.bk_cast_edge (id UInt32, s String) ENGINE = MergeTree ORDER BY id`);
  const EDGE = ['inf', 'nan', '1e999', '-inf', ' 12 ', '99999999999999999999', '12', '2026-13-45', '20240115', '10', ' 2024-01-15 ', '2024-01-15', '+5', '1,5', '0x10'];
  await write(`INSERT INTO test_cj.bk_cast_edge VALUES ${EDGE.map((v, i) => `(${i + 1}, '${v}')`).join(',')}`);
  const edge = async (cast) => {
    const res = await app('POST', '/api/query', { from: { db: DB, table: 'bk_cast_edge' }, rowDimensions: [{ db: DB, table: 'bk_cast_edge', column: 'id' }],
      measures: [{ db: DB, table: 'bk_cast_edge', column: 's', agg: 'max', cast }], limit: 100 });
    assert.equal(res.status, 200, `edge ${cast}: ${res.status} ${res.text.slice(0, 300)}`);
    return Object.fromEntries(res.json.rows.map((r) => [EDGE[Number(r.keys[0]) - 1], r.values[0]]));
  };
  // Pinned by hand: a number cast keeps only text that parses to a FINITE number; padding, commas and hex are not numbers.
  const asNum = await edge('number');
  assert.deepEqual(asNum, { 'inf': null, 'nan': null, '1e999': null, '-inf': null, ' 12 ': null, '99999999999999999999': 1e20, '12': 12,
    '2026-13-45': null, '20240115': 20240115, '10': 10, ' 2024-01-15 ': null, '2024-01-15': null, '+5': 5, '1,5': null, '0x10': null });
  ok('number cast: inf / nan / 1e999 / padded / comma / hex text are NULL, 1e20 and +5 parse');
  // Date cast: ISO text parses (padding trimmed); an impossible date is NULL; digits only are NULL unless YYYYMMDD
  // (never "day of this month", which would change with the calendar).
  const asDate = await edge('date');
  assert.deepEqual(asDate, { 'inf': null, 'nan': null, '1e999': null, '-inf': null, ' 12 ': null, '99999999999999999999': null, '12': null,
    '2026-13-45': null, '20240115': '2024-01-15', '10': null, ' 2024-01-15 ': '2024-01-15', '2024-01-15': '2024-01-15', '+5': null, '1,5': null, '0x10': null });
  ok('date cast: ISO and YYYYMMDD parse, impossible dates and digit-only text are NULL');
  // text cast of the huge integer column value is the text itself, and a number cast aggregates finite values only
  let r2 = await app('POST', '/api/query', { from: { db: DB, table: 'bk_cast_edge' }, measures: [{ db: DB, table: 'bk_cast_edge', column: 's', agg: 'countNonNull', cast: 'number' }] });
  assert.equal(r2.json.rows[0].values[0], 5); ok('5 of 15 values count as numbers (1e20, 12, 20240115, 10, +5)');
  // refusals
  await bad({ measures: [ref('d', { agg: 'max', cast: 'number' })] }, 'date cast to number', /measures\[0\]/);
  await bad({ rowDimensions: [ref('n', { cast: 'date' })] }, 'number cast to date', /rowDimensions\[0\]/);
  await bad({ rowDimensions: [ref('n', { cast: 'bogus' })] }, 'unknown cast', /rowDimensions\[0\]\.cast/);
  await bad({ rowDimensions: [ref('n', { cast: 'toString(1)' })] }, 'injection-shaped cast', /rowDimensions\[0\]\.cast/);
  await bad({ rowDimensions: [{ db: '', table: '', column: 'c', calc: { k: 'num', v: 1 }, cast: 'text' }] }, 'cast on a calculation', /rowDimensions\[0\]\.cast/);
  await bad({ filters: [ref('s_num', { op: '>', value: 'x', cast: 'number' })] }, 'non-number filter value on a number cast', /filters\[0\]/);
  await app('POST', '/api/connection/disconnect', {});
}

let failed = false;
try { await main(); } catch (e) { failed = true; console.log(`FAIL: ${e.stack}`); }
finally { try { await write(`DROP TABLE IF EXISTS test_cj.bk_cast_edge`); await write(`DROP TABLE IF EXISTS test_cj.bk_cast`); console.log('dropped test_cj.bk_cast'); } catch (e) { console.log(`cleanup failed: ${e.message}`); failed = true; } }
console.log(failed ? 'FAILED' : `${n} ok`);
process.exit(failed ? 1 : 0);
