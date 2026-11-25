import { test } from "node:test";
import assert from "node:assert/strict";
import { chartFit, slotFor, FIT } from "../../src/DashboardBuilder/Features/Dashboard/chart-fit.js";

const cats = (n, name = "c") => Array.from({ length: n }, (_, i) => `${name}${i}`);

test("charts without a category axis take no minimum", () => {
  for (const type of ["pie", "donut", "treemap", "scatter", "scatterShapes"])
    assert.deepEqual(chartFit({ type, categories: cats(80) }, 800), { minWidth: 0, minHeight: 0, rotate: 0, zoom: null, window: 0, windowY: 0 });
});
test("vertical bars: every category gets a slot along the bottom", () => {
  const f = chartFit({ type: "bar", categories: cats(50), series: [{}] }, 700);
  assert.equal(f.minWidth, 50 * FIT.slot + FIT.gutter);
  assert.equal(f.minHeight, 0);
});
test("grouped bars widen the slot per bar", () => {
  assert.equal(slotFor(FIT.slot, 1), FIT.slot);
  assert.equal(slotFor(FIT.slot, 4), 4 * FIT.barPx + 8);
  const f = chartFit({ type: "bar", categories: cats(10), series: [{}, {}, {}, {}] }, 700);
  assert.equal(f.minWidth, 10 * (4 * FIT.barPx + 8) + FIT.gutter);
});
test("horizontal bars: the slots run down the left axis instead", () => {
  const f = chartFit({ type: "bar", orientation: "horizontal", categories: cats(50), series: [{}] }, 700);
  assert.equal(f.minWidth, 0);
  assert.equal(f.minHeight, 50 * FIT.rowSlot + FIT.gutter);
});
test("labels stay level when they fit side by side, and turn upright when they don't", () => {
  assert.equal(chartFit({ type: "bar", categories: cats(5), series: [{}] }, 900).rotate, 0);
  assert.equal(chartFit({ type: "bar", categories: cats(50, "Customer number "), series: [{}] }, 700).rotate, 90);
});
test("a wider pane can level labels again", () => {
  const spec = { type: "line", categories: cats(8, "Region name "), series: [{}] };
  assert.equal(chartFit(spec, 500).rotate, 90);
  assert.equal(chartFit(spec, 1600).rotate, 0);
});
test("Fit width judges the labels against the shared pane width, so crowded labels turn upright", () => {
  const spec = { type: "bar", categories: Array.from({ length: 40 }, (_, i) => `c${i % 10}`), series: [{}] };
  assert.equal(chartFit(spec, 700).rotate, 0); // standard: each category keeps its slot, the pane scrolls
  assert.equal(chartFit(spec, 700, 0, true).rotate, 90); // fitted: 40 categories in 700px
  assert.equal(chartFit(spec, 1800, 0, true).rotate, 0); // a wide pane levels them again
});
test("combo stays vertical even when the shelves say horizontal", () => {
  const f = chartFit({ type: "combo", orientation: "horizontal", categories: cats(30), series: [{}, {}] }, 700);
  assert.equal(f.minWidth, 30 * FIT.slot + FIT.gutter);
});
test("heatmap sizes both axes", () => {
  const f = chartFit({ type: "heatmap", xCats: cats(40), yCats: cats(30) }, 700);
  assert.equal(f.minWidth, 40 * FIT.slot + FIT.gutter);
  assert.equal(f.minHeight, 30 * FIT.rowSlot + FIT.gutter);
});

test("a date axis is sized from its shortened labels (no needless upright turn)", async () => {
  const { chartFit } = await import("../../src/DashboardBuilder/Features/Dashboard/chart-fit.js");
  const cats = Array.from({ length: 10 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")} 00:00:00`);
  const base = { type: "bar", categories: cats, series: [{ name: "v", data: cats.map(() => 1) }] };
  assert.equal(chartFit(base, 1200).rotate, 90);
  assert.equal(chartFit({ ...base, dateLabels: "all" }, 1200).rotate, 0);
});

import { rotatedLabelCap } from "../../src/DashboardBuilder/Features/Dashboard/chart-fit.js";
test("rotatedLabelCap: upright bottom labels never take more than ~40% of a short pane, within 48..labelMax", () => {
  assert.equal(rotatedLabelCap(600), 160);
  assert.equal(rotatedLabelCap(300), 120);
  assert.equal(rotatedLabelCap(150), 60);
  assert.equal(rotatedLabelCap(40), 48);
  assert.equal(rotatedLabelCap(0), 160); // unknown height: the usual cap
});
