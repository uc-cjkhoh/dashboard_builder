// Live smoke for MAKEDATE / ISOYEAR / DATENAME / DATETRUNC: the dev app (APP_URL, default http://localhost:5224) against a real
// ClickHouse. Creates its fixture table in test_cj (bk_datex) straight over HTTPS — never through the app, which stays
// read-only — and drops it in `finally`. Every expectation is a hand-worked calendar fact (see the table comment).
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5224';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');
const DB = 'test_cj', TBL = 'bk_datex', T = `${DB}.${TBL}`;

async function ch(sql, { readonly = true } = {}) {
  const qs = new URLSearchParams({ default_format: 'JSONCompact', output_format_json_quote_64bit_integers: '0' });
  if (readonly) qs.set('readonly', '2');
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?${qs}`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 500)}`);
  return text.trim() ? JSON.parse(text).data : [];
}
const write = (sql) => {
  assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_datex\b/, `refusing write: ${sql.slice(0, 60)}`);
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

const f = (column) => ({ k: 'field', db: DB, table: TBL, column });
const num = (v) => ({ k: 'num', v });
const str = (v) => ({ k: 'str', v });
const fn = (name, ...args) => ({ k: 'fn', fn: name, args });
const base = () => ({ from: { db: DB, table: TBL }, joins: [], columnDimensions: [], measures: [{ db: DB, table: TBL, column: 'id', agg: 'countNonNull' }], filters: [], fresh: true });
let passed = 0;
const ok = (name) => { passed++; console.log(`ok ${name}`); };

// Row id -> the calculation's text (a date at midnight loses its 00:00:00), through the app.
async function byId(calc, label) {
  const r = await app('POST', '/api/query', { ...base(), rowDimensions: [{ db: DB, table: TBL, column: 'id' }, { db: DB, table: TBL, column: label, calc }] });
  assert.equal(r.status, 200, `${label}: ${r.status} ${r.text.slice(0, 300)}`);
  return Object.fromEntries(r.json.rows.map((x) => [String(x.keys[0]), x.keys[1] === null ? null : String(x.keys[1]).replace(' 00:00:00', '')]));
}
const txt = (e) => fn('text', e);

// id  y     m   d   dt          (dt: 1 Mon 2024-12-30, 2 Wed 2024-05-08, 3 Sun 2021-01-03, 4 NULL; the rest are filler)
//  1  2024  2   29  2024-12-30  leap day
//  2  2024  2   30  2024-05-08  impossible: Feb 30
//  3  2023  2   29  2021-01-03  impossible: 2023 is not a leap year
//  4  2024  13  1   NULL        impossible: month 13
//  5  2024  4   31  2024-01-01  impossible: April has 30 days
//  6  2024  1   0   2024-01-01  day 0
//  7  2024.5 1  1   2024-01-01  not a whole number
//  8  NULL  1   1   2024-01-01  NULL part
//  9  1900  1   1   2024-01-01  below the window (1901..2298)
// 10  2298  12  31  2024-01-01  last day of the window
// 11  2299  1   1   2024-01-01  above the window
// 12  2000  2   29  2024-01-01  leap century
// 13  2100  2   29  2024-01-01  2100 is not a leap year
async function setup() {
  await write(`DROP TABLE IF EXISTS ${T}`);
  await write(`CREATE TABLE ${T} (id UInt32, y Nullable(Float64), m Float64, d Float64, dt Nullable(Date)) ENGINE = MergeTree ORDER BY id`);
  await write(`INSERT INTO ${T} VALUES (1,2024,2,29,'2024-12-30'),(2,2024,2,30,'2024-05-08'),(3,2023,2,29,'2021-01-03'),(4,2024,13,1,NULL),(5,2024,4,31,'2024-01-01'),(6,2024,1,0,'2024-01-01'),(7,2024.5,1,1,'2024-01-01'),(8,NULL,1,1,'2024-01-01'),(9,1900,1,1,'2024-01-01'),(10,2298,12,31,'2024-01-01'),(11,2299,1,1,'2024-01-01'),(12,2000,2,29,'2024-01-01'),(13,2100,2,29,'2024-01-01')`);
}
async function teardown() {
  await write(`DROP TABLE IF EXISTS ${T}`);
  const left = await ch(`SELECT name FROM system.tables WHERE database = '${DB}' AND name = '${TBL}'`);
  assert.deepEqual(left, [], 'bk_datex still present');
  console.log('ok teardown: test_cj.bk_datex dropped');
}

async function main() {
  const conn = await app('POST', '/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);

  {
    const got = await byId(txt(fn('makedate', f('y'), f('m'), f('d'))), 'mk');
    assert.deepEqual(got, { 1: '2024-02-29', 2: null, 3: null, 4: null, 5: null, 6: null, 7: null, 8: null, 9: null, 10: '2298-12-31', 11: null, 12: '2000-02-29', 13: null });
    ok('MAKEDATE: only the real dates (29 Feb 2024, 2298-12-31, 29 Feb 2000) come back; Feb 30, 29 Feb 2023/2100, month 13, Apr 31, day 0, 2024.5, NULL, 1900 and 2299 are NULL (no 1970-01-01, no roll-over)');
  }
  {
    const got = await byId(txt(fn('makedate', num(2024), num(2), num(30))), 'lit');
    assert.ok(Object.values(got).every((v) => v === null));
    const leap = await byId(txt(fn('makedate', num(2024), num(2), num(29))), 'lit2');
    assert.ok(Object.values(leap).every((v) => v === '2024-02-29'));
    ok('MAKEDATE of literals: Feb 30 is NULL on every row, Feb 29 2024 is a date on every row');
  }
  {
    const got = await byId(fn('isoyear', f('dt')), 'iso');
    assert.deepEqual([got[1], got[2], got[3], got[4]].map((v) => v === null ? null : Number(v)), [2025, 2024, 2020, null]);
    ok('ISOYEAR: 2024-12-30 is 2025, 2024-05-08 is 2024, 2021-01-03 is 2020, NULL is NULL');
  }
  {
    const wd = await byId(fn('datename', str('weekday'), f('dt')), 'wd');
    assert.deepEqual([wd[1], wd[2], wd[3], wd[4]], ['Monday', 'Wednesday', 'Sunday', null]);
    const mo = await byId(fn('datename', str('Month'), f('dt')), 'mo');
    assert.deepEqual([mo[1], mo[2], mo[3], mo[4]], ['December', 'May', 'January', null]);
    ok('DATENAME: English weekday and month names, NULL for NULL');
  }
  {
    const want = {
      year: ['2024-01-01', '2024-01-01', '2021-01-01', null],
      quarter: ['2024-10-01', '2024-04-01', '2021-01-01', null],
      month: ['2024-12-01', '2024-05-01', '2021-01-01', null],
      week: ['2024-12-30', '2024-05-06', '2020-12-28', null],
      day: ['2024-12-30', '2024-05-08', '2021-01-03', null],
    };
    for (const [unit, v] of Object.entries(want)) {
      const got = await byId(txt(fn('datetrunc', str(unit.toUpperCase()), f('dt'))), `t_${unit}`);
      assert.deepEqual([got[1], got[2], got[3], got[4]], v, `DATETRUNC ${unit}`);
    }
    const hour = await byId(txt(fn('datetrunc', str('hour'), f('dt'))), 't_hour');
    assert.equal(hour[1], '2024-12-30');
    ok('DATETRUNC year/quarter/month/week (Monday)/day: 2020-12-28 is the Monday before 2021-01-03; NULL stays NULL');
  }
  {
    const bad = await app('POST', '/api/query', { ...base(), rowDimensions: [{ db: DB, table: TBL, column: 'x', calc: fn('datename', str('year'), f('dt')) }] });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /DATENAME's part must be 'weekday' or 'month'/);
    const bad2 = await app('POST', '/api/query', { ...base(), rowDimensions: [{ db: DB, table: TBL, column: 'x', calc: fn('datetrunc', str('decade'), f('dt')) }] });
    assert.equal(bad2.status, 400);
    assert.match(bad2.json.error, /DATETRUNC's unit must be one of/);
    ok('an unknown DATENAME part and DATETRUNC unit are 400s');
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
