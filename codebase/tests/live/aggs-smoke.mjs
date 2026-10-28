// Live smoke for the added aggregations (median, stddev, variance, percentile, attr): the dev app (APP_URL, default
// http://localhost:5187) against a real ClickHouse. Fixture table test_cj.bk_aggs is created and dropped straight over
// HTTPS; the app stays read-only. Expectations are hand-computed (see the fixture comment).
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5187';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');
const DB = 'test_cj', T = 'bk_aggs';

async function ch(sql, readonly) {
  const qs = new URLSearchParams({ default_format: 'JSONCompact', output_format_json_quote_64bit_integers: '0' });
  if (readonly) qs.set('readonly', '2');
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?${qs}`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 300)}`);
  return text.trim() ? JSON.parse(text).data : [];
}
const write = (sql) => { assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_aggs\b/); return ch(sql, false); };

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

// Fixture (g: group; x Nullable(Float64); s Nullable(String); xs = x as text, 'zz' in C):
//   A: x = 1,2,3,4,NULL    s = p,p,p,p,NULL   median 3 (n=4 non-null, index floor(4*.5)=2), p25 -> index 1 = 2,
//      sample variance 5/3, stddev sqrt(5/3), attr(s) = 'p' (NULL ignored)
//   B: x = 10 (single row) s = q               median 10, stddev/variance NULL (one value), attr 'q'
//   C: x = NULL, NULL      s = u,v             median NULL, stddev NULL, attr NULL (two distinct values)
//   D: x = 5,5,5           s = NULL x3         median 5, stddev 0, variance 0, attr NULL (no non-NULL value)
async function setup() {
  await write(`DROP TABLE IF EXISTS ${DB}.${T}`);
  await write(`CREATE TABLE ${DB}.${T} (g String, x Nullable(Float64), s Nullable(String), xs Nullable(String)) ENGINE = MergeTree ORDER BY g`);
  await write(`INSERT INTO ${DB}.${T} VALUES ('A',1,'p','1'),('A',2,'p','2'),('A',3,'p','3'),('A',4,'p','4'),('A',NULL,NULL,NULL),('B',10,'q','10'),('C',NULL,'u',NULL),('C',NULL,'v','zz'),('D',5,NULL,'5'),('D',5,NULL,'5'),('D',5,NULL,'5')`);
}
const teardown = () => write(`DROP TABLE IF EXISTS ${DB}.${T}`).catch((e) => console.error(`teardown: ${e.message}`));

async function main() {
  const conn = await app('/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);

  // (a) plain measures: median / stddev / variance / attr, NULLs, single-row group, all-NULL group.
  {
    const j = await ok([plain('x', 'median'), plain('x', 'stddev'), plain('x', 'variance'), plain('s', 'attr')], 'a');
    assert.deepEqual(j.measures, ['median x', 'stddev x', 'variance x', 'attr s']);
    const r = rows(j);
    eqRow(r.A, [3, Math.sqrt(5 / 3), 5 / 3, 'p'], 'A');
    eqRow(r.B, [10, null, null, 'q'], 'B (single row: spread is NULL, not 0 or NaN)');
    eqRow(r.C, [null, null, null, null], 'C (all NULL values; two distinct strings)');
    eqRow(r.D, [5, 0, 0, null], 'D (constant; a group of only NULL strings)');
    pass('(a) plain median/stddev/variance/attr over A (NULL skipped), B (one row), C (all NULL), D (constant)');
  }
  // (b) calculated fields: the same functions, PERCENTILE with a bound fraction, a row-level calc with a plain aggregation.
  {
    const j = await ok([
      calc('med', agg('median', f('x'))), calc('p25', agg('percentile', f('x'), 0.25)), calc('p100', agg('percentile', f('x'), 1)),
      calc('p0', agg('percentile', f('x'), 0)), calc('sd2', agg('stddev', { k: 'bin', op: '*', l: f('x'), r: { k: 'num', v: 2 } })),
      calc('attr', agg('attr', f('s'))), calc('rowlevel', { k: 'bin', op: '*', l: f('x'), r: { k: 'num', v: 2 } }, 'median'),
    ], 'b');
    const r = rows(j);
    eqRow(r.A, [3, 2, 4, 1, 2 * Math.sqrt(5 / 3), 'p', 6], 'A');
    eqRow(r.B, [10, 10, 10, 10, null, 'q', 20], 'B');
    eqRow(r.C, [null, null, null, null, null, null, null], 'C');
    eqRow(r.D, [5, 5, 5, 5, 0, null, 10], 'D');
    pass('(b) calculated MEDIAN / PERCENTILE(0.25, 1, 0) / STDDEV(x*2) / ATTR and a row-level calc with median');
  }
  // (c) approximate mode (no sampling key on this table, so it reads everything): the same numbers.
  {
    const j = await ok([plain('x', 'median'), calc('p25', agg('percentile', f('x'), 0.25))], 'c', { approximate: true });
    const r = rows(j);
    eqRow(r.A, [3, 2], 'A approx'); eqRow(r.B, [10, 10], 'B approx');
    pass('(c) approximate mode returns the same exact order statistics when no sample is taken');
  }
  // (c2) a text field cast to a number takes the new aggregations (type cast + median/stddev/variance on one measure).
  {
    const xs = (a) => ({ ...col('xs'), agg: a, cast: 'number' });
    const j = await ok([xs('median'), xs('stddev'), xs('variance')], 'c2');
    assert.deepEqual(j.measures, ['median xs', 'stddev xs', 'variance xs']);
    const r = rows(j);
    eqRow(r.A, [3, Math.sqrt(5 / 3), 5 / 3], 'A cast'); eqRow(r.B, [10, null, null], 'B cast');
    eqRow(r.C, [null, null, null], 'C cast (unparseable text is NULL)'); eqRow(r.D, [5, 0, 0], 'D cast');
    const bad = await app('/api/query', req([{ ...col('s'), agg: 'median' }]));
    assert.equal(bad.status, 400, 'median of uncast text is refused');
    const castText = await app('/api/query', req([{ ...col('x'), agg: 'median', cast: 'text' }]));
    assert.equal(castText.status, 400, 'median of a number cast to text is refused');
    pass('(c2) cast xs to number + median/stddev/variance matches the numeric column; median of text / of a text cast is a 400');
  }
  // (d) refusals are 400s with the field named.
  const bad = async (m, field, rx, label) => {
    const r = await app('/api/query', req(m));
    assert.equal(r.status, 400, `${label}: ${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(r.json.field, field, `${label}: field ${r.json.field}`);
    assert.match(r.json.error, rx, label);
  };
  await bad([plain('x', 'percentile')], undefined, /Unknown aggregation/, 'plain percentile has no fraction');
  await bad([plain('s', 'median')], 'measures[0]', /Median needs a numeric column/, 'median of text');
  await bad([plain('s', 'stddev')], 'measures[0]', /Stddev needs a numeric column/, 'stddev of text');
  await bad([calc('p', agg('percentile', f('x'), 1.5))], 'measures[0].calc.p', /fraction between 0 and 1/, 'p above 1');
  await bad([calc('p', agg('percentile', f('x')))], 'measures[0].calc.p', /fraction between 0 and 1/, 'p missing');
  await bad([calc('p', agg('sum', f('x'), 0.5))], 'measures[0].calc.p', /takes no fraction/, 'p on sum');
  await bad([calc('m', agg('median', f('s')))], 'measures[0].calc.arg', /MEDIAN needs a number/, 'median of text calc');
  await bad([calc('m', agg('median', agg('sum', f('x'))))], 'measures[0].calc.arg', /can't contain another aggregate/, 'aggregate in aggregate');
  pass('(d) refusals: plain percentile, median/stddev of text, p outside 0..1 / missing / on SUM, aggregate in aggregate -> 400 naming the field');

  // (e) a Top-N filter ranked by a new aggregation: the two groups with the highest median x.
  {
    const r = await app('/api/query', req([plain('x', 'median')], { filters: [{ ...col('g'), op: 'top', value: '2', topBy: plain('x', 'median') }] }));
    assert.equal(r.status, 200, `e: ${r.status} ${r.text.slice(0, 300)}`);
    assert.deepEqual(r.json.rows.map((x) => x.keys[0]), ['B', 'D'].sort(), 'top 2 by median x are B (10) and D (5)');
    pass('(e) Top-2 groups ranked by median x: B and D');
  }
  await app('/api/connection/disconnect');
}

let failed = false;
try { await setup(); await main(); } catch (e) { failed = true; console.error(`FAIL: ${e.message}`); } finally { await teardown(); }
console.log(`${passed} checks passed${failed ? ', FAILED' : ''}`);
process.exit(failed ? 1 : 0);
