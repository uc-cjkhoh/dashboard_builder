import { test } from "node:test";
import assert from "node:assert/strict";
import { flyoutSections, MARKER_TYPES } from "../../src/DashboardBuilder/Features/Dashboard/marks-flyout-model.js";

const base = { chartType: "bar", isChart: true, heatmapCircle: false, sizeEdit: false, shapeBins: false, memberShapes: false, labelMarks: false, labelPosition: false, lineKeys: [], tooltipKeys: [], labelsDrawn: false, periodSet: false, compare: false, pagesSet: false };
const keys = (tool, i) => flyoutSections(tool, { ...base, ...i }).map((s) => `${s.label}:${s.keys.join("+")}`);

test("a bar has the Size meter; with a drawn Size field the field sets the sizes, so Edit Sizes replaces the meter", () => {
  assert.deepEqual(keys("size", {}), ["Size:markerSize"]);
  assert.deepEqual(keys("size", { sizeEdit: true }), ["Size:editSizes"]);
});
test("a line keeps the Size meter beside a Size field (its marker size still applies)", () => {
  assert.deepEqual(keys("size", { chartType: "line", sizeEdit: true }), ["Size:markerSize+editSizes"]);
  assert.deepEqual(keys("size", { chartType: "gantt", sizeEdit: true }), ["Size:editSizes"]);
});
test("the Size meter is offered on every sized chart type and on none of the fixed ones", () => {
  for (const t of ["bar", "stacked", "line", "area", "combo", "scatter", "pie", "donut", "funnel", "gauge", "sankey", "boxplot", "waterfall", "bullet", "gantt", "multiples"]) assert.deepEqual(keys("size", { chartType: t }), ["Size:markerSize"], t);
  for (const t of ["treemap", "histogram", "table", "text"]) assert.deepEqual(keys("size", { chartType: t }), [], t);
});
test("a circle heatmap lights Size with Marker size, a square heatmap does not", () => {
  assert.deepEqual(keys("size", { chartType: "heatmap", heatmapCircle: true }), ["Size:markerSize"]);
  assert.deepEqual(keys("size", { chartType: "heatmap" }), []);
  assert.deepEqual(keys("size", { chartType: "scatter", sizeEdit: true }), ["Size:editSizes"]);
  assert.ok(MARKER_TYPES.has("line") && !MARKER_TYPES.has("pie"));
});
test("a line gives Shape its Marker shape only; scatter gives bins and members", () => {
  assert.deepEqual(keys("shape", { chartType: "line" }), ["Shape:markerShape"]);
  assert.deepEqual(keys("shape", { chartType: "scatter", shapeBins: true }), ["Shape:shapeBins"]);
  assert.deepEqual(keys("shape", { chartType: "scatter", memberShapes: true }), ["Shape:memberShapes"]);
});
test("a pie gives Shape and Path no section at all", () => {
  for (const tool of ["shape", "path", "angle", "detail", "drill", "pages", "filters", "color"]) assert.deepEqual(keys(tool, { chartType: "pie" }), [], tool);
});
test("Label: Show mark labels only on a chart; Label Appearance, Marks to Label and Options by chart type, each under a heading", () => {
  assert.deepEqual(keys("label", { chartType: "table", isChart: false }), []);
  assert.deepEqual(keys("label", { labelChart: true, labelMarks: true, labelPosition: true, labelsDrawn: true }),
    ["Label:dataLabels", "Label Appearance:labelText+labelFont+labelAlign+labelPosition", "Marks to Label:labelMarks", "Options:labelOverlap"]);
  assert.deepEqual(keys("label", {}), ["Label:dataLabels"]); // a chart that draws no label (a histogram, a box plot): the checkbox alone, as before
  assert.deepEqual(keys("label", { labelChart: true }), ["Label:dataLabels", "Label Appearance:labelText+labelFont+labelAlign", "Options:labelOverlap"]); // offered, though nothing is drawn yet: the flyout disables them
});
test("Label: only the Label tile's sections carry a heading", () => {
  const withHeading = (tool, i) => flyoutSections(tool, { chartType: "bar", isChart: true, tooltipKeys: [], lineKeys: [], ...i }).filter((s) => s.heading).map((s) => s.label);
  assert.deepEqual(withHeading("label", { labelChart: true, labelMarks: true, labelPosition: true }), ["Label Appearance", "Marks to Label", "Options"]);
  for (const tool of ["size", "shape", "tooltip", "path", "pages", "period"]) assert.deepEqual(withHeading(tool, { sizeEdit: true, shapeBins: true, pagesSet: true, periodSet: true, tooltipKeys: ["showTooltips"] }), [], tool);
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
test("Pages: Speed only once a Pages field is set", () => {
  assert.deepEqual(keys("pages", {}), []);
  assert.deepEqual(keys("pages", { pagesSet: true }), ["Playback:pageSpeed"]);
});
