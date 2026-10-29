import { test } from "node:test";
import assert from "node:assert/strict";
import { bestType, showMeOptions, roleOf, issueFor }
  from "../../src/DashboardBuilder/Features/Dashboard/show-me-rules.js";
import { CHART_TYPES } from "../../src/DashboardBuilder/Features/Dashboard/viewbar-model.js";

const TYPES = CHART_TYPES.map(([id]) => id);
const TIME = new Set(["line", "area", "combo"]);
const counts = (o = {}) => ({ dims: 0, shelfDims: 0, measures: 0, hasDate: false, textValue: false,
  discreteColor: false, numericField: false, ...o });
const dim = (column, category = "text") => ({ db: "d", table: "t", column, category });
const date = (column) => dim(column, "temporal");
const meas = (column) => ({ db: "d", table: "t", column, category: "numeric", agg: "sum" });
const names = (arr) => arr.map((f) => f.column);
const isDim = (f) => roleOf(f) === "dimension";
const keyOrder = (columns, rows) => [...rows.filter(isDim), ...columns.filter(isDim)];
const measureOrder = (columns, rows) => [...columns.filter((f) => !isDim(f)), ...rows.filter((f) => !isDim(f))];

test("bestType follows the spec table, first match wins", () => {
  const cases = [
    [{}, null],
    [{ textValue: true, shelfDims: 1, measures: 1 }, "table"],
    [{ shelfDims: 3, measures: 1 }, "table"],
    [{ shelfDims: 0, measures: 2 }, "scatter"],
    [{ shelfDims: 0, measures: 1 }, "kpi"],
    [{ shelfDims: 0, measures: 3 }, "kpi"],
    [{ shelfDims: 1, measures: 1, hasDate: true }, "line"],
    [{ shelfDims: 2, measures: 2, hasDate: true }, "line"],
    [{ shelfDims: 1, measures: 2 }, "bar"],
    [{ shelfDims: 2, measures: 1 }, "heatmap"],
    [{ shelfDims: 2, measures: 2 }, "table"],
    [{ shelfDims: 1, measures: 0 }, "table"],
  ];
  for (const [o, want] of cases) assert.equal(bestType(counts(o)), want, JSON.stringify(o));
});
test("bestType ignores encodings — Colour / Detail dimensions don't steer it", () => {
  assert.equal(bestType(counts({ shelfDims: 1, dims: 3, measures: 1 })), "bar");
});
test("showMeOptions lists every type in order with its issue and outlines one valid best type", () => {
  const c = counts({ shelfDims: 1, dims: 1, measures: 1, numericField: true });
  const opts = showMeOptions(TYPES, () => c);
  assert.deepEqual(opts.map((o) => o.id), TYPES);
  for (const o of opts) assert.equal(o.issue, issueFor(o.id, c), o.id);
  assert.deepEqual(opts.filter((o) => o.recommended).map((o) => o.id), ["bar"]);
});
test("showMeOptions asks for counts per candidate type", () => {
  const seen = [];
  showMeOptions(["bar", "scatter"], (t) => { seen.push(t); return counts({ shelfDims: 1, dims: 1, measures: 1 }); });
  assert.ok(seen.includes("bar") && seen.includes("scatter"));
});
test("no recommendation without fields, or when the best type is itself invalid", () => {
  assert.equal(showMeOptions(TYPES, () => counts()).some((o) => o.recommended), false);
  // 1 dimension + discrete Colour + 2 measures: Bar is best, but the colour-split rule rejects it.
  const c = counts({ shelfDims: 1, dims: 2, measures: 2, discreteColor: true, numericField: true });
  assert.equal(showMeOptions(TYPES, () => c).some((o) => o.recommended), false);
  assert.deepEqual(showMeOptions([], () => c), []);
});
