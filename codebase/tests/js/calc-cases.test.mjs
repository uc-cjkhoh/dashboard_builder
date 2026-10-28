// Calculated fields — the client parser and type checker, run against the shared fixture
// tests/fixtures/calc-cases.json (the C# CalcValidatorTests run the same cases: messages, paths and
// sorted `tables` must match exactly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseFormula } from "../../src/DashboardBuilder/Features/Calc/calc-parser.js";
import { check, FUNCTIONS } from "../../src/DashboardBuilder/Features/Calc/calc-types.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/calc-cases.json", import.meta.url), "utf8"));
const tables = Object.entries(fixture.catalog).map(([key, columns]) => {
  const dot = key.indexOf(".");
  return { db: key.slice(0, dot), table: key.slice(dot + 1), columns };
});

/** categoryOf(db, table, column) over the fixture catalog; null for an unknown column. */
const categoryOf = (db, table, column) => {
  const t = tables.find((x) => x.db === db && x.table === table);
  return t && Object.hasOwn(t.columns, column) ? t.columns[column] : null;
};

/** A resolver like the app's: 3 parts exact, 2 parts by table name (ambiguous across databases is an error),
 *  1 part is a calculation name (or null when none matches). */
const resolverWith = (calcNames = []) => (parts) => {
  if (parts.length === 1) {
    return calcNames.includes(parts[0]) ? { calc: { name: parts[0] } } : null; // the parser words the rest
  }
  const [db, table, column] = parts.length === 3 ? parts : [null, parts[0], parts[1]];
  const hits = tables.filter((t) => t.table === table && (db === null || t.db === db));
  if (hits.length === 0) return { error: `Unknown table ${table}.` };
  if (hits.length > 1) return { error: `${table}.${column} is in more than one database — write [db.table.column].` };
  return { field: { db: hits[0].db, table, column } };
};
const resolve = resolverWith();

let ran = 0; // cases that reached at least one test below; must equal fixture.cases.length

test("fixture shape: every case is well formed and exercised (mirrors C# Every_fixture_case_is_well_formed)", () => {
  const names = new Set();
  const strings = (a) => Array.isArray(a) && a.every((x) => typeof x === "string");
  for (const c of fixture.cases) {
    assert.ok(typeof c.name === "string" && c.name.trim() !== "", `a fixture case has no name: ${JSON.stringify(c)}`);
    assert.ok(!names.has(c.name), `duplicate fixture case name: ${c.name}`);
    names.add(c.name);
    const hasAst = Object.hasOwn(c, "ast"), hasParseError = Object.hasOwn(c, "parseError");
    assert.ok(hasAst !== hasParseError, `case '${c.name}' must have exactly one of ast / parseError`);
    if (hasParseError) {
      assert.equal(typeof c.parseError, "string", `case '${c.name}': parseError must be a string`);
      assert.equal(typeof c.formula, "string", `case '${c.name}': a parseError case needs a formula string`);
      continue;
    }
    const e = c.expect;
    assert.ok(e && typeof e === "object", `case '${c.name}' has no expect object`);
    if (Object.hasOwn(e, "error")) {
      assert.equal(typeof e.error, "string", `case '${c.name}': expect.error must be a string`);
      assert.equal(typeof e.path, "string", `case '${c.name}': expect.error needs a string expect.path`);
    } else {
      assert.equal(typeof e.type, "string", `case '${c.name}': expect needs error+path or type+isAggregate+tables`);
      assert.equal(typeof e.isAggregate, "boolean", `case '${c.name}': expect.isAggregate must be a boolean`);
      assert.ok(strings(e.tables), `case '${c.name}': expect.tables must be an array of strings`);
    }
    if (Object.hasOwn(c, "formula")) assert.equal(typeof c.formula, "string", `case '${c.name}': formula must be a string`);
  }
  assert.ok(fixture.cases.length > 0);
});
test("fixture shape: every case was run", () => {
  assert.equal(ran, fixture.cases.length, "a case was skipped by the runner (typo'd key?)");
});

for (const c of fixture.cases) {
  if (c.ast !== undefined || c.parseError !== undefined) ran++;
  if (c.formula !== undefined && c.ast !== undefined) {
    test(`parse: ${c.name}`, () => {
      assert.deepEqual(parseFormula(c.formula, resolve), { ast: c.ast });
    });
  }
  if (c.ast !== undefined) {
    test(`check: ${c.name}`, () => {
      const got = check(c.ast, categoryOf);
      if (c.expect.error !== undefined) {
        assert.deepEqual(got, { error: { message: c.expect.error, path: c.expect.path } });
      } else {
        assert.deepEqual(got, { type: c.expect.type, isAggregate: c.expect.isAggregate, tables: c.expect.tables });
      }
    });
  }
  if (c.parseError !== undefined) {
    test(`parse error: ${c.name}`, () => {
      const got = parseFormula(c.formula, resolve);
      assert.ok(got.error, "expected a parse error");
      assert.ok(got.error.message.includes(c.parseError), `"${got.error.message}" should contain "${c.parseError}"`);
      assert.equal(typeof got.error.pos, "number");
    });
  }
}

// ---- Parser details not pinned by the fixture ----------------------------------------------------------

const num = (v) => ({ k: "num", v });
const f = (table, column, db = "shop") => ({ k: "field", db, table, column });
const err = (text, r = resolve) => parseFormula(text, r).error;

test("precedence: * binds tighter than +, and both are left-associative", () => {
  assert.deepEqual(parseFormula("1 + 2 * 3", resolve).ast,
    { k: "bin", op: "+", l: num(1), r: { k: "bin", op: "*", l: num(2), r: num(3) } });
  assert.deepEqual(parseFormula("8 - 2 - 1", resolve).ast,
    { k: "bin", op: "-", l: { k: "bin", op: "-", l: num(8), r: num(2) }, r: num(1) });
  assert.deepEqual(parseFormula("(1 + 2) * 3", resolve).ast,
    { k: "bin", op: "*", l: { k: "bin", op: "+", l: num(1), r: num(2) }, r: num(3) });
});
test("unary minus: stays a node, nests, and binds tighter than *", () => {
  assert.deepEqual(parseFormula("--1", resolve).ast, { k: "un", op: "-", arg: { k: "un", op: "-", arg: num(1) } });
  assert.deepEqual(parseFormula("-2 * 3", resolve).ast,
    { k: "bin", op: "*", l: { k: "un", op: "-", arg: num(2) }, r: num(3) });
});
test("numbers: decimals and exponents; whitespace is free", () => {
  assert.deepEqual(parseFormula("  0.5\t+ .25 ", resolve).ast, { k: "bin", op: "+", l: num(0.5), r: num(0.25) });
  assert.deepEqual(parseFormula("1.5e2", resolve).ast, num(150));
});
test("function names are case-insensitive and lowercase in the tree", () => {
  assert.equal(parseFormula("CoUnTd([orders.status])", resolve).ast.fn, "countd");
});
test("references: spaces are kept and match case-sensitively; a calc name becomes a calc node", () => {
  const r = resolverWith(["Net revenue"]);
  assert.deepEqual(parseFormula("[Net revenue] * 2", r).ast, { k: "bin", op: "*", l: { k: "calc", name: "Net revenue" }, r: num(2) });
  assert.equal(err("[net revenue]", r).message, "Write the field as [table.column].");
  assert.deepEqual(parseFormula("[shop.items.price]", resolve).ast, f("items", "price"));
  assert.deepEqual(parseFormula("[archive.items.price]", resolve).ast, f("items", "price", "archive"));
});
test("a resolver error is reported at the reference", () => {
  const e = err("1 + [nope.x]");
  assert.equal(e.message, "Unknown table nope.");
  assert.equal(e.pos, 4);
});
test("malformed references", () => {
  assert.equal(err("[]").message, "Write the field as [table.column].");
  assert.equal(err("[a.b.c.d]").message, "Write the field as [table.column].");
  assert.equal(err("[orders.]").message, "Write the field as [table.column].");
  assert.equal(err("[orders.a[b]").message, "Missing ] after orders.a");
});
test("error positions point at the problem", () => {
  assert.equal(err("1 +").pos, 3);
  assert.equal(err("SUM([orders.amount]").pos, 19);
  assert.equal(err("1 + # 2").pos, 4);
});
test("other syntax errors", () => {
  assert.equal(err("").message, "Expected a value.");
  assert.equal(err("1 2").message, "Unexpected 2");
  assert.equal(err("1)").message, "Unexpected )");
  assert.equal(err("* 2").message, "Unexpected *");
  assert.equal(err("1 + * 2").message, "Expected a value after +");
  assert.equal(err("-").message, "Expected a value after -");
  assert.equal(err("(").message, "Expected a value after (");
  assert.equal(err("(1 + 2").message, "Expected )");
  assert.equal(err("SUM").message, "Expected ( after SUM");
  assert.equal(err("MEDIAN([orders.amount])").message, "Unknown function MEDIAN.");
  assert.equal(err("foo").message, "Unexpected foo");
  assert.equal(err("1,000").message, "Unexpected ,");
  assert.equal(err("SUM()").message, "Expected a value after (");
});
test("the 500-character limit is inclusive; the number limit also covers a huge exponent", () => {
  const ok = "1" + "+1".repeat(249); // 499 chars
  assert.ok(parseFormula(ok.padEnd(500, " "), resolve).ast);
  assert.equal(err(ok.padEnd(501, " ")).message, "A formula can be at most 500 characters.");
  assert.equal(err("1e400").message, "That number is out of range.");
});

// ---- Type checker details --------------------------------------------------------------------------------

test("FUNCTIONS is the C# CalcCatalog table", () => {
  assert.deepEqual(Object.keys(FUNCTIONS), ["sum", "avg", "min", "max", "count", "countd"]);
  assert.deepEqual(FUNCTIONS.sum, { accepts: ["number"], result: "number" });
  assert.deepEqual(FUNCTIONS.min, { accepts: ["number", "date", "text"], result: null });
  assert.deepEqual(FUNCTIONS.countd, { accepts: ["number", "date", "text", "boolean"], result: "number" });
});
test("a function name that is an Object.prototype key is unknown, not found", () => {
  const e = check({ k: "agg", fn: "constructor", arg: num(1) }, categoryOf).error;
  assert.deepEqual(e, { message: "Unknown function constructor.", path: "" });
});

const chain = (depth) => { let n = num(1); for (let i = 1; i < depth; i++) n = { k: "un", op: "-", arg: n }; return n; };
const wide = (count) => {
  if (count === 1) return num(1);
  const rest = count - 1, left = Math.floor((rest - 1) / 2) | 1;
  return { k: "bin", op: "+", l: wide(left), r: wide(rest - left) };
};
test("limits: depth 12 passes, 13 is too deep (root is depth 1)", () => {
  assert.equal(check(chain(12), categoryOf).type, "number");
  assert.deepEqual(check(chain(13), categoryOf), { error: { message: "That formula is too deep.", path: "" } });
});
test("limits: 200 nodes pass, 201 is too large", () => {
  assert.equal(check(wide(199), categoryOf).type, "number");
  assert.deepEqual(check(wide(201), categoryOf), { error: { message: "That formula is too large.", path: "" } });
});
test("a non-finite number is out of range, at its own path", () => {
  for (const v of [Infinity, -Infinity, NaN]) {
    assert.deepEqual(check(num(v), categoryOf), { error: { message: "That number is out of range.", path: "" } });
  }
  assert.deepEqual(check({ k: "bin", op: "+", l: num(1), r: num(Infinity) }, categoryOf),
    { error: { message: "That number is out of range.", path: "r" } });
});
test("an unexpanded calc reference, or a node of no known kind, is rejected", () => {
  assert.deepEqual(check({ k: "calc", name: "X" }, categoryOf), { error: { message: "Unknown expression node.", path: "" } });
  assert.deepEqual(check(null, categoryOf), { error: { message: "Unknown expression node.", path: "" } });
});
test("tables are sorted by code unit, not by locale", () => {
  const cat = () => "numeric";
  const ast = { k: "bin", op: "+", l: f("t", "a", "b"), r: f("t", "a", "B") };
  assert.deepEqual(check(ast, cat).tables, ["B.t", "b.t"]);
});
