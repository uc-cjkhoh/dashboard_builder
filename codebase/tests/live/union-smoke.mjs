// Live smoke for POST /api/union: the dev app (APP_URL, default http://localhost:5220) against a real ClickHouse.
// Fixture tables test_cj.bk_union_a / bk_union_b / bk_union_c are created and dropped over HTTPS; the app stays read-only.
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5220';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');
const DB = 'test_cj';
const TABLES = ['bk_union_a', 'bk_union_b', 'bk_union_c'];

async function ch(sql) {
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?default_format=JSONCompact`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 300)}`);
}
const write = (sql) => { assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_union_[abc]\b/); return ch(sql); };

let cookie = '';
async function app(path, body) {
  const res = await fetch(`${APP}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body ?? {}) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
const union = (extra) => app('/api/union', { db: DB, tables: ['bk_union_a', 'bk_union_b'], ...extra });

let passed = 0, failed = false;
try {
  await write(`CREATE TABLE ${DB}.bk_union_a (id UInt32, name Nullable(String), only_a String) ENGINE = MergeTree ORDER BY id`);
  await write(`CREATE TABLE ${DB}.bk_union_b (name String, id Int64, only_b UInt8) ENGINE = MergeTree ORDER BY id`);
  await write(`CREATE TABLE ${DB}.bk_union_c (id String, other UInt8) ENGINE = MergeTree ORDER BY other`);
  await write(`INSERT INTO ${DB}.bk_union_a SELECT number, if(number = 0, NULL, concat('a', toString(number))), 'x' FROM numbers(60)`);
  await write(`INSERT INTO ${DB}.bk_union_b SELECT concat('b', toString(number)), number + 1000, 1 FROM numbers(70)`);
  await write(`INSERT INTO ${DB}.bk_union_c SELECT toString(number), 1 FROM numbers(5)`);
  const conn = await app('/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);

  let r = await union({ limit: 200 });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.deepEqual(r.json.columns.map((c) => c.name), ['Source table', 'id', 'name'], 'shared columns in the first table order');
  assert.equal(r.json.rows.length, 130); assert.equal(r.json.truncated, false);
  const bySource = {}; for (const row of r.json.rows) bySource[row[0]] = (bySource[row[0]] ?? 0) + 1;
  assert.deepEqual(bySource, { bk_union_a: 60, bk_union_b: 70 });
  assert.ok(r.json.rows.some((row) => row[0] === 'bk_union_a' && row[2] === null), 'a NULL stays NULL');
  console.log('ok 130 rows from both tables, source first, shared columns only'); passed++;

  r = await union({ limit: 20 });
  assert.equal(r.json.rows.length, 20); assert.equal(r.json.truncated, true);
  const small = {}; for (const row of r.json.rows) small[row[0]] = (small[row[0]] ?? 0) + 1;
  assert.deepEqual(small, { bk_union_a: 10, bk_union_b: 10 }, 'both tables appear at a small limit');
  r = await union({ limit: 100 });
  assert.equal(r.json.rows.length, 100); assert.equal(r.json.truncated, true);
  r = await union({});
  assert.equal(r.json.rows.length, 100); assert.equal(r.json.limit, 100);
  console.log('ok default limit 100, truncated'); passed++;

  r = await union({ columns: ['name'], limit: 5 });
  assert.deepEqual(r.json.columns.map((c) => c.name), ['Source table', 'name']);
  assert.equal(r.json.rows.length, 5);
  console.log('ok a requested column subset'); passed++;

  r = await union({ tables: ['bk_union_a', 'bk_union_c'] });
  assert.equal(r.status, 400, 'id is a number in a, text in c: no shared kind, no other shared name'); assert.equal(r.json.field, 'tables');
  r = await union({ tables: ['bk_union_a', 'bk_union_c'], columns: ['id'] });
  assert.equal(r.status, 400); assert.equal(r.json.field, 'columns[0]');
  r = await union({ columns: ['only_a'] });
  assert.equal(r.status, 400); // unknown in b
  r = await union({ tables: ['bk_union_a', 'nope'] });
  assert.equal(r.status, 400);
  r = await union({ tables: ['bk_union_a'] });
  assert.equal(r.status, 400); assert.equal(r.json.field, 'tables');
  r = await union({ limit: 1001 });
  assert.equal(r.status, 400); assert.equal(r.json.field, 'limit');
  r = await union({ tables: ['bk_union_a', 'bk_union_b`; DROP TABLE x; --'] });
  assert.equal(r.status, 400);
  console.log('ok refusals: kind mismatch, unknown column / table, one table, limit, injection text'); passed++;
} catch (e) { console.log(`FAIL ${e.stack}`); failed = true; }
finally {
  for (const t of TABLES) { try { await write(`DROP TABLE IF EXISTS ${DB}.${t}`); } catch (e) { console.log(`cleanup ${t}: ${e.message}`); } }
}
console.log(`\n${passed} ok${failed ? ', FAILED' : ''}`);
process.exit(failed ? 1 : 0);
