// Live smoke for compound join keys: the dev app (APP_URL, default http://localhost:5223) against a real ClickHouse. Fixtures live in
// test_cj (bk_cj_*), created straight over HTTPS (never through the app, which stays read-only) and dropped in `finally`.
// Expectations are hand-computed from the inserted rows. Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS.
import assert from 'node:assert/strict';
const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5223';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');
const DB = 'test_cj', A = 'bk_cj_a', B = 'bk_cj_b', C = 'bk_cj_c', D = 'bk_cj_d';
async function ch(sql) {
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const t = await res.text(); if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${t.slice(0, 300)}`);
}
const write = (sql) => { assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_cj_[a-d]\b/); return ch(sql); };
let cookie = '';
async function app(path, body) {
  const res = await fetch(APP + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const set = res.headers.getSetCookie?.() ?? []; if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const col = (column, table) => ({ db: DB, table, column });
const meas = (column, table, agg) => ({ db: DB, table, column, agg });
const key = (t, c) => ({ db: DB, table: t, column: c });
const req = (type, pairs) => ({
  from: { db: DB, table: A }, joins: [{ left: col('k1', A), right: col('k1', B), ...(type ? { type } : {}), ...(pairs ? { pairs } : {}) }],
  rowDimensions: [col('name', B)], columnDimensions: [], measures: [meas('v', A, 'sum'), meas('w', B, 'sum'), meas('k1', A, 'count')], filters: [], fresh: true });
const byName = (r) => Object.fromEntries(r.rows.map((x) => [x.keys[0], x.values.map((v) => (v === null ? null : Number(v)))]));
try {
  for (const t of [A, B, C, D]) await write(`DROP TABLE IF EXISTS ${DB}.${t}`);
  await write(`CREATE TABLE ${DB}.${A} (k1 Int32, k2 Nullable(String), v Float64) ENGINE = Memory`);
  await write(`INSERT INTO ${DB}.${A} VALUES (1,'x',10),(1,'y',20),(2,'x',5),(2,NULL,7)`);
  await write(`CREATE TABLE ${DB}.${B} (k1 Int32, k2 Nullable(String), w Float64, name String) ENGINE = Memory`);
  await write(`INSERT INTO ${DB}.${B} VALUES (1,'x',1,'ax'),(1,'z',2,'az'),(2,'x',3,'bx')`);
  await write(`CREATE TABLE ${DB}.${C} (k Decimal(10, 2), d DateTime) ENGINE = Memory`);
  await write(`INSERT INTO ${DB}.${C} VALUES (1.00,'2024-01-01 00:00:00'),(2.50,'2024-01-02 00:00:00')`);
  await write(`CREATE TABLE ${DB}.${D} (k Int32, d Date) ENGINE = Memory`);
  await write(`INSERT INTO ${DB}.${D} VALUES (1,'2024-01-01'),(3,'2024-01-03')`);
  const conn = await app('/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, 'connect');
  const pair = [{ left: 'k2', right: 'k2' }];
  const single = await app('/api/query', req('inner'));
  assert.equal(single.status, 200, single.text.slice(0, 300));
  assert.deepEqual(byName(single.json), { ax: [30, 2, 2], az: [30, 4, 2], bx: [12, 6, 2] }, 'single key k1 only');
  const inner = await app('/api/query', req('inner', pair));
  assert.equal(inner.status, 200, inner.text.slice(0, 300));
  assert.deepEqual(byName(inner.json), { ax: [10, 1, 1], bx: [5, 3, 1] }, 'compound inner');
  console.log('ok compound inner join (k1 AND k2) keeps only rows matching on both');
  const left = await app('/api/query', req('left', pair));
  assert.equal(left.status, 200, left.text.slice(0, 300));
  const l = byName(left.json);
  assert.deepEqual(l.ax, [10, 1, 1]); assert.deepEqual(l.bx, [5, 3, 1]);
  const unmatched = Object.entries(l).filter(([k]) => k !== 'ax' && k !== 'bx');
  assert.equal(unmatched.length, 1); assert.deepEqual(unmatched[0][1], [27, null, 2]); // A(1,y) and A(2,NULL): a NULL part never matches
  console.log('ok compound left join: unmatched rows incl. a NULL key part land in one NULL-extended group');
  const prev = await app('/api/relationships/preview', { from: key(A, 'k1'), to: key(B, 'k1'), pairs: pair });
  assert.equal(prev.status, 200, prev.text.slice(0, 300));
  assert.deepEqual(prev.json.from, { rows: 4, nullRows: 1, keys: 3, matchedKeys: 2, matchedRows: 2, maxDuplicates: 1, avgDuplicates: 1 });
  assert.deepEqual(prev.json.to, { rows: 3, nullRows: 0, keys: 3, matchedKeys: 2, matchedRows: 2, maxDuplicates: 1, avgDuplicates: 1 });
  console.log('ok compound preview counts (NULL part = NULL key)');
  // Mixed types of one kind still match, as the real join coerces them: Decimal 1.00 = Int 1, DateTime midnight = Date.
  const mixed = await app('/api/relationships/preview', { from: key(C, 'k'), to: key(D, 'k'), pairs: [{ left: 'd', right: 'd' }] });
  assert.equal(mixed.status, 200, mixed.text.slice(0, 300));
  assert.deepEqual([mixed.json.from.matchedKeys, mixed.json.from.keys, mixed.json.to.matchedKeys, mixed.json.to.keys], [1, 2, 1, 2], 'Decimal-vs-Int and DateTime-vs-Date compound key');
  console.log('ok compound preview: Decimal vs Int and DateTime vs Date parts match');
  // Rejections: too many pairs, a bad column, a hostile column never reaches SQL.
  assert.equal((await app('/api/query', req('inner', [pair[0], pair[0], pair[0], pair[0]]))).status, 400);
  assert.equal((await app('/api/query', req('inner', [{ left: 'k2', right: 'nope' }]))).status, 400);
  assert.equal((await app('/api/query', req('inner', [{ left: 'k2`; DROP TABLE x; --', right: 'k2' }]))).status, 400);
  assert.equal((await app('/api/relationships/preview', { from: key(A, 'k1'), to: key(B, 'k1'), pairs: [{ left: 'v', right: 'name' }] })).status, 400); // number vs text
  console.log('ok pair-count, unknown / hostile column and kind rejections are 400');
} finally {
  for (const t of [A, B, C, D]) await write(`DROP TABLE IF EXISTS ${DB}.${t}`).catch(() => {});
}
