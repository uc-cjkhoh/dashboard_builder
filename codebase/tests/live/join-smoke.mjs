// Live smoke for inner/left/right/full joins (T02-12/13): the dev app (APP_URL, default http://localhost:5180) against a real
// ClickHouse. Creates its fixture tables in test_cj (bk_joins_*) straight over HTTPS — never through the
// app, which stays read-only — and drops them in `finally`. Every expectation beyond the pinned core values
// comes from an independent oracle: a hand-written SELECT run directly on ClickHouse.
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5180';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');

const DB = 'test_cj';
const A = 'bk_joins_a', B = 'bk_joins_b';
const TABLES = [A, B];

// ---- ClickHouse over HTTPS --------------------------------------------------------------------------
async function ch(sql, { readonly = true } = {}) {
  const qs = new URLSearchParams({ default_format: 'JSONCompact', output_format_json_quote_64bit_integers: '0' });
  if (readonly) qs.set('readonly', '2');
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?${qs}`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 500)}`);
  return text.trim() ? JSON.parse(text).data : [];
}
const select = (sql) => {
  assert.match(sql, /^\s*SELECT\b/i, 'oracle statements are SELECT only');
  return ch(sql);
};
// The only writes this script makes: DDL / inserts on test_cj.bk_joins_* tables.
const write = (sql) => {
  assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_joins_[a-z]+\b/, `refusing write: ${sql.slice(0, 60)}`);
  return ch(sql, { readonly: false });
};

// ---- the app ----------------------------------------------------------------------------------------
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

const col = (column, table) => ({ db: DB, table, column });
const meas = (column, table, aggName) => ({ db: DB, table, column, agg: aggName });
const req = (from, to, type, extra = {}) => ({
  from: { db: DB, table: from }, joins: [{ left: col('k', from), right: col('k', to), type }],
  rowDimensions: [col('name', B)], columnDimensions: [],
  measures: [meas('v', A, 'sum'), meas('w', B, 'sum'), meas('k', A, 'count')], filters: [], fresh: true, ...extra });
const byName = (r) => Object.fromEntries(r.rows.map((x) => [x.keys[0], x.values.map((v) => (v === null ? null : Number(v)))]));
const ok = (n) => console.log(`ok ${n}`);

// A: keys 1, 2, 2, 4, NULL.  B: keys 1, 2, 3, NULL.  A NULL key never matches (NULL <> NULL in a join).
// Grouped by B.name; measures [sum A.v, sum B.w, count()] (hand-computed):
const EXPECT = {
  inner: { one: [10, 1, 1], two: [25, 4, 2] },
  left:  { one: [10, 1, 1], two: [25, 4, 2], null: [107, null, 2] },           // A rows 4 and NULL have no B row: name is NULL (not ''), sum B.w is NULL (not 0)
  right: { one: [10, 1, 1], two: [25, 4, 2], three: [null, 3, 1], nul: [null, 50, 1] },
  full:  { one: [10, 1, 1], two: [25, 4, 2], three: [null, 3, 1], nul: [null, 50, 1], null: [107, null, 2] },
};

async function main() {
  const conn = await app('POST', '/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);
  for (const t of ['inner', 'left', 'right', 'full']) {
    const r = await query(req(A, B, t), t);
    assert.deepEqual(byName(r), EXPECT[t], `${t}: app result ${JSON.stringify(byName(r))}`);
    ok(`${t} join: groups, NULL (not '') for the unmatched side, sums, counts`);
  }
  // Same relationship planned from the other table: B as base with A joined LEFT keeps B's rows == A-from RIGHT.
  assert.deepEqual(byName(await query(req(B, A, 'left'), 'B left A')), EXPECT.right);
  assert.deepEqual(byName(await query(req(B, A, 'right'), 'B right A')), EXPECT.left);
  ok('swapping the base table swaps left and right (preserved side follows the keyword)');
  // Total group count, "Other" bucket and a date-free auto path run with the nulls setting too.
  const t = await query(req(A, B, 'full', { withTotal: true }), 'full total');
  assert.equal(t.total, 5);
  ok('full join: group total counts the NULL group');
  const o = await query(req(A, B, 'full', { limit: 2, otherBucket: true, sort: { column: 'k0', desc: false } }), 'full other');
  assert.ok(o.truncated);
  assert.ok(o.other, 'Other bucket present');
  ok('full join: Other bucket answered');
  // A base-table filter turns the outer join into an inner one for the filtered rows (documented): v > 8 drops the NULL-extended B rows.
  const f = await query(req(A, B, 'right', { filters: [{ db: DB, table: A, column: 'v', op: '>', value: '8' }] }), 'filtered');
  assert.deepEqual(byName(f), { one: [10, 1, 1], two: [20, 2, 1] });
  ok('WHERE on the preserved-away side drops its NULL-extended rows (right join + A filter)');
  // Rejections.
  const top = await app('POST', '/api/query', req(A, B, 'full', { filters: [{ db: DB, table: B, column: 'name', op: 'top', value: '2', topBy: meas('w', B, 'sum') }] }));
  assert.equal(top.status, 400); assert.match(top.json.error, /top-N/i);
  const bad = await app('POST', '/api/query', req(A, B, 'cross'));
  assert.equal(bad.status, 400);
  ok('top-N with a right/full join and unknown join types are 400');
  const ap = await query(req(A, B, 'full', { approximate: true }), 'approx');
  assert.deepEqual(byName(ap), EXPECT.full);
  assert.equal(ap.approx?.sample ?? null, null);
  ok('approximate mode with a full join reads exactly (no sample)');
}

try {
  for (const t of TABLES) await write(`DROP TABLE IF EXISTS ${DB}.${t}`);
  await write(`CREATE TABLE ${DB}.${A} (k Nullable(Int32), v Float64) ENGINE = MergeTree ORDER BY tuple() SETTINGS allow_nullable_key = 1`);
  await write(`INSERT INTO ${DB}.${A} VALUES (1,10),(2,20),(2,5),(4,7),(NULL,100)`);
  await write(`CREATE TABLE ${DB}.${B} (k Nullable(Int32), w Float64, name String) ENGINE = MergeTree ORDER BY tuple() SETTINGS allow_nullable_key = 1`);
  await write(`INSERT INTO ${DB}.${B} VALUES (1,1,'one'),(2,2,'two'),(3,3,'three'),(NULL,50,'nul')`);
  await main();
} catch (e) {
  console.error(e); process.exitCode = 1;
} finally {
  for (const t of TABLES) await write(`DROP TABLE IF EXISTS ${DB}.${t}`);
  const left = await select(`SELECT name FROM system.tables WHERE database = '${DB}' AND startsWith(name, 'bk_joins_')`);
  console.log(left.length ? `LEFTOVER TABLES: ${JSON.stringify(left)}` : 'ok teardown: test_cj.bk_joins_* dropped');
}
