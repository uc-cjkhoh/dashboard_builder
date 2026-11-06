// Live smoke for the filter on an aggregated measure (HAVING): the dev app (APP_URL, default http://localhost:5180) against a real
// ClickHouse. Creates its fixture in test_cj (bk_having_*) straight over HTTPS — never through the app, which stays read-only — and
// drops it in `finally`. Every expectation comes from an independent oracle: a hand-written SELECT … HAVING run directly on ClickHouse.
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5180';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');
const DB = 'test_cj', T = 'bk_having_orders';

async function ch(sql, { readonly = true } = {}) {
  const qs = new URLSearchParams({ default_format: 'JSONCompact', output_format_json_quote_64bit_integers: '0' });
  if (readonly) qs.set('readonly', '2');
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?${qs}`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 500)}`);
  return text.trim() ? JSON.parse(text).data : [];
}
const select = (sql) => { assert.match(sql, /^\s*SELECT\b/i, 'oracle statements are SELECT only'); return ch(sql); };
const write = (sql) => { assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_having_[a-z]+\b/, `refusing write: ${sql.slice(0, 60)}`); return ch(sql, { readonly: false }); };

let cookie = '';
async function app(method, path, body) {
  const res = await fetch(`${APP}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
const query = async (req, label) => { const r = await app('POST', '/api/query', req); assert.equal(r.status, 200, `${label}: expected 200, got ${r.status} ${r.text.slice(0, 400)}`); return r.json; };
const rejected = async (req, field, label) => { const r = await app('POST', '/api/query', req); assert.equal(r.status, 400, `${label}: expected 400, got ${r.status}`); assert.equal(r.json?.field, field, `${label}: field ${r.json?.field}`); };

const col = (column) => ({ db: DB, table: T, column });
const sum = (column) => ({ db: DB, table: T, column, agg: 'sum' });
const base = () => ({ from: { db: DB, table: T }, joins: [], rowDimensions: [col('region')], columnDimensions: [], measures: [sum('amount')], filters: [], fresh: true });
const flat = (r) => r.rows.map((x) => [x.keys[0], ...x.values.map(Number)]);
const oracle = async (sql) => (await select(sql)).map((row) => [row[0], ...row.slice(1).map(Number)]);
let passed = 0;
const ok = (name) => { passed++; console.log(`ok ${name}`); };

async function main() {
  const conn = await app('POST', '/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);

  let r = await query({ ...base(), having: [{ measure: 0, op: '>=', value: '10' }] }, 'sum >= 10');
  assert.deepEqual(flat(r), await oracle(`SELECT region, sum(amount) FROM ${DB}.${T} GROUP BY region HAVING sum(amount) >= 10 ORDER BY region`));
  assert.deepEqual(flat(r).map((x) => x[0]), ['N', 'S', 'W']);
  ok('sum(amount) >= 10 keeps N, S, W and matches the oracle HAVING');

  r = await query({ ...base(), having: [{ measure: 0, op: 'between', values: ['5', '20'] }] }, 'between');
  assert.deepEqual(flat(r).map((x) => x[0]), ['N', 'S']);
  ok('between 5 and 20 keeps N and S');

  r = await query({ ...base(), measures: [sum('amount'), { db: DB, table: T, column: 'qty', agg: 'count' }], having: [{ measure: 0, op: '>=', value: '10' }, { measure: 1, op: '<', value: '2' }] }, 'two filters');
  assert.deepEqual(flat(r), await oracle(`SELECT region, sum(amount), count(qty) FROM ${DB}.${T} GROUP BY region HAVING sum(amount) >= 10 AND count(qty) < 2 ORDER BY region`));
  ok('two measure filters are ANDed (W only)');

  r = await query({ ...base(), filters: [{ db: DB, table: T, column: 'region', op: '!=', value: 'W' }], having: [{ measure: 0, op: '>=', value: '10' }], withTotal: true }, 'row filter + having + total');
  assert.deepEqual(flat(r).map((x) => x[0]), ['N', 'S']);
  assert.equal(Number(r.total), 2);
  ok('a row filter (WHERE) composes with the measure filter; the total counts the groups that pass');

  r = await query({ ...base(), filters: [{ db: DB, table: T, column: 'region', op: 'top', value: '2', topBy: sum('amount') }], having: [{ measure: 0, op: '<', value: '50' }] }, 'top n + having');
  assert.deepEqual(flat(r).map((x) => x[0]), ['N']); // top 2 by sum = W (100), N (15); the measure filter then drops W
  ok('Top-N ranks first, the measure filter then filters those groups (N only)');

  r = await query({ ...base(), having: [{ measure: 0, op: '>', value: '1' }], limit: 1 }, 'limit');
  assert.equal(r.rows.length, 1); assert.equal(r.truncated, true);
  ok('the limit and the truncation probe still apply after the measure filter');

  r = await query({ ...base(), rowDimensions: [], having: [{ measure: 0, op: '>', value: '100000' }], withTotal: true }, 'no dimension');
  assert.equal(r.rows.length, 0); assert.equal(Number(r.total), 0);
  ok('a view with no dimension: its single group is dropped when it fails; total 0');

  await rejected({ ...base(), having: [{ measure: 0, op: 'like', value: '1' }] }, 'having[0].op', 'operator');
  await rejected({ ...base(), having: [{ measure: 0, op: '>', value: "1; DROP TABLE x" }] }, 'having[0].value', 'value');
  await rejected({ ...base(), having: [{ measure: 3, op: '>', value: '1' }] }, 'having[0].measure', 'measure index');
  await rejected({ ...base(), otherBucket: true, having: [{ measure: 0, op: '>', value: '1' }] }, 'otherBucket', 'other bucket');
  ok('a bad operator, number, measure index and the Other bucket are rejected with 400 (never clamped)');

  await app('POST', '/api/connection/disconnect');
}

try {
  await write(`DROP TABLE IF EXISTS ${DB}.${T}`);
  await write(`CREATE TABLE ${DB}.${T} (region String, amount Float64, qty UInt32) ENGINE = MergeTree ORDER BY region`);
  await write(`INSERT INTO ${DB}.${T} VALUES ('N',10,1),('N',5,2),('S',7.5,3),('S',2.5,4),('E',1,5),('W',100,6)`);
  await main();
} finally {
  await write(`DROP TABLE IF EXISTS ${DB}.${T}`);
  const left = await select(`SELECT name FROM system.tables WHERE database = '${DB}' AND startsWith(name, 'bk_having_')`);
  assert.deepEqual(left, [], `bk_having tables still present: ${JSON.stringify(left)}`);
  console.log('ok teardown: test_cj.bk_having_* dropped');
}
console.log(`\n${passed} ok`);
