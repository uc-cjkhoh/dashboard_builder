import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";
import {
  unionSource, unpivotSource, uniqueName, wireSource, cleanSource, sourceOfTable, sourceProblem, sourceNote,
  distinctPlan, distinctMembers, takenNames, MIXED_MESSAGE, UNION_NOTE,
} from "../../src/DashboardBuilder/Features/Core/source-model.js";

test("the name limit mirrors the server", () => assert.equal(LIMITS.sourceName, 200));

test("a union source is named after its tables and keeps them in order", () => {
  assert.deepEqual(unionSource("d", ["a", "b"]), { kind: "union", db: "d", name: "Union: a + b", tables: ["a", "b"] });
});
test("a union needs two to five different tables", () => {
  assert.throws(() => unionSource("d", ["a"]), /between 2 and 5/);
  assert.throws(() => unionSource("d", ["a", "b", "c", "d", "e", "f"]), /between 2 and 5/);
  assert.throws(() => unionSource("d", ["a", "a"]), /different/);
});
test("an unpivot source is named after its table and carries its columns and kept columns", () => {
  assert.deepEqual(unpivotSource("d", "sales", ["q1", "q2"], ["region"]), { kind: "unpivot", db: "d", name: "Unpivot: sales", table: "sales", columns: ["q1", "q2"], keep: ["region"] });
});
test("an unpivot is refused outside the limits or with a column in both roles", () => {
  assert.throws(() => unpivotSource("d", "t", ["a"]), /between 2 and 50/);
  assert.throws(() => unpivotSource("d", "t", Array.from({ length: 51 }, (_, i) => `c${i}`)), /between 2 and 50/);
  assert.throws(() => unpivotSource("d", "t", ["a", "b"], ["k1", "k2", "k3", "k4", "k5", "k6"]), /at most 5/);
  assert.throws(() => unpivotSource("d", "t", ["a", "b"], ["a"]), /different columns/);
});
test("a second source with the same name gets a number, and a long name is cut to fit", () => {
  assert.equal(unionSource("d", ["a", "b"], ["Union: a + b"]).name, "Union: a + b 2");
  assert.equal(uniqueName("x", ["x", "x 2"]), "x 3");
  const long = "t".repeat(190);
  const name = unionSource("d", [long, long + "2"]).name;
  assert.ok(name.length <= LIMITS.sourceName);
  assert.ok(uniqueName("y".repeat(250), []).length <= LIMITS.sourceName);
  const taken = [uniqueName("y".repeat(250), [])];
  const second = uniqueName("y".repeat(250), taken);
  assert.notEqual(second, taken[0]); assert.ok(second.length <= LIMITS.sourceName);
});
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
test("a new source avoids the database's tables and the entities on the canvas, in that database only", () => {
  const entities = new Map([["1", { db: "d", table: "Union: a + b" }], ["2", { db: "x", table: "other" }]]);
  assert.deepEqual(takenNames(entities, "d", ["a", "b"]), ["a", "b", "Union: a + b"]);
  assert.equal(unionSource("d", ["a", "b"], takenNames(entities, "d", ["a", "b"])).name, "Union: a + b 2");
});
