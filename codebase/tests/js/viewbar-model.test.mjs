import { test } from "node:test";
import assert from "node:assert/strict";
import { CHART_TYPES, chartIcon, chartLabel, sortSummary } from "../../src/DashboardBuilder/Features/Dashboard/viewbar-model.js";
import { PATHS } from "../../src/DashboardBuilder/Features/Core/icons.js";

test("every chart type has an icon that exists", () => {
  for (const [type] of CHART_TYPES) assert.ok(PATHS[chartIcon(type)], type);
});
test("chart type labels come from the list; an unknown type falls back to the first", () => {
  assert.equal(chartLabel("line"), "Line");
  assert.equal(chartLabel("nope"), CHART_TYPES[0][1]);
});
test("sort summary: no targets → nothing to sort", () => {
  assert.equal(sortSummary([], null), null);
});
test("sort summary defaults to the first target, ascending", () => {
  const targets = [{ id: "a", label: "t.a" }, { id: "b", label: "t.b" }];
  assert.deepEqual(sortSummary(targets, null), { current: targets[0], dir: "asc" });
});
test("sort summary follows the sheet's field and direction", () => {
  const targets = [{ id: "a", label: "t.a" }, { id: "b", label: "t.b" }];
  assert.deepEqual(sortSummary(targets, { by: "b", dir: "desc" }), { current: targets[1], dir: "desc" });
});
test("sort summary falls back to the first target when the sorted field left the view", () => {
  const targets = [{ id: "a", label: "t.a" }];
  assert.deepEqual(sortSummary(targets, { by: "gone", dir: "desc" }), { current: targets[0], dir: "desc" });
});
