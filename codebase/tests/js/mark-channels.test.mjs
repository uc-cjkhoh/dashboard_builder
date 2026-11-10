import { test } from "node:test";
import assert from "node:assert/strict";
import { colourChannel, sizeChannel, sizeFractions, sizeRange, barThickness, markerSizeFor }
  from "../../src/DashboardBuilder/Features/Dashboard/mark-channel-model.js";
import { positionOf, stepIndexOf, stepPieces } from "../../src/DashboardBuilder/Features/Dashboard/colour-scale-model.js";
import { marksChannels, scatterGroups, treemapTree } from "../../src/DashboardBuilder/Features/Dashboard/result-model.js";
import { planDims, planMeasures, SCATTER_TYPES, COLOR_USES } from "../../src/DashboardBuilder/Features/Dashboard/sheet-plan.js";
import { visibleTools } from "../../src/DashboardBuilder/Features/Dashboard/toolbar-rules.js";
import { applySelectionDim } from "../../src/DashboardBuilder/Features/Dashboard/selection-dim.js";

// Which chart types take which Marks channel, and the pure mappings behind them (no DOM).
const dim = (column) => ({ db: "shop", table: "orders", column, category: "text" });
const meas = (column, agg = "sum") => ({ db: "shop", table: "orders", column, category: "numeric", agg });
const marks = (over = {}) => ({ size: null, label: null, detail: [], tooltip: [], shape: null, path: null, angle: null, ...over });
const sheet = (over = {}) => ({ columns: [], rows: [], color: [], filters: [], chartType: "bar", sort: null, selection: null, drill: null,
  marks: marks(), pages: null, format: {}, period: null, ...over });
const fmt = (v) => String(v);
const row = (keys, ...values) => ({ keys, values });

test("colourChannel: a colour measure shades bar, line, area, pie, donut, treemap and the point charts; other types get a hint", () => {
  for (const t of ["scatter", "square", "circle", "pie", "donut", "treemap"]) assert.deepEqual(colourChannel(t, 1), { ok: true, note: null }, t);
  for (const t of ["bar", "line", "area"]) assert.equal(colourChannel(t, 1).ok, true, t);
  for (const t of ["bar", "line", "area"]) { const c = colourChannel(t, 2); assert.equal(c.ok, false); assert.match(c.note, /single measure/); }
  assert.match(colourChannel("stacked", 2).note, /Stacked/);
  for (const t of ["combo", "waterfall", "kpi"]) { const c = colourChannel(t, 2); assert.equal(c.ok, false, t); assert.match(c.note, /Scatter.*Treemap/); }
});
test("sizeChannel: Size scales point charts, bar thickness (one measure), line / area markers and treemap area; a pie gets its own hint", () => {
  for (const t of ["scatter", "square", "circle", "line", "area", "treemap"]) assert.equal(sizeChannel(t, 2).ok, true, t);
  assert.equal(sizeChannel("bar", 1).ok, true);
  assert.match(sizeChannel("bar", 2).note, /single measure/);
  assert.match(sizeChannel("stacked", 2).note, /Stacked/);
  for (const t of ["pie", "donut"]) { const c = sizeChannel(t, 1); assert.equal(c.ok, false); assert.match(c.note, /slice/); }
  for (const t of ["combo", "kpi", "heatmap"]) assert.match(sizeChannel(t, 1).note, /Scatter.*Bar.*Treemap/);
});
test("sizeFractions: the data span maps to 0..1; one value, or all equal, is full size; nulls stay null", () => {
  assert.deepEqual(sizeFractions([10, 20, 30]), [0, 0.5, 1]);
  assert.deepEqual(sizeFractions([5, 5]), [1, 1]);
  assert.deepEqual(sizeFractions([7]), [1]);
  assert.deepEqual(sizeFractions([10, null, 30, "x"]), [0, null, 1, null]);
  assert.deepEqual(sizeRange([3, null, 41, 9]), { min: 3, max: 41 });
  assert.equal(sizeRange([null]), null);
});
test("barThickness runs from a readable minimum to the share of the category band; a narrow band never goes below the minimum", () => {
  assert.equal(barThickness(0, 100), 6);
  assert.equal(barThickness(1, 100), 80);
  assert.equal(barThickness(0.5, 100), 43);
  assert.equal(barThickness(null, 100), 6, "a missing size is the thinnest");
  assert.equal(barThickness(1, 5), 6, "a band narrower than the minimum still draws the minimum");
});
test("markerSizeFor: 6..24 px by fraction; a missing size is the smallest", () => {
  assert.deepEqual([0, 0.5, 1, null].map((f) => markerSizeFor(f)), [6, 15, 24, 6]);
});
test("positionOf and stepIndexOf place a value on the scale: clamped at the ends, a boundary belongs to the step above", () => {
  assert.equal(positionOf(5, 0, 10), 0.5);
  assert.equal(positionOf(-5, 0, 10), 0);
  assert.equal(positionOf(50, 0, 10), 1);
  assert.equal(positionOf(null, 0, 10), null);
  assert.equal(positionOf(NaN, 0, 10), null);
  assert.deepEqual([0, 24, 25, 49.9, 50, 74, 75, 100, 500, -3].map((v) => stepIndexOf(v, 0, 100, 4)), [0, 0, 1, 1, 2, 2, 3, 3, 3, 0]);
  assert.equal(stepIndexOf(null, 0, 100, 4), null);
  // the same boundaries as the legend's pieces
  const pieces = stepPieces(0, 100, 4, ["#000000", "#ffffff"], fmt);
  for (const v of [0, 10, 25, 26, 60, 75, 99, 100]) {
    const i = pieces.findIndex((p) => (p.gte == null || v >= p.gte) && (p.lt == null || v < p.lt));
    assert.equal(stepIndexOf(v, 0, 100, 4), i, `value ${v}`);
  }
});

const result = (rows, over = {}) => ({ rowDimensions: ["region"], columnDimensions: [], measures: ["sum(amount)", "sum(qty)"], rows, ...over });
const barSheet = (type, over = {}) => sheet({ chartType: type, columns: [dim("region")], rows: [meas("amount")], ...over });

test("marksChannels: a colour measure's values line up with the rows on bar, line, area and pie; a second measure turns it into a hint", () => {
  for (const type of ["bar", "line", "area", "pie", "donut"]) {
    const s = barSheet(type, { color: [meas("qty")] });
    const r = result([row(["EU"], 5, 2), row(["US"], 7, 9)]);
    const out = marksChannels(s, r, planMeasures(s), -1, 1, fmt, fmt, undefined, SCATTER_TYPES, () => "n");
    assert.deepEqual(out.spec.colorValues, [2, 9], type);
    assert.equal(out.spec.colorName, "sum(qty)");
    assert.equal(out.note, null, type);
  }
  const two = barSheet("bar", { color: [meas("qty")], rows: [meas("amount"), meas("id")] });
  const r2 = result([row(["EU"], 5, 6, 2)], { measures: ["a", "b", "c"] });
  const o2 = marksChannels(two, r2, planMeasures(two), -1, 2, fmt, fmt, undefined, SCATTER_TYPES, () => "n");
  assert.equal(o2.spec.colorValues, undefined);
  assert.match(o2.note, /single measure/);
  const st = barSheet("stacked", { color: [meas("qty")], rows: [meas("amount"), meas("id")] });
  const o3 = marksChannels(st, r2, planMeasures(st), -1, 2, fmt, fmt, undefined, SCATTER_TYPES, () => "n");
  assert.equal(o3.spec.colorValues, undefined);
  assert.match(o3.note, /Stacked/);
});
test("marksChannels: the Other row takes neither colour nor size", () => {
  const s = barSheet("bar", { color: [meas("qty")], marks: marks({ size: meas("id") }) });
  const r = result([row(["EU"], 5, 2, 8), { keys: ["Other"], values: [99, 500, 900], isOther: true }], { measures: ["a", "b", "c"] });
  const out = marksChannels(s, r, planMeasures(s), 1, 2, fmt, fmt, undefined, SCATTER_TYPES, () => "n");
  assert.deepEqual(out.spec.colorValues, [8, null]);
  assert.deepEqual(out.spec.sizes, [2, null]);
});
test("marksChannels: Size reaches bar (one measure), line and area; hints on pie, stacked, a two-measure bar", () => {
  const cases = [["bar", 1, true], ["line", 1, true], ["area", 1, true], ["pie", 1, false], ["donut", 1, false]];
  for (const [type, , ok] of cases) {
    const s = barSheet(type, { marks: marks({ size: meas("qty") }) });
    const out = marksChannels(s, result([row(["EU"], 5, 2)]), planMeasures(s), 1, -1, fmt, fmt, undefined, SCATTER_TYPES, () => "n");
    assert.equal(Array.isArray(out.spec.sizes), ok, type);
    assert.equal(out.note === null, ok, type);
    if (ok) assert.equal(out.spec.sizeName, "sum(qty)");
  }
  const lines = barSheet("line", { rows: [meas("amount"), meas("id")], marks: marks({ size: meas("qty") }) });
  assert.ok(Array.isArray(marksChannels(lines, result([row(["EU"], 5, 6, 2)], { measures: ["a", "b", "c"] }), planMeasures(lines), 2, -1, fmt, fmt, undefined, SCATTER_TYPES, () => "n").spec.sizes), "several lines share one Size");
  const bars = barSheet("bar", { rows: [meas("amount"), meas("id")], marks: marks({ size: meas("qty") }) });
  const o = marksChannels(bars, result([row(["EU"], 5, 6, 2)], { measures: ["a", "b", "c"] }), planMeasures(bars), 2, -1, fmt, fmt, undefined, SCATTER_TYPES, () => "n");
  assert.equal(o.spec.sizes, undefined); assert.match(o.note, /single measure/);
});

test("COLOR_USES and planDims: a Colour dimension is a group-by on the scatter family too, last; one field on Colour and Shape groups once", () => {
  for (const t of ["scatter", "square", "circle"]) assert.ok(COLOR_USES.has(t), t);
  for (const t of ["pie", "donut", "combo", "treemap"]) assert.ok(!COLOR_USES.has(t), t);
  const s = sheet({ chartType: "scatter", columns: [meas("amount")], rows: [meas("qty")], color: [dim("channel")], marks: marks({ shape: dim("tier") }) });
  assert.deepEqual(planDims(s).keyOrder.map((f) => f.column), ["tier", "channel"]);
  const same = { ...s, color: [dim("tier")] };
  assert.deepEqual(planDims(same).keyOrder.map((f) => f.column), ["tier"]);
});

test("scatterGroups: Colour alone makes one series per member with member colours and a legend over that field", () => {
  const s = sheet({ chartType: "scatter", columns: [meas("amount")], rows: [meas("qty")], color: [dim("channel")] });
  const r = result([row(["web"], 1, 2), row(["shop"], 3, 4), row(["web"], 5, 6)], { rowDimensions: ["channel"], measures: ["a", "b"] });
  const g = scatterGroups(s, r, [0, 1], -1, fmt);
  assert.deepEqual(g.groups.map((x) => [x.name, x.points.length, x.colour.index, x.shape]), [["web", 2, 0, null], ["shop", 1, 1, null]]);
  assert.deepEqual(g.legend.field, dim("channel"));
  assert.equal(g.legend.byName.get("shop"), "shop");
  assert.deepEqual(g.colourMembers.map((m) => [m.name, m.raw]), [["web", "web"], ["shop", "shop"]]);
});
test("scatterGroups: Colour and Shape on different fields: a series per pair, colour by Colour member, symbol by Shape member", () => {
  const s = sheet({ chartType: "scatter", columns: [meas("amount")], rows: [meas("qty")], color: [dim("channel")], marks: marks({ shape: dim("tier") }) });
  // key order: shape, colour
  const r = result([row(["gold", "web"], 1, 2), row(["gold", "shop"], 3, 4), row(["basic", "web"], 5, 6), row(["gold", "web"], 7, 8)], { rowDimensions: ["tier", "channel"], measures: ["a", "b"] });
  const g = scatterGroups(s, r, [0, 1], -1, fmt);
  assert.deepEqual(g.groups.map((x) => [x.name, x.points.length, x.colour.index, x.shape.index]),
    [["web · gold", 2, 0, 0], ["shop · gold", 1, 1, 0], ["web · basic", 1, 0, 1]]);
  assert.equal(g.legend.field, null, "pair names are highlight-only");
  assert.deepEqual(g.colourMembers.map((m) => m.name), ["web", "shop"]);
});
test("scatterGroups: the same field on Colour and Shape is one legend, colour and symbol moving together", () => {
  const s = sheet({ chartType: "scatter", columns: [meas("amount")], rows: [meas("qty")], color: [dim("channel")], marks: marks({ shape: dim("channel") }) });
  const r = result([row(["web"], 1, 2), row(["shop"], 3, 4)], { rowDimensions: ["channel"], measures: ["a", "b"] });
  const g = scatterGroups(s, r, [0, 1], -1, fmt);
  assert.deepEqual(g.groups.map((x) => [x.name, x.colour.index, x.shape.index]), [["web", 0, 0], ["shop", 1, 1]]);
  assert.deepEqual(g.legend.field, dim("channel"));
});
test("scatterGroups: Shape alone is unchanged (no colour record); other keys label the points; Size rides along", () => {
  const s = sheet({ chartType: "scatter", columns: [meas("amount")], rows: [meas("qty")], marks: marks({ shape: dim("tier"), size: meas("id") }) });
  const r = result([row(["gold", "EU"], 1, 2, 9)], { rowDimensions: ["tier", "region"], measures: ["a", "b", "c"] });
  const g = scatterGroups(s, r, [0, 1], 2, fmt);
  assert.equal(g.groups[0].colour, null);
  assert.equal(g.groups[0].shape.index, 0);
  assert.deepEqual(g.groups[0].points[0], { value: [1, 2, 9], name: "EU" });
});

test("treemapTree: with Size the area is the Size measure, the shelf measure stays as the label value, a colour measure rides along", () => {
  const r = { rowDimensions: ["region"], columnDimensions: [], measures: ["shelf", "size", "col"], rows: [row(["EU"], 5, 100, 1), row(["US"], 7, 40, 9)] };
  assert.deepEqual(treemapTree(r, fmt), [{ name: "EU", value: 5 }, { name: "US", value: 7 }], "no marks: as before");
  const t = treemapTree(r, fmt, { sizeIdx: 1, colourIdx: 2 });
  assert.deepEqual(t, [{ name: "EU", value: 100, shelf: 5, size: 100, colour: 1 }, { name: "US", value: 40, shelf: 7, size: 40, colour: 9 }]);
  const two = { rowDimensions: ["region", "channel"], columnDimensions: [], measures: ["shelf", "size"], rows: [row(["EU", "web"], 5, 10), row(["EU", "shop"], 6, 30)] };
  const n = treemapTree(two, fmt, { sizeIdx: 1, colourIdx: -1 });
  assert.equal(n[0].value, 40, "a parent is the sum of its areas");
  assert.deepEqual(n[0].children.map((c) => [c.name, c.value, c.shelf]), [["web", 10, 5], ["shop", 30, 6]]);
  const c = treemapTree(r, fmt, { sizeIdx: -1, colourIdx: 2 });
  assert.deepEqual(c[0], { name: "EU", value: 5, shelf: 5, colour: 1 });
});

test("visibleTools: Size is not quiet on bar, line, area and treemap; still quiet on pie, donut, KPI and table", () => {
  const tools = [{ key: "size", count: 0 }];
  for (const t of ["scatter", "square", "circle", "bar", "line", "area", "treemap"]) assert.equal(visibleTools(t, tools).visible.length, 1, t);
  for (const t of ["pie", "donut", "kpi", "table", "stacked", "combo", "heatmap"]) assert.equal(visibleTools(t, tools).more.length, 1, t);
  assert.equal(visibleTools("square", [{ key: "shape", count: 0 }]).visible.length, 1, "Shape stays with the scatter family");
  assert.equal(visibleTools("bar", [{ key: "shape", count: 0 }]).more.length, 1);
});
test("applySelectionDim fades the bars of a custom (variable-width) series too", () => {
  const opt = { series: [{ type: "custom", data: [{ value: [0, 5, 1] }, { value: [1, 7, 2] }] }] };
  const out = applySelectionDim(opt, "bar", [1]);
  assert.equal(out.series[0].data[0].itemStyle.opacity, 0.35);
  assert.equal(out.series[0].data[1].itemStyle, undefined);
});
