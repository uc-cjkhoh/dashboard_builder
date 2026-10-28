import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFilter, opsFor, serverFilter, statFilters } from "../../src/DashboardBuilder/Features/Dashboard/filter-rules.js";

const F = (o) => ({ db: "d", table: "t", column: "c", category: "text", ...o });

test("operators follow the field type", () => {
  assert.ok(opsFor("text").includes("contains"));
  assert.ok(!opsFor("numeric").includes("contains"));
  assert.ok(opsFor("temporal").includes("relative"));
  assert.ok(!opsFor("text").includes("relative"));
  assert.ok(!opsFor("numeric").includes("top")); // a measure isn't ranked by itself
});
test("text match: empty is a no-op, wrong type invalid", () => {
  assert.equal(checkFilter(F({ op: "contains", value: "" })).state, "empty");
  assert.equal(checkFilter(F({ op: "contains", value: "ab" })).state, "ok");
  assert.equal(checkFilter(F({ op: "startsWith", value: "1", category: "numeric" })).state, "invalid");
});
test("relative date: a known preset on a date field", () => {
  assert.equal(checkFilter(F({ op: "relative", value: "last30", category: "temporal" })).state, "ok");
  assert.equal(checkFilter(F({ op: "relative", value: "custom", category: "temporal" })).state, "invalid");
  assert.equal(checkFilter(F({ op: "relative", value: "", category: "temporal" })).state, "empty");
  assert.equal(checkFilter(F({ op: "relative", value: "last7" })).state, "invalid");
});
test("top-N: a whole number and a measure to rank by", () => {
  const by = { db: "d", table: "t", column: "amount", agg: "sum" };
  assert.equal(checkFilter(F({ op: "top", value: "10", topBy: by })).state, "ok");
  assert.equal(checkFilter(F({ op: "top", value: "10" })).state, "invalid");
  for (const v of ["0", "1001", "1.5", "ten"]) assert.equal(checkFilter(F({ op: "top", value: v, topBy: by })).state, "invalid", v);
});
test("relative dates reach the server as a bound between", () => {
  const resolve = () => ({ from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(serverFilter(F({ op: "relative", value: "lastMonth", category: "temporal" }), { resolve, dateOnly: true }).values, ["2026-09-01", "2026-09-30"]);
  const dt = serverFilter(F({ op: "relative", value: "lastMonth", category: "temporal" }), { resolve, dateOnly: false });
  assert.deepEqual([dt.op, dt.values], ["between", ["2026-09-01 00:00:00", "2026-09-30 23:59:59"]]);
  const top = serverFilter(F({ op: "top", value: " 5 ", topBy: { db: "d", table: "t", column: "a" }, bottom: true }));
  assert.deepEqual([top.value, top.topBy.agg, top.bottom], ["5", "sum", true]);
});
test("histograms and box plots skip top-N filters (counted as not applied)", () => {
  const by = { db: "d", table: "t", column: "amount", agg: "sum" };
  const r = statFilters([F({ op: "top", value: "3", topBy: by }), F({ op: "contains", value: "x" })], "d", "t");
  assert.equal(r.apply.length, 1);
  assert.equal(r.ignored, 1);
});

test("countNonNull is offered for numeric, text, temporal and other fields", async () => {
  const { aggsFor } = await import("../../src/DashboardBuilder/Features/Dashboard/filter-rules.js");
  for (const c of ["numeric", "text", "temporal", "boolean", "other"]) assert.ok(aggsFor(c).includes("countNonNull"), c);
});

test("serverFilter never sends a Top-N whose ranking could not be wired (topBy null)", () => {
  const f = { db: "d", table: "t", column: "region", op: "top", value: "5", topBy: { db: "", table: "", column: "Net", calc: "c1" } };
  assert.equal(serverFilter(f, { wireTopBy: () => null }), null);
  assert.equal(serverFilter(f, { wireTopBy: () => ({ db: "", table: "", column: "Net", calc: { k: "num", v: 1 } }) }).topBy.column, "Net");
});
