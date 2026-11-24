import { test } from "node:test";
import assert from "node:assert/strict";
import { flyoutSections, MARKER_TYPES } from "../../src/DashboardBuilder/Features/Dashboard/marks-flyout-model.js";

const base = { chartType: "bar", isChart: true, heatmapCircle: false, sizeEdit: false, shapeBins: false, memberShapes: false, labelMarks: false, labelPosition: false, lineKeys: [], tooltipKeys: [], periodSet: false, compare: false };
const keys = (tool, i) => flyoutSections(tool, { ...base, ...i }).map((s) => `${s.label}:${s.keys.join("+")}`);

test("a bar has no Marker size; Edit Sizes only with a drawn Size field", () => {
  assert.deepEqual(keys("size", {}), []);
  assert.deepEqual(keys("size", { sizeEdit: true }), ["Size:editSizes"]);
});
test("a circle heatmap lights Size with Marker size, a square heatmap does not", () => {
  assert.deepEqual(keys("size", { chartType: "heatmap", heatmapCircle: true }), ["Size:markerSize"]);
  assert.deepEqual(keys("size", { chartType: "heatmap" }), []);
  assert.deepEqual(keys("size", { chartType: "scatter", sizeEdit: true }), ["Size:markerSize+editSizes"]);
  assert.ok(MARKER_TYPES.has("line") && !MARKER_TYPES.has("pie"));
});
test("a line gives Shape its Marker shape only; scatter gives bins and members", () => {
  assert.deepEqual(keys("shape", { chartType: "line" }), ["Shape:markerShape"]);
  assert.deepEqual(keys("shape", { chartType: "scatter", shapeBins: true }), ["Shape:shapeBins"]);
  assert.deepEqual(keys("shape", { chartType: "scatter", memberShapes: true }), ["Shape:memberShapes"]);
});
test("a pie gives Size, Shape and Path no section at all", () => {
  for (const tool of ["size", "shape", "path", "angle", "detail", "drill", "pages", "filters", "color"]) assert.deepEqual(keys(tool, { chartType: "pie" }), [], tool);
});
test("Label: Data labels only on a chart, Label marks and position when offered", () => {
  assert.deepEqual(keys("label", { chartType: "table", isChart: false }), []);
  assert.deepEqual(keys("label", { labelMarks: true, labelPosition: true }), ["Label:dataLabels+labelMarks+labelPosition"]);
});
test("Tooltip: the text always, Behaviour only with controls", () => {
  assert.deepEqual(keys("tooltip", { chartType: "table", isChart: false }), ["Text:text"]);
  assert.deepEqual(keys("tooltip", { tooltipKeys: ["showTooltips", "tooltipButtons"] }), ["Text:text", "Behaviour:showTooltips+tooltipButtons"]);
});
test("Path: Line style on line, area and combo, Line pattern when offered", () => {
  assert.deepEqual(keys("path", { chartType: "combo", lineKeys: ["linePattern", "lineMarkers"] }), ["Line:lineStyle+linePattern"]);
  assert.deepEqual(keys("path", { chartType: "bar", lineKeys: [] }), []);
});
test("Dates: the range with a period, A fall is good only while comparing", () => {
  assert.deepEqual(keys("period", {}), []);
  assert.deepEqual(keys("period", { periodSet: true }), ["Range:period"]);
  assert.deepEqual(keys("period", { periodSet: true, compare: true }), ["Range:period+fallGood"]);
});
test("a tool with no moved controls has no section", () => {
  assert.deepEqual(keys("nope", {}), []);
});
