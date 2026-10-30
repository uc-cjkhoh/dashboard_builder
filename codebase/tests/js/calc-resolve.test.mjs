// Calculated fields — resolver and compile seam (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogFromEntities, makeResolve, compileCalculation, calcTables } from "../../src/DashboardBuilder/Features/Calc/calc-resolve.js";
import { parseFormula } from "../../src/DashboardBuilder/Features/Calc/calc-parser.js";

const col = (name, category) => ({ name, category });
const entities = [
  { id: "e1", db: "shop", table: "orders", columns: [col("amount", "numeric"), col("qty", "numeric"), col("status", "text"), col("tags", "other"), col("a.b", "text")] },
  { id: "e2", db: "shop", table: "items", columns: [col("price", "numeric")] },
  { id: "e3", db: "archive", table: "items", columns: [col("price", "numeric")] },
];
const catalog = catalogFromEntities(entities);
const resolve = makeResolve(catalog, new Set(["Net"]));

test("catalog lookups", () => {
  assert.equal(catalog.categoryOf("shop", "orders", "amount"), "numeric");
  assert.equal(catalog.categoryOf("shop", "orders", "zip"), null);
  assert.equal(catalog.has("shop", "orders", "amount"), true);
  assert.equal(catalog.has("shop", "orders", "a.b"), false);
  assert.deepEqual(catalog.tablesByName.get("items"), ["shop.items", "archive.items"]);
});

test("resolve parts", () => {
  assert.deepEqual(resolve(["orders", "amount"]), { field: { db: "shop", table: "orders", column: "amount" } });
  assert.deepEqual(resolve(["archive", "items", "price"]), { field: { db: "archive", table: "items", column: "price" } });
  assert.deepEqual(resolve(["Net"]), { calc: { name: "Net" } });
  assert.equal(resolve(["orders"]), null);
  assert.equal(parseFormula("[orders]", resolve).error.message, "Write the field as [table.column].");
  assert.deepEqual(resolve(["items", "price"]), { error: "items.price is in more than one database — write [db.table.column]." });
  assert.deepEqual(resolve(["orders", "qty2"]), { error: "orders.qty2 isn't in the model." });
  assert.deepEqual(resolve(["orders", "tags"]), { error: "orders.tags can't be used in a calculation." });
  assert.deepEqual(resolve(["orders", "a.b"]), { error: "orders.a.b isn't in the model." });
});

const calc = (id, name, formula) => ({ id, name, formula });
const ratio = calc("c1", "Ratio", "SUM([orders.amount]) / SUM([orders.qty])");

test("compile a ratio", () => {
  const r = compileCalculation(ratio, [ratio], catalog);
  assert.equal(r.role, "measure");
  assert.equal(r.ast.k, "bin");
  assert.deepEqual(calcTables(r.info), ["shop.orders"]);
});
test("dimension, constant", () => {
  const s = calc("c2", "S", "[orders.status]");
  assert.equal(compileCalculation(s, [s], catalog).role, "dimension");
  const k = calc("c3", "K", "1+2");
  const r = compileCalculation(k, [k], catalog);
  assert.deepEqual(calcTables(r.info), []);
  assert.equal(r.role, "measure");
});
test("references expand", () => {
  const a = calc("a", "A", "[orders.amount]*2");
  const b = calc("b", "B", "SUM([A])");
  const r = compileCalculation(b, [a, b], catalog);
  assert.equal(r.ast.k, "agg");
  assert.equal(r.ast.arg.k, "bin");
  assert.equal(r.role, "measure");
});
test("cycle and removed table give the E15 sentence", () => {
  const a = calc("a", "A", "[B]+1");
  const b = calc("b", "B", "[A]+1");
  assert.match(compileCalculation(a, [a, b], catalog).error.message, /^Calculation 'A' can't be computed: Calculation '.' refers to itself/);
  const q = calc("q", "Q", "SUM([orders.qty])");
  const small = catalogFromEntities([{ db: "shop", table: "other", columns: [] }]);
  assert.equal(compileCalculation(q, [q], small).error.message, "Calculation 'Q' can't be computed: orders.qty isn't in the model.");
  const dep = calc("d", "D", "SUM([Q])");
  assert.equal(compileCalculation(dep, [q, dep], small).error.message, "Calculation 'D' can't be computed: orders.qty isn't in the model.");
});
test("syntax errors keep their position; non-string formula is an error", () => {
  const e = compileCalculation(calc("x", "X", "1 +"), [], catalog).error;
  assert.equal(e.pos, 3);
  assert.equal(compileCalculation(calc("x", "X", undefined), [], catalog).error.message, "Write a formula.");
});

test("a renamed draft replaces its stale saved entry", () => {
  const savedOld = calc("c1", "Old", "[orders.amount]");
  const draft = calc("c1", "New", "[orders.qty]");
  const user = calc("u", "U", "[Old]*2");
  const e = compileCalculation(user, [savedOld, user], catalog);
  assert.ok(e.ast); // sanity: saved "Old" resolves while it is the only version
  const stale = compileCalculation(user, [draft, user], catalog); // draft already renamed away from Old
  assert.equal(stale.error.message, "Write the field as [table.column].");
  const viaNew = calc("u2", "U2", "[New]*2");
  const r = compileCalculation(viaNew, [savedOld, draft, viaNew], catalog);
  assert.equal(r.ast.l.column, "qty");
  // compiling the draft itself under the new name ignores the stale "Old" entry
  const self = calc("c1", "New", "[Old]");
  assert.equal(compileCalculation(self, [savedOld, self], catalog).error.message, "Write the field as [table.column].");
});
test("a cycle through the unsaved draft is detected", () => {
  const a = calc("a", "A", "[orders.amount]");
  const b = calc("b", "B", "[A]+1");
  const draftA = calc("a", "A", "[B]+1"); // unsaved edit of A now refers to B
  const r = compileCalculation(draftA, [a, b], catalog);
  assert.match(r.error.message, /^Calculation 'A' can't be computed: Calculation '.' refers to itself/);
});
test("empty formula and ambiguous two-part reference", () => {
  assert.ok(compileCalculation(calc("e", "E", ""), [], catalog).error.message);
  const x = calc("x", "X", "SUM([items.price])");
  assert.equal(compileCalculation(x, [x], catalog).error.message,
    "Calculation 'X' can't be computed: items.price is in more than one database — write [db.table.column].");
});
test("duplicate names: the first one wins", () => {
  const d1 = calc("d1", "Dup", "[orders.amount]");
  const d2 = calc("d2", "Dup", "[orders.qty]");
  const u = calc("u", "U", "[Dup]");
  assert.equal(compileCalculation(u, [d1, d2, u], catalog).ast.column, "amount");
});

test("catalog lists its offered fields", () => {
  const f = catalog.fields;
  assert.ok(f.some((x) => x.db === "shop" && x.table === "orders" && x.column === "amount" && x.category === "numeric"));
  assert.ok(!f.some((x) => x.column === "a.b"));
  assert.equal(f.length, 6);
});

test("text functions: a row-level text calculation is a dimension; a predicate and a LEN follow their type", () => {
  const c = (formula, calcs = []) => compileCalculation({ id: "x", name: "X", formula }, calcs, catalog);
  const lower = c("LOWER([orders.status])");
  assert.equal(lower.role, "dimension");
  assert.equal(lower.info.type, "text");
  assert.equal(c("CONTAINS([orders.status], 'a')").role, "dimension"); // boolean
  assert.equal(c("LEN([orders.status])").role, "measure"); // row-level number
  assert.equal(c("COUNTD(LOWER([orders.status]))").role, "measure");
});

test("TEXT: a dimension, nested TEXT and a comparison on it compile; STR is the same node", () => {
  const c = (formula) => compileCalculation({ id: "x", name: "X", formula }, [], catalog);
  assert.equal(c("TEXT([orders.status])").role, "dimension");
  assert.equal(c("TEXT(TEXT([orders.amount]))").info.type, "text");
  assert.equal(c("TEXT([orders.amount]) = '10'").info.type, "boolean");
  assert.deepEqual(c("STR([orders.amount])").ast, c("TEXT([orders.amount])").ast);
});

test("text functions: a calculation reference inside a call is expanded before sending", () => {
  const base = { id: "b", name: "Base", formula: "TRIM([orders.status])" };
  const r = compileCalculation({ id: "x", name: "X", formula: "LEFT([Base], 3)" }, [base], catalog);
  assert.deepEqual(r.ast, { k: "fn", fn: "left", args: [{ k: "fn", fn: "trim", args: [{ k: "field", db: "shop", table: "orders", column: "status" }] }, { k: "num", v: 3 }] });
});

test("text functions: a type error names the calculation and the argument", () => {
  const r = compileCalculation({ id: "x", name: "X", formula: "LOWER([orders.amount])" }, [], catalog);
  assert.equal(r.error.message, "Calculation 'X' can't be computed: LOWER needs a text — orders.amount is number.");
});
