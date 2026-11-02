// Live smoke for calculated fields as FILTERS (D82): the dev app (APP_URL, default http://localhost:5228) against a real ClickHouse.
// Creates its fixture tables in test_cj (bk_cfilter, bk_cfilter_c) straight over HTTPS — never through the app, which stays
// read-only — and drops them in `finally`. Every expectation is a hand computation (the data table below).
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5228';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');

const DB = 'test_cj', TBL = 'bk_cfilter', CT = 'bk_cfilter_c', T = `${DB}.${TBL}`, C = `${DB}.${CT}`;

async function ch(sql, { readonly = true } = {}) {
  const qs = new URLSearchParams({ default_format: 'JSONCompact', output_format_json_quote_64bit_integers: '0' });
  if (readonly) qs.set('readonly', '2');
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?${qs}`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 500)}`);
  return text.trim() ? JSON.parse(text).data : [];
}
const write = (sql) => {
  assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_cfilter(_c)?\b/, `refusing write: ${sql.slice(0, 60)}`);
  return ch(sql, { readonly: false });
};

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

const f = (column, table = TBL) => ({ k: 'field', db: DB, table, column });
const num = (v) => ({ k: 'num', v });
const str = (v) => ({ k: 'str', v });
const cmp = (op, l, r) => ({ k: 'cmp', op, l, r });
const ifnull = (l, r) => ({ k: 'ifnull', l, r });
const agg = (fn, arg) => ({ k: 'agg', fn, arg });
const bin = (op, l, r) => ({ k: 'bin', op, l, r });
// A calculated filter as the client sends it: no db / table, the label as column, the tree as calc.
const cf = (label, calc, op, value, values = null) => ({ db: '', table: '', column: label, op, value: value ?? '', values, calc });
const plain = (column, op, value) => ({ db: DB, table: TBL, column, op, value, values: null });
const base = () => ({ from: { db: DB, table: TBL }, joins: [], rowDimensions: [], columnDimensions: [], measures: [], filters: [], fresh: true });
const grp = { db: DB, table: TBL, column: 'grp' };
const countRows = { db: DB, table: TBL, column: 'id', agg: 'countNonNull' };
const sumScore = { db: DB, table: TBL, column: 'score', agg: 'sum' };
const avgScore = { db: DB, table: TBL, column: 'score', agg: 'avg' };

let passed = 0;
const ok = (name) => { passed++; console.log(`ok ${name}`); };
const close = (a, b) => Math.abs(Number(a) - Number(b)) <= 1e-9 * Math.max(1, Math.abs(Number(b)));
const keyed = (r) => Object.fromEntries(r.rows.map((x) => [String(x.keys[0]), x.values[0]]));
function expectMap(r, want, label) {
  const got = keyed(r);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${label}: keys ${JSON.stringify(Object.keys(got))}`);
  for (const [k, v] of Object.entries(want)) assert.ok(close(got[k], v), `${label}: key ${k} got ${JSON.stringify(got[k])} want ${v}`);
}
const byGrp = (extra) => ({ ...base(), rowDimensions: [grp], measures: [countRows], ...extra });

// id grp score label  flag d            cust region
//  1  A  10   x      true  2026-01-05   east
//  2  A  20   y      false 2026-02-10   west
//  3  A  NULL x      true  2026-03-15   -
//  4  B  20   NULL   false 2026-01-20   east
//  5  B  5    z      true  2026-02-25   west
//  6  B  NULL NULL   false 2026-03-30   -
//  7  C  20   x      true  2026-01-05   -
//  8  C  1    it's   false 2026-04-01   -
async function setup() {
  await write(`DROP TABLE IF EXISTS ${T}`);
  await write(`DROP TABLE IF EXISTS ${C}`);
  await write(`CREATE TABLE ${T} (id UInt32, grp String, score Nullable(Float64), label Nullable(String), flag Bool, d Date) ENGINE = MergeTree ORDER BY id`);
  await write(`INSERT INTO ${T} VALUES (1,'A',10,'x',true,'2026-01-05'),(2,'A',20,'y',false,'2026-02-10'),(3,'A',NULL,'x',true,'2026-03-15'),(4,'B',20,NULL,false,'2026-01-20'),(5,'B',5,'z',true,'2026-02-25'),(6,'B',NULL,NULL,false,'2026-03-30'),(7,'C',20,'x',true,'2026-01-05'),(8,'C',1,'it\\'s',false,'2026-04-01')`);
  await write(`CREATE TABLE ${C} (cid UInt32, region String) ENGINE = MergeTree ORDER BY cid`);
  await write(`INSERT INTO ${C} VALUES (1,'east'),(2,'west'),(4,'east'),(5,'west')`);
}
async function teardown() {
  await write(`DROP TABLE IF EXISTS ${T}`);
  await write(`DROP TABLE IF EXISTS ${C}`);
  const left = await ch(`SELECT name FROM system.tables WHERE database = '${DB}' AND name IN ('${TBL}', '${CT}')`);
  assert.deepEqual(left, [], 'bk_cfilter tables still present');
  console.log('ok teardown: test_cj.bk_cfilter and bk_cfilter_c dropped');
}

async function main() {
  const conn = await app('POST', '/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);
  const score = f('score'), doubled = bin('*', score, num(2));

  { // score * 2 > 30 keeps scores 20, 20, 20 (ids 2, 4, 7); the NULL scores drop (NULL > 30 is not true)
    const r = await query(byGrp({ filters: [cf('Doubled', doubled, '>', '30')] }), 'gt');
    expectMap(r, { A: 1, B: 1, C: 1 }, 'score*2 > 30');
    ok('score * 2 > 30: one row each of A, B, C (NULL scores never match)');
  }
  { // row filter BEFORE aggregation: the filtered average is over the kept rows only
    const r = await query({ ...base(), measures: [avgScore], filters: [cf('Doubled', doubled, '>', '30')] }, 'avg');
    assert.ok(close(r.rows[0].values[0], 20), `avg ${r.rows[0].values[0]}`);
    const all = await query({ ...base(), measures: [avgScore] }, 'avg all');
    assert.ok(close(all.rows[0].values[0], 76 / 6), `avg all ${all.rows[0].values[0]}`);
    ok('the filter applies to rows before the average: 20 filtered, 76/6 unfiltered');
  }
  { // a calculated filter ANDs with a plain filter; the sum is of the kept rows
    const r = await query({ ...base(), rowDimensions: [grp], measures: [sumScore], filters: [cf('Score or 0', ifnull(score, num(0)), '>=', '10'), plain('grp', '!=', 'C')] }, 'and');
    expectMap(r, { A: 30, B: 20 }, 'calc AND plain');
    ok('IFNULL(score, 0) >= 10 AND grp != C: sums A 30, B 20');
  }
  { // text calculation, in / notin; exclude keeps NULL results (a NOT IN alone would drop them)
    const label = ifnull(f('label'), str('none'));
    const inn = await query(byGrp({ filters: [cf('Label', label, 'in', '', ['none', 'z'])] }), 'in');
    expectMap(inn, { B: 3 }, 'in');
    const out = await query(byGrp({ filters: [cf('Label', label, 'notin', '', ['x'])] }), 'notin');
    expectMap(out, { A: 1, B: 3, C: 1 }, 'notin');
    const qt = await query(byGrp({ filters: [cf('Label', label, '=', "it's")] }), 'quote');
    expectMap(qt, { C: 1 }, 'quote');
    ok("IFNULL(label, 'none') in (none, z): B 3; not in (x): A 1, B 3, C 1; = it's: C 1 (the quote is bound data)");
  }
  { // text match works on a text calculation
    const r = await query(byGrp({ filters: [cf('Label', ifnull(f('label'), str('none')), 'startsWith', 'N')] }), 'startswith');
    expectMap(r, { B: 2 }, 'startsWith');
    ok("startsWith 'N' (case-insensitive) on IFNULL(label, 'none'): B 2");
  }
  { // boolean calculation: in (true); not in (true) keeps the NULL-result rows
    const gt15 = cmp('>', score, num(15));
    const t = await query(byGrp({ filters: [cf('High', gt15, 'in', '', ['true'])] }), 'bool in');
    expectMap(t, { A: 1, B: 1, C: 1 }, 'bool in');
    const n = await query(byGrp({ filters: [cf('High', gt15, 'notin', '', ['true'])] }), 'bool notin');
    expectMap(n, { A: 2, B: 2, C: 1 }, 'bool notin');
    ok('score > 15 as a boolean filter: in (true) A 1, B 1, C 1; not in (true) A 2, B 2, C 1 (NULL rows kept)');
  }
  { // numeric between (inclusive)
    const r = await query(byGrp({ filters: [cf('Doubled', doubled, 'between', '', ['20', '40'])] }), 'between');
    expectMap(r, { A: 2, B: 1, C: 1 }, 'between');
    ok('score * 2 between 20 and 40 (inclusive): A 2, B 1, C 1');
  }
  { // date calculation: bound string compared with a Date expression
    const ge = await query(byGrp({ filters: [cf('Day', f('d'), '>=', '2026-02-01')] }), 'date >=');
    expectMap(ge, { A: 2, B: 2, C: 1 }, 'date >=');
    const bt = await query(byGrp({ filters: [cf('Day', f('d'), 'between', '', ['2026-01-01', '2026-01-31'])] }), 'date between');
    expectMap(bt, { A: 1, B: 1, C: 1 }, 'date between');
    ok('a date calculation filters by bound dates: >= 2026-02-01 A 2, B 2, C 1; January A 1, B 1, C 1');
  }
  { // a cross-table calculation brings its table in through the request's joins
    const r = await query({ ...byGrp({ joins: [{ left: { db: DB, table: TBL, column: 'id' }, right: { db: DB, table: CT, column: 'cid' } }] }),
      filters: [cf('Region', f('region', CT), '=', 'east')] }, 'join');
    expectMap(r, { A: 1, B: 1 }, 'join');
    ok("a filter on [bk_cfilter_c.region] = 'east' across a join: A 1, B 1");
  }
  { // Top-N ranks within the calculated filter's rows (filters run first)
    const topBy = { db: DB, table: TBL, column: 'score', agg: 'sum' };
    const topFilter = { db: DB, table: TBL, column: 'grp', op: 'top', value: '1', values: null, topBy };
    const plainTop = await query({ ...base(), rowDimensions: [grp], measures: [countRows], filters: [topFilter] }, 'top');
    expectMap(plainTop, { A: 3 }, 'top 1 unfiltered');
    const filtered = await query({ ...base(), rowDimensions: [grp], measures: [countRows], filters: [cf('Low', cmp('<=', score, num(5)), 'in', '', ['true']), topFilter] }, 'top filtered');
    expectMap(filtered, { B: 1 }, 'top 1 among score <= 5');
    ok('Top 1 group by sum(score): A unfiltered; B once the calculated filter keeps only score <= 5 rows');
  }
  { // refusals: an aggregate calculation, a top-N on a calculation, a literal with no table, an unknown field, a too-long in-list
    const total = agg('sum', score);
    const a = await app('POST', '/api/query', byGrp({ filters: [cf('Total', total, '>', '1')] }));
    assert.equal(a.status, 400); assert.equal(a.json.field, 'filters[0].calc'); assert.match(a.json.error, /can't contain an aggregate/);
    const t = await app('POST', '/api/query', byGrp({ filters: [{ ...cf('Doubled', doubled, 'top', '3'), topBy: sumScore }] }));
    assert.equal(t.status, 400); assert.equal(t.json.field, 'filters[0].calc');
    const u = await app('POST', '/api/query', byGrp({ filters: [cf('Bad', f('nope'), '=', '1')] }));
    assert.equal(u.status, 400); assert.match(u.json.field, /^filters\[0\]\.calc/);
    const o = await app('POST', '/api/query', byGrp({ filters: [cf('Other', f('region', CT), '=', 'east')] }));
    assert.equal(o.status, 400); // the table isn't in the query: no join, no metadata lookup
    const big = await app('POST', '/api/query', byGrp({ filters: [cf('Label', f('label'), 'in', '', Array.from({ length: 501 }, (_, i) => String(i)))] }));
    assert.equal(big.status, 400); assert.equal(big.json.field, 'filters[0].values');
    const nan = await app('POST', '/api/query', byGrp({ filters: [cf('Doubled', doubled, '>', 'abc')] }));
    assert.equal(nan.status, 400);
    const noTop = await app('POST', '/api/query', byGrp({ filters: Array.from({ length: 21 }, () => cf('Doubled', doubled, '>', '1')) }));
    assert.equal(noTop.status, 400); assert.equal(noTop.json.field, 'filters');
    ok('refused with 400: an aggregate calc, a calc Top-N, an unknown field, a table not in the query, 501 in-values, a non-number, 21 filters');
  }
  await app('POST', '/api/connection/disconnect');
}

let failed = false;
try {
  await setup();
  await main();
} catch (e) {
  failed = true;
  console.error(`FAIL: ${e.message}`);
} finally {
  await teardown();
}
console.log(`${passed} checks passed${failed ? ', FAILED' : ''}`);
process.exit(failed ? 1 : 0);
