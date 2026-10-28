// Live smoke for the `notin` (Exclude) filter: the dev app (APP_URL, default http://localhost:5181) against a
// real ClickHouse. Fixture table test_cj.bk_notin (a Nullable(String) and a Float64 column) is created and
// dropped straight over HTTPS; the app stays read-only. Oracles are hand-written SELECTs run on ClickHouse.
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5181';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');
const DB = 'test_cj', T = 'bk_notin';

async function ch(sql, readonly) {
  const qs = new URLSearchParams({ default_format: 'JSONCompact', output_format_json_quote_64bit_integers: '0' });
  if (readonly) qs.set('readonly', '2');
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?${qs}`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 300)}`);
  return text.trim() ? JSON.parse(text).data : [];
}
const select = (sql) => { assert.match(sql, /^\s*SELECT\b/i); return ch(sql, true); };
const write = (sql) => { assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_notin\b/); return ch(sql, false); };

let cookie = '';
async function app(path, body) {
  const res = await fetch(`${APP}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body ?? {}) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
const count = async (filters) => {
  const r = await app('/api/query', { from: { db: DB, table: T }, joins: [], rowDimensions: [], columnDimensions: [],
    measures: [{ db: DB, table: T, column: 'qty', agg: 'count' }], filters, fresh: true });
  assert.equal(r.status, 200, `query: ${r.status} ${r.text.slice(0, 300)}`);
  return Number(r.json.rows[0].values[0]);
};
const flt = (column, op, values) => ({ db: DB, table: T, column, op, value: '', values });

let passed = 0, failed = false;
try {
  await write(`CREATE TABLE ${DB}.${T} (city Nullable(String), qty Float64) ENGINE = Memory`);
  await write(`INSERT INTO ${DB}.${T} VALUES ('NY', 1), ('LA', 2), ('SF', 3), ('SF', 4), (NULL, 5)`);
  const conn = await app('/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);

  const oracle = Number((await select(`SELECT count() FROM ${DB}.${T} WHERE city IS NULL OR city NOT IN ('NY', 'LA')`))[0][0]);
  assert.equal(oracle, 3);
  assert.equal(await count([flt('city', 'notin', ['NY', 'LA'])]), 3); // SF, SF and the NULL row
  console.log('ok text notin: excludes NY and LA, keeps SF x2 and the NULL row (3)'); passed++;

  assert.equal(await count([flt('city', 'notin', ['SF'])]), 3); // NY, LA, NULL
  assert.equal(await count([flt('city', 'in', ['SF'])]), 2);
  console.log('ok notin SF = 3; in SF = 2 (NULL is in neither)'); passed++;

  assert.equal(await count([flt('qty', 'notin', ['1', '2', '5'])]), 2);
  console.log('ok numeric notin binds a Float64 array (2)'); passed++;

  assert.equal(await count([flt('city', 'notin', ['NY']), flt('qty', 'notin', ['3'])]), 3); // LA, SF(4), NULL
  console.log('ok two notin filters combine with AND (3)'); passed++;

  const bad = await app('/api/query', { from: { db: DB, table: T }, joins: [], rowDimensions: [], columnDimensions: [],
    measures: [{ db: DB, table: T, column: 'qty', agg: 'count' }], filters: [flt('city', 'notin', [])] });
  assert.equal(bad.status, 400);
  const bad2 = await app('/api/query', { from: { db: DB, table: T }, joins: [], rowDimensions: [], columnDimensions: [],
    measures: [{ db: DB, table: T, column: 'qty', agg: 'count' }], filters: [flt('qty', 'notin', ['x'])] });
  assert.equal(bad2.status, 400);
  console.log('ok empty notin and a non-number on a numeric column are 400'); passed++;
  await app('/api/connection/disconnect');
} catch (e) { failed = true; console.error(`FAIL: ${e.message}`); }
finally {
  await write(`DROP TABLE IF EXISTS ${DB}.${T}`);
  const left = await select(`SELECT name FROM system.tables WHERE database = '${DB}' AND name = '${T}'`);
  if (left.length) { failed = true; console.error('fixture table still present'); }
}
console.log(`${passed} checks passed${failed ? ', FAILED' : ''}`);
process.exit(failed ? 1 : 0);
