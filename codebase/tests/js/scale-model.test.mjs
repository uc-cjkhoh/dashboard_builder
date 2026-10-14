import { test } from "node:test";
import assert from "node:assert/strict";
import { scalePlan, withOther, otherLabel, bucketNotice, tableProgress, needsNextPage, TABLE_PAGE } from "../../src/DashboardBuilder/Features/Dashboard/scale-model.js";
import { chartFit, markCount, FIT } from "../../src/DashboardBuilder/Features/Dashboard/chart-fit.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

test("the Table pages and counts; it never folds into Other or groups dates", () => {
  assert.deepEqual(scalePlan("table", { topN: 10, dateBucket: "month" }, 1), { limit: TABLE_PAGE, offset: 0, withTotal: true });
});
test("a chart asks for Top-N, or the 5,000 cap for All", () => {
  assert.equal(scalePlan("line", {}, 1).limit, LIMITS.rows);
  assert.equal(scalePlan("line", { topN: 20 }, 1).limit, 20);
});
test("Other is asked for on one-dimension bar / pie / donut / treemap only", () => {
  for (const t of ["bar", "pie", "donut", "treemap"]) assert.equal(scalePlan(t, {}, 1).otherBucket, true, t);
  assert.equal(scalePlan("bar", {}, 2).otherBucket, undefined);
  assert.equal(scalePlan("line", {}, 1).otherBucket, undefined);
  assert.equal(scalePlan("stacked", {}, 1).otherBucket, undefined);
});
test("charts group dates automatically unless set to Exact; scatter never does", () => {
  assert.equal(scalePlan("line", {}, 1).dateBucket, "auto");
  assert.equal(scalePlan("bar", { dateBucket: "month" }, 1).dateBucket, "month");
  assert.equal(scalePlan("line", { dateBucket: "exact" }, 1).dateBucket, undefined);
  assert.equal(scalePlan("scatter", {}, 1).dateBucket, undefined);
});
test("Other becomes one last row, marked so clicks and colours can skip it", () => {
  const rows = [{ keys: ["a"], values: [3] }];
  const out = withOther(rows, { groups: 4950, values: [12] });
  assert.equal(out.length, 2);
  assert.deepEqual(out[1], { keys: ["Other (4,950 more)"], values: [12], isOther: true });
  assert.equal(withOther(rows, null), rows);
  assert.equal(withOther(rows, { groups: 0, values: [0] }), rows);
  assert.equal(otherLabel(1), "Other (1 more)");
});
test("the date-grouping notice names the grain", () => {
  assert.match(bucketNotice({ key: 0, grain: "month" }), /grouped by month/);
  assert.equal(bucketNotice(null), null);
});
test("table progress: partial, complete, unknown", () => {
  assert.equal(tableProgress(500, 12345), "Rows 1–500 of 12,345 — scroll to load more");
  assert.equal(tableProgress(12345, 12345), "12,345 rows");
  assert.equal(tableProgress(1, 1), "1 row");
  assert.equal(tableProgress(10, null), null);
});
test("the next page loads near the bottom, and only while rows remain", () => {
  const pane = { scrollTop: 600, clientHeight: 400, scrollHeight: 1300 };
  assert.equal(needsNextPage(pane, 500, 2000), true);
  assert.equal(needsNextPage({ ...pane, scrollTop: 0 }, 500, 2000), false);
  assert.equal(needsNextPage(pane, 2000, 2000), false);
  assert.equal(needsNextPage({ scrollTop: 0, clientHeight: 800, scrollHeight: 800 }, 20, 900), true); // pane not yet full
});
test("past 1,000 categories an axis zooms instead of growing", () => {
  const f = chartFit({ type: "bar", categories: Array.from({ length: 5000 }, (_, i) => `c${i}`), series: [{}] }, 800, 400);
  assert.equal(f.zoom, "x");
  assert.equal(f.minWidth, 0);
  assert.equal(f.window, Math.floor((800 - FIT.gutter) / FIT.slot));
  const h = chartFit({ type: "bar", orientation: "horizontal", categories: Array.from({ length: 3000 }, (_, i) => `c${i}`), series: [{}] }, 800, 400);
  assert.equal(h.zoom, "y");
  assert.equal(h.minHeight, 0);
});
test("mark counts pick canvas for big charts", () => {
  assert.equal(markCount({ type: "bar", categories: new Array(1000), series: [{}, {}] }), 2000);
  assert.equal(markCount({ type: "heatmap", cells: new Array(30) }), 30);
  assert.ok(markCount({ type: "line", categories: new Array(5000), series: [{}] }) > FIT.canvasMarks);
});
