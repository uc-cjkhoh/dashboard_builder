import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";
import {
  wireSource, cleanSource, sourceOfTable, sourceProblem, sourceNote,
  distinctPlan, distinctMembers, lossyNote, MIXED_MESSAGE, UNION_NOTE,
} from "../../src/DashboardBuilder/Features/Core/source-model.js";

test("the name limit mirrors the server", () => assert.equal(LIMITS.sourceName, 200));

test("the wire shape carries only what its kind uses", () => {
  assert.deepEqual(wireSource({ kind: "union", db: "d", name: "N", tables: ["a", "b"], columns: [], extra: 1 }), { kind: "union", db: "d", name: "N", tables: ["a", "b"] });
  assert.deepEqual(wireSource({ kind: "union", db: "d", name: "N", tables: ["a", "b"], columns: ["id"] }), { kind: "union", db: "d", name: "N", tables: ["a", "b"], columns: ["id"] });
  assert.deepEqual(wireSource({ kind: "unpivot", db: "d", name: "N", table: "t", columns: ["a", "b"] }), { kind: "unpivot", db: "d", name: "N", table: "t", columns: ["a", "b"], keep: [] });
});
test("a saved source is re-checked: bad shapes, other names and other kinds are dropped", () => {
  const ok = { kind: "union", db: "d", name: "N", tables: ["a", "b"] };
  assert.deepEqual(cleanSource(ok, "d", "N"), ok);
  assert.equal(cleanSource(ok, "d", "other"), null);
  assert.equal(cleanSource(ok, "x", "N"), null);
  assert.equal(cleanSource({ ...ok, kind: "join" }, "d", "N"), null);
  assert.equal(cleanSource({ ...ok, tables: ["a"] }, "d", "N"), null);
  assert.equal(cleanSource({ ...ok, tables: ["a", "a"] }, "d", "N"), null);
  assert.equal(cleanSource({ ...ok, tables: ["a", 3] }, "d", "N"), null);
  assert.equal(cleanSource(null, "d", "N"), null);
  const up = { kind: "unpivot", db: "d", name: "N", table: "t", columns: ["a", "b"], keep: ["k"] };
  assert.deepEqual(cleanSource(up, "d", "N"), up);
  assert.deepEqual(cleanSource({ ...up, keep: undefined }, "d", "N"), { ...up, keep: [] });
  assert.equal(cleanSource({ ...up, columns: ["a"] }, "d", "N"), null);
  assert.equal(cleanSource({ ...up, keep: ["a"] }, "d", "N"), null);
  assert.equal(cleanSource({ ...up, table: "" }, "d", "N"), null);
});
test("a source is found by the entity of its name", () => {
  const src = { kind: "union", db: "d", name: "N", tables: ["a", "b"] };
  const entities = new Map([["1", { db: "d", table: "plain" }], ["2", { db: "d", table: "N", source: src }]]);
  assert.equal(sourceOfTable(entities, "d", "N"), src);
  assert.equal(sourceOfTable(entities, "d", "plain"), null);
  assert.equal(sourceOfTable(entities, "x", "N"), null);
});
test("a view over a source and another table is refused with a sentence; one table is fine", () => {
  const entities = new Map([["1", { db: "d", table: "plain" }], ["2", { db: "d", table: "N", source: {} }]]);
  const k = (t) => `d\u0000${t}`;
  assert.equal(sourceProblem([k("N")], entities), null);
  assert.equal(sourceProblem([k("plain")], entities), null);
  assert.equal(sourceProblem([k("plain"), k("other")], entities), null);
  assert.equal(sourceProblem([k("N"), k("plain")], entities), MIXED_MESSAGE);
  assert.equal(sourceProblem([k("plain"), k("N")], entities), MIXED_MESSAGE);
});
test("a card says how its columns are matched", () => {
  assert.equal(sourceNote({ kind: "union" }), UNION_NOTE);
  assert.equal(sourceNote({ kind: "unpivot", columns: ["a", "b", "c"] }), "Field and Value from 3 columns.");
});
test("a filter's member list is a one-dimension query over the source", () => {
  const src = { kind: "union", db: "d", name: "N", tables: ["a", "b"] };
  const plan = distinctPlan(src, "region", 201);
  assert.deepEqual(plan.from, { db: "d", table: "N" });
  assert.deepEqual(plan.source, wireSource(src));
  assert.deepEqual(plan.rowDimensions, [{ db: "d", table: "N", column: "region" }]);
  assert.deepEqual([plan.joins, plan.measures, plan.filters, plan.limit], [[], [], [], 201]);
  assert.deepEqual(distinctMembers({ rows: [{ keys: ["a"] }, { keys: [null] }, { keys: ["b"] }] }), ["a", "b"]);
  assert.deepEqual(distinctMembers(null), []);
});
test("a saved source whose name is longer than the server allows is dropped", () => {
  const name = "n".repeat(LIMITS.sourceName);
  const ok = { kind: "union", db: "d", name, tables: ["a", "b"] };
  assert.deepEqual(cleanSource(ok, "d", name), ok);
  const long = name + "x";
  assert.equal(cleanSource({ ...ok, name: long }, "d", long), null);
});
test("a card whose columns were read as one wider type says so in one line", () => {
  assert.equal(lossyNote([]), null);
  assert.equal(lossyNote(undefined), null);
  assert.equal(lossyNote(["n"]), "Types differ: read as Float64, large values may round.");
});

import { unionMismatch, mismatchSummary } from "../../src/DashboardBuilder/Features/Core/source-model.js";
const col = (name, type, category) => ({ name, type, category });
test("unionMismatch: lists columns the union leaves out, with the tables that have them", () => {
  const m = unionMismatch([
    { table: "a", columns: [col("id", "Int32", "numeric"), col("x", "String", "text"), col("only_a", "Int32", "numeric")] },
    { table: "b", columns: [col("id", "Int64", "numeric"), col("x", "Int32", "numeric"), col("only_b", "String", "text")] },
  ]);
  assert.deepEqual(m.missing, [{ column: "only_a", in: ["a"], notIn: ["b"] }, { column: "only_b", in: ["b"], notIn: ["a"] }]);
  assert.deepEqual(m.kind, [{ column: "x", kinds: { a: "text", b: "numeric" } }]);
  assert.deepEqual(m.shared, ["id"]);
});
test("unionMismatch: identical columns give an empty report and a clean summary", () => {
  const t = [col("a", "Int32", "numeric")];
  const m = unionMismatch([{ table: "p", columns: t }, { table: "q", columns: t }]);
  assert.deepEqual([m.missing, m.kind, m.shared], [[], [], ["a"]]);
  assert.equal(mismatchSummary(m), "Every column is in all tables.");
});
test("mismatchSummary counts left-out columns", () => {
  const m = { missing: [{}, {}], kind: [{}], shared: [] };
  assert.equal(mismatchSummary(m), "3 columns are left out: 2 not in every table, 1 of unlike kinds.");
  assert.equal(mismatchSummary({ missing: [{}], kind: [], shared: [] }), "1 column is left out: 1 not in every table, 0 of unlike kinds.");
});

// --- custom SQL on a card (D105) ---------------------------------------------------------------------------------------
import {
  defaultSql, sqlProblem, sqlWire, customSqlOf, sqlSourcesFor, cleanCustomSql, lostKeys, distinctPlanSql,
} from "../../src/DashboardBuilder/Features/Core/source-model.js";

test("the custom SQL limit mirrors the server", () => assert.equal(LIMITS.customSql, 10000));
test("the default SQL lists every column, quoted, one per line, from the quoted db.table", () => {
  assert.equal(defaultSql("shop", "orders", [{ name: "id" }, { name: "we`ird" }]), "SELECT\n  `id`,\n  `we\\`ird`\nFROM `shop`.`orders`");
  assert.equal(defaultSql("shop", "orders"), "SELECT\n  *\nFROM `shop`.`orders`");
});
test("sqlProblem refuses empty and over-long text; the server checks the rest", () => {
  assert.match(sqlProblem(""), /Write a SELECT/); assert.match(sqlProblem("  \n"), /Write a SELECT/);
  assert.match(sqlProblem("x".repeat(10001)), /at most 10,000/);
  assert.equal(sqlProblem("SELECT 1"), null);
});
test("custom SQL is read from the card of that table and sent as a sql source", () => {
  const e = new Map([["a", { db: "shop", table: "orders", customSql: "SELECT 1" }], ["b", { db: "shop", table: "users" }]]);
  assert.equal(customSqlOf(e, "shop", "orders"), "SELECT 1");
  assert.equal(customSqlOf(e, "shop", "users"), null);
  assert.deepEqual(sqlWire("shop", "orders", "SELECT 1"), { kind: "sql", db: "shop", name: "orders", sql: "SELECT 1" });
  assert.deepEqual(sqlSourcesFor(e, [{ db: "shop", table: "users" }, { db: "shop", table: "orders" }, { db: "shop", table: "orders" }]), [sqlWire("shop", "orders", "SELECT 1")]);
  assert.deepEqual(sqlSourcesFor(e, [{ db: "shop", table: "users" }]), []);
});
test("a card with custom SQL is not a union / unpivot source", () => {
  const e = new Map([["a", { db: "shop", table: "orders", customSql: "SELECT 1" }]]);
  assert.equal(sourceOfTable(e, "shop", "orders"), null);
  assert.equal(sourceProblem(["shop\u0000orders", "shop\u0000users"], e), null); // it can be joined
});
test("a saved custom SQL must be text of an allowed length", () => {
  assert.equal(cleanCustomSql("SELECT 1"), "SELECT 1");
  for (const bad of [undefined, null, 5, "", "   ", "x".repeat(10001), {}]) assert.equal(cleanCustomSql(bad), null);
});
test("lostKeys names the relationship columns a new query no longer returns", () => {
  const cols = [{ name: "id" }, { name: "region" }];
  assert.deepEqual(lostKeys(["id", "region", "id"], cols), []);
  assert.deepEqual(lostKeys(["id", "customer", "customer", "day"], cols), ["customer", "day"]);
});
test("the member list of a custom SQL column is a one-dimension query through sources", () => {
  const p = distinctPlanSql("shop", "orders", "SELECT 1", "region", 201);
  assert.deepEqual(p.from, { db: "shop", table: "orders" });
  assert.deepEqual(p.sources, [sqlWire("shop", "orders", "SELECT 1")]);
  assert.equal("source" in p, false);
  assert.deepEqual(p.rowDimensions, [{ db: "shop", table: "orders", column: "region" }]);
  assert.equal(p.limit, 201);
});
