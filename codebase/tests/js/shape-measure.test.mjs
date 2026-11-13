// A measure on Shape: the plan seam (a measure, not a group-by), the view caps, and the binned groups. Pure modules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planDims, planMeasures, buildPlan } from "../../src/DashboardBuilder/Features/Dashboard/sheet-plan.js";
import { viewCounts, checkAdd } from "../../src/DashboardBuilder/Features/Dashboard/filter-rules.js";
import { scatterGroups } from "../../src/DashboardBuilder/Features/Dashboard/result-model.js";
import { shapeChannel, SHAPE_MEASURE_HINT } from "../../src/DashboardBuilder/Features/Dashboard/mark-channel-model.js";
import { emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";

const fmt = (v) => String(v);
const dim = (column) => ({ db: "d", table: "t", column, category: "text", role: "dimension" });
const meas = (column, agg = "sum") => ({ db: "d", table: "t", column, category: "numeric", role: "measure", agg });
const row = (keys, ...values) => ({ keys, values });
const scatter = (over = {}) => ({ ...emptySheet("S"), chartType: "scatter", columns: [meas("x")], rows: [meas("y")], ...over });
const withShape = (shape, over = {}) => { const s = scatter(over); s.marks = { ...s.marks, shape }; return s; };

test("a Shape measure is a measure after the others, not a group-by; a Shape dimension still is a group-by", () => {
  const s = withShape(meas("rating"));
  assert.deepEqual(planDims(s).keyOrder, []);
  assert.deepEqual(planMeasures(s).map((e) => [e.field.column, e.role, e.agg]), [["x", "shelf", "sum"], ["y", "shelf", "sum"], ["rating", "shape", "sum"]]);
  const d = withShape(dim("region"));
  assert.deepEqual(planDims(d).keyOrder.map((f) => f.column), ["region"]);
  assert.equal(planMeasures(d).length, 2);
});

test("the Shape measure follows the aux measures, so their indices do not move", () => {
  const s = withShape(meas("rating"));
  s.marks.label = meas("qty"); s.marks.size = meas("area");
  assert.deepEqual(planMeasures(s).map((e) => e.role), ["shelf", "shelf", "size", "aux", "shape"]);
});

test("a Shape measure is only a measure on the scatter family; the plan is otherwise byte-identical", () => {
  const bar = { ...withShape(meas("rating")), chartType: "bar" };
  assert.equal(planMeasures(bar).some((e) => e.role === "shape"), false);
  const plain = scatter();
  assert.equal(JSON.stringify(planMeasures(plain)), JSON.stringify(planMeasures({ ...plain, marks: { ...plain.marks, shape: null } })));
  assert.equal(JSON.stringify(planDims(plain)), JSON.stringify(planDims(withShape(meas("rating")))));
});

test("view caps: a Shape measure counts as a measure, a Shape dimension as a group-by", () => {
  const base = viewCounts(scatter());
  assert.deepEqual(viewCounts(withShape(meas("r"))), { dims: base.dims, measures: base.measures + 1 });
  assert.deepEqual(viewCounts(withShape(dim("region"))), { dims: base.dims + 1, measures: base.measures });
});

test("checkAdd refuses a Shape measure past the measure cap, and a measure Shape never blocks a dimension cap", () => {
  const full = scatter({ columns: Array.from({ length: 5 }, (_, i) => meas("c" + i)), rows: Array.from({ length: 5 }, (_, i) => meas("r" + i)) });
  assert.equal(checkAdd(full, "shape", meas("rating")).ok, false);
  assert.match(checkAdd(full, "shape", meas("rating")).error, /measures/);
  assert.equal(checkAdd(scatter(), "shape", meas("rating")).ok, true);
});

test("shapeChannel: only the scatter family bins a measure; elsewhere a hint, never an error", () => {
  assert.equal(shapeChannel("scatter", true).ok, true);
  assert.equal(shapeChannel("circle", true).ok, true);
  assert.equal(shapeChannel("bar", true).ok, false);
  assert.equal(shapeChannel("bar", true).note, SHAPE_MEASURE_HINT);
  assert.equal(shapeChannel("bar", false).ok, false);
});

const sheetS = () => withShape(meas("rating"));
const result = (rows) => ({ rowDimensions: [], columnDimensions: [], measures: ["x", "y", "rating"], rows });
test("binned groups: one series per bin that holds a point, lowest bin first, the symbol index is the bin, a missing value its own group", () => {
  const rows = [row([], 1, 1, 9), row([], 2, 2, 0), row([], 3, 3, 5), row([], 4, 4, null), row([], 5, 5, 10)];
  const g = scatterGroups(sheetS(), result(rows), [0, 1], -1, fmt, { shapeIdx: 2, bins: 5, fmtVal: fmt });
  assert.deepEqual(g.groups.map((x) => [x.name, x.shape.index, x.points.length]), [["0 to 2", 0, 1], ["4 to 6", 2, 1], ["8 to 10", 4, 2], ["No value", 6, 1]]);
  assert.equal(g.legend.field, null); assert.equal(g.byName.size, 0); // a legend click highlights; it cannot select a bin as a filter
  assert.equal(g.groups[2].points[0].shapeValue, "9"); assert.equal(g.groups[3].points[0].shapeValue, "—");
});

test("binned groups beside a Colour field: pairs named 'colour · bin', a highlight-only legend; the bins are cut over every point", () => {
  const s = withShape(meas("rating"), { color: [dim("region")] });
  const r = { rowDimensions: [], columnDimensions: ["region"], measures: ["x", "y", "rating"], rows: [row(["EU"], 1, 1, 0), row(["US"], 2, 2, 10), row(["EU"], 3, 3, 10)] };
  const g = scatterGroups(s, r, [0, 1], -1, fmt, { shapeIdx: 2, bins: 2, fmtVal: fmt });
  assert.deepEqual(g.groups.map((x) => x.name).sort(), ["EU · 0 to 5", "EU · 5 to 10", "US · 5 to 10"].sort());
  assert.equal(g.legend.field, null);
  assert.deepEqual(g.groups.map((x) => x.shape.index).sort(), [0, 1, 1]);
});

test("a Shape dimension is unchanged by the new argument", () => {
  const s = withShape(dim("region"));
  const r = { rowDimensions: [], columnDimensions: ["region"], measures: ["x", "y"], rows: [row(["EU"], 1, 1), row(["US"], 2, 2), row(["EU"], 3, 3)] };
  const a = scatterGroups(s, r, [0, 1], -1, fmt), b = scatterGroups(s, r, [0, 1], -1, fmt, {});
  assert.deepEqual(a.groups.map((x) => [x.name, x.shape.index]), [["EU", 0], ["US", 1]]);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("viewCounts counts a Shape measure whatever the chart type (a conservative cap), so a saved chart type switch cannot slip past the limit", () => {
  const base = viewCounts({ ...scatter(), chartType: "bar" });
  const s = withShape(meas("rating")); s.chartType = "bar";
  assert.deepEqual(viewCounts(s), { dims: base.dims, measures: base.measures + 1 });
});
