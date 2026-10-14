import { test } from "node:test";
import assert from "node:assert/strict";
import { waterfallSteps, niceMax, multiplesGrid } from "../../src/DashboardBuilder/Features/Dashboard/chart.js";
import { chartFit } from "../../src/DashboardBuilder/Features/Dashboard/chart-fit.js";
import { CHART_TYPES, chartIcon } from "../../src/DashboardBuilder/Features/Dashboard/viewbar-model.js";
import { CHART_TYPE_IDS } from "../../src/DashboardBuilder/Features/Core/sheet-schema.js";

test("waterfall steps run from the previous total and end with a Total bar", () => {
  const s = waterfallSteps(["Jan", "Feb", "Mar"], [100, -30, 50]);
  assert.deepEqual(s.map((x) => [x.name, x.start, x.end, x.kind]), [
    ["Jan", 0, 100, "up"], ["Feb", 100, 70, "down"], ["Mar", 70, 120, "up"], ["Total", 0, 120, "total"]]);
});
test("a waterfall can run below zero; blanks count as no change", () => {
  const s = waterfallSteps(["a", "b", "c"], [-50, null, 20]);
  assert.deepEqual(s.map((x) => x.end), [-50, -50, -30, -30]);
});
test("round gauge / axis maxima", () => {
  assert.equal(niceMax(73), 100);
  assert.equal(niceMax(180), 200);
  assert.equal(niceMax(2100), 2500);
  assert.equal(niceMax(0), 1);
});
test("small-multiples grids follow the pane's shape", () => {
  assert.deepEqual(multiplesGrid(1, 800, 450), { cols: 1, rows: 1 });
  assert.deepEqual(multiplesGrid(6, 800, 450), { cols: 3, rows: 2 });
  assert.deepEqual(multiplesGrid(24, 1200, 600), { cols: 7, rows: 4 });
  assert.ok(multiplesGrid(4, 300, 900).cols <= 2); // tall pane → fewer columns
});
test("waterfall scrolls like a bar chart (with its Total); funnel, gauge, Sankey and multiples fit the pane", () => {
  assert.ok(chartFit({ type: "waterfall", categories: Array.from({ length: 60 }, (_, i) => `m${i}`) }, 600).minWidth > 600);
  for (const type of ["funnel", "gauge", "sankey", "multiples"]) assert.equal(chartFit({ type, categories: new Array(500) }, 600).minWidth, 0, type);
  assert.ok(chartFit({ type: "bullet", categories: Array.from({ length: 40 }, (_, i) => `c${i}`) }, 600).minHeight > 0);
});
test("the new types are pickable, saveable and have icons", () => {
  for (const t of ["waterfall", "funnel", "gauge", "bullet", "sankey", "multiples"]) {
    assert.ok(CHART_TYPES.some(([v]) => v === t), t);
    assert.ok(CHART_TYPE_IDS.has(t), t);
    assert.equal(chartIcon(t), `chart-${t}`);
  }
});
