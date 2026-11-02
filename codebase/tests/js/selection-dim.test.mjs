import { test } from "node:test";
import assert from "node:assert/strict";
import { applySelectionDim, DIM_OPACITY, DIM_TYPES } from "../../src/DashboardBuilder/Features/Dashboard/selection-dim.js";

// Dimming the unselected marks of the dashboard's source widget: a render-only restyle of an ECharts option.
test("a bar chart: every mark but the selected one is faded; the selected one is untouched", () => {
  const out = applySelectionDim({ series: [{ type: "bar", data: [1, 2, 3] }] }, "bar", 1);
  assert.deepEqual(out.series[0].data, [{ value: 1, itemStyle: { opacity: DIM_OPACITY } }, 2, { value: 3, itemStyle: { opacity: DIM_OPACITY } }]);
});
test("stacked: every series fades the same categories", () => {
  const out = applySelectionDim({ series: [{ type: "bar", stack: "s", data: [1, 2] }, { type: "bar", stack: "s", data: [3, 4] }] }, "stacked", 0);
  assert.deepEqual(out.series.map((s) => s.data[1]), [{ value: 2, itemStyle: { opacity: DIM_OPACITY } }, { value: 4, itemStyle: { opacity: DIM_OPACITY } }]);
  assert.deepEqual(out.series.map((s) => s.data[0]), [1, 3]);
});
test("pie keeps a slice's own colour and adds the opacity", () => {
  const data = [{ name: "A", value: 1, itemStyle: { color: "x" } }, { name: "B", value: 2 }];
  const out = applySelectionDim({ series: [{ type: "pie", data }] }, "pie", 1);
  assert.deepEqual(out.series[0].data[0], { name: "A", value: 1, itemStyle: { color: "x", opacity: DIM_OPACITY } });
  assert.deepEqual(out.series[0].data[1], { name: "B", value: 2 });
});
test("a null datum stays a null value and nothing throws", () => {
  const out = applySelectionDim({ series: [{ type: "bar", data: [null, 2] }] }, "bar", 1);
  assert.deepEqual(out.series[0].data[0], { value: null, itemStyle: { opacity: DIM_OPACITY } });
});
test("a trend or reference line drawn over a bar chart is not a mark", () => {
  const line = { type: "line", data: [1, 2] };
  assert.deepEqual(applySelectionDim({ series: [{ type: "bar", data: [1, 2] }, line] }, "bar", 0).series[1], line);
});
test("no selection, a missing one (-1) or a chart type that can't style a datum leaves the option alone", () => {
  const opt = { series: [{ type: "line", data: [1, 2] }] };
  assert.deepEqual(applySelectionDim(opt, "line", 1), opt);
  const bar = { series: [{ type: "bar", data: [1, 2] }] };
  assert.deepEqual(applySelectionDim(bar, "bar", -1), bar);
  assert.deepEqual(applySelectionDim(bar, "bar", null), bar);
  assert.deepEqual(applySelectionDim(bar, "bar", undefined), bar);
  assert.deepEqual([...DIM_TYPES].sort(), ["bar", "donut", "pie", "stacked"]);
});
test("several selected indices all stay at full strength (duplicate primary values), stacked too", () => {
  const out = applySelectionDim({ series: [{ type: "bar", stack: "s", data: [1, 2, 3, 4] }, { type: "bar", stack: "s", data: [5, 6, 7, 8] }] }, "stacked", [0, 2]);
  for (const sr of out.series) assert.deepEqual(sr.data.map((d) => (typeof d === "object" ? DIM_OPACITY : 1)), [1, DIM_OPACITY, 1, DIM_OPACITY]);
  const same = { series: [{ type: "bar", data: [1, 2] }] };
  assert.deepEqual(applySelectionDim(same, "bar", []), same, "an empty set dims nothing");
});
test("the input option is not mutated", () => {
  const opt = { series: [{ type: "bar", data: [1, 2, 3] }] };
  const copy = structuredClone(opt);
  applySelectionDim(opt, "bar", 0);
  assert.deepEqual(opt, copy);
});
