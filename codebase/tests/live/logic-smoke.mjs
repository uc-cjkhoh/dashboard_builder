// Live smoke for calculated-field logic functions (IF/IIF/CASE/IFNULL/ISNULL/ZN, comparisons, text literals): the dev app (APP_URL, default http://localhost:5188) against a real
// ClickHouse. Creates its fixture tables in test_cj (bk_logic) straight over HTTPS — never through the
// app, which stays read-only — and drops them in `finally`. Every expectation beyond the pinned core values
// comes from an independent oracle: a hand computation (see the table comment below).
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5188';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');

const DB = 'test_cj', TBL = 'bk_logic', T = `${DB}.${TBL}`;

async function ch(sql, { readonly = true } = {}) {
  const qs = new URLSearchParams({ default_format: 'JSONCompact', output_format_json_quote_64bit_integers: '0' });
  if (readonly) qs.set('readonly', '2');
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?${qs}`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 500)}`);
  return text.trim() ? JSON.parse(text).data : [];
}
// The only writes: DDL / inserts on test_cj.bk_logic.
const write = (sql) => {
  assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_logic\b/, `refusing write: ${sql.slice(0, 60)}`);
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

const f = (column) => ({ k: 'field', db: DB, table: TBL, column });
const num = (v) => ({ k: 'num', v });
const str = (v) => ({ k: 'str', v });
const cmp = (op, l, r) => ({ k: 'cmp', op, l, r });
const when = (c, t) => ({ c, t });
const kase = (whens, els) => (els === undefined ? { k: 'case', whens } : { k: 'case', whens, else: els });
const iff = (c, t, e) => kase([when(c, t)], e);
const ifnull = (l, r) => ({ k: 'ifnull', l, r });
const isnull = (arg) => ({ k: 'isnull', arg });
const agg = (fn, arg) => ({ k: 'agg', fn, arg });
const bin = (op, l, r) => ({ k: 'bin', op, l, r });
const calcDim = (label, calc) => ({ db: DB, table: TBL, column: label, calc });
const calcMeas = (label, calc, aggName = null) => ({ db: DB, table: TBL, column: label, agg: aggName, calc });
const base = () => ({ from: { db: DB, table: TBL }, joins: [], rowDimensions: [], columnDimensions: [], measures: [], filters: [], fresh: true });
const countRows = { db: DB, table: TBL, column: 'id', agg: 'countNonNull' };

let passed = 0;
const ok = (name) => { passed++; console.log(`ok ${name}`); };
const close = (a, b) => (a === null || b === null) ? a === b : Math.abs(Number(a) - Number(b)) <= 1e-9 * Math.max(1, Math.abs(Number(b)));
const keyed = (r) => Object.fromEntries(r.rows.map((x) => [String(x.keys[0]), x.values]));
function expectMap(r, want, label) {
  const got = keyed(r);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${label}: keys ${JSON.stringify(Object.keys(got))}`);
  for (const [k, v] of Object.entries(want)) {
    const g = got[k][0];
    assert.ok(typeof v === 'string' || typeof v === 'boolean' ? g === v || String(g) === String(v) : close(g, v), `${label}: key ${k} got ${JSON.stringify(g)} want ${JSON.stringify(v)}`);
  }
}

// id grp score label flag
//  1  A  10   x      true
//  2  A  20   y      false
//  3  A  NULL x      true
//  4  B  20   NULL   false     <- 20 ties across A, B, C
//  5  B  5    z      true
//  6  B  NULL NULL   false
//  7  C  20   x      true
//  8  C  1    it's   false
async function setup() {
  await write(`DROP TABLE IF EXISTS ${T}`);
  await write(`CREATE TABLE ${T} (id UInt32, grp String, score Nullable(Float64), label Nullable(String), flag Bool) ENGINE = MergeTree ORDER BY id`);
  await write(`INSERT INTO ${T} VALUES (1,'A',10,'x',true),(2,'A',20,'y',false),(3,'A',NULL,'x',true),(4,'B',20,NULL,false),(5,'B',5,'z',true),(6,'B',NULL,NULL,false),(7,'C',20,'x',true),(8,'C',1,'it\\'s',false)`);
}
async function teardown() {
  await write(`DROP TABLE IF EXISTS ${T}`);
  const left = await ch(`SELECT name FROM system.tables WHERE database = '${DB}' AND name = '${TBL}'`);
  assert.deepEqual(left, [], 'bk_logic still present');
  console.log('ok teardown: test_cj.bk_logic dropped');
}

async function main() {
  const conn = await app('POST', '/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);
  const score = f('score');

  { // NULL condition goes to ELSE: 10, NULL, 5, NULL, 1 -> low; 20,20,20 -> high
    const r = await query({ ...base(), rowDimensions: [calcDim('band', iff(cmp('>', score, num(15)), str('high'), str('low')))], measures: [countRows] }, 'if');
    expectMap(r, { high: 3, low: 5 }, 'IF NULL -> else');
    ok('IF(score > 15, high, low): NULL score falls to the else (high 3, low 5)');
  }
  { // nested CASE; the row without a match (and the NULL-score rows) are NULL
    const nested = kase([when(cmp('>', score, num(15)), kase([when(f('flag'), str('hi-on'))], str('hi-off'))), when(cmp('>', score, num(5)), str('mid'))]);
    const r = await query({ ...base(), rowDimensions: [calcDim('c', nested)], measures: [countRows] }, 'case');
    expectMap(r, { 'hi-off': 2, 'hi-on': 1, mid: 1, null: 4 }, 'nested CASE');
    ok('nested CASE without ELSE: hi-off 2, hi-on 1, mid 1, NULL 4 (score 5 is not > 5; NULL scores match nothing)');
  }
  { // first matching WHEN wins on a tie (20 matches both)
    const c = kase([when(cmp('>=', score, num(20)), str('first')), when(cmp('>', score, num(10)), str('second'))], str('none'));
    const r = await query({ ...base(), rowDimensions: [calcDim('c', c)], measures: [countRows] }, 'tie');
    expectMap(r, { first: 3, none: 5 }, 'first WHEN wins');
    ok('CASE: first matching WHEN wins (score 20 matches both; first 3, none 5)');
  }
  { // IFNULL on text, quote-bearing literal
    const r = await query({ ...base(), rowDimensions: [calcDim('l', ifnull(f('label'), str('none')))], measures: [countRows] }, 'ifnull text');
    expectMap(r, { x: 3, y: 1, z: 1, none: 2, "it's": 1 }, 'IFNULL text');
    ok("IFNULL(label, 'none'): x 3, y 1, z 1, none 2, it's 1");
  }
  { // comparison with NULL is NULL (not false): a boolean dimension has a NULL key
    const r = await query({ ...base(), rowDimensions: [calcDim('q', cmp('=', f('label'), str("it's")))], measures: [countRows] }, 'quote eq');
    expectMap(r, { true: 1, false: 5, null: 2 }, "label = 'it''s'");
    ok("label = 'it''s' as a boolean dimension: true 1, false 5, NULL 2 (a quote in a bound literal is data)");
  }
  { // injection-shaped literal is just text
    const r = await query({ ...base(), rowDimensions: [calcDim('q', cmp('=', f('label'), str("x'; DROP TABLE bk_logic; --")))], measures: [countRows] }, 'inject');
    expectMap(r, { false: 6, null: 2 }, 'injection literal');
    const still = await ch(`SELECT count() FROM ${T}`);
    assert.equal(Number(still[0][0]), 8);
    ok('an injection-shaped text literal matches nothing and the table is intact');
  }
  { // ISNULL boolean dimension
    const r = await query({ ...base(), rowDimensions: [calcDim('n', isnull(score))], measures: [countRows] }, 'isnull');
    expectMap(r, { true: 2, false: 6 }, 'ISNULL');
    ok('ISNULL(score) as a dimension reads true 2 / false 6');
  }
  { // aggregate calculations by grp
    const meas = [
      calcMeas('hits', agg('sum', iff(cmp('>=', score, num(20)), num(1), num(0)))),
      calcMeas('zn sum', agg('sum', ifnull(score, num(0)))),
      calcMeas('zn avg', agg('avg', ifnull(score, num(0)))),
      calcMeas('safe mean', iff(cmp('>', agg('count', score), num(0)), bin('/', agg('sum', score), agg('count', score)), num(0))),
    ];
    const r = await query({ ...base(), rowDimensions: [{ db: DB, table: TBL, column: 'grp' }], measures: meas }, 'aggs');
    assert.deepEqual(r.measures, ['hits', 'zn sum', 'zn avg', 'safe mean']);
    const m = keyed(r);
    const want = { A: [1, 30, 10, 15], B: [1, 25, 25 / 3, 12.5], C: [1, 21, 10.5, 10.5] };
    for (const [g, vs] of Object.entries(want)) vs.forEach((v, i) => assert.ok(close(m[g][i], v), `aggs ${g}[${i}] got ${m[g][i]} want ${v}`));
    ok('aggregate IF/IFNULL measures by group: SUM(IF(>=20,1,0)), SUM/AVG(IFNULL(score,0)), IF(COUNT>0, SUM/COUNT, 0) all equal the hand values');
  }
  { // aggregate text and boolean results
    const r = await query({ ...base(), rowDimensions: [{ db: DB, table: TBL, column: 'grp' }], measures: [
      calcMeas('size', iff(cmp('>', agg('sum', score), num(25)), str('big'), str('small'))),
      calcMeas('enough', cmp('>=', agg('sum', score), num(25))),
    ] }, 'agg text/bool');
    const m = keyed(r);
    assert.deepEqual([m.A[0], m.B[0], m.C[0]], ['big', 'small', 'small']);
    assert.deepEqual([m.A[1], m.B[1], m.C[1]].map(String), ['true', 'true', 'false']);
    ok('aggregate text IF(SUM>25,big,small) = big/small/small; aggregate boolean SUM>=25 = true/true/false');
  }
  { // AND / OR / NOT three-valued: score>5 AND flag
    const c = { k: 'logic', op: 'and', l: cmp('>', score, num(5)), r: f('flag') };
    const r = await query({ ...base(), rowDimensions: [calcDim('a', c)], measures: [countRows] }, 'and');
    // id1 10>5 & true -> true; id2 true & false -> false; id3 NULL & true -> NULL; id4 true & false -> false;
    // id5 5>5 false -> false; id6 NULL & false -> false; id7 true & true -> true; id8 1>5 false -> false
    expectMap(r, { true: 2, false: 5, null: 1 }, 'AND');
    const n = await query({ ...base(), rowDimensions: [calcDim('n', { k: 'not', arg: c })], measures: [countRows] }, 'not');
    expectMap(n, { true: 5, false: 2, null: 1 }, 'NOT');
    ok('three-valued AND / NOT: true 2 / false 5 / NULL 1 and its negation 5 / 2 / 1');
  }
  { // type error and limit come back as a 400 with the node path
    const bad = await app('POST', '/api/query', { ...base(), rowDimensions: [calcDim('x', iff(score, num(1), num(0)))], measures: [countRows] });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /A condition needs a boolean — bk_logic\.score is number\./);
    assert.equal(bad.json.field, 'rowDimensions[0].calc.w0.c');
    const long = await app('POST', '/api/query', { ...base(), rowDimensions: [calcDim('x', cmp('=', f('label'), str('y'.repeat(101))))], measures: [countRows] });
    assert.equal(long.status, 400);
    assert.match(long.json.error, /at most 100 characters/);
    const edge = await query({ ...base(), rowDimensions: [calcDim('x', cmp('=', f('label'), str('y'.repeat(100))))], measures: [countRows] }, '100 chars');
    assert.ok(edge.rows.length > 0);
    ok('a non-boolean condition and a 101-character literal are 400s with a path; 100 characters runs');
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
