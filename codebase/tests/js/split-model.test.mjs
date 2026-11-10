import test from "node:test";
import assert from "node:assert/strict";
import { splitPlan, SPLIT_MAX_PIECES } from "../../src/DashboardBuilder/Features/Calc/split-model.js";

const F = { db: "shop", table: "orders", column: "tags" };
const plan = (over = {}) => splitPlan({ field: F, sep: ",", pieces: 3, calcs: [], ...over });

test("one calculated field per piece, SPLIT over the db-qualified column", () => {
  const p = plan();
  assert.equal(p.ok, true);
  assert.deepEqual(p.calcs, [
    { name: "tags 1", formula: "SPLIT([shop.orders.tags], ',', 1)" },
    { name: "tags 2", formula: "SPLIT([shop.orders.tags], ',', 2)" },
    { name: "tags 3", formula: "SPLIT([shop.orders.tags], ',', 3)" },
  ]);
});
test("a quote in the separator is doubled and a display name is the base", () => {
  assert.equal(plan({ sep: "'", pieces: 2, name: "Tag" }).calcs[0].formula, "SPLIT([shop.orders.tags], '''', 1)");
  assert.equal(plan({ name: "Tag" }).calcs[1].name, "Tag 2");
});
test("a name that is taken gets the next free number", () => {
  const p = plan({ calcs: [{ id: "calc1", name: "tags 1", formula: "" }] });
  assert.deepEqual(p.calcs.map((c) => c.name), ["tags (split) 1", "tags (split) 2", "tags (split) 3"]);
});
test("pieces are 2 to 10 whole numbers and the separator 1 to 20 characters", () => {
  assert.equal(SPLIT_MAX_PIECES, 10);
  assert.match(plan({ pieces: 1 }).error, /2 to 10/);
  assert.match(plan({ pieces: 11 }).error, /2 to 10/);
  assert.match(plan({ pieces: 2.5 }).error, /2 to 10/);
  assert.match(plan({ sep: "" }).error, /1 to 20 characters/);
  assert.match(plan({ sep: "x".repeat(21) }).error, /1 to 20 characters/);
  assert.equal(plan({ sep: "x".repeat(20) }).ok, true);
});
test("the workbook's calculated-field limit is respected", () => {
  const full = Array.from({ length: 19 }, (_, i) => ({ id: "c" + i, name: "n" + i, formula: "" }));
  assert.match(plan({ calcs: full }).error, /at most 20/);
  assert.equal(plan({ calcs: full.slice(0, 17) }).ok, true);
});
test("a column or table name a formula reference can't hold is refused", () => {
  assert.match(plan({ field: { ...F, column: "a.b" } }).error, /can't be written/);
  assert.match(plan({ field: { ...F, column: "a]b" } }).error, /can't be written/);
});
test("a long column name is cut so the field names stay within the name limit", () => {
  const p = plan({ field: { ...F, column: "c".repeat(80) } });
  assert.equal(p.ok, true);
  assert.ok(p.calcs.every((c) => c.name.length <= 60));
});
test("every planned formula compiles through the calculation engine to a text dimension", async () => {
  const { catalogFromEntities, compileCalculation } = await import("../../src/DashboardBuilder/Features/Calc/calc-resolve.js");
  const catalog = catalogFromEntities([{ id: "e1", db: "shop", table: "orders", columns: [{ name: "tags", category: "text" }] }]);
  for (const sep of [",", "'", " | "]) {
    const p = plan({ sep, pieces: 4 });
    for (const [i, c] of p.calcs.entries()) {
      const r = compileCalculation({ id: "n" + i, ...c }, [], catalog);
      assert.equal(r.error, undefined, `${c.formula}: ${r.error?.message}`);
      assert.equal(r.role, "dimension");
    }
  }
});

test("names the pieces in order; an empty entry keeps the default name", () => {
  const p = plan({ names: "Country, ,City" });
  assert.equal(p.ok, true);
  assert.deepEqual(p.calcs.map((c) => c.name), ["Country", "tags 2", "City"]);
  assert.equal(p.calcs[0].formula, "SPLIT([shop.orders.tags], ',', 1)");
});
test("fewer names than pieces name the first pieces; more names than pieces are refused", () => {
  assert.deepEqual(plan({ names: "A" }).calcs.map((c) => c.name), ["A", "tags 2", "tags 3"]);
  assert.match(plan({ names: "A,B,C,D" }).error, /4 names for 3 pieces/);
  assert.equal(plan({ names: "" }).calcs[0].name, "tags 1");
});
test("a given name that is taken, repeated or not allowed is refused, never renamed", () => {
  assert.match(plan({ names: "A,a" }).error, /more than once/);
  assert.match(plan({ names: "A", calcs: [{ id: "c1", name: "a", formula: "" }] }).error, /already exists/);
  assert.match(plan({ names: "A.B" }).error, /can't contain/);
  assert.match(plan({ names: "x".repeat(61) }).error, /60/);
});
test("a default name that collides with a given name moves the defaults on", () => {
  assert.deepEqual(plan({ names: ",tags 2" }).calcs.map((c) => c.name), ["tags 1", "tags 2", "tags 3"]);
  assert.deepEqual(plan({ names: ",tags 1" }).calcs.map((c) => c.name), ["tags (split) 1", "tags 1", "tags (split) 3"]);
});
