// Live smoke for POST /api/unpivot (SPLIT itself is pinned by text-smoke.mjs): the dev app (APP_URL, default http://localhost:5224) against a real ClickHouse.
// Fixture tables test_cj.bk_unpivot_a is created and dropped over HTTPS; the app stays read-only.
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5224';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');
const DB = 'test_cj';
const TABLES = ['bk_unpivot_a'];

async function ch(sql) {
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?default_format=JSONCompact`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 300)}`);
}
const write = (sql) => { assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_unpivot_a\b/); return ch(sql); };

let cookie = '';
async function app(path, body) {
  const res = await fetch(`${APP}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body ?? {}) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
const unpivot = (extra) => app('/api/unpivot', { db: DB, table: 'bk_unpivot_a', columns: ['q1', 'q2', 'q3'], keep: ['id'], ...extra });

let passed = 0, failed = false;
try {
  await write(`CREATE TABLE ${DB}.bk_unpivot_a (id UInt32, region String, q1 Nullable(Int32), q2 Int32, q3 Int32, note String, k0 String, __p String, Field String) ENGINE = MergeTree ORDER BY id`);
  await write(`INSERT INTO ${DB}.bk_unpivot_a SELECT number, 'EU', if(number = 0, NULL, toInt32(number)), toInt32(number * 10), toInt32(number * 100), 'n', concat('key', toString(number)), 'pp', 'ff' FROM numbers(50)`);
  const conn = await app('/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);

  let r = await unpivot({ limit: 150 });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.deepEqual(r.json.columns.map((c) => c.name), ['id', 'Field', 'Value']);
  assert.equal(r.json.rows.length, 150); assert.equal(r.json.truncated, false, '50 rows x 3 columns = 150 exactly');
  const row0 = r.json.rows.filter((x) => x[0] === '0');
  assert.deepEqual(row0.map((x) => x[1]).sort(), ['q1', 'q2', 'q3']);
  assert.equal(row0.find((x) => x[1] === 'q1')[2], null, 'a NULL value stays NULL');
  assert.equal(row0.find((x) => x[1] === 'q2')[2], '0', 'zero stays zero');
  const row7 = r.json.rows.filter((x) => x[0] === '7');
  assert.deepEqual(row7.map((x) => [x[1], x[2]]).sort(), [['q1', '7'], ['q2', '70'], ['q3', '700']]);
  console.log('ok 150 rows: each source row once per column, NULL and zero kept distinct'); passed++;

  r = await unpivot({ limit: 20 });
  assert.equal(r.json.rows.length, 20); assert.equal(r.json.truncated, true);
  r = await unpivot({});
  assert.equal(r.json.rows.length, 100); assert.equal(r.json.truncated, true); assert.equal(r.json.limit, 100);
  r = await unpivot({ keep: [] });
  assert.deepEqual(r.json.columns.map((c) => c.name), ['Field', 'Value']);
  console.log('ok bounded by the limit (truncated), default 100, no kept column'); passed++;

  // Source columns named like helper aliases (k0, __p) and like the result's Field column.
  r = await unpivot({ columns: ['q1', 'q2'], keep: ['k0', '__p', 'Field'], limit: 6 });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.deepEqual(r.json.columns.map((c) => c.name), ['k0', '__p', 'Field', 'Field_', 'Value']);
  assert.ok(r.json.columns.every((c, i) => i < 3 || c.type === 'String'));
  assert.deepEqual(r.json.rows.slice(0, 2).map((x) => x.slice(0, 3)), [['key0', 'pp', 'ff'], ['key0', 'pp', 'ff']], 'kept columns are the source columns, not helper aliases');
  assert.deepEqual(r.json.rows.slice(0, 2).map((x) => x[3]).sort(), ['q1', 'q2']);
  console.log('ok source columns named k0 / __p / Field do not collide'); passed++;

  r = await unpivot({ db: 'no_such_db_x' });
  assert.ok(r.status === 400 || r.status === 404, `unknown db ${r.status}`);
  r = await unpivot({ table: 'no_such_table_x' });
  assert.ok(r.status === 400 || r.status === 404, `unknown table ${r.status}`);
  console.log('ok unknown db / table refused'); passed++;

  r = await unpivot({ columns: ['q1', 'note'] });
  assert.equal(r.status, 400); assert.equal(r.json.field, 'columns[1]');
  r = await unpivot({ columns: ['q1', 'nope'] });
  assert.equal(r.status, 400);
  r = await unpivot({ columns: ['q1'] });
  assert.equal(r.status, 400); assert.equal(r.json.field, 'columns');
  r = await unpivot({ keep: ['q1'] });
  assert.equal(r.status, 400); assert.equal(r.json.field, 'keep[0]');
  r = await unpivot({ limit: 1001 });
  assert.equal(r.status, 400); assert.equal(r.json.field, 'limit');
  r = await unpivot({ table: 'nope' });
  assert.ok(r.status === 400 || r.status === 404, `unknown table ${r.status}`);
  r = await unpivot({ columns: ['q1', 'q2`; DROP TABLE x; --'] });
  assert.equal(r.status, 400);
  console.log('ok refusals: kind mismatch, unknown column / table, one column, kept twice, limit, injection text'); passed++;
} catch (e) { console.log(`FAIL ${e.stack}`); failed = true; }
finally {
  for (const t of TABLES) { try { await write(`DROP TABLE IF EXISTS ${DB}.${t}`); } catch (e) { console.log(`cleanup ${t}: ${e.message}`); } }
}
console.log(`\n${passed} ok${failed ? ', FAILED' : ''}`);
process.exit(failed ? 1 : 0);
