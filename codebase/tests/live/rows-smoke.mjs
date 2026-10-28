// Live smoke for POST /api/rows: the dev app (APP_URL, default http://localhost:5183) against a real ClickHouse.
// Fixture table test_cj.bk_rows is created and dropped straight over HTTPS; the app stays read-only. Oracles are
// hand-written SELECTs run on ClickHouse. Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed);
// NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5183';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');
const DB = 'test_cj', T = 'bk_rows';

async function ch(sql, readonly) {
  const qs = new URLSearchParams({ default_format: 'JSONCompact', output_format_json_quote_64bit_integers: '0' });
  if (readonly) qs.set('readonly', '2');
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?${qs}`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 300)}`);
  return text.trim() ? JSON.parse(text).data : [];
}
const select = (sql) => { assert.match(sql, /^\s*SELECT\b/i); return ch(sql, true); };
const write = (sql) => { assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_rows\b/); return ch(sql, false); };

let cookie = '';
async function app(path, body) {
  const res = await fetch(`${APP}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body ?? {}) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
const rows = (extra) => app('/api/rows', { db: DB, table: T, ...extra });

let passed = 0, failed = false;
try {
  await write(`CREATE TABLE ${DB}.${T} (id UInt32, name Nullable(String), qty Float64, d Date, blob String) ENGINE = MergeTree ORDER BY id`);
  await write(`INSERT INTO ${DB}.${T} SELECT number, if(number % 10 = 0, NULL, concat('n', toString(number))), number / 4, toDate('2024-01-01') + number, repeat('x', 1500) FROM numbers(150)`);
  const conn = await app('/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);
  assert.equal(Number((await select(`SELECT count() FROM ${DB}.${T}`))[0][0]), 150);

  let r = await rows({});
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.json.rows.length, 100); assert.equal(r.json.truncated, true); assert.equal(r.json.limit, 100);
  assert.deepEqual(r.json.columns.map((c) => [c.name, c.type]), [['id', 'UInt32'], ['name', 'Nullable(String)'], ['qty', 'Float64'], ['d', 'Date'], ['blob', 'String']]);
  console.log('ok default limit 100 of 150, truncated, column names and raw types'); passed++;

  r = await rows({ limit: 150 });
  assert.equal(r.json.rows.length, 150); assert.equal(r.json.truncated, false);
  r = await rows({ limit: 5 });
  assert.equal(r.json.rows.length, 5); assert.equal(r.json.truncated, true);
  console.log('ok limit 150 = all rows, not truncated; limit 5 = 5 rows, truncated'); passed++;

  r = await rows({ columns: ['qty', 'name', 'd'], limit: 3 });
  assert.deepEqual(r.json.columns.map((c) => c.name), ['qty', 'name', 'd']);
  assert.equal(r.json.rows[0][1], null);            // id 0 has a NULL name
  assert.equal(r.json.rows[1][1], 'n1');
  assert.equal(r.json.rows[1][2], '2024-01-02');    // a Date, as ISO text
  assert.equal(r.json.rows[1][0], '0.25');
  console.log('ok requested columns in order; NULL is JSON null; a Date is ISO text'); passed++;

  r = await rows({ columns: ['id'], filters: [{ column: 'name', op: '=', value: 'n7' }] });
  assert.deepEqual(r.json.rows, [['7']]);
  r = await rows({ columns: ['id'], filters: [{ column: 'qty', op: 'between', value: '', values: ['1', '2'] }, { column: 'name', op: 'notin', value: '', values: ['n4'] }], limit: 50 });
  const oracle = (await select(`SELECT id FROM ${DB}.${T} WHERE qty >= 1 AND qty <= 2 AND (name NOT IN ('n4') OR isNull(name)) LIMIT 50`)).map((x) => String(x[0]));
  assert.deepEqual(r.json.rows.map((x) => x[0]), oracle);
  console.log(`ok filters bind values (= and between + notin match the oracle, ${oracle.length} rows)`); passed++;

  r = await rows({ columns: ['id'], filters: [{ column: 'name', op: '=', value: "x' OR 1=1 --" }] });
  assert.equal(r.status, 200); assert.deepEqual(r.json.rows, []);
  console.log('ok an injection-shaped value is just a value (0 rows)'); passed++;

  r = await rows({ columns: ['blob'], limit: 1 });
  assert.equal(r.json.rows[0][0].length, 1001); assert.ok(r.json.rows[0][0].endsWith('…'));
  console.log('ok a 1500-character cell is cut to 1000 characters plus an ellipsis'); passed++;

  for (const [name, body] of [['limit 0', { limit: 0 }], ['limit 1001', { limit: 1001 }], ['limit -1', { limit: -1 }],
    ['unknown column', { columns: ['nope'] }], ['hostile column', { columns: ['id`, (SELECT 1) AS `x'] }],
    ['unknown filter column', { filters: [{ column: 'nope', op: '=', value: '1' }] }], ['unknown operator', { filters: [{ column: 'id', op: 'drop', value: '1' }] }],
    ['top-N', { filters: [{ column: 'id', op: 'top', value: '1' }] }], ['a non-number on a number column', { filters: [{ column: 'qty', op: '=', value: 'abc' }] }]]) {
    const x = await rows(body);
    assert.equal(x.status, 400, `${name}: ${x.status} ${x.text.slice(0, 120)}`);
    assert.ok(typeof x.json?.error === 'string', `${name}: error shape`);
  }
  assert.equal((await app('/api/rows', { db: DB, table: 'no_such_table' })).status, 400);
  assert.equal((await app('/api/rows', { db: 'no_such_db', table: T })).status, 400);
  console.log('ok out-of-range limit, unknown names, bad operators and values are all 400 (never clamped)'); passed++;
  await app('/api/connection/disconnect');
  const none = await rows({});
  assert.equal(none.status, 409);
  console.log('ok without a connection it is 409'); passed++;
} catch (e) { failed = true; console.error(`FAIL: ${e.message}`); }
finally {
  await write(`DROP TABLE IF EXISTS ${DB}.${T}`);
  const left = await select(`SELECT name FROM system.tables WHERE database = '${DB}' AND name = '${T}'`);
  if (left.length) { failed = true; console.error('fixture table still present'); }
}
console.log(`${passed} checks passed${failed ? ', FAILED' : ''}`);
process.exit(failed ? 1 : 0);
