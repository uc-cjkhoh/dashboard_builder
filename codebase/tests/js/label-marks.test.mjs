// Label options (Format → Label marks): which marks carry their label — pure model, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LABEL_POSITION_CHOICES, labelPositionError, labelPositionOf, cleanLabelPosition, labelPositionsFor, labelPositionSymbol, LABEL_MARK_CHOICES, labelMarksError, labelMarksOf, cleanLabelMarks, labelModesFor, effectiveLabelMode, labelMask, mostRecentRaw, labelContext, LABEL_MARK_HINT }
  from "../../src/DashboardBuilder/Features/Dashboard/label-marks-model.js";
import { emptySheet, defaultFormat } from "../../src/DashboardBuilder/Features/Core/store.js";

const at = (mask, series, n) => Array.from({ length: n }, (_, d) => mask.at(series, d));
const idx = (mask, si, n) => at(mask, si, n).flatMap((v, i) => (v ? [i] : []));

test("the modes in words, All first", () => {
  assert.deepEqual(LABEL_MARK_CHOICES.map((c) => c[0]), ["all", "minmax", "selected", "highlighted", "recent", "ends"]);
  assert.deepEqual(LABEL_MARK_CHOICES.map((c) => c[1]), ["All", "Min & max", "Selected", "Highlighted", "Most recent", "Line ends"]);
});

test("a stored mode: only the listed ones, anything else refused; the default is All and stores nothing", () => {
  for (const m of ["all", "minmax", "selected", "highlighted", "recent", "ends"]) assert.equal(labelMarksError(m), null);
  for (const m of ["", "none", "MINMAX", null, undefined, 3, {}]) assert.match(labelMarksError(m), /Label marks/);
  assert.equal(labelMarksOf({}), "all"); assert.equal(labelMarksOf({ labelMarks: "ends" }), "ends"); assert.equal(labelMarksOf({ labelMarks: "bogus" }), "all");
  assert.deepEqual(cleanLabelMarks("all"), { ok: true, value: null });
  assert.deepEqual(cleanLabelMarks(null), { ok: true, value: null });
  assert.deepEqual(cleanLabelMarks("minmax"), { ok: true, value: "minmax" });
  assert.equal(cleanLabelMarks("bogus").ok, false);
  assert.equal("labelMarks" in defaultFormat(), false);
});

test("which modes a chart offers: Line ends on line and area only, Most recent only with a date", () => {
  const modes = (type, temporal = false, drawn = true) => labelModesFor({ type, temporal, drawn });
  assert.deepEqual(modes("bar"), ["all", "minmax", "selected", "highlighted"]);
  assert.deepEqual(modes("bar", true), ["all", "minmax", "selected", "highlighted", "recent"]);
  assert.deepEqual(modes("line", true), ["all", "minmax", "selected", "highlighted", "recent", "ends"]);
  assert.deepEqual(modes("area"), ["all", "minmax", "selected", "highlighted", "ends"]);
  assert.deepEqual(modes("combo"), ["all", "minmax", "selected", "highlighted"]);
  assert.deepEqual(modes("pie"), ["all", "minmax", "selected", "highlighted"]);
  assert.deepEqual(modes("scatter"), ["all", "minmax", "selected", "highlighted"]);
  assert.deepEqual(modes("heatmap"), []); assert.deepEqual(modes("table"), []); assert.deepEqual(modes("gantt"), []);
  assert.deepEqual(modes("bar", true, false), []); // no labels drawn: nothing to choose
});

test("a saved mode that does not apply here labels every mark, as before", () => {
  const ctx = { type: "bar", temporal: false, drawn: true };
  assert.equal(effectiveLabelMode("ends", ctx), "all");
  assert.equal(effectiveLabelMode("recent", ctx), "all");
  assert.equal(effectiveLabelMode("minmax", ctx), "minmax");
  assert.equal(effectiveLabelMode(undefined, ctx), "all");
  assert.equal(effectiveLabelMode("bogus", ctx), "all");
  assert.equal(effectiveLabelMode("ends", { type: "line", temporal: false, drawn: true }), "ends");
  assert.equal(effectiveLabelMode("minmax", { type: "heatmap", temporal: false, drawn: true }), "all");
});

test("All (or nothing) draws no mask at all, so the chart is untouched", () => {
  assert.equal(labelMask("all", { series: [[1, 2]] }), null);
  assert.equal(labelMask(undefined, { series: [[1, 2]] }), null);
  assert.equal(labelMask("bogus", { series: [[1, 2]] }), null);
});

test("Min & max: the lowest and the highest mark of each series; negatives count; a tie takes the first", () => {
  const m = labelMask("minmax", { series: [[3, -2, 9, 4, 9, -2], [5, 5, 5]] });
  assert.deepEqual(idx(m, 0, 6), [1, 2]); // min -2 first at 1, max 9 first at 2
  assert.deepEqual(idx(m, 1, 3), [0]); // all equal: one mark, not none
  assert.equal(m.hover, false);
});

test("Min & max ignores missing values and the skipped (Other) mark; a lone value is both ends", () => {
  const m = labelMask("minmax", { series: [[null, 4, undefined, 1, NaN, 100], [7]], skip: [5] });
  assert.deepEqual(idx(m, 0, 6), [1, 3]); // 100 is the Other mark: not a candidate
  assert.deepEqual(idx(m, 1, 1), [0]);
  assert.deepEqual(idx(labelMask("minmax", { series: [[null, null]] }), 0, 2), []);
  assert.deepEqual(idx(labelMask("minmax", { series: [["2", "10", "x"]] }), 0, 3), [0, 1]); // numeric strings read as numbers, text is no value
});

test("Line ends: the first and last real point of every line, past leading and trailing gaps", () => {
  const m = labelMask("ends", { series: [[null, null, 3, 4, 5, null], [1, 2, 3], [null, 8, null]] });
  assert.deepEqual(idx(m, 0, 6), [2, 4]);
  assert.deepEqual(idx(m, 1, 3), [0, 2]);
  assert.deepEqual(idx(m, 2, 3), [1]); // one real point is both ends
  assert.deepEqual(idx(labelMask("ends", { series: [[null, null]] }), 0, 2), []);
});

test("Selected: the marks the selection names, in every series; nothing selected labels nothing", () => {
  const m = labelMask("selected", { series: [[1, 2, 3], [4, 5, 6]], selected: [1] });
  assert.deepEqual(idx(m, 0, 3), [1]); assert.deepEqual(idx(m, 1, 3), [1]);
  assert.deepEqual(idx(labelMask("selected", { series: [[1, 2]], selected: [] }), 0, 2), []);
  assert.deepEqual(idx(labelMask("selected", { series: [[1, 2, 3]], selected: [0, 2] }), 0, 3), [0, 2]); // two marks of one value
});

test("Most recent: the marks at the latest date, in every series", () => {
  const m = labelMask("recent", { series: [[1, 2, 3], [4, 5, 6]], recent: [2] });
  assert.deepEqual(idx(m, 0, 3), [2]); assert.deepEqual(idx(m, 1, 3), [2]);
  assert.deepEqual(idx(labelMask("recent", { series: [[1, 2]], recent: [] }), 0, 2), []);
});

test("Highlighted: no label until a mark (or a legend item) is highlighted, then it shows", () => {
  const m = labelMask("highlighted", { series: [[1, 2]] });
  assert.equal(m.hover, true);
  assert.deepEqual(at(m, 0, 2), [true, true]); // the label a mark shows once highlighted
});

test("mostRecentRaw: the latest ISO date or date-time as it was written; nothing for a non-date", () => {
  assert.equal(mostRecentRaw(["2024-03-01", "2024-11-15", "2024-02-29", null]), "2024-11-15");
  assert.equal(mostRecentRaw(["2024-03-01 10:00:00", "2024-03-01 09:30:00"]), "2024-03-01 10:00:00");
  assert.equal(mostRecentRaw(["2023-12-31", "2024-01-01"]), "2024-01-01"); // across a year
  assert.equal(mostRecentRaw(["EU", "US"]), null);
  assert.equal(mostRecentRaw([1, 2, 3]), null);
  assert.equal(mostRecentRaw([null, undefined]), null);
  assert.equal(mostRecentRaw([]), null);
  assert.equal(mostRecentRaw(["2024-01-01", "EU"]), "2024-01-01"); // a stray text value does not hide the date
});

const dim = (column, category = "text") => ({ db: "d", table: "t", column, category, role: "dimension" });
const meas = (column) => ({ db: "d", table: "t", column, category: "numeric", role: "measure", agg: "sum" });
const sheet = (over = {}) => ({ ...emptySheet("S"), columns: [dim("placed", "temporal")], rows: [meas("v")], ...over });

test("labelContext: labels drawn only with Data labels or a Label field; a date on the view makes Most recent possible", () => {
  assert.deepEqual(labelContext(sheet({ chartType: "line" })), { type: "line", temporal: true, drawn: false });
  const on = sheet({ chartType: "line", format: { ...defaultFormat(), dataLabels: true } });
  assert.deepEqual(labelContext(on), { type: "line", temporal: true, drawn: true });
  const withLabel = sheet({ chartType: "bar" }); withLabel.marks.label = meas("v");
  assert.equal(labelContext(withLabel).drawn, true);
  assert.equal(labelContext(sheet({ chartType: "bar", columns: [dim("region")], format: { ...defaultFormat(), dataLabels: true } })).temporal, false);
});

test("a date part that is not a point in time (month of year) is not 'most recent'", () => {
  const f = { ...dim("placed", "temporal"), datePart: "monthOfYear" };
  assert.equal(labelContext(sheet({ columns: [f], format: { ...defaultFormat(), dataLabels: true } })).temporal, false);
  const g = { ...dim("placed", "temporal"), datePart: "month" };
  assert.equal(labelContext(sheet({ columns: [g], format: { ...defaultFormat(), dataLabels: true } })).temporal, true);
});

test("labelContext: a point chart split by Shape or Colour draws labels like any other point chart, and offers every mode that means something there", () => {
  const base = () => sheet({ chartType: "scatter", columns: [meas("x")], rows: [meas("y")], format: { ...defaultFormat(), dataLabels: true } });
  const byShape = base(); byShape.marks.shape = dim("region");
  assert.equal(labelContext(byShape).drawn, true);
  const byColour = base(); byColour.color = [dim("channel")];
  assert.equal(labelContext(byColour).drawn, true);
  const byBoth = base(); byBoth.marks.shape = dim("region"); byBoth.color = [dim("channel")];
  assert.equal(labelContext(byBoth).drawn, true);
  assert.deepEqual(labelModesFor(labelContext(byColour)), ["all", "minmax", "selected", "highlighted"]); // no date on the view, not a line
  assert.deepEqual(labelPositionsFor(labelContext(byShape)), ["auto", "above", "below", "left", "right"]);
  assert.equal(labelContext(base()).drawn, true);
  const off = byColour; off.format = { ...defaultFormat() };
  assert.equal(labelContext(off).drawn, false); // Data labels off and no Label field: nothing drawn, nothing offered
});

test("Selected and Most recent through a mark key: the selection names marks of the whole chart, not an index inside each series", () => {
  // two series whose marks are rows 0,2 and 1,3 of the result
  const rows = [[0, 2], [1, 3]];
  const keyOf = (si, di) => rows[si][di];
  const m = labelMask("selected", { series: [[5, 6], [7, 8]], selected: [3], keyOf });
  assert.deepEqual(idx(m, 0, 2), []); assert.deepEqual(idx(m, 1, 2), [1]);
  const r = labelMask("recent", { series: [[5, 6], [7, 8]], recent: [0, 1], keyOf });
  assert.deepEqual(idx(r, 0, 2), [0]); assert.deepEqual(idx(r, 1, 2), [0]);
  assert.deepEqual(idx(labelMask("selected", { series: [[5, 6]], selected: [1] }), 0, 2), [1]); // no keyOf: the mark's index, as before
  const mm = labelMask("minmax", { series: [[5, 1, 9], [2, 2]], keyOf }); // Min & max does not read the key
  assert.deepEqual(idx(mm, 0, 3), [1, 2]); assert.deepEqual(idx(mm, 1, 2), [0]);
});

test("the hint for a stored mode that does not apply", () => {
  assert.match(LABEL_MARK_HINT("ends"), /Line ends/);
  assert.match(LABEL_MARK_HINT("recent"), /date/);
  assert.equal(LABEL_MARK_HINT("minmax"), null);
});

test("Label position: auto or one side; anything else refused, auto is not stored", () => {
  assert.deepEqual(LABEL_POSITION_CHOICES.map((c) => c[0]), ["auto", "above", "below", "left", "right"]);
  for (const p of ["auto", "above", "below", "left", "right"]) assert.equal(labelPositionError(p), null);
  for (const p of ["top", "inside", "", null, undefined, 1, "ABOVE"]) assert.match(labelPositionError(p), /Label position/);
  assert.equal(labelPositionOf({}), "auto"); assert.equal(labelPositionOf({ labelPosition: "left" }), "left"); assert.equal(labelPositionOf({ labelPosition: "top" }), "auto");
  assert.deepEqual(cleanLabelPosition("auto"), { ok: true, value: null });
  assert.deepEqual(cleanLabelPosition("below"), { ok: true, value: "below" });
  assert.equal(cleanLabelPosition("inside").ok, false);
  assert.equal("labelPosition" in defaultFormat(), false);
});

test("Label position is offered only where a label sits on a point over the plot: line, area and the point charts, while labels are drawn", () => {
  const five = ["auto", "above", "below", "left", "right"];
  for (const type of ["line", "area", "scatter", "square", "circle"]) assert.deepEqual(labelPositionsFor({ type, drawn: true, temporal: false }), five, type);
  for (const type of ["bar", "stacked", "combo", "pie", "donut", "heatmap", "table"]) assert.deepEqual(labelPositionsFor({ type, drawn: true }), [], type);
  assert.deepEqual(labelPositionsFor({ type: "line", drawn: false }), []);
});

test("the ECharts position of a choice: auto leaves the chart's own", () => {
  assert.equal(labelPositionSymbol("auto"), null); assert.equal(labelPositionSymbol(undefined), null); assert.equal(labelPositionSymbol("bogus"), null);
  assert.deepEqual(["above", "below", "left", "right"].map(labelPositionSymbol), ["top", "bottom", "left", "right"]);
});
