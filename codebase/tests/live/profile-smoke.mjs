// Live smoke for the column profile: the dev app (APP_URL, default http://localhost:5180) against a real ClickHouse.
// Creates test_cj.bk_profile* straight over HTTPS (the app stays read-only) and drops them in `finally`.
// Expectations are pinned by hand from the fixture rows below, not from the code under test.
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5180';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');
const DB = 'test_cj';

async function ch(sql) {
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?default_format=JSONCompact`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 400)}`);
}
const write = (sql) => { assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_profile(_empty|_big|_u)?\b/); return ch(sql); };

let cookie = '';
async function app(method, path, body) {
  const res = await fetch(`${APP}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}
const profile = async (table, body, status = 200) => {
  const r = await app('POST', `/api/databases/${DB}/tables/${table}/profile`, body);
  assert.equal(r.status, status, `${table} ${JSON.stringify(body)}: ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
};
let n = 0;
const ok = (name) => console.log(`ok ${++n} ${name}`);
const tops = (p) => p.top.map((t) => [t.value, t.count]);

async function main() {
  for (const t of ['bk_profile', 'bk_profile_empty', 'bk_profile_big', 'bk_profile_u']) await write(`DROP TABLE IF EXISTS test_cj.${t}`);
  await write(`CREATE TABLE test_cj.bk_profile (id UInt32, grp Nullable(String), n Nullable(Int32), d Date, big String, arr Array(UInt8)) ENGINE = MergeTree ORDER BY id`);
  await write(`INSERT INTO test_cj.bk_profile VALUES
    (1,'a',10,'2024-03-01','${'x'.repeat(150)}',[1,2]),
    (2,'a',20,'2024-03-09','v2',[1,2]),
    (3,'b',NULL,'2024-03-05','v3',[]),
    (4,NULL,5,'2024-03-02','v4',[3]),
    (5,'b',5,'2024-03-03','v5',[3]),
    (6,'c',7,'2024-03-04','v6',[])`);
  await write(`CREATE TABLE test_cj.bk_profile_empty (id UInt32, s String) ENGINE = MergeTree ORDER BY id`);
  await write(`CREATE TABLE test_cj.bk_profile_big (id UInt32, s String) ENGINE = MergeTree ORDER BY id`);
  await write(`INSERT INTO test_cj.bk_profile_big SELECT number, toString(number) FROM numbers(2000)`);
  // non-ASCII text: the cut is in characters (leftUTF8), never bytes, and the cut flag is exact
  await write(`CREATE TABLE test_cj.bk_profile_u (id UInt32, s String) ENGINE = MergeTree ORDER BY id`);
  await write(`INSERT INTO test_cj.bk_profile_u VALUES (1,'${'é'.repeat(100)}'), (2,'${'日本語'.repeat(40)}'), (3,'${'ก'.repeat(101)}'), (4,'${'a'.repeat(100)}X'), (5,'${'a'.repeat(100)}Y')`);
  const conn = await app('POST', '/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);

  // grp: a x2, b x2 (a tie, broken by value), c x1, NULL x1 (NULL last among equal counts)
  let p = await profile('bk_profile', { column: 'grp' });
  assert.deepEqual([p.rows, p.nulls, p.distinct, p.category], [6, 1, 3, 'text']);
  assert.deepEqual(tops(p), [['a', 2], ['b', 2], ['c', 1], [null, 1]]);
  assert.equal(p.min, null); assert.equal(p.max, null);
  ok('text with NULLs and a tie: rows 6, nulls 1, distinct 3, top a2 b2 c1 NULL1');

  // n: 10,20,NULL,5,5,7 -> nulls 1, distinct {5,7,10,20} = 4, min 5, max 20
  p = await profile('bk_profile', { column: 'n' });
  assert.deepEqual([p.rows, p.nulls, p.distinct, p.min, p.max], [6, 1, 4, '5', '20']);
  assert.deepEqual(tops(p)[0], ['5', 2]);
  ok('Nullable Int32: nulls 1, distinct 4, min 5, max 20, most frequent 5 (x2)');

  p = await profile('bk_profile', { column: 'd' });
  assert.deepEqual([p.min, p.max, p.distinct, p.nulls], ['2024-03-01', '2024-03-09', 6, 0]); ok('Date: min 2024-03-01, max 2024-03-09, no NULLs');

  p = await profile('bk_profile', { column: 'big', limit: 6 });
  const longV = p.top.find((t) => t.cut);
  assert.equal(p.top.length, 6); assert.equal(longV.value, 'x'.repeat(100)); assert.equal(p.top.filter((t) => t.cut).length, 1); assert.equal(p.distinct, 6);
  assert.equal((await profile('bk_profile', { column: 'big', limit: 1 })).top.length, 1);
  ok('a 150-character value is cut to 100 and flagged; limit 1 returns one value');

  p = await profile('bk_profile', { column: 'arr' });
  assert.equal(p.category, 'compound'); assert.equal(p.distinct, 3);
  assert.deepEqual(tops(p).slice(0, 2).map((t) => t[1]), [2, 2]); ok('Array column profiles as text: 3 distinct arrays, two appear twice');

  p = await profile('bk_profile_empty', { column: 's' });
  assert.deepEqual([p.rows, p.nulls, p.distinct, p.top.length], [0, 0, 0, 0]); ok('an empty table profiles to zeros and no top values');
  p = await profile('bk_profile_empty', { column: 'id' });
  assert.equal(p.min, null); assert.equal(p.max, null); ok('an empty numeric column has no min/max (not 0)');

  p = await profile('bk_profile_big', { column: 's' });
  assert.equal(p.rows, 2000); assert.ok(Math.abs(p.distinct - 2000) <= 40, `distinct ${p.distinct}`);
  assert.equal(p.top.length, 10); assert.ok(p.top.every((t) => t.count === 1)); ok('high cardinality: 2000 rows, ~2000 distinct (approximate), 10 top values each x1');
  p = await profile('bk_profile_big', { column: 's', limit: 50 });
  assert.equal(p.top.length, 50); ok('limit 50 returns 50 top values');

  p = await profile('bk_profile_u', { column: 's' });
  assert.equal(p.rows, 5); assert.equal(p.distinct, 5);
  assert.deepEqual(p.top.map((t) => [t.value, t.count, t.cut]), [
    ['a'.repeat(100), 2, true],                 // 'a'*100+X and +Y differ only after character 100: one group
    ['é'.repeat(100), 1, false],                // exactly 100 characters (200 bytes): not cut
    ['ก'.repeat(100), 1, true],                 // 101 Thai characters: cut to 100
    ['日本語'.repeat(33) + '日', 1, true],         // 120 CJK characters: cut to 100
  ]); ok('non-ASCII values are cut by characters not bytes (exactly 100 = not cut, 101+ = cut); values differing after character 100 merge');

  await profile('bk_profile', { column: 'nope' }, 404); ok('an unknown column is 404');
  await profile('bk_profile', { column: 'grp`; DROP TABLE x; --' }, 404); ok('a hostile column name is 404 and never reaches SQL');
  await profile('nope_table', { column: 'a' }, 404); ok('an unknown table is 404');
  await profile('bk_profile', { column: 'grp', limit: 51 }, 400); await profile('bk_profile', { column: 'grp', limit: 0 }, 400); ok('limit 0 and 51 are 400');
  await profile('bk_profile', { column: '' }, 400); ok('a blank column is 400');
}
try { await main(); console.log(`all ${n} ok`); }
finally { for (const t of ['bk_profile', 'bk_profile_empty', 'bk_profile_big', 'bk_profile_u']) await write(`DROP TABLE IF EXISTS test_cj.${t}`).catch(() => {}); }
