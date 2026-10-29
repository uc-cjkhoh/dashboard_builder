// Live smoke for box-plot outliers (T07-08): the dev app (APP_URL, default http://localhost:5210) against a real
// ClickHouse. Fixture table test_cj.bk_box is created and dropped over HTTPS; the app stays read-only.
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5210';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');
const DB = 'test_cj', T = 'bk_box';

async function ch(sql) {
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?default_format=JSONCompact`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 300)}`);
}
const write = (sql) => { assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_box\b/); return ch(sql); };

let cookie = '';
async function app(path, body) {
  const res = await fetch(`${APP}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body ?? {}) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
let passed = 0;
const pass = (m) => { passed++; console.log(`ok ${m}`); };

// Fixture: A = 1..10 and 100 (q1 3.5, q3 8.5, fences -4 / 16: 100 is the one outlier, whiskers 1 / 10);
//          B = 5,5,5 (no outliers); C = -50, 1..9 (q1 ~2.25, q3 ~7.75 -> -50 is a low outlier)
async function setup() {
  await write(`DROP TABLE IF EXISTS ${DB}.${T}`);
  await write(`CREATE TABLE ${DB}.${T} (g String, x Float64, v Float64, label String, n Nullable(String)) ENGINE = MergeTree ORDER BY g`);
  // v / label are decoys named like the SQL aliases (v = 0 on every row except the A outlier, label = the group);
  // n is a Nullable dimension: NULL holds A's 4..10 and 100 (100 is the outlier, whisker 10); every other row is 'e'.
  const rows = [...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100].map((x) => ['A', x]), ...[5, 5, 5].map((x) => ['B', x]), ...[-50, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((x) => ['C', x])];
  await write(`INSERT INTO ${DB}.${T} (g, x, v, label, n) VALUES ${rows.map(([g, x]) => `('${g}',${x},${x === 100 ? 7 : 0},'${g}',${g === 'A' && x > 3 ? 'NULL' : "'e'"})`).join(',')}`);
}
const teardown = () => write(`DROP TABLE IF EXISTS ${DB}.${T}`).catch((e) => console.error(`teardown: ${e.message}`));
const box = (extra = {}) => app(`/api/databases/${DB}/tables/${T}/boxplot`, { dimension: 'g', measure: 'x', filters: [], limit: 50, ...extra });

async function main() {
  const conn = await app('/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);
  {
    const r = await box(); assert.equal(r.status, 200, r.text.slice(0, 300));
    const g = Object.fromEntries(r.json.groups.map((x) => [x.label, x]));
    assert.equal(g.A.lowerWhisker, 1); assert.equal(g.A.upperWhisker, 10); assert.equal(g.A.max, 100);
    assert.equal(g.B.lowerWhisker, 5); assert.equal(g.B.upperWhisker, 5);
    assert.equal(g.C.lowerWhisker, 1);
    const o = r.json.outliers.map((x) => `${x.label}:${x.value}`);
    assert.deepEqual(o, ['A:100', 'C:-50']);
    assert.equal(r.json.outliersTruncated, false);
    pass('(a) grouped: whiskers stop at the fences; outliers are A:100 and C:-50');
  }
  {
    const r = await box({ dimension: null }); assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.json.groups.length, 1);
    assert.ok(r.json.outliers.some((x) => x.value === 100) && r.json.outliers.every((x) => x.label === null));
    pass('(b) ungrouped box: scalar fences, outliers carry no label');
  }
  {
    const r = await box({ filters: [{ column: 'g', op: '=', value: 'B' }] }); assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.json.outliers.length, 0); assert.equal(r.json.groups.length, 1);
    pass('(c) a bound filter narrows both the box and its outliers');
  }
  {
    const r = await box({ limit: 1 }); assert.equal(r.status, 200);
    assert.equal(r.json.truncated, true); assert.ok(r.json.outliers.every((x) => x.label === 'A'));
    pass('(d) the group limit also bounds the outlier groups');
  }
  {
    const r = await box({ filters: [{ column: 'v', op: '=', value: '0' }] }); assert.equal(r.status, 200, r.text.slice(0, 300));
    const g = Object.fromEntries(r.json.groups.map((x) => [x.label, x]));
    assert.equal(g.A.max, 10, 'the filter on the user column v removed the 100 row'); assert.equal(g.A.upperWhisker, 10);
    assert.ok(!r.json.outliers.some((x) => x.label === 'A'), 'A has no outlier once v = 0 filters row 100 out');
    const r2 = await box({ filters: [{ column: 'label', op: '=', value: 'A' }] }); assert.equal(r2.status, 200);
    assert.deepEqual(r2.json.groups.map((x) => x.label), ['A']); assert.deepEqual(r2.json.outliers.map((x) => x.value), [100]);
    pass('(f) filters on user columns named v and label hit the same rows in the stats, whisker and outlier queries');
  }
  {
    const r = await box({ dimension: 'n' }); assert.equal(r.status, 200, r.text.slice(0, 300));
    const g = Object.fromEntries(r.json.groups.map((x) => [String(x.label), x]));
    assert.ok('null' in g && 'e' in g, `groups ${Object.keys(g)}`);
    assert.equal(g.null.max, 100); assert.equal(g.null.upperWhisker, 10, 'NULL group whisker stops at the fence');
    assert.deepEqual(r.json.outliers.filter((x) => x.label === null).map((x) => x.value).sort((a, b) => a - b), [100]);
    pass('(g) a NULL dimension group gets whiskers and outliers (join on text form + is-NULL)');
  }
  {
    const r = await box({ measure: 'x; DROP TABLE t' }); assert.equal(r.status, 400);
    pass('(e) a hostile measure identifier is a 400');
  }
}
try { await setup(); await main(); } catch (e) { console.error(`FAIL: ${e.stack ?? e.message}`); process.exitCode = 1; } finally { await teardown(); }
console.log(`${passed} passed${process.exitCode ? ', FAILED' : ''}`);
