import { test } from "node:test";
import assert from "node:assert/strict";
import { primaryDim, chartOrientation, aliasNames, pathOrderedRows, statusText, captionText, markFieldValues, marksChannels, scatterShapeGroups,
  colorSplitData, colorSplitLabels, heatmapData, treemapTree, sankeyLinks, multiplesData, scatterSymbol, MAX_PANELS, cmpValues, sameField }
  from "../../src/DashboardBuilder/Features/Dashboard/result-model.js";
import { tupleKey, uniqueTuples, runs, levelSpans } from "../../src/DashboardBuilder/Features/Dashboard/grid-model.js";
import { SCATTER_TYPES, planMeasures } from "../../src/DashboardBuilder/Features/Dashboard/sheet-plan.js";

// The pure shaping of a result for drawing: no DOM, so every rule is checkable here.
const dim = (column) => ({ db: "shop", table: "orders", column, category: "text" });
const meas = (column, agg = "sum") => ({ db: "shop", table: "orders", column, category: "numeric", agg });
const sheet = (over = {}) => ({ columns: [], rows: [], color: [], filters: [], chartType: "bar", sort: null, selection: null, drill: null,
  marks: { size: null, label: null, detail: [], tooltip: [], shape: null, path: null, angle: null }, pages: null, format: {}, period: null, ...over });
const fmt = (v) => String(v);
const res = (rows, over = {}) => ({ rowDimensions: ["region"], columnDimensions: [], measures: ["sum(amount)"], rows, ...over });
const row = (keys, ...values) => ({ keys, values });

test("grid helpers: tuple keys, unique tuples, runs and row spans", () => {
  assert.equal(tupleKey([null, "a"]), tupleKey(["", "a"]));
  assert.deepEqual(uniqueTuples([["a"], ["b"], ["a"]]), [["a"], ["b"]]);
  const leaves = [["a", "x"], ["a", "y"], ["b", "x"]].map((tuple) => ({ tuple, mi: null }));
  assert.deepEqual(runs(leaves, (l) => l.tuple[0]).map((g) => g.span), [2, 1]);
  assert.deepEqual(levelSpans(leaves, 0), [2, 0, 1]);
});
test("primaryDim: first Rows dimension, then Columns; a calculated dimension has none; a drill level leads", () => {
  assert.equal(primaryDim(sheet({ rows: [dim("region")], columns: [dim("channel")] })).column, "region");
  assert.equal(primaryDim(sheet({ columns: [dim("channel")] })).column, "channel");
  assert.equal(primaryDim(sheet()), null);
  const calc = { calc: "c1", category: "text", role: "dimension" };
  assert.equal(primaryDim(sheet({ rows: [calc] })), null);
  assert.equal(primaryDim(sheet({ rows: [dim("region")], drill: { levels: [dim("country"), dim("city")], depth: 1, path: [] } })).column, "city");
});
test("chartOrientation: horizontal only with a Rows dimension and none on Columns", () => {
  assert.equal(chartOrientation(sheet({ rows: [dim("region")] })), "horizontal");
  assert.equal(chartOrientation(sheet({ rows: [dim("region")], columns: [dim("channel")] })), "vertical");
  assert.equal(chartOrientation(sheet({ columns: [dim("channel")] })), "vertical");
});
test("aliasNames: dimensions and aggregated measures take their field aliases; count and unknown measures keep theirs", () => {
  const s = sheet({ rows: [dim("region")], columns: [meas("amount")] });
  const meta = (f) => (f.column === "region" ? { alias: "Area" } : f.column === "amount" ? { alias: "Revenue" } : {});
  const out = aliasNames(s, res([row(["EU"], 1)]), meta);
  assert.deepEqual(out.rowDimensions, ["Area"]);
  assert.deepEqual(out.measures, ["sum Revenue"]);
  const same = aliasNames(s, res([]), () => ({}));
  assert.deepEqual([same.rowDimensions, same.measures], [["region"], ["sum(amount)"]]);
  const counted = aliasNames(sheet({ rows: [dim("region")], columns: [meas("amount", "count")] }), res([]), () => ({ alias: "X" }));
  assert.deepEqual(counted.measures, ["sum(amount)"]);
});
test("pathOrderedRows orders by the Path dimension key or measure; null without a Path in the query", () => {
  const rows = [row(["b"], 2), row(["a"], 3), row(["c"], 1)];
  assert.equal(pathOrderedRows(sheet({ rows: [dim("region")], columns: [meas("amount")] }), res(rows), []), null);
  const byKey = sheet({ rows: [dim("region")], columns: [meas("amount")], chartType: "line", marks: { ...sheet().marks, path: dim("region") } });
  assert.deepEqual(pathOrderedRows(byKey, res(rows), planMeasures(byKey)).map((r) => r.keys[0]), ["a", "b", "c"]);
  const byMeasure = sheet({ rows: [dim("region")], columns: [meas("amount")], chartType: "line", marks: { ...sheet().marks, path: meas("amount") } });
  assert.deepEqual(pathOrderedRows(byMeasure, res(rows), planMeasures(byMeasure)).map((r) => r.keys[0]), ["c", "b", "a"]);
  assert.equal(rows[0].keys[0], "b", "the input is not reordered in place");
});
test("statusText: marks and measures; rows x columns only for a table; the selection", () => {
  const r = res([row(["EU"], 1), row(["US"], 2)]);
  assert.equal(statusText(sheet(), r), "2 marks · 1 measure");
  assert.equal(statusText(sheet({ chartType: "table" }), r), "2 marks · 2 rows × 1 column · 1 measure");
  assert.equal(statusText(sheet({ selection: { label: "region = EU" } }), res([row(["EU"], 1)], { measures: ["a", "b"] })), "1 mark · 2 measures · Selected: region = EU");
});
test("captionText: measures by dimensions plus the count of usable filters", () => {
  const names = { measureName: (f) => `${f.agg} ${f.column}`, nameOf: (f) => f.column };
  assert.equal(captionText(sheet({ rows: [dim("region")], columns: [meas("amount")] }), names), "sum amount by region");
  assert.equal(captionText(sheet({ rows: [dim("region")] }), names), "count by region");
  assert.equal(captionText(sheet(), names), "");
});
test("captionText: a histogram or box plot describes the distribution, not a sum", () => {
  const names = { measureName: (f) => `${f.agg} ${f.column}`, nameOf: (f) => f.column };
  const base = { rows: [dim("region")], columns: [meas("amount")] };
  assert.equal(captionText(sheet({ ...base, chartType: "histogram" }), names), "distribution of amount");
  assert.equal(captionText(sheet({ ...base, chartType: "boxplot" }), names), "amount by region");
  assert.equal(captionText(sheet({ columns: [meas("amount")], chartType: "boxplot" }), names), "distribution of amount");
  assert.equal(captionText(sheet({ columns: [meas("amount")], chartType: "boxplot", filters: [] }), names), "distribution of amount");
});
test("markFieldValues reads a group-by key or a measure per row; null when the field is not in the query", () => {
  const s = sheet({ rows: [dim("region")], columns: [meas("amount")] });
  const mplan = planMeasures(s);
  const rows = [row(["EU"], 5), row([null], 7)];
  assert.deepEqual(markFieldValues(s, rows, mplan, dim("region"), fmt, fmt, () => "n"), { name: "orders.region", values: ["EU", "—"] });
  assert.deepEqual(markFieldValues(s, rows, mplan, meas("amount"), (v) => `$${v}`, fmt, (f) => `${f.agg} ${f.column}`), { name: "sum amount", values: ["$5", "$7"] });
  assert.equal(markFieldValues(s, rows, mplan, dim("other"), fmt, fmt, () => ""), null);
});
test("marksChannels: Size and continuous Colour feed a scatter and become hints elsewhere; the tooltip catalog lists the fields", () => {
  const marks = { ...sheet().marks, size: meas("qty"), tooltip: [dim("channel")] };
  const s = sheet({ chartType: "bar", columns: [dim("region")], rows: [meas("amount")], marks });
  const mplan = planMeasures(s);
  const result = res([row(["EU", "web"], 5, 2)], { measures: ["sum(amount)", "sum(qty)"], columnDimensions: ["channel"] });
  const out = marksChannels(s, result, mplan, 1, -1, fmt, fmt, undefined, SCATTER_TYPES, () => "n");
  assert.match(out.note, /Size shapes a Scatter/);
  assert.equal(out.spec.sizes, undefined);
  assert.ok(Array.isArray(out.tooltipCat));
  const sc = { ...s, chartType: "scatter" };
  const out2 = marksChannels(sc, result, planMeasures(sc), 1, -1, fmt, fmt, undefined, SCATTER_TYPES, () => "n");
  assert.deepEqual(out2.spec.sizes, [2]);
  assert.equal(out2.spec.sizeName, "sum(qty)");
  assert.equal(out2.note, null);
});
test("scatterShapeGroups: one series per Shape member, the raw member kept for the legend (string members included)", () => {
  const s = sheet({ chartType: "scatter", columns: [meas("amount")], rows: [meas("qty")], marks: { ...sheet().marks, shape: dim("channel") } });
  const result = res([row(["web"], 1, 2), row(["shop"], 3, 4), row(["web"], 5, 6)], { measures: ["a", "b"], rowDimensions: ["channel"] });
  const { groups, byName } = scatterShapeGroups(s, result, [0, 1], -1, fmt);
  assert.deepEqual(groups.map((g) => [g.name, g.points.length]), [["web", 2], ["shop", 1]]);
  assert.deepEqual(groups[0].points[0].value, [1, 2]);
  assert.equal(byName.get("shop"), "shop");
});
test("colorSplitData pivots the trailing key into series and fills missing cells with null", () => {
  const result = { rowDimensions: ["region"], columnDimensions: ["channel"], measures: ["m"],
    rows: [row(["EU", "web"], 1), row(["EU", "shop"], 2), row(["US", "web"], 3)] };
  const d = colorSplitData(result, fmt);
  assert.deepEqual(d.categories, ["EU", "US"]);
  assert.deepEqual(d.series, [{ name: "web", data: [1, 3] }, { name: "shop", data: [2, null] }]);
  assert.deepEqual(d.colorVals, ["web", "shop"]);
});
test("colorSplitData also says which result row fills each series cell, so a Label can follow the split", () => {
  const result = { rowDimensions: ["region"], columnDimensions: ["channel"], measures: ["m"],
    rows: [row(["EU", "web"], 1), row(["EU", "shop"], 2), row(["US", "web"], 3)] };
  assert.deepEqual(colorSplitData(result, fmt).cellRows, [[0, 2], [1, null]]);
});
test("colorSplitLabels maps per-row label texts onto each series cell", () => {
  const result = { rowDimensions: ["region"], columnDimensions: ["channel"], measures: ["m"],
    rows: [row(["EU", "web"], 1), row(["EU", "shop"], 2), row(["US", "web"], 3)] };
  assert.deepEqual(colorSplitLabels(colorSplitData(result, fmt), ["a", "b", "c"]), [["a", "c"], ["b", ""]]);
});
test("heatmapData and treemapTree", () => {
  const result = { rowDimensions: ["r"], columnDimensions: ["c"], measures: ["m"], rows: [row(["a", "x"], 1), row(["a", "y"], 2), row(["b", "x"], 3)] };
  assert.deepEqual(heatmapData(result, fmt), { xCats: ["x", "y"], yCats: ["a", "b"], cells: [[0, 0, 1], [1, 0, 2], [0, 1, 3]] });
  assert.deepEqual(treemapTree(result, fmt), [
    { name: "a", value: 3, children: [{ name: "x", value: 1 }, { name: "y", value: 2 }] },
    { name: "b", value: 3, children: [{ name: "x", value: 3 }] }]);
  const one = { rowDimensions: ["r"], columnDimensions: [], measures: ["m"], rows: [row(["a"], 4), row([null], 5)] };
  assert.deepEqual(treemapTree(one, fmt), [{ name: "a", value: 4 }, { name: "—", value: 5 }]);
});
test("sankeyLinks keeps positive flows with side-prefixed nodes", () => {
  const links = sankeyLinks([row(["a", "a"], 3), row(["a", "b"], 0), row(["b", "a"], -1), row(["b", "c"], 2)], (k) => k);
  assert.deepEqual(links, [{ source: "s:a", target: "t:a", value: 3 }, { source: "s:b", target: "t:c", value: 2 }]);
});
test("multiplesData: panels per first key, x from the second, capped at MAX_PANELS with a notice", () => {
  const rows = [row(["a", "x"], 1), row(["a", "y"], 2), row(["b", "x"], 3)];
  const series = [{ name: "m", data: [1, 2, 3] }];
  const d = multiplesData(rows, series, ["m"], fmt);
  assert.deepEqual(d.xCats, ["x", "y"]);
  assert.deepEqual(d.panels.map((p) => [p.name, p.series[0]]), [["a", [1, 2]], ["b", [3, null]]]);
  assert.equal(d.notice, null);
  const many = Array.from({ length: MAX_PANELS + 3 }, (_, i) => row([`p${i}`, "x"], i));
  const capped = multiplesData(many, [{ name: "m", data: many.map((_, i) => i) }], ["m"], fmt);
  assert.equal(capped.panels.length, MAX_PANELS);
  assert.match(capped.notice, new RegExp(`first ${MAX_PANELS} of ${MAX_PANELS + 3} panels`));
});
test("small pure helpers: scatterSymbol, cmpValues, sameField", () => {
  assert.deepEqual(["square", "circle", "scatter"].map(scatterSymbol), ["rect", "circle", "circle"]);
  assert.ok(cmpValues(2, 10) < 0 && cmpValues("b", "a") > 0);
  assert.ok(sameField(dim("a"), dim("a")) && !sameField(dim("a"), dim("b")) && !sameField(null, dim("a")));
});
test("scatterShapeGroups keeps raw Shape members of every kind for the legend: null, numeric, numeric-looking text", () => {
  const s = sheet({ chartType: "scatter", columns: [meas("amount")], rows: [meas("qty")], marks: { ...sheet().marks, shape: dim("channel") } });
  const result = res([row([null], 1, 2), row([7], 3, 4), row(["007"], 5, 6), row(["web"], 7, 8)], { measures: ["a", "b"], rowDimensions: ["channel"] });
  const { groups, byName } = scatterShapeGroups(s, result, [0, 1], -1, fmt);
  assert.deepEqual(groups.map((g) => g.name), ["—", "7", "007", "web"]);
  assert.equal(byName.get("—"), null);
  assert.strictEqual(byName.get("7"), 7);
  assert.strictEqual(byName.get("007"), "007", "a numeric-looking string stays a string");
  assert.strictEqual(byName.get("web"), "web");
});
