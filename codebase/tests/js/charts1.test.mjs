// Line styles (T03-05), circle heatmap (T03-10) and bullet target from a field (T03-12) — pure models.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LINE_STYLE_CHOICES, lineStep, linesTakeStyle } from "../../src/DashboardBuilder/Features/Dashboard/line-style-model.js";
import { HEATMAP_SHAPE_CHOICES, circleSize } from "../../src/DashboardBuilder/Features/Dashboard/heatmap-model.js";
import { targetChoices, bulletTargets, bandsFor } from "../../src/DashboardBuilder/Features/Dashboard/bullet-model.js";
import { defaultFormat, emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
import { parseWorkbook, serializeWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

test("line styles: straight draws no step; step holds to the next point; jump changes mid-way", () => {
  assert.deepEqual(LINE_STYLE_CHOICES.map((c) => c[0]), ["straight", "step", "jump"]);
  assert.equal(lineStep("straight"), false);
  assert.equal(lineStep(undefined), false);
  assert.equal(lineStep("step"), "end");
  assert.equal(lineStep("jump"), "middle");
  assert.equal(lineStep("zigzag"), false);
});

test("line style is offered for line, area and combo only", () => {
  for (const t of ["line", "area", "combo"]) assert.ok(linesTakeStyle(t), t);
  for (const t of ["bar", "pie", "heatmap", "table"]) assert.ok(!linesTakeStyle(t), t);
});

test("heatmap shape choices; circle size fits the cell, clamped", () => {
  assert.deepEqual(HEATMAP_SHAPE_CHOICES.map((c) => c[0]), ["square", "circle"]);
  assert.equal(circleSize(200, 150, 4, 3), 40);       // cell 50 x 50 -> 80 %
  assert.equal(circleSize(400, 100, 4, 5), 16);       // cell 100 x 20 -> min side 20 * 0.8
  assert.equal(circleSize(4000, 3000, 2, 2), 48);     // capped
  assert.equal(circleSize(100, 100, 50, 50), 6);      // floored
  assert.equal(circleSize(0, 0, 0, 0), 6);            // degenerate
});

test("bullet target choices list the measures after the first", () => {
  assert.deepEqual(targetChoices(["Sales"]), []);
  assert.deepEqual(targetChoices(["Sales", "Budget", "Plan"]), [[1, "Budget"], [2, "Plan"]]);
});

test("bullet targets: a field gives one target per category, else the fixed number, else null", () => {
  const series = [{ data: [5, 6] }, { data: [10, 20] }];
  assert.deepEqual(bulletTargets({ fixed: 8, measureIndex: 1, series, count: 2 }), [10, 20]);
  assert.deepEqual(bulletTargets({ fixed: 8, measureIndex: null, series, count: 2 }), [8, 8]);
  assert.deepEqual(bulletTargets({ fixed: 8, measureIndex: 5, series, count: 2 }), [8, 8], "out of range falls back");
  assert.deepEqual(bulletTargets({ fixed: 8, measureIndex: 0, series, count: 2 }), [8, 8], "the value measure itself is not a target");
  assert.equal(bulletTargets({ fixed: null, measureIndex: null, series, count: 2 }), null);
  assert.deepEqual(bulletTargets({ fixed: null, measureIndex: 1, series: [{ data: [1] }, { data: [null] }], count: 1 }), [null]);
});

test("bullet bands scale with each target; a missing target gives zero-width bands", () => {
  assert.deepEqual(bandsFor([10, null], 0, 0.5), [5, 0]);
  assert.deepEqual(bandsFor([10, 20], 0.5, 0.75), [2.5, 5]);
});

test("defaults and old workbooks: lineStyle straight, heatmapShape square, targetMeasure null", () => {
  const f = defaultFormat();
  assert.equal(f.lineStyle, "straight"); assert.equal(f.heatmapShape, "square"); assert.equal(f.targetMeasure, null);
});

const roundTrip = (format) => {
  const sheet = { ...emptySheet(), chartType: "line", format };
  const state = { entities: new Map(), relationships: [], dashboards: [{ id: "dash#1", name: "D", sheet }], active: { kind: "dashboard", id: "dash#1" } };
  return parseWorkbook(JSON.stringify(serializeWorkbook(state)));
};
test("workbook: the new settings round-trip; unknown values reset with an issue; absent ones open unchanged", () => {
  const ok = roundTrip({ lineStyle: "jump", heatmapShape: "circle", targetMeasure: 2 });
  const f = ok.dashboards[0].sheet.format;
  assert.equal(f.lineStyle, "jump"); assert.equal(f.heatmapShape, "circle"); assert.equal(f.targetMeasure, 2);
  const bad = roundTrip({ lineStyle: "wavy", heatmapShape: "star", targetMeasure: -1 });
  const g = bad.dashboards[0].sheet.format;
  assert.equal(g.lineStyle, "straight"); assert.equal(g.heatmapShape, "square"); assert.equal(g.targetMeasure, null);
  assert.ok(bad.issues.some((i) => /line style/.test(i)));
  assert.ok(bad.issues.some((i) => /heatmap shape/.test(i)));
  assert.ok(bad.issues.some((i) => /target measure/.test(i)));
  const old = roundTrip({ target: 5 });
  assert.equal(old.issues.length, 0, JSON.stringify(old.issues));
  assert.equal(old.dashboards[0].sheet.format.lineStyle, "straight");
});
