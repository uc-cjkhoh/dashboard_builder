// Live smoke for calculated-field date functions (DATEDIFF/DATEADD/YEAR/MONTH/DAY/QUARTER/WEEK/WEEKDAY/DATE): the dev app (APP_URL, default http://localhost:5192) against a real
// ClickHouse. Creates its fixture tables in test_cj (bk_dates) straight over HTTPS — never through the
// app, which stays read-only — and drops them in `finally`. Every expectation beyond the pinned core values
// comes from an independent oracle: a hand computation (see the table comment below).
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5192';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');

const DB = 'test_cj', TBL = 'bk_dates', T = `${DB}.${TBL}`;

async function ch(sql, { readonly = true } = {}) {
  const qs = new URLSearchParams({ default_format: 'JSONCompact', output_format_json_quote_64bit_integers: '0' });
  if (readonly) qs.set('readonly', '2');
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?${qs}`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 500)}`);
  return text.trim() ? JSON.parse(text).data : [];
}
// The only writes: DDL / inserts on test_cj.bk_dates.
const write = (sql) => {
  assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_dates\b/, `refusing write: ${sql.slice(0, 60)}`);
  return ch(sql, { readonly: false });
};

let cookie = '';
async function app(method, path, body) {
  const res = await fetch(`${APP}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
async function query(req, label) {
  const r = await app('POST', '/api/query', req);
  assert.equal(r.status, 200, `${label}: expected 200, got ${r.status} ${r.text.slice(0, 400)}`);
  return r.json;
}

const f = (column) => ({ k: 'field', db: DB, table: TBL, column });
const num = (v) => ({ k: 'num', v });
const str = (v) => ({ k: 'str', v });
const fn = (name, ...args) => ({ k: 'fn', fn: name, args });
const agg = (name, arg) => ({ k: 'agg', fn: name, arg });
const ifnull = (l, r) => ({ k: 'ifnull', l, r });
const dim = (column) => ({ db: DB, table: TBL, column });
const calcDim = (label, calc) => ({ db: DB, table: TBL, column: label, calc });
const calcMeas = (label, calc, aggName = null) => ({ db: DB, table: TBL, column: label, agg: aggName, calc });
const base = () => ({ from: { db: DB, table: TBL }, joins: [], rowDimensions: [], columnDimensions: [], measures: [], filters: [], fresh: true });
const countRows = { db: DB, table: TBL, column: 'id', agg: 'countNonNull' };

let passed = 0;
const ok = (name) => { passed++; console.log(`ok ${name}`); };

// id  d (Date)     t (DateTime UTC)        s (text)
//  1  2024-01-31   2024-01-31 22:30:00     '2024-03-05'
//  2  2024-02-29   2024-03-01 01:15:30     '2024-02-29'          (leap day)
//  3  2023-12-31   2023-12-31 23:59:59     '12345'               (year end; digits only -> NULL)
//  4  2021-01-01   2021-01-01 00:00:00     'hello'               (ISO week 53 of 2020)
//  5  2020-12-31   NULL                    '20240229'            (ISO week 53; YYYYMMDD parses)
//  6  NULL         NULL                    NULL
//  7  2024-12-30   2024-12-30 12:00:00     '1850-01-01'          (ISO week 1 of 2025; year before the Date range -> NULL)
//  8  2024-03-03   2024-03-03 00:00:00     '2024-02-30'          (Sunday; no such day -> NULL)
//  9  2024-03-31   2024-03-31 23:00:00     '2024-03-05 10:30:00' (month end; time of day dropped)
async function setup() {
  await write(`DROP TABLE IF EXISTS ${T}`);
  await write(`CREATE TABLE ${T} (id UInt32, d Nullable(Date), t Nullable(DateTime('UTC')), s Nullable(String)) ENGINE = MergeTree ORDER BY id`);
  await write(`INSERT INTO ${T} VALUES (1,'2024-01-31','2024-01-31 22:30:00','2024-03-05'),(2,'2024-02-29','2024-03-01 01:15:30','2024-02-29'),(3,'2023-12-31','2023-12-31 23:59:59','12345'),(4,'2021-01-01','2021-01-01 00:00:00','hello'),(5,'2020-12-31',NULL,'20240229'),(6,NULL,NULL,NULL),(7,'2024-12-30','2024-12-30 12:00:00','1850-01-01'),(8,'2024-03-03','2024-03-03 00:00:00','2024-02-30'),(9,'2024-03-31','2024-03-31 23:00:00','2024-03-05 10:30:00')`);
}
async function teardown() {
  await write(`DROP TABLE IF EXISTS ${T}`);
  const left = await ch(`SELECT name FROM system.tables WHERE database = '${DB}' AND name = '${TBL}'`);
  assert.deepEqual(left, [], 'bk_dates still present');
  console.log('ok teardown: test_cj.bk_dates dropped');
}

async function byId(calc, label) {
  const r = await query({ ...base(), rowDimensions: [dim('id'), calcDim('c', calc)], measures: [countRows] }, label);
  return Object.fromEntries(r.rows.map((x) => [String(x.keys[0]), x.keys[1] === null ? null : String(x.keys[1])]));
}
const NULL = null;
async function expectById(label, calc, want) {
  const got = await byId(calc, label);
  const w = Object.fromEntries(want.map((v, i) => [String(i + 1), v === null ? null : String(v)]));
  assert.deepEqual(got, w, `${label}: got ${JSON.stringify(got)}`);
  ok(`${label}: ${JSON.stringify(want)}`);
}

async function main() {
  const conn = await app('POST', '/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);
  const d = f('d'), t = f('t'), s = f('s');

  await expectById('YEAR', fn('year', d), [2024, 2024, 2023, 2021, 2020, NULL, 2024, 2024, 2024]);
  await expectById('MONTH', fn('month', d), [1, 2, 12, 1, 12, NULL, 12, 3, 3]);
  await expectById('DAY', fn('day', d), [31, 29, 31, 1, 31, NULL, 30, 3, 31]);
  await expectById('QUARTER', fn('quarter', d), [1, 1, 4, 1, 4, NULL, 4, 1, 1]);
  await expectById('WEEK is the ISO week (53 at the 2020/2021 turn, 1 for 2024-12-30)', fn('week', d), [5, 9, 52, 53, 53, NULL, 1, 9, 13]);
  await expectById('WEEKDAY is ISO: Monday 1 .. Sunday 7', fn('weekday', d), [3, 4, 7, 5, 4, NULL, 1, 7, 7]);
  await expectById('YEAR of a DateTime', fn('year', t), [2024, 2024, 2023, 2021, NULL, NULL, 2024, 2024, 2024]);
  await expectById("DATEADD('month', 1, d): month end clamps, leap day moves on", fn('dateadd', str('month'), num(1), d), ['2024-02-29', '2024-03-29', '2024-01-31', '2021-02-01', '2021-01-31', NULL, '2025-01-30', '2024-04-03', '2024-04-30']);
  await expectById("DATEADD('year', 1, d): leap day -> 28 Feb", fn('dateadd', str('year'), num(1), d), ['2025-01-31', '2025-02-28', '2024-12-31', '2022-01-01', '2021-12-31', NULL, '2025-12-30', '2025-03-03', '2025-03-31']);
  await expectById("DATEADD('day', -1, d): a negative amount", fn('dateadd', str('day'), { k: 'un', op: '-', arg: num(1) }, d), ['2024-01-30', '2024-02-28', '2023-12-30', '2020-12-31', '2020-12-30', NULL, '2024-12-29', '2024-03-02', '2024-03-30']);
  await expectById("DATEADD('week', 1, d)", fn('dateadd', str('week'), num(1), d), ['2024-02-07', '2024-03-07', '2024-01-07', '2021-01-08', '2021-01-07', NULL, '2025-01-06', '2024-03-10', '2024-04-07']);
  await expectById("DATEADD('quarter', 1, d)", fn('dateadd', str('Quarter'), num(1), d), ['2024-04-30', '2024-05-29', '2024-03-31', '2021-04-01', '2021-03-31', NULL, '2025-03-30', '2024-06-03', '2024-06-30']);
  await expectById("DATEDIFF('day', d, DATE(s))", fn('datediff', str('day'), d, fn('date', s)), [34, 0, NULL, NULL, 1155, NULL, NULL, NULL, -26]);
  await expectById("DATEDIFF('day', d, DATEADD('day', 30, d)) is 30 for every non-NULL date", fn('datediff', str('day'), d, fn('dateadd', str('day'), num(30), d)), [30, 30, 30, 30, 30, NULL, 30, 30, 30]);
  await expectById("DATEDIFF('year', d, d + 1 day) counts calendar boundaries", fn('datediff', str('year'), d, fn('dateadd', str('day'), num(1), d)), [0, 0, 1, 0, 1, NULL, 0, 0, 0]);
  await expectById("DATEDIFF('quarter', d, d + 1 day)", fn('datediff', str('quarter'), d, fn('dateadd', str('day'), num(1), d)), [0, 0, 1, 0, 1, NULL, 0, 0, 1]);
  await expectById("DATEDIFF('month', d, d + 1 month)", fn('datediff', str('month'), d, fn('dateadd', str('month'), num(1), d)), [1, 1, 1, 1, 1, NULL, 1, 1, 1]);
  await expectById("DATEDIFF('month', d, d + 1 day) is boundaries, not 30-day spans", fn('datediff', str('month'), d, fn('dateadd', str('day'), num(1), d)), [1, 1, 1, 0, 1, NULL, 0, 0, 1]);
  await expectById("DATEDIFF('week', d, d + 7 days)", fn('datediff', str('week'), d, fn('dateadd', str('day'), num(7), d)), [1, 1, 1, 1, 1, NULL, 1, 1, 1]);
  await expectById("DATEDIFF('hour', t, t + 150 minutes) counts hour boundaries", fn('datediff', str('hour'), t, fn('dateadd', str('minute'), num(150), t)), [3, 2, 3, 2, NULL, NULL, 2, 2, 2]);
  await expectById("DATEDIFF('day', t, t + 2 hours) across midnight", fn('datediff', str('day'), t, fn('dateadd', str('hour'), num(2), t)), [1, 0, 1, 0, NULL, NULL, 0, 0, 1]);
  await expectById("DATEDIFF('second', t, t - 90 seconds)", fn('datediff', str('second'), t, fn('dateadd', str('second'), { k: 'un', op: '-', arg: num(90) }, t)), [-90, -90, -90, -90, NULL, NULL, -90, -90, -90]);
  await expectById("DATEDIFF('hour', d, d + 1 day): a time unit on a plain Date reads midnight to midnight", fn('datediff', str('hour'), d, fn('dateadd', str('day'), num(1), d)), [24, 24, 24, 24, 24, NULL, 24, 24, 24]);
  await expectById("DATEADD('day', 1, t) keeps the time of day (a midnight value reads as a date, as everywhere in the app)", fn('dateadd', str('day'), num(1), t), ['2024-02-01 22:30:00', '2024-03-02 01:15:30', '2024-01-01 23:59:59', '2021-01-02', NULL, NULL, '2024-12-31 12:00:00', '2024-03-04', '2024-04-01 23:00:00']);
  await expectById('DATE(s): digits-only, text, out-of-range and impossible dates are NULL; YYYYMMDD parses; time dropped', fn('date', s), ['2024-03-05', '2024-02-29', NULL, NULL, '2024-02-29', NULL, NULL, NULL, '2024-03-05']);
  await expectById('YEAR(DATE(s)) chains', fn('year', fn('date', s)), [2024, 2024, NULL, NULL, 2024, NULL, NULL, NULL, 2024]);
  await expectById("IF on a date part: IF(MONTH(d) = 12, 'dec', 'other')", { k: 'case', whens: [{ c: { k: 'cmp', op: '=', l: fn('month', d), r: num(12) }, t: str('dec') }], else: str('other') }, ['other', 'other', 'dec', 'other', 'dec', 'other', 'dec', 'other', 'other']);

  { // inside an aggregate and as a group
    const r = await query({ ...base(), measures: [calcMeas('w', agg('sum', fn('week', d)))] }, 'sum week');
    assert.equal(Number(r.rows[0].values[0]), 5 + 9 + 52 + 53 + 53 + 1 + 9 + 13);
    ok('SUM(WEEK(d)) = 195 (NULL skipped)');
    const g = await query({ ...base(), rowDimensions: [calcDim('y', fn('year', d))], measures: [countRows] }, 'group year');
    const got = Object.fromEntries(g.rows.map((x) => [String(x.keys[0]), Number(x.values[0])]));
    assert.deepEqual(got, { 2024: 5, 2023: 1, 2021: 1, 2020: 1, null: 1 });
    ok('group by YEAR(d): 2024 x5, 2023, 2021, 2020, NULL');
    const dm = await query({ ...base(), measures: [calcMeas('latest', fn('dateadd', str('day'), num(1), d), 'max')] }, 'max date');
    assert.equal(String(dm.rows[0].values[0]).slice(0, 10), '2024-12-31');
    ok('MAX(DATEADD(day, 1, d)) = 2024-12-31 (a date calculation takes MAX)');
  }
  { // errors: 400 with the node path
    const e = async (calc) => app('POST', '/api/query', { ...base(), rowDimensions: [dim('id'), calcDim('x', calc)], measures: [countRows] });
    const a = await e(fn('year', s));
    assert.equal(a.status, 400);
    assert.match(a.json.error, /YEAR needs a date — bk_dates\.s is text\. Use DATE\(\) to turn text into a date\./);
    assert.equal(a.json.field, 'rowDimensions[1].calc.args.0');
    const u = await e(fn('datediff', str("day'); DROP TABLE x; --"), d, d));
    assert.equal(u.status, 400);
    assert.match(u.json.error, /DATEDIFF's unit must be one of 'year'/);
    assert.equal(u.json.field, 'rowDimensions[1].calc.args.0');
    const n = await e(fn('dateadd', str('day'), num(100001), d));
    assert.equal(n.status, 400);
    assert.match(n.json.error, /DATEADD's amount must be a whole number from -100000 to 100000/);
    const ar = await e(fn('datediff', str('day'), d));
    assert.equal(ar.status, 400);
    assert.match(ar.json.error, /DATEDIFF takes 3 arguments\./);
    ok('a text argument, an injection-shaped unit, an amount over 100000 and wrong arity are 400s with a path');
  }
  await app('POST', '/api/connection/disconnect');
}

let failed = false;
try {
  await setup();
  await main();
} catch (e) {
  failed = true;
  console.error(`FAIL: ${e.message}`);
} finally {
  await teardown();
}
console.log(`${passed} checks passed${failed ? ', FAILED' : ''}`);
process.exit(failed ? 1 : 0);
