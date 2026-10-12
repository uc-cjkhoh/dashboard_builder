import { test } from "node:test";
import assert from "node:assert/strict";
import { aggsFor, checkFilter, statFilters, withCategories } from "../../src/DashboardBuilder/Features/Dashboard/filter-rules.js";
const F = (o) => ({ db: "s", table: "orders", column: "amount", category: "numeric", op: "=", value: "", values: null, ...o });
test("aggregations match the column category", () => {
  assert.ok(aggsFor("numeric").includes("sum"));
  assert.deepEqual(aggsFor("temporal"), ["count", "countDistinct", "min", "max"]);
  assert.deepEqual(aggsFor("boolean"), ["count", "countDistinct"]);
});
test("an untouched filter is empty, not an error", () => {
  assert.equal(checkFilter(F({})).state, "empty");
  assert.equal(checkFilter(F({ value: "   " })).state, "empty");
  assert.equal(checkFilter(F({ op: "between", values: ["", ""] })).state, "empty");
});
test("a non-number on a numeric column is invalid and says so", () => {
  const r = checkFilter(F({ value: "1,000" }));
  assert.equal(r.state, "invalid"); assert.match(r.error, /not a number for column orders\.amount/);
});
test("a half range or inverted range is invalid", () => {
  assert.match(checkFilter(F({ op: "between", values: ["5", ""] })).error, /both From and To/);
  assert.match(checkFilter(F({ op: "between", values: ["9", "1"] })).error, /From must be less than or equal to To/);
});
test("a valid date filter is ok", () => assert.equal(checkFilter(F({ category: "temporal", value: "2024-01-31" })).state, "ok"));
test("stat charts apply same-table ok filters and count the rest", () => {
  const r = statFilters([F({ value: "5" }), F({ table: "customers", value: "1" }), F({ value: "x" }), F({ op: "in", values: ["1", "2"] })], "s", "orders");
  assert.deepEqual(r.apply, [{ column: "amount", op: "=", value: "5", values: null }, { column: "amount", op: "in", value: "", values: ["1", "2"] }]);
  assert.equal(r.ignored, 1);
});
test("a filter in addFilter's shape (with category) is ok", () => {
  const f = { db: "s", table: "orders", column: "amount", category: "numeric", op: "=", value: "5" };
  assert.equal(checkFilter(f).state, "ok");
});
test("a filter without a category is backfilled from the catalog", () => {
  const f = { db: "s", table: "orders", column: "amount", op: "=", value: "5" };
  withCategories([f], (db, t, c) => (c === "amount" ? "numeric" : undefined));
  assert.equal(f.category, "numeric"); assert.equal(checkFilter(f).state, "ok");
  const g = { ...f, category: "text" };
  withCategories([g], () => "numeric"); assert.equal(g.category, "text");
});
test("a filter whose column is not in the catalog stays visibly invalid", () => {
  const f = { db: "s", table: "orders", column: "gone", op: "=", value: "5" };
  withCategories([f], () => undefined);
  const r = checkFilter(f); assert.equal(r.state, "invalid"); assert.match(r.error, /can't be compared/);
});
