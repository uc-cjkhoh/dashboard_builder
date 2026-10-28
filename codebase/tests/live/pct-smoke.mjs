// Live smoke for the plain percentile measure (T04-07): the dev app (APP_URL, default
// http://localhost:5204) against a real ClickHouse. Fixture table test_cj.bk_pct is created and dropped straight over
// HTTPS; the app stays read-only. Expectations are hand-computed (see the fixture comment).
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5204';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');
const DB = 'test_cj', T = 'bk_pct';

async function ch(sql, readonly) {
  const qs = new URLSearchParams({ default_format: 'JSONCompact', output_format_json_quote_64bit_integers: '0' });
  if (readonly) qs.set('readonly', '2');
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?${qs}`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 300)}`);
  return text.trim() ? JSON.parse(text).data : [];
}
const write = (sql) => { assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_pct\b/); return ch(sql, false); };

let cookie = '';
async function app(path, body) {
  const res = await fetch(`${APP}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body ?? {}) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
const f = (column) => ({ k: 'field', db: DB, table: T, column });
const agg = (fn, arg, p) => ({ k: 'agg', fn, arg, ...(p === undefined ? {} : { p }) });
const col = (column) => ({ db: DB, table: T, column });
const plain = (column, a) => ({ ...col(column), agg: a });
const calc = (label, tree, a = null) => ({ db: DB, table: T, column: label, agg: a, calc: tree });
const req = (measures, extra = {}) => ({ from: { db: DB, table: T }, joins: [], rowDimensions: [col('g')], columnDimensions: [], measures, filters: [], fresh: true, ...extra });
async function ok(measures, label, extra) {
  const r = await app('/api/query', req(measures, extra));
  assert.equal(r.status, 200, `${label}: ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}
const rows = (j) => Object.fromEntries(j.rows.map((r) => [r.keys[0], r.values.map((v) => (v === null || typeof v === 'string' ? v : Number(v)))]));
const near = (a, b, label) => assert.ok(typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b, `${label}: ${a} vs ${b}`);
const eqRow = (got, want, label) => { assert.equal(got.length, want.length, label); want.forEach((w, i) => near(got[i], w, `${label}[${i}]`)); };
let passed = 0;
const pass = (m) => { passed++; console.log(`ok ${m}`); };

// Fixture (g: group; x Nullable(Float64); xs = x as text, 'zz' in C). Percentiles interpolate linearly (position (n-1)*p):
//   A: x = 1,2,3,4,NULL   p25 1.75, p50 2.5, p75 3.25, p90 3.7, p0 1, p100 4 (the NULL is ignored)
//   B: x = 10 (a single row)   every percentile 10
//   C: x = NULL, NULL          every percentile NULL
//   D: x = 5,5,5               every percentile 5
async function setup() {
  await write(`DROP TABLE IF EXISTS ${DB}.${T}`);
  await write(`CREATE TABLE ${DB}.${T} (g String, x Nullable(Float64), xs Nullable(String)) ENGINE = MergeTree ORDER BY g`);
  await write(`INSERT INTO ${DB}.${T} (g, x, xs) VALUES ('A',1,'1'),('A',2,'2'),('A',3,'3'),('A',4,'4'),('A',NULL,NULL),('B',10,'10'),('C',NULL,NULL),('C',NULL,'zz'),('D',5,'5'),('D',5,'5'),('D',5,'5')`);
}
const teardown = () => write(`DROP TABLE IF EXISTS ${DB}.${T}`).catch((e) => console.error(`teardown: ${e.message}`));
const pct = (column, p, extra = {}) => ({ ...col(column), agg: 'percentile', p, ...extra });

async function main() {
  const conn = await app('/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);

  {
    const j = await ok([pct('x', 0.25), pct('x', 0.5), pct('x', 0.75), pct('x', 0.9), pct('x', 0), pct('x', 1)], 'a');
    assert.deepEqual(j.measures, ['p25 x', 'p50 x', 'p75 x', 'p90 x', 'p0 x', 'p100 x']);
    const r = rows(j);
    eqRow(r.A, [1.75, 2.5, 3.25, 3.7, 1, 4], 'A'); eqRow(r.B, [10, 10, 10, 10, 10, 10], 'B (single row)');
    eqRow(r.C, [null, null, null, null, null, null], 'C (all NULL)'); eqRow(r.D, [5, 5, 5, 5, 5, 5], 'D');
    pass('(a) p25/p50/p75/p90/p0/p100 over NULLs, a single row and an all-NULL group; labels p<percent> <column>');
  }
  {
    const j = await ok([pct('x', 0.995)], 'a2');
    assert.deepEqual(j.measures, ['p99.5 x']);
    near(rows(j).A[0], 3.985, 'A p99.5');
    pass('(a2) a fractional percent labels as p99.5 and interpolates (3.985)');
  }
  {
    const j = await ok([pct('x', 0.5), { ...col('x'), agg: 'median' }], 'b', { approximate: true });
    const r = rows(j);
    eqRow(r.A, [2.5, 2.5], 'A approx');
    pass('(b) approximate mode: a percentile is exact (never scaled) and equals the median at p50');
  }
  {
    const xs = (p) => pct('xs', p, { cast: 'number' });
    const r = rows(await ok([xs(0.25), xs(0.5)], 'c'));
    eqRow(r.A, [1.75, 2.5], 'A cast'); eqRow(r.B, [10, 10], 'B cast'); eqRow(r.C, [null, null], 'C cast'); eqRow(r.D, [5, 5], 'D cast');
    const bad = await app('/api/query', req([pct('xs', 0.5)]));
    assert.equal(bad.status, 400, 'percentile of uncast text is refused');
    pass('(c) a text column cast to a number takes a percentile; uncast text is a 400');
  }
  for (const [label, m, field] of [
    ['p above 1', pct('x', 1.5), 'measures[0].p'], ['p below 0', pct('x', -0.1), 'measures[0].p'], ['p missing', { ...col('x'), agg: 'percentile' }, 'measures[0].p'],
    ['p null', pct('x', null), 'measures[0].p'], ['p on sum', { ...col('x'), agg: 'sum', p: 0.5 }, 'measures[0].p'], ['p on median', { ...col('x'), agg: 'median', p: 0.5 }, 'measures[0].p'],
  ]) {
    const r = await app('/api/query', req([m]));
    assert.equal(r.status, 400, `${label}: ${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(r.json.field, field, `${label}: field ${r.json?.field}`);
  }
  pass('(d) hostile fractions (1.5, -0.1, missing, null, p on another aggregation) are 400 on measures[0].p, never clamped');
  {
    const r = await app('/api/query', req([pct('x', 0.5), pct('x', 1.5)]));
    assert.equal(r.status, 400); assert.equal(r.json.field, 'measures[1].p');
    pass('(d2) the field names the offending measure index');
  }
  {
    const top = (p, value = '2') => ({ ...col('g'), op: 'top', value, topBy: pct('x', p) });
    const j = await ok([pct('x', 0.5)], 'e', { filters: [top(0.5)] });
    assert.deepEqual(Object.keys(rows(j)).sort(), ['B', 'D'], 'top 2 by p50 are B (10) and D (5)');
    const bad = await app('/api/query', req([pct('x', 0.5)], { filters: [top(7)] }));
    assert.equal(bad.status, 400); assert.equal(bad.json.field, 'filters[0].topBy.p');
    const dflt = await app('/api/query', req([pct('x', 0.5)], { filters: [{ ...col('g'), op: 'top', value: '2', topBy: { ...col('x'), agg: 'percentile' } }] }));
    assert.equal(dflt.status, 400); assert.equal(dflt.json.field, 'filters[0].topBy.p');
    pass('(e) Top-N ranked by a percentile works (B, D) and refuses a missing / out-of-range topBy.p');
  }
  {
    const r = rows(await ok([pct('x', 0.5), { ...col('x'), agg: 'sum' }], 'f', { filters: [{ ...col('g'), op: 'top', value: '1', topBy: pct('x', 0.25) }] }));
    assert.deepEqual(Object.keys(r), ['B']);
    pass('(f) a percentile measure beside a percentile Top-N uses separate bound parameters (mp0, tp0)');
  }
}
try { await setup(); await main(); } catch (e) { console.error(`FAIL: ${e.stack ?? e.message}`); process.exitCode = 1; } finally { await teardown(); }
console.log(`${passed} passed${process.exitCode ? ', FAILED' : ''}`);
