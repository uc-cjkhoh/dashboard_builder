// Live smoke for calculated fields: the dev app (APP_URL, default http://localhost:5180) against a real
// ClickHouse. Creates its fixture tables in test_cj (calc_smoke_*) straight over HTTPS — never through the
// app, which stays read-only — and drops them in `finally`. Every expectation beyond the pinned core values
// comes from an independent oracle: a hand-written SELECT run directly on ClickHouse.
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5180';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');

const DB = 'test_cj';
const ORDERS = 'calc_smoke_orders', CUSTOMERS = 'calc_smoke_customers', BIG = 'calc_smoke_big';
const TABLES = [ORDERS, CUSTOMERS, BIG];

// ---- ClickHouse over HTTPS --------------------------------------------------------------------------
async function ch(sql, { readonly = true } = {}) {
  const qs = new URLSearchParams({ default_format: 'JSONCompact', output_format_json_quote_64bit_integers: '0' });
  if (readonly) qs.set('readonly', '2');
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?${qs}`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 500)}`);
  return text.trim() ? JSON.parse(text).data : [];
}
const select = (sql) => {
  assert.match(sql, /^\s*SELECT\b/i, 'oracle statements are SELECT only');
  return ch(sql);
};
// The only writes this script makes: DDL / inserts on test_cj.calc_smoke_* tables.
const write = (sql) => {
  assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.calc_smoke_[a-z]+\b/, `refusing write: ${sql.slice(0, 60)}`);
  return ch(sql, { readonly: false });
};

// ---- the app ----------------------------------------------------------------------------------------
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

// ---- tree builders ----------------------------------------------------------------------------------
const f = (column, table = ORDERS) => ({ k: 'field', db: DB, table, column });
const num = (v) => ({ k: 'num', v });
const bin = (op, l, r) => ({ k: 'bin', op, l, r });
const agg = (fn, arg) => ({ k: 'agg', fn, arg });
const col = (column, table = ORDERS) => ({ db: DB, table, column });
const calcDim = (label, calc) => ({ db: DB, table: ORDERS, column: label, calc });
const calcMeas = (label, calc, aggName = null) => ({ db: DB, table: ORDERS, column: label, agg: aggName, calc });
// fresh: skip the app's 60 s result cache — a rerun recreates the fixture, so a cached result could be stale.
const base = (table = ORDERS) => ({ from: { db: DB, table }, joins: [], rowDimensions: [], columnDimensions: [], measures: [], filters: [], fresh: true });

// ---- comparison helpers -----------------------------------------------------------------------------
const close = (a, b) => (a === null || b === null) ? a === b
  : (typeof a === 'string' || typeof b === 'string') ? a === b // text cells (min/max of text) compare exactly
  : Math.abs(Number(a) - Number(b)) <= 1e-9 * Math.max(1, Math.abs(Number(b)));
const keyNum = (k) => (k === null ? null : Number(k));
function assertRowsMatch(appRows, oracleRows, dims, label, { numericKeys = [] } = {}) {
  assert.equal(appRows.length, oracleRows.length, `${label}: row count app=${appRows.length} oracle=${oracleRows.length}`);
  for (let i = 0; i < oracleRows.length; i++) {
    const a = appRows[i], o = oracleRows[i];
    for (let d = 0; d < dims; d++) {
      const ok = numericKeys.includes(d) ? close(keyNum(a.keys[d]), o[d] === null ? null : Number(o[d])) : a.keys[d] === (o[d] === null ? null : String(o[d]));
      assert.ok(ok, `${label}: row ${i} key ${d} app=${JSON.stringify(a.keys[d])} oracle=${JSON.stringify(o[d])}`);
    }
    for (let v = 0; v < o.length - dims; v++)
      assert.ok(close(a.values[v], o[dims + v]), `${label}: row ${i} value ${v} app=${JSON.stringify(a.values[v])} oracle=${JSON.stringify(o[dims + v])}`);
  }
}
const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.keys[0], r.values]));
let passed = 0;
const ok = (name) => { passed++; console.log(`ok ${name}`); };

const T = `${DB}.${ORDERS}`, C = `${DB}.${CUSTOMERS}`, B = `${DB}.${BIG}`;

async function setup() {
  for (const t of TABLES) await write(`DROP TABLE IF EXISTS ${DB}.${t}`);
  await write(`CREATE TABLE ${T} (region String, amount Decimal(18,2), qty UInt32, price Nullable(Float64), placed Date) ENGINE = MergeTree ORDER BY region`);
  await write(`INSERT INTO ${T} VALUES ('N',10,2,1.5,'2026-01-05'),('N',5,3,NULL,'2026-02-10'),('S',7.5,0,2.0,'2026-01-20'),('S',2.5,0,NULL,'2026-03-01'),('E',1,1,4.0,'2026-02-15')`);
  // Related to orders on region: N and S match, E has no customer row (inner vs left differ), W has no order.
  await write(`CREATE TABLE ${C} (region String, tier UInt8) ENGINE = MergeTree ORDER BY region`);
  await write(`INSERT INTO ${C} VALUES ('N',1),('S',2),('W',3)`);
  // Distinct amounts per region A..E: 4, 10, 16, 22, 28 (no tie in a COUNTD rank).
  // A larger table with a sampling key (approximate mode reads a 10% sample) and > 500 distinct dates (auto grain buckets).
  await write(`CREATE TABLE ${B} (id UInt32, region String, amount Float64, qty UInt32, placed Date) ENGINE = MergeTree ORDER BY (region, intHash32(id)) SAMPLE BY intHash32(id)`);
  await write(`INSERT INTO ${B} SELECT number, ['A','B','C','D','E'][(number % 5) + 1], (number % (20 + 30 * (number % 5))) * 1.25, number % 3, toDate('2023-01-01') + (number % 1000) FROM numbers(20000)`);
}

async function teardown() {
  for (const t of TABLES) await write(`DROP TABLE IF EXISTS ${DB}.${t}`);
  const left = await select(`SELECT name FROM system.tables WHERE database = '${DB}' AND startsWith(name, 'calc_smoke_')`);
  assert.deepEqual(left, [], `calc_smoke tables still present: ${JSON.stringify(left)}`);
  console.log('ok teardown: test_cj.calc_smoke_* dropped');
}

const RATIO = bin('/', agg('sum', f('amount')), agg('sum', f('qty')));

async function main() {
  const conn = await app('POST', '/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);
  assert.ok(cookie, 'connect: session cookie');

  // ================= Core (pinned values from the brief) =================
  {
    const r = await query({ ...base(), rowDimensions: [col('region')], measures: [calcMeas('ratio', RATIO)] }, 'ratio');
    assert.deepEqual(r.measures, ['ratio']);
    const m = byKey(r.rows);
    assert.equal(m.N[0], 3); assert.equal(m.S[0], null); assert.equal(m.E[0], 1);
    ok('core: SUM(amount)/SUM(qty) by region -> N=3, S=null, E=1');
  }
  {
    const r = await query({ ...base(), rowDimensions: [col('region')], measures: [calcMeas('ratio', RATIO)], otherBucket: true, limit: 2, withTotal: true }, 'ratio other');
    assert.equal(r.truncated, true); assert.notEqual(r.other, null); assert.notEqual(r.total, null);
    assert.equal(r.total, 3);
    assert.deepEqual(r.rows.map((x) => x.keys[0]), ['E', 'N']);
    assert.equal(r.other.groups, 1); assert.equal(r.other.values[0], null); // the S group: 10 / 0
    ok('core: ratio + OtherBucket + Limit 2 + WithTotal -> truncated, other, total');
  }
  {
    const r = await query({ ...base(), rowDimensions: [col('region')], measures: [calcMeas('diff', bin('-', f('qty'), f('amount')), 'sum')] }, 'diff');
    assert.equal(byKey(r.rows).N[0], -10);
    ok('core: SUM(qty - amount) row-level for N = -10');
  }
  {
    const r = await query({ ...base(), rowDimensions: [col('region')], measures: [calcMeas('n', agg('count', f('price'))), calcMeas('pq', agg('sum', bin('*', f('price'), f('qty'))))] }, 'count/sum price');
    const m = byKey(r.rows);
    assert.deepEqual([m.N[0], m.S[0], m.E[0]], [1, 1, 1]);
    assert.deepEqual([m.N[1], m.S[1], m.E[1]], [3, 0, 4]);
    ok('core: COUNT(price) = 1,1,1; SUM(price*qty) = 3,0,4');
  }
  {
    const r = await query({ ...base(), rowDimensions: [calcDim('x10', bin('*', f('qty'), num(10)))] }, 'x10');
    assert.deepEqual(r.rowDimensions, ['x10']);
    assert.deepEqual(new Set(r.rows.map((x) => Number(x.keys[0]))), new Set([0, 10, 20, 30]));
    ok(`core: dimension qty*10 keys {0,10,20,30} (raw ${JSON.stringify(r.rows.map((x) => x.keys[0]))})`);
  }
  {
    const r = await query({ ...base(), rowDimensions: [col('region')], measures: [calcMeas('ratio', RATIO)], approximate: true }, 'ratio approx');
    assert.ok(r.rows.length === 3);
    ok('core: Approximate ratio succeeds');
  }
  {
    const r = await app('POST', '/api/query', { ...base(), rowDimensions: [calcDim('agg', agg('sum', f('qty')))] });
    assert.equal(r.status, 400, `aggregate dimension: ${r.status}`);
    assert.equal(r.json.field, 'rowDimensions[0].calc');
    const s = await app('POST', '/api/query', { ...base(), measures: [calcMeas('bad', agg('sum', f('region')))] });
    assert.equal(s.status, 400);
    assert.equal(s.json.error, 'SUM needs a number — calc_smoke_orders.region is text.');
    assert.equal(s.json.field, 'measures[0].calc.arg');
    ok('core: aggregate dimension and SUM(text) are 400s with their fields');
  }

  {
    // A field on a table that exists but isn't part of the query is rejected the same way whether or not the column exists.
    for (const column of ['tier', 'nope']) {
      const r = await app('POST', '/api/query', { ...base(), measures: [calcMeas('x', bin('+', f('qty'), f(column, CUSTOMERS)), 'sum')] });
      assert.equal(r.status, 400, `table not in the query (${column}): ${r.status} ${r.text.slice(0, 200)}`);
      assert.equal(r.json.error, 'Field references a table not in the query.', `table not in the query (${column}): ${r.text.slice(0, 200)}`);
    }
    ok('core: a calc field on a table not in the query is a 400 (existing and unknown column alike)');
  }

  // ================= (a) calc dimension with a literal + OtherBucket (NOT IN, nullIf NULL key) =================
  {
    // 10 / qty: qty 0 -> nullIf -> NULL key for both S rows. Keys: 3.33 (amount 5), 5 (10), 10 (1), NULL (10).
    const dim = calcDim('ten over qty', bin('/', num(10), f('qty')));
    const sumAmt = { ...col('amount'), agg: 'sum' };
    const ok1 = `SELECT 10 / nullIf(toFloat64(qty), 0) AS k, sum(amount) AS v FROM ${T} GROUP BY k`;
    // (a1) NULL group SHOWN (sort by sum desc): shown 5 (10) then NULL (10); Other = {3.33, 10} -> 2 groups, 6.
    const r1 = await query({ ...base(), rowDimensions: [dim], measures: [sumAmt], otherBucket: true, limit: 2, sort: { column: 'v0', desc: true } }, 'a1');
    const o1 = await select(`SELECT k, v FROM (${ok1}) ORDER BY v DESC, k ASC LIMIT 2`);
    assertRowsMatch(r1.rows, o1, 1, 'a1', { numericKeys: [0] });
    const oo1 = await select(`SELECT count(), sum(v) FROM (SELECT k, v FROM (${ok1}) ORDER BY v DESC, k ASC LIMIT 1000 OFFSET 2)`);
    assert.equal(r1.truncated, true);
    assert.ok(r1.other, 'a1: other present');
    assert.equal(r1.other.groups, Number(oo1[0][0]), `a1: other groups app=${r1.other.groups} oracle=${oo1[0][0]}`);
    assert.ok(close(r1.other.values[0], oo1[0][1]), `a1: other sum app=${r1.other.values[0]} oracle=${oo1[0][1]} (NULL group double-counted?)`);
    ok(`(a1) calc dim 10/qty, NULL key shown: other ${r1.other.groups} groups, sum ${r1.other.values[0]} == oracle`);
    // (a2) NULL group in OTHER (default ascending sort puts NULL last): shown 3.33, 5; Other = {10, NULL}.
    const r2 = await query({ ...base(), rowDimensions: [dim], measures: [sumAmt], otherBucket: true, limit: 2 }, 'a2');
    const o2 = await select(`SELECT k, v FROM (${ok1}) ORDER BY k ASC LIMIT 2`);
    assertRowsMatch(r2.rows, o2, 1, 'a2', { numericKeys: [0] });
    const oo2 = await select(`SELECT count(), sum(v) FROM (SELECT k, v FROM (${ok1}) ORDER BY k ASC LIMIT 1000 OFFSET 2)`);
    assert.ok(r2.other, 'a2: other present');
    assert.ok(close(r2.other.values[0], oo2[0][1]), `a2: other sum app=${r2.other.values[0]} oracle=${oo2[0][1]}`);
    assert.equal(r2.other.groups, Number(oo2[0][0]), `a2: other groups app=${r2.other.groups} oracle=${oo2[0][0]} (NULL group not counted?)`);
    ok(`(a2) calc dim 10/qty, NULL key in Other: other ${r2.other.groups} groups, sum ${r2.other.values[0]} == oracle`);
  }

  // ================= (b) calc referencing a joined table, inner and left =================
  {
    const join = (type) => [{ left: col('region'), right: col('region', CUSTOMERS), ...(type === 'left' ? { type: 'left' } : {}) }];
    const meas = calcMeas('amount x tier', agg('sum', bin('*', f('amount'), f('tier', CUSTOMERS))));
    const dim = calcDim('tier x 100', bin('*', f('tier', CUSTOMERS), num(100)));
    for (const type of ['inner', 'left']) {
      const settings = type === 'left' ? ' SETTINGS join_use_nulls = 1' : '';
      const J = type === 'left' ? 'LEFT JOIN' : 'INNER JOIN';
      const r = await query({ ...base(), joins: join(type), rowDimensions: [col('region')], measures: [meas] }, `b ${type} measure`);
      const o = await select(`SELECT o.region, sum(toFloat64(o.amount) * toFloat64(c.tier)) FROM ${T} AS o ${J} ${C} AS c ON o.region = c.region GROUP BY o.region ORDER BY o.region${settings}`);
      assertRowsMatch(r.rows, o, 1, `b ${type} measure`);
      const r2 = await query({ ...base(), joins: join(type), rowDimensions: [dim], measures: [{ ...col('amount'), agg: 'sum' }] }, `b ${type} dim`);
      const o2 = await select(`SELECT toFloat64(c.tier) * 100 AS k, sum(o.amount) FROM ${T} AS o ${J} ${C} AS c ON o.region = c.region GROUP BY k ORDER BY k${settings}`);
      assertRowsMatch(r2.rows, o2, 1, `b ${type} dim`, { numericKeys: [0] });
      ok(`(b) ${type} join: SUM(amount*customers.tier) by region ${JSON.stringify(r.rows.map((x) => [x.keys[0], x.values[0]]))}; dim tier*100 ${JSON.stringify(r2.rows.map((x) => x.keys[0]))}`);
    }
  }

  // ================= (c) calc dimension BEFORE a real date dimension, DateBucket auto =================
  {
    // Small table: 5 distinct dates -> auto stays exact.
    const r = await query({ ...base(), rowDimensions: [calcDim('x10', bin('*', f('qty'), num(10))), col('placed')], measures: [calcMeas('amt2', bin('*', agg('sum', f('amount')), num(2)))], dateBucket: 'auto', limit: 100 }, 'c small');
    const o = await select(`SELECT toFloat64(qty) * 10 AS k0, placed AS k1, sum(toFloat64(amount)) * 2 FROM ${T} GROUP BY k0, k1 ORDER BY k0, k1`);
    assertRowsMatch(r.rows, o, 2, 'c small', { numericKeys: [0] });
    assert.equal(r.bucket ?? null, null);
    // Big table: 1000 distinct dates over 999 days -> auto picks week; a bound filter rides along to the probe.
    const big = (c) => ({ k: 'field', db: DB, table: BIG, column: c });
    const req = {
      ...base(BIG),
      rowDimensions: [{ db: DB, table: BIG, column: 'qty x10', calc: bin('*', big('qty'), num(10)) }, { db: DB, table: BIG, column: 'placed' }],
      measures: [{ db: DB, table: BIG, column: 'amt2', agg: null, calc: bin('*', agg('sum', big('amount')), num(2)) }],
      filters: [{ db: DB, table: BIG, column: 'amount', op: '>', value: '5', values: null }],
      dateBucket: 'auto', limit: 5000,
    };
    const rb = await query(req, 'c big');
    assert.deepEqual(rb.bucket, { key: 1, grain: 'week' });
    const ob = await select(`SELECT toFloat64(qty) * 10 AS k0, toMonday(placed) AS k1, sum(toFloat64(amount)) * 2 FROM ${B} WHERE amount > 5 GROUP BY k0, k1 ORDER BY k0, k1`);
    assertRowsMatch(rb.rows, ob, 2, 'c big', { numericKeys: [0] });
    ok(`(c) calc dim before date dim, auto grain: small exact (${r.rows.length} rows), big -> week (${rb.rows.length} rows) == oracle`);
  }

  // ================= (d) Approximate + COUNTD inside a calc Top-N rank =================
  {
    // Unsampled table (no sampling key): COUNTD -> uniq. Rank = COUNTD(qty) + SUM(amount)/100: N 2.15, S 1.10, E 1.01.
    const rank = calcMeas('rank', bin('+', agg('countd', f('qty')), bin('/', agg('sum', f('amount')), num(100))));
    const top = { ...col('region'), op: 'top', value: '2', values: null, topBy: rank };
    const r = await query({ ...base(), rowDimensions: [col('region')], measures: [{ ...col('amount'), agg: 'sum' }], filters: [top], approximate: true }, 'd orders');
    const o = await select(`SELECT region, sum(amount) FROM ${T} WHERE region IN (SELECT region FROM ${T} GROUP BY region ORDER BY uniq(qty) + sum(toFloat64(amount)) / 100 DESC LIMIT 2) GROUP BY region ORDER BY region`);
    assertRowsMatch(r.rows, o, 1, 'd orders');
    assert.deepEqual(r.rows.map((x) => x.keys[0]), ['N', 'S']);
    // Sampled table: SAMPLE 0.1; the rank's literal and the measure's scaling run inside the Top-N subquery.
    const big = (c) => ({ k: 'field', db: DB, table: BIG, column: c });
    const bRank = { db: DB, table: BIG, column: 'rank', agg: null, calc: bin('*', agg('countd', big('amount')), num(3)) };
    const rb = await query({
      ...base(BIG), rowDimensions: [{ db: DB, table: BIG, column: 'region' }],
      measures: [{ db: DB, table: BIG, column: 'ratio', agg: null, calc: bin('/', agg('sum', big('amount')), agg('sum', big('qty'))) }, { db: DB, table: BIG, column: 'amount', agg: 'countDistinct' }],
      filters: [{ db: DB, table: BIG, column: 'region', op: 'top', value: '3', values: null, topBy: bRank }], approximate: true,
    }, 'd big');
    assert.deepEqual(rb.approx, { distinct: true, sample: 0.1 });
    const sub = `SELECT region FROM ${B} AS t0 SAMPLE 0.1 GROUP BY region ORDER BY uniq(toFloat64(amount)) * 3 DESC LIMIT 3`;
    const ranks = await select(`SELECT region, uniq(toFloat64(amount)) * 3 AS r FROM ${B} AS t0 SAMPLE 0.1 GROUP BY region ORDER BY r DESC`);
    assert.ok(ranks.length < 4 || ranks[2][1] !== ranks[3][1], `d big: oracle rank tie at the cut ${JSON.stringify(ranks)}`);
    const ob = await select(`SELECT region, sum(toFloat64(amount) * t0._sample_factor) / nullIf(sum(toFloat64(qty) * t0._sample_factor), 0), uniq(amount) FROM ${B} AS t0 SAMPLE 0.1 WHERE region IN (${sub}) GROUP BY region ORDER BY region`);
    assertRowsMatch(rb.rows, ob, 1, 'd big');
    ok(`(d) Approximate + COUNTD in calc Top-N: orders top2 ${JSON.stringify(r.rows.map((x) => x.keys[0]))}; sampled big top3 ${JSON.stringify(rb.rows.map((x) => x.keys[0]))} == oracle`);
  }

  // ================= (e) one request: calc measure literal + Top-N calc literal + filter + WithTotal + OtherBucket =================
  {
    // Filter amount >= 1 (bound). Top 2 by SUM(qty)+0.5: N 5.5, E 1.5 (S 0.5 out). Limit 1: shown E, Other N.
    const req = {
      ...base(), rowDimensions: [col('region')],
      measures: [calcMeas('amt x2', bin('*', agg('sum', f('amount')), num(2))), calcMeas('qty+price', bin('+', f('qty'), num(0.25)), 'sum')],
      filters: [
        { ...col('amount'), op: '>=', value: '1', values: null },
        { ...col('region'), op: 'top', value: '2', values: null, topBy: calcMeas('rank', bin('+', agg('sum', f('qty')), num(0.5))) },
      ],
      withTotal: true, otherBucket: true, limit: 1,
    };
    const r = await query(req, 'e');
    const w = `WHERE amount >= 1 AND region IN (SELECT region FROM ${T} WHERE amount >= 1 GROUP BY region ORDER BY sum(toFloat64(qty)) + 0.5 DESC LIMIT 2)`;
    const g = `SELECT region AS k, sum(toFloat64(amount)) * 2 AS v0, sum(toFloat64(qty) + 0.25) AS v1 FROM ${T} ${w} GROUP BY k`;
    const o = await select(`SELECT k, v0, v1 FROM (${g}) ORDER BY k LIMIT 1`);
    assertRowsMatch(r.rows, o, 1, 'e rows');
    const tot = await select(`SELECT count() FROM (${g})`);
    assert.equal(r.total, Number(tot[0][0]), `e total app=${r.total} oracle=${tot[0][0]}`);
    const oo = await select(`SELECT count(), sum(v0), sum(v1) FROM (SELECT * FROM (${g}) ORDER BY k LIMIT 1000 OFFSET 1)`);
    assert.equal(r.truncated, true);
    assert.ok(r.other, 'e: other present');
    assert.equal(r.other.groups, Number(oo[0][0]));
    assert.ok(close(r.other.values[0], oo[0][1]) && close(r.other.values[1], oo[0][2]), `e other app=${JSON.stringify(r.other.values)} oracle=${JSON.stringify(oo[0])}`);
    ok(`(e) combined: rows ${JSON.stringify(r.rows.map((x) => [x.keys[0], ...x.values]))}, total ${r.total}, other ${JSON.stringify(r.other)} == oracle`);
  }

  // ================= (f) min/max of a text calc return strings =================
  {
    const r = await query({ ...base(), measures: [calcMeas('first', agg('min', f('region'))), calcMeas('last', f('region'), 'max'), calcMeas('first placed', agg('min', f('placed')))] }, 'f');
    const o = await select(`SELECT min(region), max(region), toString(min(placed)) FROM ${T}`);
    assert.deepEqual(r.rows[0].values, o[0]);
    assert.ok(r.rows[0].values.every((v) => typeof v === 'string'));
    const rg = await query({ ...base(), rowDimensions: [col('qty')], measures: [calcMeas('first', agg('min', f('region')))] }, 'f grouped');
    const og = await select(`SELECT toString(qty), min(region) FROM ${T} GROUP BY qty ORDER BY qty`);
    assertRowsMatch(rg.rows, og, 1, 'f grouped');
    ok(`(f) MIN/MAX of text calcs are strings: ${JSON.stringify(r.rows[0].values)}`);
  }

  // ================= (g) Float64 calc-dimension keys =================
  {
    const r = await query({ ...base(), rowDimensions: [calcDim('amount / 3', bin('/', f('amount'), num(3)))], measures: [{ ...col('qty'), agg: 'sum' }] }, 'g');
    const o = await select(`SELECT toFloat64(amount) / 3 AS k, sum(qty) FROM ${T} GROUP BY k ORDER BY k`);
    assertRowsMatch(r.rows, o, 1, 'g', { numericKeys: [0] });
    assert.ok(r.rows.every((x) => x.keys[0] !== null && /^-?\d+(\.\d+)?(E[-+]?\d+)?$/i.test(x.keys[0])), `g: keys parse as invariant numbers ${JSON.stringify(r.rows.map((x) => x.keys[0]))}`);
    ok(`(g) Float64 calc-dimension keys parse numerically: ${JSON.stringify(r.rows.map((x) => x.keys[0]))}`);
  }

  // ================= (h) Approximate on the core ratio: same values as exact =================
  {
    const r = await query({ ...base(), rowDimensions: [col('region')], measures: [calcMeas('ratio', RATIO)], approximate: true, fresh: true }, 'h');
    const o = await select(`SELECT region, sum(toFloat64(amount)) / nullIf(sum(toFloat64(qty)), 0) FROM ${T} GROUP BY region ORDER BY region`);
    assertRowsMatch(r.rows, o, 1, 'h');
    assert.deepEqual(r.approx, { distinct: false, sample: null });
    ok(`(h) Approximate ratio == oracle; approx ${JSON.stringify(r.approx)}`);
  }

  // ================= (i) calculated column dimension =================
  {
    const colCalc = calcDim('qty x10', bin('*', f('qty'), num(10)));
    const r = await query({ ...base(), rowDimensions: [col('region')], columnDimensions: [colCalc], measures: [{ ...col('amount'), agg: 'sum' }] }, 'i');
    assert.deepEqual(r.columnDimensions, ['qty x10']);
    const o = await select(`SELECT region, toFloat64(qty) * 10 AS k, sum(toFloat64(amount)) FROM ${T} GROUP BY region, k ORDER BY region, k`);
    assert.equal(r.rows.length, o.length, `i: rows app=${r.rows.length} oracle=${o.length}`);
    const got = new Set(r.rows.map((x) => `${x.keys[0]}|${Number(x.keys[1])}|${Number(x.values[0])}`));
    for (const row of o) assert.ok(got.has(`${row[0]}|${Number(row[1])}|${Number(row[2])}`), `i: missing ${JSON.stringify(row)}`);
    assert.deepEqual(new Set(r.rows.map((x) => Number(x.keys[1]))), new Set([0, 10, 20, 30]));
    ok(`(i) calculated column dimension keys {0,10,20,30} == oracle (${r.rows.length} cells)`);
  }

  // ================= (j) CSV export honours calculations =================
  {
    const req = { ...base(), rowDimensions: [col('region')], measures: [calcMeas('amount per qty', RATIO), calcMeas('qty doubled', bin('*', f('qty'), num(2)), 'sum')] };
    const json = await query(req, 'j json');
    const res = await fetch(`${APP}/api/query/export.csv`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(req) });
    const text = await res.text();
    assert.equal(res.status, 200, `j export: ${res.status} ${text.slice(0, 300)}`);
    const lines = text.trim().split('\r\n').map((l) => l.split(','));
    assert.deepEqual(lines[0], ['calc_smoke_orders.region', 'amount per qty', 'qty doubled']);
    assert.equal(lines.length - 1, json.rows.length);
    json.rows.forEach((row, i) => {
      assert.equal(lines[i + 1][0], row.keys[0]);
      row.values.forEach((v, c) => {
        const cell = lines[i + 1][c + 1];
        assert.ok(v === null ? cell === '' : close(Number(cell), v), `j: row ${i} col ${c} csv=${cell} json=${v}`);
      });
    });
    ok(`(j) CSV export: header uses the labels, ${json.rows.length} rows equal the JSON result`);
  }

  // ================= (k) a plain non-null count is named the way the client labels it, in JSON and CSV =================
  {
    const req = { ...base(), rowDimensions: [col('region')], measures: [{ ...col('price'), agg: 'countNonNull' }] };
    const json = await query(req, 'k json');
    assert.deepEqual(json.measures, ['non-null price']);
    const res = await fetch(`${APP}/api/query/export.csv`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(req) });
    const text = await res.text();
    assert.equal(res.status, 200, `k export: ${res.status} ${text.slice(0, 300)}`);
    assert.deepEqual(text.trim().split('\r\n')[0].split(','), ['calc_smoke_orders.region', 'non-null price']);
    const byRegion = Object.fromEntries(json.rows.map((r) => [r.keys[0], Number(r.values[0])]));
    assert.deepEqual(byRegion, { N: 1, S: 1, E: 1 });
    ok('(k) plain countNonNull: measure named "non-null price" in JSON and the CSV header; N=1 S=1 E=1');
  }

  // ================= (l) TEXT() / STR(): numbers, dates and text become text, compared with toString on ClickHouse =================
  {
    const txt = (arg) => ({ k: 'fn', fn: 'text', args: [arg] });
    const run = async (label, expr) => (await query({ ...base(), rowDimensions: [calcDim(label, expr)], measures: [{ ...col('qty'), agg: 'sum' }] }, label)).rows;
    const oracle = (sqlExpr) => select(`SELECT ${sqlExpr} AS k, sum(qty) FROM ${T} GROUP BY k ORDER BY k`);
    const cases = [
      ['TEXT(placed)', txt(f('placed')), 'toString(placed)'],
      ['TEXT(qty)', txt(f('qty')), 'toString(toFloat64(qty))'],
      ['TEXT(amount)', txt(f('amount')), 'toString(toFloat64(amount))'],
      ['TEXT(price)', txt(f('price')), 'toString(price)'],
      ['TEXT(region)', txt(f('region')), 'toString(region)'],
      ['TEXT(DATEADD)', txt({ k: 'fn', fn: 'dateadd', args: [{ k: 'str', v: 'day' }, num(1), f('placed')] }), `toString(toDateTime64(addDays(toDateTime64(placed, 0), 1), 0))`],
    ];
    for (const [label, expr, sql] of cases) {
      const rows = await run(label, expr);
      const want = await oracle(sql);
      assert.equal(rows.length, want.length, `${label}: rows`);
      want.forEach((w, i) => {
        assert.equal(rows[i].keys[0], w[0] === null ? null : String(w[0]), `${label}: key ${i}`);
        assert.ok(close(rows[i].values[0], w[1]), `${label}: value ${i}`);
      });
    }
    const dates = (await run('TEXT(placed)', txt(f('placed')))).map((r) => r.keys[0]);
    assert.deepEqual(dates, ['2026-01-05', '2026-01-20', '2026-02-10', '2026-02-15', '2026-03-01']);
    ok(`(l) TEXT(): date, integer, decimal, nullable float, text and DATEADD results match toString on ClickHouse; dates read YYYY-MM-DD`);
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
