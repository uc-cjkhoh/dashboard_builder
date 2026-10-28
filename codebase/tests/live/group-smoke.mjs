// Live smoke for group fields (T02-30): the dev app (APP_URL, default http://localhost:5203) against a real ClickHouse. The group
// expression is the tree Calc/group-model.js builds (the same one the browser sends); it must GROUP members in ClickHouse, with
// every member bound as a parameter. Fixture: test_cj.bk_groups, created straight over HTTPS (never through the app, which stays
// read-only) and dropped in `finally`. Expectations are HAND-COMPUTED from the inserted rows below and cross-checked with an
// independent oracle SELECT (multiIf over the same members).
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';
import { groupTree } from '../../src/DashboardBuilder/Features/Calc/group-model.js';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5203';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');
const DB = 'test_cj', TABLE = 'bk_groups';

async function ch(sql, { readonly = true } = {}) {
  const qs = new URLSearchParams({ default_format: 'JSONCompact', output_format_json_quote_64bit_integers: '0' });
  if (readonly) qs.set('readonly', '2');
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?${qs}`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 500)}`);
  return text.trim() ? JSON.parse(text).data : [];
}
const select = (sql) => { assert.match(sql, /^\s*SELECT\b/i); return ch(sql); };
const write = (sql) => { assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_groups\b/, `refusing write: ${sql.slice(0, 60)}`); return ch(sql, { readonly: false }); };

let cookie = '';
async function app(method, path, body) {
  const res = await fetch(`${APP}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

// The rows (region, amount) — the hand-computed answers follow from this list.
const ROWS = [
  ['APAC', 10], ['EU', 20], ['EU', 5], ['US', 7], [null, 3], ['constructor', 4], ["O'Brien", 1], ['', 2],
  ["x'); DROP TABLE test_cj.bk_groups; --", 6], ['%', 8],
];
const FIELD = { db: DB, table: TABLE, column: 'region' };
const SPEC = { field: FIELD, groups: [
  { name: 'Asia & Europe', members: ['APAC', 'EU', "O'Brien"] },
  { name: 'Americas', members: ['US'] },
  { name: 'Odd', members: ["x'); DROP TABLE test_cj.bk_groups; --", '%'] },
] };
const sqlStr = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
let passed = 0;
const ok = (n) => { passed++; console.log(`ok ${n}`); };

async function main() {
  const conn = await app('POST', '/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);
  const req = (spec, extra = {}) => ({ from: { db: DB, table: TABLE }, joins: [], fresh: true, filters: [],
    rowDimensions: [{ db: '', table: '', column: 'region (groups)', calc: groupTree(spec) }], columnDimensions: [],
    measures: [{ db: DB, table: TABLE, column: 'amount', agg: 'sum' }, { db: DB, table: TABLE, column: 'amount', agg: 'count' }], ...extra });
  const r = await app('POST', '/api/query', req(SPEC));
  assert.equal(r.status, 200, `query: ${r.status} ${r.text.slice(0, 400)}`);
  const got = new Map(r.json.rows.map((x) => [x.keys[0], x.values.map(Number)]));

  // Hand-computed: Asia & Europe = APAC 10 + EU 25 + O'Brien 1 = 36 over 4 rows; Americas = US 7 (1 row);
  // Odd = the injection-looking member 6 + '%' 8 = 14 over 2 rows; ungrouped members keep their own value:
  // 'constructor' 4 (1), '' 2 (1), NULL 3 (1) — a NULL member compares as unknown, falls to ELSE and stays NULL.
  const expected = new Map([['Asia & Europe', [36, 4]], ['Americas', [7, 1]], ['Odd', [14, 2]], ['constructor', [4, 1]], ['', [2, 1]], [null, [3, 1]]]);
  assert.equal(got.size, expected.size, `groups: ${JSON.stringify([...got])}`);
  for (const [k, v] of expected) assert.deepEqual(got.get(k), v, `group ${JSON.stringify(k)}: app=${JSON.stringify(got.get(k))} hand=${JSON.stringify(v)}`);
  ok('the group tree groups in ClickHouse: 36/4, 7/1, 14/2, and ungrouped constructor 4/1, "" 2/1, NULL 3/1 (hand-computed)');

  const members = (g) => g.members.map(sqlStr).join(', ');
  const oracle = await select(`SELECT multiIf(region IN (${members(SPEC.groups[0])}), 'Asia & Europe', region IN (${members(SPEC.groups[1])}), 'Americas', region IN (${members(SPEC.groups[2])}), 'Odd', region) AS g, sum(amount), count() FROM ${DB}.${TABLE} GROUP BY g ORDER BY g`);
  assert.equal(oracle.length, got.size);
  for (const [g, s, c] of oracle) assert.deepEqual(got.get(g), [Number(s), Number(c)], `oracle ${JSON.stringify(g)}`);
  ok('an independent multiIf oracle agrees on every group');

  const still = await select(`SELECT count() FROM system.tables WHERE database = '${DB}' AND name = '${TABLE}'`);
  assert.equal(Number(still[0][0]), 1, 'the table is still there: member text was never executed');
  ok('the member that looks like SQL was matched as data (the table survives)');

  const big = { field: FIELD, groups: [{ name: 'All', members: Array.from({ length: 50 }, (_, i) => `m${i}`) }] };
  const refused = await app('POST', '/api/query', req(big));
  assert.equal(refused.status, 400, `an over-budget tree must be refused by the server too: ${refused.status}`);
  ok(`the engine refuses a 50-member group (${refused.json?.error ?? 'error'}), matching the client's edit-time refusal`);

  const maxed = { field: FIELD, groups: [{ name: 'All', members: ['APAC', 'EU', ...Array.from({ length: 47 }, (_, i) => `m${i}`)] }] };
  const full = await app('POST', '/api/query', req(maxed));
  assert.equal(full.status, 200, `49 members must be accepted: ${full.status} ${full.text.slice(0, 300)}`);
  assert.equal(Number(full.json.rows.find((x) => x.keys[0] === 'All').values[0]), 35);
  ok('a 49-member group (the budget) is accepted: APAC 10 + EU 25 = 35');

  // Columns the catalog calls "text" that are not String: probe what the tree does on each.
  const probe = {};
  for (const [col, member] of [['u', '00000000-0000-0000-0000-000000000001'], ['ip4', '10.0.0.1'], ['ip6', '::1'], ['e', 'a'], ['ne', 'a'], ['fs', 'ab1'], ['lc', 'x']]) {
    const spec = { field: { db: DB, table: TABLE, column: col }, groups: [{ name: 'G', members: [member] }] };
    const q = await app('POST', '/api/query', req(spec));
    probe[col] = q.status === 200 ? 'ok' : `${q.status} ${(q.json?.error ?? '').slice(0, 120)}`;
    console.log(`probe ${col}: ${probe[col]}`);
  }
  // Pinned: String-like columns group; UUID / IPv4 / IPv6 / Nullable(Enum) have no common type with the text branches and fail, so the client refuses them (groupCategoryProblem).
  for (const col of ['fs', 'lc', 'e']) assert.equal(probe[col], 'ok', `${col} should group`);
  for (const col of ['u', 'ip4', 'ip6', 'ne']) assert.notEqual(probe[col], 'ok', `${col} was expected to fail (and be refused client-side)`);
  ok('FixedString / LowCardinality(String) group; UUID, IPv4, IPv6 and Nullable(Enum8) fail in ClickHouse (refused client-side; every Enum is refused)');
  await app('POST', '/api/connection/disconnect');
}

let failed = false;
try {
  await write(`DROP TABLE IF EXISTS ${DB}.${TABLE}`);
  await write(`CREATE TABLE ${DB}.${TABLE} (region Nullable(String), amount Float64, u UUID, ip4 IPv4, ip6 IPv6, e Enum8('a' = 1, 'b' = 2), fs FixedString(3), lc LowCardinality(String), ne Nullable(Enum8('a' = 1, 'b' = 2))) ENGINE = MergeTree ORDER BY tuple()`);
  await write(`INSERT INTO ${DB}.${TABLE} VALUES ${ROWS.map(([r, a], i) => `(${r === null ? 'NULL' : sqlStr(r)}, ${a}, '00000000-0000-0000-0000-00000000000${i % 2}', '10.0.0.${i % 2}', '::${i % 2}', ${i % 2 ? "'a'" : "'b'"}, 'ab${i % 2}', ${i % 2 ? "'x'" : "'y'"}, ${i % 2 ? "'a'" : 'NULL'})`).join(', ')}`);
  await main();
} catch (e) {
  failed = true;
  console.error(`FAIL: ${e.message}`);
} finally {
  await write(`DROP TABLE IF EXISTS ${DB}.${TABLE}`);
  const left = await select(`SELECT name FROM system.tables WHERE database = '${DB}' AND name = '${TABLE}'`);
  console.log(left.length ? 'FAIL teardown: table still present' : 'ok teardown: test_cj.bk_groups dropped');
}
console.log(`${passed} checks passed${failed ? ', FAILED' : ''}`);
process.exit(failed ? 1 : 0);
