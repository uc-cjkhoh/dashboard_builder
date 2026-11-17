import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkSql, tokenize, posOf, serverErrorPos, canonSyntax, BLOCKED_FUNCTIONS, ALLOWED_TABLE_FUNCTIONS } from "../../src/DashboardBuilder/Features/Core/sql-check.js";
import { opensBlock } from "../../src/DashboardBuilder/Features/Canvas/sql-editor.js";

const msgs = (sql) => checkSql(sql).map((p) => p.message);
const one = (sql) => { const m = checkSql(sql); assert.equal(m.length, 1, `${JSON.stringify(sql)} -> ${JSON.stringify(m)}`); return m[0]; };

test("plain selects have no problems; empty text has none (Save asks for a query)", () => {
  for (const ok of ["SELECT a, b FROM d.t", "select a from t where x = 'a;b' and y = \"c;d\" and z = `e;f`", "WITH x AS (SELECT 1 AS n) SELECT n FROM x",
    "SELECT a FROM (SELECT a FROM t) UNION ALL SELECT a FROM u", "SELECT 'it''s (open' AS s", "SELECT 'a\\'b;(' AS s", "SELECT a FROM t;", "SELECT a FROM t ;;", "SELECT 1 -- done"]) assert.deepEqual(msgs(ok), [], ok);
  assert.deepEqual(checkSql(""), []); assert.deepEqual(checkSql("  \n "), []); assert.deepEqual(checkSql("-- only a comment"), []);
});
test("the same refusals as the server's guard, with the position of the offending token", () => {
  assert.match(one("DROP TABLE t").message, /must start with SELECT/);
  assert.deepEqual([one("DROP TABLE t").from, one("DROP TABLE t").to], [0, 4]);
  assert.match(one("INSERT INTO t VALUES (1)").message, /must start with SELECT/);
  assert.match(one("(SELECT 1)").message, /must start with SELECT/);
  const semi = one("SELECT 1; SELECT 2"); assert.match(semi.message, /extra ';'/); assert.equal(semi.from, 8);
  const set = one("SELECT a FROM t SETTINGS max_execution_time = 0"); assert.match(set.message, /change settings/); assert.equal(set.from, 16);
  for (const fn of ["url('x')", "file('a.csv')", "S3('x')", "remote('h', d.t)", "mysql('h', 'd', 't', 'u', 'p')"])
    assert.match(one(`SELECT * FROM ${fn}`).message, /outside this connection/, fn);
  assert.deepEqual(msgs("SELECT url FROM t"), []); // a column called url is not a call
});
test("quoted names are names, a backslash escapes in backticks too, and only allowed table functions go where a table goes (CustomSql.cs)", () => {
  for (const [sql, re] of [
    ["SELECT * FROM `url`('http://169.254.169.254/', 'LineAsString')", /'url' reads outside/],
    ['SELECT * FROM "s3"(\'x\')', /'s3' reads outside/],
    ["SELECT * FROM `ur\\l`('x')", /'url' reads outside/],
    ["SELECT * FROM icebergS3('x')", /'icebergS3' reads outside/],
    ["SELECT * FROM t, someFutureTableFunction('x')", /reads outside/],
    ["SELECT a FROM t WHERE a IN (SELECT b FROM mongodb('h'))", /'mongodb' reads outside/],
    ["SELECT 1 FORMAT JSON", /output format/],
    ["SELECT a FROM t INTO OUTFILE 'x.csv'", /write a file/],
  ]) assert.match(one(sql).message, re, sql);
  assert.ok(msgs("SELECT 1 AS `\\` AS a, `, * FROM url('http://x/') SETTINGS max_execution_time=0").some((m) => /change settings/.test(m)));
  for (const ok of ["SELECT number FROM numbers(10)", "SELECT * FROM t, numbers(3) AS n", "SELECT * FROM view(SELECT a FROM t)",
    "SELECT EXTRACT(YEAR FROM toDate(created)) AS y FROM t", "SELECT trim(BOTH ' ' FROM upper(name)) FROM t", "SELECT x FROM t ARRAY JOIN splitByChar(',', tags) AS x",
    "SELECT `a\\`b` FROM t", "SELECT URLHierarchy(page) AS h, format('{}', a) AS f FROM t", "SELECT a AS format FROM t", "SELECT format FROM t ORDER BY format DESC", "SELECT a, format FROM t ORDER BY a, format ASC",
    "SELECT a FROM (SELECT a FROM t) AS s JOIN u ON s.a = lower(u.b)"]) assert.deepEqual(msgs(ok), [], ok);
});
test("the allowed table functions are the server's list", () => {
  const cs = readFileSync(new URL("../../src/DashboardBuilder/ClickHouse/CustomSql.cs", import.meta.url), "utf8");
  const block = cs.slice(cs.indexOf("AllowedTableFunctions = new"), cs.indexOf("};", cs.indexOf("AllowedTableFunctions = new")));
  assert.deepEqual([...ALLOWED_TABLE_FUNCTIONS].sort(), [...new Set([...block.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]))].sort());
});
test("brackets: an extra ')' and a never-closed '(' are each pinned to their own character", () => {
  const extra = one("SELECT 1)"); assert.match(extra.message, /no '\('/); assert.equal(extra.from, 8);
  const open = one("SELECT (1"); assert.match(open.message, /never closed/); assert.equal(open.from, 7);
  assert.equal(checkSql("SELECT ((1)").length, 1); // the outer one
});
test("quotes and comments left open end at the end of the text", () => {
  const q = one("SELECT 'open"); assert.match(q.message, /missing its closing quote \('\)/); assert.deepEqual([q.from, q.to], [7, 12]);
  assert.match(one("SELECT `open").message, /name is missing its closing quote \(`\)/);
  assert.match(one("SELECT 1 /* open").message, /never closed/);
});
test("words inside quotes and comments never trip a check", () => {
  assert.deepEqual(msgs("SELECT 'DROP; (settings url(' AS note, `settings` FROM t"), []);
  assert.deepEqual(msgs("SELECT a -- ; ( settings\nFROM t /* url( ; */"), []);
});
test("the length limit mirrors the server", () => {
  assert.deepEqual(msgs("SELECT '" + "x".repeat(9980) + "'"), []);
  assert.match(one("SELECT '" + "x".repeat(10000) + "'").message, /at most 10,000/);
});
test("problems come back in text order", () => {
  const list = checkSql("SELECT ) FROM url('x') SETTINGS a = 1");
  assert.deepEqual(list.map((p) => p.from), [...list.map((p) => p.from)].sort((a, b) => a - b));
  assert.equal(list.length, 3);
});
test("tokenize: words, numbers, symbols, quoted runs and comments with offsets", () => {
  const t = tokenize("SELECT `a b`, 1.5 -- c\n;");
  assert.deepEqual(t.map((x) => x.kind), ["word", "quoted", "symbol", "number", "comment", "symbol"]);
  assert.deepEqual([t[1].from, t[1].to], [7, 12]);
});
test("posOf turns an offset into a line and column", () => {
  assert.deepEqual(posOf("ab\ncde", 0), { line: 0, ch: 0 });
  assert.deepEqual(posOf("ab\ncde", 4), { line: 1, ch: 1 });
  assert.deepEqual(posOf("ab", 99), { line: 0, ch: 2 });
});
test("a server position (line 1 is the DESCRIBE wrapper) maps back onto the typed text", () => {
  const msg = "Syntax error: failed at position 8 ('FORM') (line 2, col 8): FORM t.";
  assert.deepEqual(serverErrorPos(msg, "SELECT a FORM t"), { line: 0, ch: 7 });
  assert.deepEqual(serverErrorPos("x (line 3, col 3): y", "SELECT\n  POSERR"), { line: 1, ch: 2 });
  assert.deepEqual(serverErrorPos("x (line 2, col 8): y", "   SELECT a FORM t"), { line: 0, ch: 10 }); // leading spaces were trimmed by the server
  assert.deepEqual(serverErrorPos("x (line 2, col 3): y", "\n\nSELECT a"), { line: 2, ch: 2 }); // so were leading blank lines
  assert.equal(serverErrorPos("no position here", "SELECT 1"), null);
  assert.equal(serverErrorPos("x (line 3, col 1): y", "SELECT /* a\nb */ 1"), null); // a block comment collapses lines
  assert.equal(serverErrorPos("x (line 9, col 1): y", "SELECT 1"), null);
});
test("the blocked table functions are the server's list", () => {
  const cs = readFileSync(new URL("../../src/DashboardBuilder/ClickHouse/CustomSql.cs", import.meta.url), "utf8");
  const block = cs.slice(cs.indexOf("BlockedFunctions"), cs.indexOf("};", cs.indexOf("BlockedFunctions")));
  const server = [...block.matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...BLOCKED_FUNCTIONS].sort(), [...new Set(server)].sort());
});
test("Enter indents under an opening bracket or a clause word, not after an ordinary line", () => {
  for (const yes of ["FROM (", "SELECT x, [", "SELECT", "from", "WHERE", "GROUP BY", "order by", "LIMIT", "  JOIN t ON"]) assert.equal(opensBlock(yes), true, yes);
  for (const no of ["SELECT a,", "FROM t", "WHERE x = 1", "FROM t AS from_x"]) assert.equal(opensBlock(no), false, no);
});

import { translateMarker } from "../../src/DashboardBuilder/Features/Canvas/sql-dialog.js";
test("a translator failure with a position becomes a marker in the MySQL text; without one there is none", () => {
  assert.deepEqual(translateMarker({ message: "m", line: 2, col: 9, start: 5 }), { from: { line: 1, ch: 5 }, to: { line: 1, ch: 9 }, message: "m" });
  assert.deepEqual(translateMarker({ message: "m", line: 1, col: 23, start: 22 }), { from: { line: 0, ch: 22 }, to: { line: 0, ch: 23 }, message: "m" });
  assert.deepEqual(translateMarker({ message: "m", line: 1, col: null, start: null }).from, { line: 0, ch: 0 });
  assert.equal(translateMarker({ message: "m" }), null);
  assert.equal(translateMarker(new Error("x")), null);
});

test("canonSyntax: EXPLAIN SYNTAX texts compare equal when only case, layout and coalesce/ifNull differ, and differ in anything that means something", () => {
  const same = (x, y) => assert.equal(canonSyntax(x), canonSyntax(y), `${x} == ${y}`);
  const differ = (x, y) => assert.notEqual(canonSyntax(x), canonSyntax(y), `${x} != ${y}`);
  same("SELECT count()\nFROM system.one", "SELECT COUNT()  FROM  system.one");
  same("SELECT ifNull(a, 0) AS x FROM t", "SELECT COALESCE(a, 0) AS x FROM t");
  same("SELECT\n    a,\n    b\nFROM t", "SELECT a, b FROM t");
  differ("SELECT a FROM t WHERE like(x, 'a%')", "SELECT a FROM t WHERE ilike(x, 'a%')");          // LIKE vs ILIKE
  differ("SELECT a FROM t WHERE equals(a, 0)", "SELECT a FROM t WHERE equals(a, 1)");             // a changed constant
  differ("SELECT a FROM t ORDER BY a ASC", "SELECT a FROM t ORDER BY a ASC NULLS FIRST");         // NULL placement
  differ("SELECT a FROM t WHERE x = 'abc'", "SELECT a FROM t WHERE x = 'ABC'");                   // text is compared exactly: case inside quotes counts
  differ("SELECT a FROM t WHERE equals(x, 'it\\'s A')", "SELECT a FROM t WHERE equals(x, 'it\\'s a')"); // an escaped quote does not end the text
  differ("SELECT a FROM t WHERE x = lowerUTF8(y)", "SELECT a FROM t WHERE x = y");
});
