// Live smoke for the join safety preview: dev app (APP_URL) against a real ClickHouse. Fixtures live in test_cj (bk_jp_*), created
// straight over HTTPS (never through the app) and dropped in `finally`. Expected counts are hand-computed from the inserted rows.
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';
const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5196';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');
const DB = 'test_cj';
const TABLES = ['bk_jp_a', 'bk_jp_b', 'bk_jp_c', 'bk_jp_d', 'bk_jp_s'];
async function ch(sql) {
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const t = await res.text(); if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${t.slice(0, 300)}`);
}
const write = (sql) => { assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_jp_[a-z]\b/); return ch(sql); };
let cookie = '';
async function app(path, body) {
  const res = await fetch(APP + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const set = res.headers.getSetCookie?.() ?? []; if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const key = (t, c) => ({ db: DB, table: t, column: c });
try {
  for (const t of TABLES) await write(`DROP TABLE IF EXISTS ${DB}.${t}`);
  await write(`CREATE TABLE ${DB}.bk_jp_a (k Nullable(Int32)) ENGINE = Memory`);
  await write(`INSERT INTO ${DB}.bk_jp_a VALUES (1),(1),(1),(2),(3),(NULL),(NULL),(5)`);
  await write(`CREATE TABLE ${DB}.bk_jp_b (k Nullable(Int32)) ENGINE = Memory`);
  await write(`INSERT INTO ${DB}.bk_jp_b VALUES (1),(2),(2),(4),(NULL)`);
  await write(`CREATE TABLE ${DB}.bk_jp_c (d Date) ENGINE = Memory`);
  await write(`INSERT INTO ${DB}.bk_jp_c VALUES ('2024-01-01'),('2024-01-02')`);
  await write(`CREATE TABLE ${DB}.bk_jp_d (t DateTime) ENGINE = Memory`);
  await write(`INSERT INTO ${DB}.bk_jp_d VALUES ('2024-01-01 00:00:00'),('2024-01-03 00:00:00')`);
  await write(`CREATE TABLE ${DB}.bk_jp_s (u UUID) ENGINE = Memory`);
  await write(`INSERT INTO ${DB}.bk_jp_s VALUES ('00000000-0000-0000-0000-000000000001')`);

  assert.equal((await app('/api/relationships/preview', { from: key('bk_jp_a', 'k'), to: key('bk_jp_b', 'k') })).status, 409, '409 before connecting');
  const conn = await app('/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200);

  const r = await app('/api/relationships/preview', { from: key('bk_jp_a', 'k'), to: key('bk_jp_b', 'k') });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // A: 8 rows, 2 NULL, keys {1,2,3,5}=4, max repeat 3 (key 1), avg 6/4=1.5; keys also in B: 1,2 -> 2 keys, 3+1=4 rows.
  assert.deepEqual(r.json.from, { rows: 8, nullRows: 2, keys: 4, matchedKeys: 2, matchedRows: 4, maxDuplicates: 3, avgDuplicates: 1.5 });
  // B: 5 rows, 1 NULL, keys {1,2,4}=3, max repeat 2 (key 2), avg 4/3=1.33; keys also in A: 1,2 -> 2 keys, 1+2=3 rows.
  assert.deepEqual(r.json.to, { rows: 5, nullRows: 1, keys: 3, matchedKeys: 2, matchedRows: 3, maxDuplicates: 2, avgDuplicates: 1.33 });
  assert.equal(r.json.sampled, false); assert.equal(r.json.sampleLimit, 1000000);

  // Bound of 3 rows each: A = 1,1,1 ; B = 1,2,2  -> sampled.
  const s = await app('/api/relationships/preview', { from: key('bk_jp_a', 'k'), to: key('bk_jp_b', 'k'), sampleLimit: 3 });
  assert.equal(s.status, 200);
  assert.deepEqual(s.json.from, { rows: 3, nullRows: 0, keys: 1, matchedKeys: 1, matchedRows: 3, maxDuplicates: 3, avgDuplicates: 3 });
  assert.deepEqual(s.json.to, { rows: 3, nullRows: 0, keys: 2, matchedKeys: 1, matchedRows: 1, maxDuplicates: 2, avgDuplicates: 1.5 });
  assert.equal(s.json.sampled, true);

  const dt = await app('/api/relationships/preview', { from: key('bk_jp_c', 'd'), to: key('bk_jp_d', 't') });
  assert.equal(dt.status, 200, JSON.stringify(dt.json)); assert.equal(dt.json.from.matchedKeys, 1); assert.equal(dt.json.to.matchedKeys, 1);

  const bad = await app('/api/relationships/preview', { from: key('bk_jp_a', 'k'), to: key('bk_jp_s', 'u') });
  assert.equal(bad.status, 400); assert.match(bad.json.error, /Can't relate bk_jp_a\.k \(numeric\) to bk_jp_s\.u \(text\)/);
  const hostile = await app('/api/relationships/preview', { from: key('bk_jp_a', 'k`; DROP TABLE x; --'), to: key('bk_jp_b', 'k') });
  assert.equal(hostile.status, 400); // unknown column, never reaches SQL
  assert.equal((await app('/api/relationships/preview', { from: key('bk_jp_a', 'k'), to: key('bk_jp_b', 'k'), sampleLimit: 1000001 })).status, 400);
  console.log('join preview smoke: all ok');
} finally {
  for (const t of TABLES) await write(`DROP TABLE IF EXISTS ${DB}.${t}`).catch(() => {});
}
