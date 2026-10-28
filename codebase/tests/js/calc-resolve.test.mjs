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
  assert.ok(compileCalculation(calc("x", "X", undefined), [], catalog).error.message);
});
