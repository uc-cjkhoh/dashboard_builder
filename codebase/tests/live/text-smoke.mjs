// Live smoke for calculated-field text functions (LOWER/UPPER/TRIM/LEN/LEFT/RIGHT/REPLACE/CONCAT/CONTAINS/STARTSWITH/ENDSWITH/SPLIT): the dev app (APP_URL, default http://localhost:5190) against a real
// ClickHouse. Creates its fixture tables in test_cj (bk_text) straight over HTTPS — never through the
// app, which stays read-only — and drops them in `finally`. Every expectation beyond the pinned core values
// comes from an independent oracle: a hand computation (see the table comment below).
// Env: CH_HOST, CH_PORT, CH_USER, CH_PASSWORD (never printed); NODE_EXTRA_CA_CERTS for the self-signed cert.
import assert from 'node:assert/strict';

const { CH_HOST, CH_PORT, CH_USER, CH_PASSWORD } = process.env;
assert.ok(CH_HOST && CH_PORT && CH_USER && CH_PASSWORD !== undefined, 'set CH_HOST, CH_PORT, CH_USER, CH_PASSWORD');
const APP = process.env.APP_URL ?? 'http://localhost:5190';
const auth = 'Basic ' + Buffer.from(`${CH_USER}:${CH_PASSWORD}`).toString('base64');

const DB = 'test_cj', TBL = 'bk_text', T = `${DB}.${TBL}`, T2 = `${DB}.bk_text_arg`;

async function ch(sql, { readonly = true } = {}) {
  const qs = new URLSearchParams({ default_format: 'JSONCompact', output_format_json_quote_64bit_integers: '0' });
  if (readonly) qs.set('readonly', '2');
  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?${qs}`, { method: 'POST', headers: { Authorization: auth }, body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 500)}`);
  return text.trim() ? JSON.parse(text).data : [];
}
// The only writes: DDL / inserts on test_cj.bk_text.
const write = (sql) => {
  assert.match(sql, /^(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS) test_cj\.bk_text(_arg)?\b/, `refusing write: ${sql.slice(0, 60)}`);
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
const fn = (name, ...args) => ({ k: 'fn', fn: name, args });
const agg = (name, arg) => ({ k: 'agg', fn: name, arg });
const ifnull = (l, r) => ({ k: 'ifnull', l, r });
const dim = (column) => ({ db: DB, table: TBL, column });
const calcDim = (label, calc) => ({ db: DB, table: TBL, column: label, calc });
const calcMeas = (label, calc, aggName = null) => ({ db: DB, table: TBL, column: label, agg: aggName, calc });
const base = () => ({ from: { db: DB, table: TBL }, joins: [], rowDimensions: [], columnDimensions: [], measures: [], filters: [], fresh: true });
const countRows = { db: DB, table: TBL, column: 'id', agg: 'countNonNull' };

let passed = 0;
const ok = (name) => { passed++; console.log(`ok ${name}`); };

// id  s
//  1  'Hello World'
//  2  'héllo wörld'         (multibyte)
//  3  NULL
//  4  ''                    (empty)
//  5  '  padded  '          (two spaces each side)
//  6  'a-b-c'
//  7  '日本語テキスト'        (7 characters, 21 bytes)
//  8  'ABC'
//  9  'a--b'                (an empty token between the dashes)
async function setup() {
  await write(`DROP TABLE IF EXISTS ${T}`);
  await write(`DROP TABLE IF EXISTS ${T2}`);
  await write(`CREATE TABLE ${T2} (id UInt32, s Nullable(String), f String, t String) ENGINE = MergeTree ORDER BY id`);
  await write(`INSERT INTO ${T2} VALUES (1,'banana','an','AN'),(2,'banana','x','y'),(3,NULL,'a','b'),(4,'x\\ty\\n','','z'),(5,'  pad\\t','','')`);
  await write(`CREATE TABLE ${T} (id UInt32, s Nullable(String)) ENGINE = MergeTree ORDER BY id`);
  await write(`INSERT INTO ${T} VALUES (1,'Hello World'),(2,'héllo wörld'),(3,NULL),(4,''),(5,'  padded  '),(6,'a-b-c'),(7,'日本語テキスト'),(8,'ABC'),(9,'a--b')`);
}
async function teardown() {
  await write(`DROP TABLE IF EXISTS ${T2}`);
  await write(`DROP TABLE IF EXISTS ${T}`);
  const left = await ch(`SELECT name FROM system.tables WHERE database = '${DB}' AND name = '${TBL}'`);
  assert.deepEqual(left, [], 'bk_text still present');
  console.log('ok teardown: test_cj.bk_text dropped');
}

// One calculated dimension next to the id: { id: value } with the value as the app returns it (NULL stays null).
async function byId(calc, label) {
  const r = await query({ ...base(), rowDimensions: [dim('id'), calcDim('c', calc)], measures: [countRows] }, label);
  return Object.fromEntries(r.rows.map((x) => [String(x.keys[0]), x.keys[1] === null ? null : String(x.keys[1])]));
}
const NULL = null;
async function expectById(label, calc, want) {
  const got = await byId(calc, label);
  const w = Object.fromEntries(want.map((v, i) => [String(i + 1), v === null ? null : String(v)]));
  assert.deepEqual(got, w, `${label}: got ${JSON.stringify(got)}`);
  ok(`${label}: ${JSON.stringify(want)}`);
}

async function main() {
  const conn = await app('POST', '/api/connection', { host: CH_HOST, port: Number(CH_PORT), user: CH_USER, password: CH_PASSWORD, secure: true, allowInvalidCert: true });
  assert.equal(conn.status, 200, `connect: ${conn.status}`);
  const s = f('s');

  await expectById('LOWER', fn('lower', s), ['hello world', 'héllo wörld', NULL, '', '  padded  ', 'a-b-c', '日本語テキスト', 'abc', 'a--b']);
  await expectById('UPPER (unicode-aware)', fn('upper', s), ['HELLO WORLD', 'HÉLLO WÖRLD', NULL, '', '  PADDED  ', 'A-B-C', '日本語テキスト', 'ABC', 'A--B']);
  await expectById('TRIM', fn('trim', s), ['Hello World', 'héllo wörld', NULL, '', 'padded', 'a-b-c', '日本語テキスト', 'ABC', 'a--b']);
  await expectById('LEN counts characters, not bytes', fn('len', s), [11, 11, NULL, 0, 10, 5, 7, 3, 4]);
  await expectById('LEFT 3', fn('left', s, num(3)), ['Hel', 'hél', NULL, '', '  p', 'a-b', '日本語', 'ABC', 'a--']);
  await expectById('LEFT 0', fn('left', s, num(0)), ['', '', NULL, '', '', '', '', '', '']);
  await expectById('LEFT 100 (longer than the text) is the whole text', fn('left', s, num(100)), ['Hello World', 'héllo wörld', NULL, '', '  padded  ', 'a-b-c', '日本語テキスト', 'ABC', 'a--b']);
  await expectById('RIGHT 3', fn('right', s, num(3)), ['rld', 'rld', NULL, '', 'd  ', 'b-c', 'キスト', 'ABC', '--b']);
  await expectById('RIGHT 100 is the whole text', fn('right', s, num(100)), ['Hello World', 'héllo wörld', NULL, '', '  padded  ', 'a-b-c', '日本語テキスト', 'ABC', 'a--b']);
  await expectById("REPLACE 'l' -> 'L' (case-sensitive, every occurrence)", fn('replace', s, str('l'), str('L')), ['HeLLo WorLd', 'héLLo wörLd', NULL, '', '  padded  ', 'a-b-c', '日本語テキスト', 'ABC', 'a--b']);
  await expectById("REPLACE '-' -> ''", fn('replace', s, str('-'), str('')), ['Hello World', 'héllo wörld', NULL, '', '  padded  ', 'abc', '日本語テキスト', 'ABC', 'ab']);
  await expectById("REPLACE '' -> 'x' leaves the text unchanged", fn('replace', s, str(''), str('x')), ['Hello World', 'héllo wörld', NULL, '', '  padded  ', 'a-b-c', '日本語テキスト', 'ABC', 'a--b']);
  await expectById("REPLACE with a quote-bearing, injection-shaped literal is a no-op", fn('replace', s, str("a'); DROP TABLE bk_text; --"), str('')), ['Hello World', 'héllo wörld', NULL, '', '  padded  ', 'a-b-c', '日本語テキスト', 'ABC', 'a--b']);
  assert.equal(Number((await ch(`SELECT count() FROM ${T}`))[0][0]), 9);
  await expectById("CONCAT(IFNULL(s, '?'), '|', s) (NULL propagates through CONCAT)", fn('concat', ifnull(s, str('?')), str('|'), s),
    ['Hello World|Hello World', 'héllo wörld|héllo wörld', NULL, '|', '  padded  |  padded  ', 'a-b-c|a-b-c', '日本語テキスト|日本語テキスト', 'ABC|ABC', 'a--b|a--b']);
  await expectById("CONCAT(IFNULL(s, '?'), '!')", fn('concat', ifnull(s, str('?')), str('!')), ['Hello World!', 'héllo wörld!', '?!', '!', '  padded  !', 'a-b-c!', '日本語テキスト!', 'ABC!', 'a--b!']);
  await expectById("CONTAINS(s, 'o') is case-sensitive; NULL stays NULL", fn('contains', s, str('o')), ['true', 'true', NULL, 'false', 'false', 'false', 'false', 'false', 'false']);
  await expectById("CONTAINS(s, 'W') (capital)", fn('contains', s, str('W')), ['true', 'false', NULL, 'false', 'false', 'false', 'false', 'false', 'false']);
  await expectById("CONTAINS(s, '') is true for every non-NULL text", fn('contains', s, str('')), ['true', 'true', NULL, 'true', 'true', 'true', 'true', 'true', 'true']);
  await expectById("CONTAINS(s, '語テ') (multibyte needle)", fn('contains', s, str('語テ')), ['false', 'false', NULL, 'false', 'false', 'false', 'true', 'false', 'false']);
  await expectById("STARTSWITH(s, 'a')", fn('startswith', s, str('a')), ['false', 'false', NULL, 'false', 'false', 'true', 'false', 'false', 'true']);
  await expectById("ENDSWITH(s, 'c')", fn('endswith', s, str('c')), ['false', 'false', NULL, 'false', 'false', 'true', 'false', 'false', 'false']);
  await expectById("ENDSWITH(s, 'テキスト')", fn('endswith', s, str('テキスト')), ['false', 'false', NULL, 'false', 'false', 'false', 'true', 'false', 'false']);
  await expectById("SPLIT(s, '-', 1)", fn('split', s, str('-'), num(1)), ['Hello World', 'héllo wörld', NULL, '', '  padded  ', 'a', '日本語テキスト', 'ABC', 'a']);
  await expectById("SPLIT(s, '-', 2): past the last token is NULL; '' between delimiters", fn('split', s, str('-'), num(2)), [NULL, NULL, NULL, NULL, NULL, 'b', NULL, NULL, '']);
  await expectById("SPLIT(s, '-', 3)", fn('split', s, str('-'), num(3)), [NULL, NULL, NULL, NULL, NULL, 'c', NULL, NULL, 'b']);
  await expectById("SPLIT(s, ' ', 3)", fn('split', s, str(' '), num(3)), [NULL, NULL, NULL, NULL, 'padded', NULL, NULL, NULL, NULL]);
  await expectById("SPLIT(s, '--', 2) (multi-character separator)", fn('split', s, str('--'), num(2)), [NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'b']);
  await expectById("nested: LEFT(UPPER(TRIM(s)), 2)", fn('left', fn('upper', fn('trim', s)), num(2)), ['HE', 'HÉ', NULL, '', 'PA', 'A-', '日本', 'AB', 'A-']);

  { // inside an aggregate: distinct lower-cased values, NULL excluded (8: every row but id 3; 'ABC' and nothing else collide)
    const r = await query({ ...base(), measures: [calcMeas('d', agg('countd', fn('lower', s)))] }, 'countd');
    assert.equal(Number(r.rows[0].values[0]), 8);
    ok('COUNTD(LOWER(s)) = 8 (NULL not counted)');
  }
  { // grouping by a text calculation, counting rows: LEFT(s,1) groups
    const r = await query({ ...base(), rowDimensions: [calcDim('first', fn('left', s, num(1)))], measures: [countRows] }, 'group');
    const got = Object.fromEntries(r.rows.map((x) => [String(x.keys[0]), Number(x.values[0])]));
    assert.deepEqual(got, { H: 1, h: 1, null: 1, '': 1, ' ': 1, a: 2, '日': 1, A: 1 });
    ok("group by LEFT(s, 1): H 1, h 1, NULL 1, '' 1, ' ' 1, a 2, 日 1, A 1");
  }
  { // a text predicate as a filter-like dimension combined with IF is covered by the unit tests; here a text measure
    const r = await query({ ...base(), measures: [calcMeas('longest', fn('lower', s), 'max')] }, 'max text');
    assert.equal(String(r.rows[0].values[0]), '日本語テキスト'); // max by byte order: the multibyte text sorts last
    ok("MAX(LOWER(s)) of a row-level text calculation = '日本語テキスト' (byte order)");
  }
  { // errors: 400 with the node path
    const bad = await app('POST', '/api/query', { ...base(), rowDimensions: [dim('id'), calcDim('x', fn('lower', f('id')))], measures: [countRows] });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /LOWER needs a text — bk_text\.id is number\./);
    assert.equal(bad.json.field, 'rowDimensions[1].calc.args.0');
    const neg = await app('POST', '/api/query', { ...base(), rowDimensions: [calcDim('x', fn('left', s, num(-1)))], measures: [countRows] });
    assert.equal(neg.status, 400);
    assert.match(neg.json.error, /LEFT's length must be a whole number from 0 to 1000/);
    const big = await app('POST', '/api/query', { ...base(), rowDimensions: [calcDim('x', fn('split', s, str('-'), num(1001)))], measures: [countRows] });
    assert.equal(big.status, 400);
    const arity = await app('POST', '/api/query', { ...base(), rowDimensions: [calcDim('x', fn('lower', s, s))], measures: [countRows] });
    assert.equal(arity.status, 400);
    assert.match(arity.json.error, /LOWER takes 1 argument\./);
    const unknown = await app('POST', '/api/query', { ...base(), rowDimensions: [calcDim('x', fn('reverse', s))], measures: [countRows] });
    assert.equal(unknown.status, 400);
    ok('a number argument, a negative length, a position over 1000, wrong arity and an unknown function are 400s with a path');
  }
  { // non-literal text arguments: fields as REPLACE from/to and as a CONTAINS needle (ClickHouse accepts non-constant needles here)
    const TB = 'bk_text_arg', fb = (c) => ({ k: 'field', db: DB, table: TB, column: c });
    const byId2 = async (calc, label) => {
      const r = await query({ from: { db: DB, table: TB }, joins: [], rowDimensions: [{ db: DB, table: TB, column: 'id' }, calcDim('c', calc)], columnDimensions: [], measures: [{ db: DB, table: TB, column: 'id', agg: 'countNonNull' }], filters: [], fresh: true }, label);
      return Object.fromEntries(r.rows.map((x) => [String(x.keys[0]), x.keys[1] === null ? null : String(x.keys[1])]));
    };
    const want = async (label, calc, vals) => {
      assert.deepEqual(await byId2(calc, label), Object.fromEntries(vals.map((v, i) => [String(i + 1), v])), label);
      ok(`${label}: ${JSON.stringify(vals)}`);
    };
    // rows: (banana,an,AN) (banana,x,y) (NULL,a,b) ('x<TAB>y<NL>','',z) ('  pad<TAB>','','')
    await want('REPLACE(s, f field, \'-\')', fn('replace', fb('s'), fb('f'), str('-')), ['b--a', 'banana', null, 'x\ty\n', '  pad\t']);
    await want('REPLACE(s, f, t) with fields as from and to', fn('replace', fb('s'), fb('f'), fb('t')), ['bANANa', 'banana', null, 'x\ty\n', '  pad\t']);
    await want('CONTAINS(s, f field needle)', fn('contains', fb('s'), fb('f')), ['true', 'false', null, 'true', 'true']);
    await want('STARTSWITH(s, f field)', fn('startswith', fb('s'), fb('f')), ['false', 'false', null, 'true', 'true']);
    await want('TRIM strips ASCII space only, not tab or newline', fn('trim', fb('s')), ['banana', 'banana', null, 'x\ty\n', 'pad\t']);
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
