import { test } from "node:test";
import assert from "node:assert/strict";
import { sizeChannel, splitSizeNote, drawsSize, lineSizeMode, lineSizeNote, LINE_WIDTH_MAX_POINTS } from "../../src/DashboardBuilder/Features/Dashboard/mark-channel-model.js";
import { marksChannels, scatterGroups, colorSplitData, sizeGridOf, statusText } from "../../src/DashboardBuilder/Features/Dashboard/result-model.js";
import { planDims, planMeasures, tableMeasures, exportPlan, buildPlan, SCATTER_TYPES, sizeKeyIndex } from "../../src/DashboardBuilder/Features/Dashboard/sheet-plan.js";
import { visibleTools } from "../../src/DashboardBuilder/Features/Dashboard/toolbar-rules.js";
import { viewCounts, checkAdd } from "../../src/DashboardBuilder/Features/Dashboard/filter-rules.js";

// Size from a dimension, Size on Text / Table, Size beside a Colour split: which charts take them and how the rows map to marks (no DOM).
const dim = (column) => ({ db: "shop", table: "orders", column, category: "text" });
const meas = (column, agg = "sum") => ({ db: "shop", table: "orders", column, category: "numeric", agg });
const marks = (over = {}) => ({ size: null, label: null, detail: [], tooltip: [], shape: null, path: null, angle: null, ...over });
const sheet = (over = {}) => ({ columns: [], rows: [], color: [], filters: [], chartType: "bar", sort: null, selection: null, drill: null,
  marks: marks(), pages: null, format: {}, period: null, ...over });
const fmt = (v) => String(v);
const row = (keys, ...values) => ({ keys, values });
const result = (rows, over = {}) => ({ rowDimensions: ["region"], columnDimensions: [], measures: ["sum(amount)"], rows, ...over });
const barSheet = (type, over = {}) => sheet({ chartType: type, columns: [dim("region")], rows: [meas("amount")], ...over });
const chan = (s, r, sizeIdx = -1) => marksChannels(s, r, planMeasures(s), sizeIdx, -1, fmt, fmt, undefined, SCATTER_TYPES, () => "n");

test("sizeChannel: a dimension on Size steps scatter bubbles, a one-measure bar, lines and areas; other types get a hint", () => {
  for (const t of ["scatter", "square", "circle", "line", "area"]) assert.equal(sizeChannel(t, 2, true).ok, true, t);
  assert.equal(sizeChannel("bar", 1, true).ok, true);
  assert.match(sizeChannel("bar", 2, true).note, /single measure/);
  assert.match(sizeChannel("treemap", 1, true).note, /measure/);
  for (const t of ["table", "text"]) assert.match(sizeChannel(t, 1, true).note, /measure/, t);
  assert.match(sizeChannel("stacked", 1, true).note, /Stacked/);
  assert.match(sizeChannel("pie", 1, true).note, /slice|pie/i);
});
test("sizeChannel: a measure on Size now also sets Text / Table font size; a pie keeps its hint and says why", () => {
  for (const t of ["text", "table"]) assert.deepEqual(sizeChannel(t, 2), { ok: true, note: null }, t);
  for (const t of ["pie", "donut"]) { const c = sizeChannel(t, 1); assert.equal(c.ok, false); assert.match(c.note, /one pie|compare/i); }
  assert.match(sizeChannel("combo", 1).note, /Text/);
});
test("splitSizeNote: only a Stacked split can't draw Size; bars, lines and areas beside a Colour split draw it", () => {
  assert.match(splitSizeNote(true, "stacked"), /Stacked/);
  for (const t of ["bar", "line", "area"]) assert.equal(splitSizeNote(true, t), null, t);
  assert.equal(splitSizeNote(false, "stacked"), null);
});
test("lineSizeMode: a straight line varies its own thickness; a stepped line, an area, and a combo keep marker size", () => {
  assert.equal(lineSizeMode("line", "straight"), "width");
  assert.equal(lineSizeMode("line", undefined), "width");
  for (const ls of ["step", "jump"]) assert.equal(lineSizeMode("line", ls), "marker", ls);
  assert.equal(lineSizeMode("area", "straight"), "marker");
  assert.equal(lineSizeMode("bar", "straight"), null);
});
test("lineSizeMode: a thickness overlay is bounded — above 2000 points in all the lines together the markers carry Size, and the note says why", () => {
  assert.equal(LINE_WIDTH_MAX_POINTS, 2000);
  assert.equal(lineSizeMode("line", "straight", 2000), "width");
  assert.equal(lineSizeMode("line", "straight", 2001), "marker");
  assert.match(lineSizeNote("line", "straight", 2001), /2,000 points/);
  assert.match(lineSizeNote("line", "step", 10), /Straight/);
  assert.equal(lineSizeNote("line", "straight", 10), null);
  assert.equal(lineSizeNote("area", "straight", 5000), null, "an area never drew thickness: no note");
});
test("drawsSize still agrees with the hint rule for bar, line and area", () => {
  for (const t of ["bar", "line", "area"]) for (const n of [1, 2]) assert.equal(drawsSize(t, n), sizeChannel(t, n).ok, `${t} ${n}`);
});
test("visibleTools: Size is not quiet on Text and Table now", () => {
  const tools = [{ key: "size", count: 0 }];
  for (const t of ["table", "text"]) assert.equal(visibleTools(t, tools).visible.length, 1, t);
  for (const t of ["pie", "donut", "kpi", "stacked", "combo", "heatmap"]) assert.equal(visibleTools(t, tools).more.length, 1, t);
});

test("planDims: a Size dimension is a group-by after Detail and before Shape and Colour; the same field elsewhere groups once", () => {
  const s = barSheet("bar", { marks: marks({ size: dim("tier"), detail: [dim("channel")] }), color: [dim("segment")] });
  assert.deepEqual(planDims(s).keyOrder.map((f) => f.column), ["region", "channel", "tier", "segment"]);
  assert.equal(sizeKeyIndex(s), 2);
  const onShelf = barSheet("bar", { marks: marks({ size: dim("region") }) });
  assert.deepEqual(planDims(onShelf).keyOrder.map((f) => f.column), ["region"]);
  assert.equal(sizeKeyIndex(onShelf), 0, "the shelf's own key carries the steps");
  const asColour = barSheet("bar", { marks: marks({ size: dim("segment") }), color: [dim("segment")] });
  assert.deepEqual(planDims(asColour).keyOrder.map((f) => f.column), ["region", "segment"]);
  assert.equal(sizeKeyIndex(asColour), 1);
});
test("planDims: no group-by where the chart can't draw a Size dimension; a measure on Size is unchanged", () => {
  for (const t of ["stacked", "pie", "treemap", "table", "text", "combo"]) assert.deepEqual(planDims(barSheet(t, { marks: marks({ size: dim("tier") }) })).keyOrder.map((f) => f.column), ["region"], t);
  const two = barSheet("bar", { rows: [meas("amount"), meas("id")], marks: marks({ size: dim("tier") }) });
  assert.deepEqual(planDims(two).keyOrder.map((f) => f.column), ["region"], "a two-measure bar can't draw it");
  assert.equal(sizeKeyIndex(two), -1);
  assert.equal(sizeKeyIndex(barSheet("bar", { marks: marks({ size: meas("qty") }) })), -1);
  const scatter = sheet({ chartType: "scatter", columns: [meas("amount")], rows: [meas("qty")], marks: marks({ size: dim("tier") }) });
  assert.deepEqual(planDims(scatter).keyOrder.map((f) => f.column), ["tier"]);
  assert.deepEqual(planMeasures(barSheet("bar", { marks: marks({ size: dim("tier") }) })).map((e) => e.role), ["shelf"], "a dimension is not a measure");
});
test("planMeasures: a Table sends its Size measure (shelf measures first, the rest as before)", () => {
  const t = barSheet("table", { marks: marks({ size: meas("qty"), label: meas("id") }) });
  assert.deepEqual(planMeasures(t).map((e) => e.role), ["shelf", "size"]);
  assert.deepEqual(planMeasures(barSheet("table", { marks: marks({ label: meas("id") }) })).map((e) => e.role), ["shelf"], "other marks stay off a table");
  assert.deepEqual(planMeasures(barSheet("table")).map((e) => e.role), ["shelf"]);
});
test("viewCounts counts a Size dimension as a group-by", () => {
  assert.deepEqual(viewCounts(barSheet("bar", { marks: marks({ size: dim("tier") }) })), { dims: 2, measures: 1 });
  assert.deepEqual(viewCounts(barSheet("bar", { marks: marks({ size: meas("qty") }) })), { dims: 1, measures: 2 });
  assert.equal(checkAdd(barSheet("bar"), "size", dim("tier")).ok, true);
});
test("buildPlan: a plan with no Size is byte-identical; a Size measure adds only its measure; a Size dimension only its key", () => {
  const ctx = { calculations: [], entities: new Map([["e1", { id: "e1", db: "shop", table: "orders" }]]), relationships: new Map(), sharedFilters: [], parameters: [], metaOf: () => ({}), nameOf: (f) => f.column, columnType: () => "" };
  const none = buildPlan(barSheet("bar"), null, ctx);
  const withDim = buildPlan(barSheet("bar", { marks: marks({ size: dim("tier") }) }), null, ctx);
  assert.deepEqual(none.measures, withDim.measures);
  assert.equal(withDim.columnDimensions.length, none.columnDimensions.length + 1);
  const withMeasure = buildPlan(barSheet("bar", { marks: marks({ size: meas("qty") }) }), null, ctx);
  assert.deepEqual(withMeasure.columnDimensions, none.columnDimensions);
  assert.equal(withMeasure.measures.length, none.measures.length + 1);
});

test("marksChannels: a Size dimension is each member's step, ordered by member; the Other row takes none", () => {
  const s = barSheet("bar", { marks: marks({ size: dim("tier") }) });
  const r = result([row(["EU", "gold"], 5), row(["US", "bronze"], 7), row(["CA", "silver"], 2), { keys: ["Other", null], values: [9], isOther: true }], { columnDimensions: ["tier"] });
  const out = chan(s, r);
  assert.deepEqual(out.spec.sizes, [1, 0, 2, null].map((x) => x));
  assert.deepEqual(out.spec.sizeMembers, ["gold", "bronze", "silver", null]);
  assert.deepEqual(out.spec.sizeOrder, ["bronze", "gold", "silver"]);
  assert.equal(out.spec.sizeName, "tier");
  assert.equal(out.note, null);
});
test("marksChannels: a Size dimension where it can't be drawn is a hint, never an error", () => {
  const s = sheet({ chartType: "treemap", columns: [dim("region")], rows: [meas("amount")], marks: marks({ size: dim("tier") }) });
  const out = chan(s, result([row(["EU"], 5)]));
  assert.equal(out.spec.sizes, undefined);
  assert.match(out.note, /measure/);
});
test("scatterGroups: a Size dimension gives each point its member's step and name", () => {
  const s = sheet({ chartType: "scatter", columns: [meas("amount")], rows: [meas("qty")], color: [dim("channel")], marks: marks({ size: dim("tier") }) });
  const r = result([row(["web", "b"], 1, 2), row(["shop", "a"], 3, 4)], { rowDimensions: ["channel", "tier"], measures: ["x", "y"] });
  assert.deepEqual(planDims(s).keyOrder.map((f) => f.column), ["tier", "channel"]);
  const r2 = { ...r, rowDimensions: ["tier", "channel"], rows: [row(["b", "web"], 1, 2), row(["a", "shop"], 3, 4)] };
  const g = scatterGroups(s, r2, [0, 1], -1, fmt);
  assert.deepEqual(g.groups.flatMap((x) => x.points.map((p) => p.value[2])), [1, 0]);
  assert.deepEqual(g.groups.flatMap((x) => x.points.map((p) => p.sizeMember)), ["b", "a"]);
  assert.deepEqual(g.sizeOrder, ["a", "b"]);
});
test("sizeGridOf: a Size column laid out per (series, category) cell of a Colour split, null for an empty cell", () => {
  const r = { rowDimensions: ["region", "channel"], columnDimensions: [], measures: ["sum(amount)", "sum(qty)"],
    rows: [row(["EU", "web"], 1, 10), row(["EU", "shop"], 2, 20), row(["US", "web"], 3, 30)] };
  const split = colorSplitData(r, fmt);
  assert.deepEqual(sizeGridOf(split, [10, 20, 30]), [[10, 30], [20, null]]);
});
test("statusText: a Table / Text Size measure is not counted as a measure of the view", () => {
  const r = result([row(["EU"], 5, 2)], { measures: ["sum(amount)", "sum(qty)"] });
  assert.match(statusText(barSheet("text", { marks: marks({ size: meas("qty") }) }), r), /1 measure$/);
  assert.match(statusText(barSheet("text"), result([row(["EU"], 5)])), /1 measure$/);
  assert.match(statusText(barSheet("bar", { marks: marks({ size: meas("qty") }) }), r), /2 measures$/, "other types keep counting every column");
});
test("tableMeasures: a Table / Text crosstab's measures are the plan's without the Size column (it is stripped before drawing), later columns keep their place", () => {
  const t = barSheet("text", { marks: marks({ size: meas("qty"), label: meas("id") }) });
  assert.deepEqual(planMeasures(t).map((e) => e.role), ["shelf", "size", "aux"]);
  assert.deepEqual(tableMeasures(t).map((e) => e.role), ["shelf", "aux"]);
  assert.deepEqual(tableMeasures(barSheet("table", { marks: marks({ size: meas("qty") }) })).map((e) => e.role), ["shelf"]);
  assert.deepEqual(tableMeasures(barSheet("text")).map((e) => e.role), ["shelf"]);
});
test("exportPlan: the CSV of a Table / Text matches the screen — the Size measure is not an exported column", () => {
  const ctx = { calculations: [], entities: new Map([["e1", { id: "e1", db: "shop", table: "orders" }]]), relationships: new Map(), sharedFilters: [], parameters: [], metaOf: () => ({}), nameOf: (f) => f.column, columnType: () => "" };
  for (const type of ["table", "text"]) {
    const s = barSheet(type, { marks: marks({ size: meas("qty") }) });
    const plan = buildPlan(s, null, ctx);
    assert.equal(plan.measures.length, 2);
    assert.equal(exportPlan(s, plan).measures.length, 1, type);
  }
  const bar = barSheet("bar", { marks: marks({ size: meas("qty") }) });
  const p = buildPlan(bar, null, ctx);
  assert.equal(exportPlan(bar, p), p, "other types export as before");
  const none = barSheet("table"); const q = buildPlan(none, null, ctx);
  assert.equal(exportPlan(none, q), q);
});
