import { test } from "node:test";
import assert from "node:assert/strict";
import { aggsFor, opsFor, OP_LABELS, serverFilter, checkFilter, statFilters, withCategories } from "../../src/DashboardBuilder/Features/Dashboard/filter-rules.js";
const F = (o) => ({ db: "s", table: "orders", column: "amount", category: "numeric", op: "=", value: "", values: null, ...o });
test("aggregations match the column category", () => {
  assert.ok(aggsFor("numeric").includes("sum"));
  assert.deepEqual(aggsFor("numeric"), ["sum", "avg", "min", "max", "median", "percentile", "stddev", "variance", "count", "countDistinct", "countNonNull", "attr"]);
  assert.deepEqual(aggsFor("text"), ["count", "countDistinct", "countNonNull", "min", "max", "attr"]);
  assert.deepEqual(aggsFor("temporal"), ["count", "countDistinct", "countNonNull", "min", "max", "attr"]);
  assert.deepEqual(aggsFor("boolean"), ["count", "countDistinct", "countNonNull"]);
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

import { checkAdd, viewCounts } from "../../src/DashboardBuilder/Features/Dashboard/filter-rules.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";
const dim = (i) => ({ db: "s", table: "t", column: `d${i}`, category: "text", role: "dimension" });
const mea = (i) => ({ db: "s", table: "t", column: `m${i}`, category: "numeric", role: "measure", agg: "sum" });
const sheetOf = (o) => ({ columns: [], rows: [], color: [], marks: {}, ...o });
test("a shelf accepts up to pillsPerShelf fields and refuses the next", () => {
  const n = LIMITS.pillsPerShelf;
  // spread over rows+columns so the 12-dimension cap is not what stops it: use detail (dimension) -> use tooltip (text, no count)
  const full = sheetOf({ marks: { tooltip: Array.from({ length: n - 1 }, (_, i) => dim(i)) } });
  assert.equal(checkAdd(full, "tooltip", dim(99)).ok, true);
  const over = sheetOf({ marks: { tooltip: Array.from({ length: n }, (_, i) => dim(i)) } });
  const r = checkAdd(over, "tooltip", dim(99));
  assert.equal(r.ok, false); assert.match(r.error, /Tooltip shelf can hold at most 20 fields/);
});
test("dimension cap: 12 allowed, 13th refused", () => {
  const at11 = sheetOf({ columns: Array.from({ length: 11 }, (_, i) => dim(i)) });
  assert.equal(checkAdd(at11, "rows", dim(50), "dimension").ok, true);
  const at12 = sheetOf({ columns: Array.from({ length: 12 }, (_, i) => dim(i)) });
  const r = checkAdd(at12, "rows", dim(50), "dimension");
  assert.equal(r.ok, false); assert.equal(r.error, "A view can group by at most 12 fields.");
  assert.equal(checkAdd(at12, "rows", mea(1), "measure").ok, true);
});
test("measure cap: 10 allowed, 11th refused", () => {
  const at9 = sheetOf({ rows: Array.from({ length: 9 }, (_, i) => mea(i)) });
  assert.equal(checkAdd(at9, "columns", mea(50), "measure").ok, true);
  const at10 = sheetOf({ rows: Array.from({ length: 10 }, (_, i) => mea(i)) });
  const r = checkAdd(at10, "columns", mea(50), "measure");
  assert.equal(r.ok, false); assert.equal(r.error, "A view can show at most 10 measures.");
});
test("replacing a single-slot encoding at the cap is allowed; counts include marks", () => {
  const s = sheetOf({ columns: Array.from({ length: 11 }, (_, i) => dim(i)), color: [dim(90)] });
  assert.deepEqual(viewCounts(s), { dims: 12, measures: 0 });
  assert.equal(checkAdd(s, "color", dim(91), "dimension").ok, true);
  assert.equal(checkAdd(s, "detail", dim(92)).ok, false);
});
test("not in is offered beside in, labelled, and checked like in", () => {
  for (const c of ["text", "numeric", "temporal", "boolean"]) assert.ok(opsFor(c).includes("notin"), c);
  assert.equal(OP_LABELS.notin, "not in");
  assert.equal(checkFilter(F({ op: "notin", values: [] })).state, "empty");
  assert.equal(checkFilter(F({ op: "notin", values: ["1", "2"] })).state, "ok");
  const big = Array.from({ length: 501 }, (_, i) => String(i));
  const r = checkFilter(F({ op: "notin", values: big }));
  assert.equal(r.state, "invalid"); assert.match(r.error, /'not in' filter can list at most 500/);
});
test("not in goes to the server as-is, and to stat charts", () => {
  const f = F({ op: "notin", values: ["1", "2"] });
  assert.deepEqual(serverFilter(f), { db: "s", table: "orders", column: "amount", op: "notin", value: "", values: ["1", "2"] });
  assert.deepEqual(statFilters([f], "s", "orders").apply, [{ column: "amount", op: "notin", value: "", values: ["1", "2"] }]);
});

test("opsFor a calculated field offers no top-N (and no relative date)", () => {
  assert.ok(opsFor("text").includes("top"));
  assert.ok(!opsFor("text", { calc: true }).includes("top"));
  assert.ok(opsFor("text", { calc: true }).includes("contains"));
  assert.ok(!opsFor("temporal", { calc: true }).includes("relative"));
  assert.ok(!opsFor("temporal", { calc: true }).includes("top"));
  assert.deepEqual(opsFor("numeric", { calc: true }), opsFor("numeric"));
});

test("a calculated filter is checked like any other (value type, in-list bound)", () => {
  const f = (o) => ({ calc: "c1", db: "", table: "", column: "Net", category: "numeric", op: ">", value: "", ...o });
  assert.equal(checkFilter(f({})).state, "empty");
  assert.equal(checkFilter(f({ value: "5" })).state, "ok");
  assert.equal(checkFilter(f({ value: "abc" })).state, "invalid");
  assert.equal(checkFilter(f({ op: "in", values: Array.from({ length: 501 }, (_, i) => String(i)) })).state, "invalid");
});
