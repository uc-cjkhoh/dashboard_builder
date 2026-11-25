import { test } from "node:test";
import assert from "node:assert/strict";
import { aggLabel, pillMarker } from "../../src/DashboardBuilder/Features/Dashboard/agg-labels.js";
import { AGGS } from "../../src/DashboardBuilder/Features/Dashboard/filter-rules.js";
import { fieldPillOptions } from "../../src/DashboardBuilder/Features/Dashboard/pill-options.js";

test("every aggregation has a plain label; saved values are untouched", () => {
  assert.equal(aggLabel("avg"), "Average");
  assert.equal(aggLabel("countDistinct"), "Count distinct");
  assert.equal(aggLabel("countNonNull"), "Count non-empty");
  assert.equal(aggLabel("attr"), "Attribute (single value)");
  assert.equal(aggLabel("stddev"), "Standard deviation");
  assert.equal(aggLabel("stddevPop"), "Standard deviation (pop.)");
  assert.equal(aggLabel("variancePop"), "Variance (pop.)");
  assert.equal(aggLabel("percentile"), "Percentile…");
  for (const a of [...AGGS.numeric, ...AGGS.ordered, ...AGGS.other]) assert.ok(/^[A-Z]/.test(aggLabel(a)), a);
  assert.equal(aggLabel("nope"), "nope");
});
test("the aggregation menu shows the plain labels but keeps the raw ids", () => {
  const r = fieldPillOptions({ measure: true, aggs: ["sum", "avg", "countDistinct", "percentile"], agg: "avg", roleFlip: false });
  assert.deepEqual(r.filter((e) => e.id?.startsWith("agg:")).map((e) => [e.id, e.label]),
    [["agg:sum", "Sum"], ["agg:avg", "Average"], ["agg:countDistinct", "Count distinct"], ["agg:percentile", "Percentile…"]]);
});
test("pillMarker: the aggregation chip and the table-calculation marker", () => {
  const f = { column: "quantity", category: "numeric", agg: "avg" };
  assert.deepEqual(pillMarker(f, { measure: true }), { agg: "avg", calc: null });
  assert.deepEqual(pillMarker({ ...f, agg: undefined }, { measure: true }), { agg: "sum", calc: null });
  assert.deepEqual(pillMarker({ ...f, tableCalc: { type: "running" } }, { measure: true }), { agg: "avg", calc: "running total" });
  assert.deepEqual(pillMarker({ ...f, tableCalc: { type: "none" } }, { measure: true }), { agg: "avg", calc: null });
  assert.equal(pillMarker(f, { measure: false }), null);
  assert.deepEqual(pillMarker({ ...f, agg: "percentile", p: 0.9 }, { measure: true }), { agg: "percentile p90", calc: null });
  assert.equal(pillMarker({ calc: "c1", column: "Net", agg: undefined }, { measure: true, calcPill: true })?.agg ?? null, null);
});
