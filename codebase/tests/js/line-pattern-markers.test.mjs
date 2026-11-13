// Format → Line pattern (Solid / Dashed / Dotted) and Format → Line markers (Automatic / All / None) on Line, Area and Combo lines:
// the pure models, the built options (what chart.js draws), the Format controls' gates and the saved-workbook rules. No browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CASES, snapshot } from "./line-golden-cases.mjs";
import { buildCartesian, tuneForSize } from "../../src/DashboardBuilder/Features/Dashboard/chart.js";
import { applyMarkOpacity } from "../../src/DashboardBuilder/Features/Dashboard/mark-opacity-model.js";
import { LINE_PATTERN_CHOICES, linePatternOf, linePatternError, effectivePattern, lineDash, comparisonDash, trendDash, lineControlSpecs } from "../../src/DashboardBuilder/Features/Dashboard/line-style-model.js";
import { LINE_MARKER_CHOICES, lineMarkersOf, lineMarkersError, isolatedPoints, markerPlan } from "../../src/DashboardBuilder/Features/Dashboard/line-marker-model.js";
import { lineControlInputs, noteLinePoints } from "../../src/DashboardBuilder/Features/Dashboard/line-controls.js";
import { LINE_PATTERNS, LINE_MARKERS } from "../../src/DashboardBuilder/Features/Core/sheet-schema.js";
import { defaultFormat, emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
import { parseWorkbook, serializeWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

const golden = JSON.parse(readFileSync(new URL("../fixtures/line-marks-golden.json", import.meta.url), "utf8"));
const S = (name, data = [1, 3, 2], extra = {}) => ({ name, data, ...extra });
const cart = (type, series, extra = {}) => buildCartesian({ type, categories: ["a", "b", "c"], series, format: {}, ...extra });
const lines = (o) => o.series.filter((s) => s.type === "line");
const many = (n) => Array.from({ length: n }, (_, i) => (i * 7) % 11);
const cats = (n) => Array.from({ length: n }, (_, i) => `c${i}`);

// ---- defaults: nothing set = today's output, byte for byte --------------------------------------------------------------
test("a sheet with neither setting, or both at their defaults, builds exactly what it built before", () => {
  for (const name of Object.keys(CASES)) {
    assert.deepEqual(snapshot(name), golden[name], `${name}: absent keys`);
    assert.deepEqual(snapshot(name, { linePattern: "solid", lineMarkers: "auto" }), golden[name], `${name}: explicit defaults`);
  }
});
test("an unknown stored value reads as the default (a stale or hand-edited format never breaks a chart)", () => {
  for (const name of ["line", "area", "comboLine", "longLine"]) assert.deepEqual(snapshot(name, { linePattern: "wavy", lineMarkers: "some" }), golden[name], name);
});

// ---- the pure pattern model --------------------------------------------------------------------------------------------
test("line pattern choices, validation and reading", () => {
  assert.deepEqual(LINE_PATTERN_CHOICES, [["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"]]);
  assert.deepEqual([...LINE_PATTERNS], ["solid", "dashed", "dotted"]);
  for (const v of ["solid", "dashed", "dotted"]) assert.equal(linePatternError(v), null, v);
  for (const v of ["dash", "DOTTED", "", null, 1, undefined]) assert.match(linePatternError(v), /Line pattern/, String(v));
  assert.equal(linePatternOf({}), "solid"); assert.equal(linePatternOf({ linePattern: "dotted" }), "dotted"); assert.equal(linePatternOf({ linePattern: "x" }), "solid");
});
test("effective pattern: a Size field drawing the line's thickness and a measure cue both override the choice", () => {
  assert.equal(effectivePattern({ pattern: "dashed" }), "dashed");
  assert.equal(effectivePattern({ pattern: "dashed", thick: true }), "solid");
  assert.equal(effectivePattern({ pattern: "dotted", cued: true }), "solid");
  assert.equal(effectivePattern({ pattern: "bogus" }), "solid");
});
test("lineDash: the cue wins, solid draws nothing, comparison lines keep a dash of their own", () => {
  assert.equal(lineDash({ pattern: "dashed" }), "dashed");
  assert.equal(lineDash({ pattern: "dotted" }), "dotted");
  assert.equal(lineDash({ pattern: "solid" }), undefined);
  assert.equal(lineDash({ pattern: "dashed", cue: { dash: "dotted" } }), "dotted");
  assert.equal(lineDash({ pattern: "dashed", cue: { dash: "solid" } }), "solid");
  assert.equal(lineDash({ pattern: "dashed", thick: true }), undefined);
  assert.equal(comparisonDash("solid"), "dashed");
  assert.deepEqual(comparisonDash("dashed"), [8, 3, 2, 3]);
  assert.deepEqual(comparisonDash("dotted"), [8, 3, 2, 3]);
});

// ---- the built options: Line pattern -----------------------------------------------------------------------------------
test("Dashed / Dotted: every plain measure line takes the pattern (line, stepped line, area border, several measures, combo lines)", () => {
  for (const p of ["dashed", "dotted"]) {
    const f = { linePattern: p };
    assert.equal(lines(cart("line", [S("v")], { format: f }))[0].lineStyle.type, p, "line");
    assert.equal(lines(cart("line", [S("v")], { format: { ...f, lineStyle: "step" } }))[0].lineStyle.type, p, "step");
    assert.equal(lines(cart("area", [S("v")], { format: f }))[0].lineStyle.type, p, "area");
    assert.deepEqual(lines(cart("line", [S("a"), S("b")], { format: f })).map((s) => s.lineStyle.type), [p, p], "several");
    const combo = cart("combo", [S("bars"), S("l1"), S("l2")], { format: f });
    assert.equal(combo.series[0].type, "bar"); assert.equal(combo.series[0].lineStyle, undefined, "the bars are untouched");
    assert.deepEqual(lines(combo).map((s) => s.lineStyle.type), [p, p], "combo lines");
    const ar = cart("combo", [S("bars"), S("a1")], { format: { ...f, secondaryType: "area" } });
    assert.equal(lines(ar)[0].lineStyle.type, p, "combo area");
    assert.ok(lines(ar)[0].areaStyle, "the area fill is still drawn");
  }
});
test("Dashed keeps the width, colour and markers; an area's fill is not patterned", () => {
  const o = cart("area", [S("v")], { format: { linePattern: "dashed" } });
  const s = o.series[0];
  assert.equal(s.lineStyle.width, 2); assert.ok(s.lineStyle.color); assert.equal(s.showSymbol, true); assert.ok(s.areaStyle);
});
test("a Size field drawing the line's thickness keeps the line solid (a dash can't vary in thickness); the overlay is unchanged", () => {
  const o = cart("line", [S("v")], { sizes: [10, 20, 30], sizeName: "qty", format: { linePattern: "dashed" } });
  assert.equal(lines(o)[0].lineStyle.type, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(o)), golden.sizeThick);
});
test("Size on a stepped line or an area varies the markers, not the line, so the pattern applies there", () => {
  assert.equal(lines(cart("line", [S("v")], { sizes: [10, 20, 30], sizeName: "q", format: { lineStyle: "step", linePattern: "dotted" } }))[0].lineStyle.type, "dotted");
  assert.equal(lines(cart("area", [S("v")], { sizes: [10, 20, 30], sizeName: "q", format: { linePattern: "dashed" } }))[0].lineStyle.type, "dashed");
});
test("a measure cue (colour measure beside several measures) wins: the pattern is not applied", () => {
  const o = cart("line", [S("a"), S("b", [2, 2, 5])], { colorValues: [-1, 5, 9], colorName: "qty", format: { linePattern: "dotted" } });
  assert.deepEqual(JSON.parse(JSON.stringify(o)), golden.cued);
  assert.deepEqual(lines(o).map((s) => s.lineStyle.type), ["solid", "dashed"]);
});
test("a colour measure on one measure: the gradient stroke wears the pattern", () => {
  const s = lines(cart("line", [S("v")], { colorValues: [-1, 5, 9], colorName: "qty", format: { linePattern: "dashed" } }))[0];
  assert.equal(s.lineStyle.type, "dashed"); assert.equal(typeof s.lineStyle.color, "object", "still a gradient");
});
test("a comparison line stays dashed and faded; beside a Dashed / Dotted main line it takes the dash-dot so the two still differ without colour", () => {
  const cmp = (f) => lines(cart("line", [S("v"), S("v (prior)", [2, 2, 2], { compare: true })], { format: f }));
  assert.deepEqual(cmp({}).map((s) => s.lineStyle.type), [undefined, "dashed"]);
  assert.deepEqual(cmp({ linePattern: "solid" }).map((s) => s.lineStyle.type), [undefined, "dashed"]);
  for (const p of ["dashed", "dotted"]) {
    const [main, prior] = cmp({ linePattern: p });
    assert.equal(main.lineStyle.type, p); assert.deepEqual(prior.lineStyle.type, [8, 3, 2, 3]);
    assert.equal(prior.lineStyle.opacity, 0.7, "still faded"); assert.equal(prior.showSymbol, false, "and marker-less");
  }
});
test("a comparison line beside a cued chart stays dashed (the pattern isn't applied there)", () => {
  const o = cart("line", [S("a"), S("b", [2, 2, 5]), S("a (prior)", [2, 2, 2], { compare: true })], { colorValues: [-1, 5, 9], colorName: "q", format: { linePattern: "dashed" } });
  assert.equal(lines(o).at(-1).lineStyle.type, "dashed");
});
test("reference lines keep their dash whatever the pattern; the trend line stays dotted unless the main line is Dotted, then it takes the dash-dot", () => {
  const an = { ref: { name: "Average", value: 2 }, trend: { name: "Trend", short: "T", data: [1, 2, 3] } };
  const o = cart("line", [S("v")], { format: { linePattern: "dotted" }, analytics: an });
  assert.equal(o.series[0].markLine.lineStyle.type, "dashed");
  assert.deepEqual(o.series[1].lineStyle.type, [8, 3, 2, 3], "dotted main line: the trend differs by more than colour");
  assert.equal(o.series[1].lineStyle.color, golden.analytics.series[1].lineStyle.color);
  assert.equal(o.series[0].lineStyle.type, "dotted");
  for (const f of [{}, { linePattern: "solid" }, { linePattern: "dashed" }]) assert.equal(cart("line", [S("v")], { format: f, analytics: an }).series[1].lineStyle.type, "dotted", JSON.stringify(f));
  const cued = cart("line", [S("a"), S("b", [2, 2, 5])], { colorValues: [-1, 5, 9], colorName: "q", format: { linePattern: "dotted" }, analytics: an });
  assert.equal(cued.series.at(-1).lineStyle.type, "dotted", "a cued chart isn't patterned, so the trend keeps its dots");
  assert.equal(trendDash("dotted").length, 4); assert.equal(trendDash("solid"), "dotted"); assert.equal(trendDash("dashed"), "dotted");
});
test("mark opacity keeps the pattern", () => {
  const o = applyMarkOpacity(cart("line", [S("v")], { format: { linePattern: "dashed", markOpacity: 50 } }), 0.5);
  assert.equal(o.series[0].lineStyle.type, "dashed"); assert.equal(o.series[0].lineStyle.opacity, 0.5);
});

// ---- the pure marker model ---------------------------------------------------------------------------------------------
test("line marker choices, validation and reading", () => {
  assert.deepEqual(LINE_MARKER_CHOICES, [["auto", "Automatic"], ["all", "All"], ["none", "None"]]);
  assert.deepEqual([...LINE_MARKERS], ["auto", "all", "none"]);
  for (const v of ["auto", "all", "none"]) assert.equal(lineMarkersError(v), null, v);
  for (const v of ["selected", "ALL", "", null, 0, undefined]) assert.match(lineMarkersError(v), /Line markers/, String(v));
  assert.equal(lineMarkersOf({}), "auto"); assert.equal(lineMarkersOf({ lineMarkers: "none" }), "none"); assert.equal(lineMarkersOf({ lineMarkers: "x" }), "auto");
});
test("isolated points: a value with no neighbour to draw a line to", () => {
  assert.deepEqual(isolatedPoints([5]), [0]);
  assert.deepEqual(isolatedPoints([1, null, 3]), [0, 2]);
  assert.deepEqual(isolatedPoints([1, 2, null, 4]), [3]);
  assert.deepEqual(isolatedPoints([null, 7, null]), [1]);
  assert.deepEqual(isolatedPoints([1, 2, 3]), []);
  assert.deepEqual(isolatedPoints([null, null]), []);
  assert.deepEqual(isolatedPoints([]), []);
  assert.deepEqual(isolatedPoints([undefined, 4, undefined]), [1]);
  assert.deepEqual(isolatedPoints([{ value: 2 }, null, { value: 3 }]), [0, 2], "object items count by their value");
});
test("markerPlan: Automatic and a forced marker leave the drawing to chart.js; All and None decide it", () => {
  assert.equal(markerPlan({ mode: "auto", data: [1, 2] }), null);
  assert.equal(markerPlan({ mode: undefined, data: [1, 2] }), null);
  assert.equal(markerPlan({ mode: "none", forced: true, data: [1, 2] }), null);
  assert.equal(markerPlan({ mode: "all", forced: true, data: [1, 2] }), null);
  assert.deepEqual(markerPlan({ mode: "all", data: [1, 2] }), { show: true, all: true, clear: null });
  assert.deepEqual(markerPlan({ mode: "none", data: [1, 2] }), { show: false, all: false, clear: null });
  const iso = markerPlan({ mode: "none", data: [1, null, 3] });
  assert.equal(iso.show, true); assert.equal(iso.all, true);
  assert.deepEqual([0, 1, 2].map((i) => iso.clear(i)), [false, true, false], "the lone points keep their marker, the rest are clear");
  const lab = markerPlan({ mode: "none", labelled: true, data: [1, 2, 3] });
  assert.equal(lab.show, true); assert.deepEqual([0, 1, 2].map((i) => lab.clear(i)), [true, true, true], "label anchors are clear");
});

// ---- the built options: Line markers ----------------------------------------------------------------------------------
const longLine = (format, extra = {}) => buildCartesian({ type: "line", categories: cats(80), series: [S("v", many(80))], format, ...extra });
test("All: a long line shows a marker on every point (and ECharts is told not to thin them)", () => {
  const s = longLine({ lineMarkers: "all" }).series[0];
  assert.equal(golden.longLine.series[0].showSymbol, false, "Automatic hides them past 60 points");
  assert.equal(s.showSymbol, true); assert.equal(s.showAllSymbol, true);
  assert.equal(longLine({ lineMarkers: "all", markerSize: 12, markerShape: "diamond" }).series[0].symbolSize, 12);
});
test("All on a short line, an area and combo lines changes nothing visible but still pins every marker", () => {
  for (const [type, series] of [["line", [S("v")]], ["area", [S("v")]], ["combo", [S("b"), S("l")]]]) {
    const o = cart(type, series, { format: { lineMarkers: "all" } });
    for (const s of lines(o)) { assert.equal(s.showSymbol, true, type); assert.equal(s.showAllSymbol, true, type); }
  }
});
test("None: no marker on any point of a line, an area, a stepped line or the lines of a combo", () => {
  for (const [type, series, f] of [["line", [S("v")], {}], ["area", [S("v")], {}], ["line", [S("v")], { lineStyle: "step" }], ["combo", [S("b"), S("l"), S("m")], {}], ["line", [S("a"), S("b")], {}]]) {
    const o = cart(type, series, { format: { lineMarkers: "none", ...f } });
    for (const s of lines(o)) { assert.equal(s.showSymbol, false, `${type} ${JSON.stringify(f)}`); assert.deepEqual(s.data, series.find((x) => x.name === s.name).data, "the values are untouched"); }
  }
});
test("None leaves a combo's bars and a bar right axis alone", () => {
  assert.deepEqual(snapshot("comboBar", { lineMarkers: "none" }), golden.comboBar);
  const o = cart("combo", [S("b"), S("l")], { format: { lineMarkers: "none" } });
  assert.equal(o.series[0].type, "bar"); assert.equal(o.series[0].showSymbol, undefined);
});
test("None never hides a lone value: a one-point line, a point between gaps and the ends of a gap keep a marker; the others are clear until hovered", () => {
  const one = buildCartesian({ type: "line", categories: ["a"], series: [S("v", [4])], format: { lineMarkers: "none" } }).series[0];
  assert.equal(one.showSymbol, true); assert.equal(one.showAllSymbol, true); assert.equal(one.data[0], 4, "the lone point is left as it is: a plain, visible marker");
  const gap = cart("line", [S("v", [1, null, 3])], { format: { lineMarkers: "none" } }).series[0];
  assert.equal(gap.showSymbol, true);
  assert.deepEqual(gap.data, [1, null, 3], "both lone points stay plain, visible markers");
  const mixed = cart("line", [S("v", [1, 2, null])], { format: { lineMarkers: "none" } }).series[0];
  assert.equal(mixed.showSymbol, false, "a point that has a neighbour is part of a line: no marker needed");
  const edge = cart("line", [S("v", [1, 2, null, 4, 5])], { format: { lineMarkers: "none" } }).series[0];
  assert.equal(edge.showSymbol, false);
  const lone = cart("line", [S("v", [1, 2, null, 4, null])], { format: { lineMarkers: "none" } }).series[0];
  assert.equal(lone.showSymbol, true);
  assert.deepEqual(lone.data.map((d) => (d == null ? null : isObj(d) ? d.itemStyle.color : "plain")), ["transparent", "transparent", null, "plain", null], "only the lone value (4) stays visible");
  assert.equal(lone.data[0].emphasis.itemStyle.color, lone.itemStyle.color, "a clear marker comes back in the series colour on hover");
  const allNull = cart("line", [S("v", [null, null, null])], { format: { lineMarkers: "none" } }).series[0];
  assert.equal(allNull.showSymbol, false);
});
const isObj = (d) => d !== null && typeof d === "object";
test("None with Data labels: the labels keep their (clear) anchors, so the text still draws; hover still shows the marker", () => {
  const o = cart("line", [S("v")], { format: { dataLabels: true, lineMarkers: "none" } });
  const s = o.series[0];
  assert.equal(s.showSymbol, true); assert.equal(s.showAllSymbol, true);
  assert.deepEqual(s.data.map((d) => d.itemStyle.color), ["transparent", "transparent", "transparent"], "transparent, not opacity 0: a label on the anchor would inherit that");
  assert.ok(s.data.every((d) => d.itemStyle.opacity === undefined));
  assert.deepEqual(s.data.map((d) => d.emphasis.itemStyle.color), [s.itemStyle.color, s.itemStyle.color, s.itemStyle.color]);
  assert.equal(s.label.show, true);
  assert.equal(s.label.formatter({ dataIndex: 1, value: 3 }), "3");
});
test("None with Label marks (Min & max) on a long line: only the labelled marks carry text, none carries a visible marker", () => {
  const f = { dataLabels: true, labelMarks: "minmax", lineMarkers: "none" };
  const s = longLine(f, { labelMarks: { mode: "minmax" } }).series[0];
  assert.equal(s.showSymbol, true);
  assert.ok(s.data.every((d) => d == null || d.itemStyle.color === "transparent"));
  const shown = s.data.map((_, i) => s.label.formatter({ dataIndex: i, value: many(80)[i] })).filter(Boolean);
  assert.ok(shown.length >= 2 && shown.length < 80, `labelled marks: ${shown.length}`);
});
test("All beside Label marks Min & max: every marker is drawn and only the min / max marks carry text", () => {
  const s = longLine({ dataLabels: true, lineMarkers: "all" }, { labelMarks: { mode: "minmax" } }).series[0];
  assert.equal(s.showSymbol, true, "All beside Min & max: every marker and the min / max labels");
});
test("None keeps a colour measure's per-mark colours and a mark border on the hover marker, and mark opacity still applies", () => {
  const byValue = cart("line", [S("v", [1, 2, null, 4, null])], { colorValues: [-1, 5, 9, 2, 3], colorName: "q", format: { lineMarkers: "none" } }).series[0];
  const first = byValue.data[0];
  assert.equal(first.itemStyle.color, "transparent");
  const plain = cart("line", [S("v", [1, 2, null, 4, null])], { colorValues: [-1, 5, 9, 2, 3], colorName: "q", format: {} }).series[0];
  assert.equal(first.emphasis.itemStyle.color, plain.data[0].itemStyle.color, "the hover marker wears its value's colour");
  assert.notEqual(first.emphasis.itemStyle.color, "transparent");
  const bordered = cart("line", [S("v", [1, 2, null, 4, null])], { format: { lineMarkers: "none", markBorder: "thin" } }).series[0];
  assert.equal(bordered.data[0].itemStyle.borderColor, "transparent", "the border is clear too");
  assert.equal(bordered.data[0].emphasis.itemStyle.borderWidth, 1); assert.notEqual(bordered.data[0].emphasis.itemStyle.borderColor, "transparent");
  assert.equal(bordered.data[3].itemStyle?.borderColor, undefined, "the lone value (4) is a plain marker with the series' own border");
  const dim = applyMarkOpacity(cart("line", [S("v", [1, 2, null, 4, null])], { format: { lineMarkers: "none", markOpacity: 50 } }), 0.5).series[0];
  assert.equal(dim.itemStyle.opacity, 0.5, "the series' mark opacity covers the hover marker (no item opacity overrides it)");
  assert.equal(dim.data[0].itemStyle.opacity, undefined);
});
test("a measure cue and a Size-sized marker are data: None doesn't remove them", () => {
  const cued = cart("line", [S("a"), S("b", [2, 2, 5])], { colorValues: [-1, 5, 9], colorName: "qty", format: { lineMarkers: "none" } });
  assert.deepEqual(JSON.parse(JSON.stringify(cued)), golden.cued);
  const stepSized = cart("line", [S("v")], { sizes: [10, 20, 30], sizeName: "qty", format: { lineStyle: "step", lineMarkers: "none" } });
  assert.deepEqual(JSON.parse(JSON.stringify(stepSized)), golden.sizeStep);
  const areaSized = cart("area", [S("v")], { sizes: [10, 20, 30], sizeName: "qty", format: { lineMarkers: "none" } });
  assert.deepEqual(JSON.parse(JSON.stringify(areaSized)), golden.sizeArea);
});
test("a Size-thickness line still takes None: the thickness is the data, the markers ride on top", () => {
  const o = cart("line", [S("v")], { sizes: [10, 20, 30], sizeName: "qty", format: { lineMarkers: "none" } });
  assert.equal(lines(o)[0].showSymbol, false);
  assert.ok(o.series.some((s) => s.type === "custom"), "the thickness overlay is still drawn");
});
test("pattern and markers together: Dotted + None", () => {
  const s = cart("line", [S("v")], { format: { linePattern: "dotted", lineMarkers: "none" } }).series[0];
  assert.equal(s.lineStyle.type, "dotted"); assert.equal(s.showSymbol, false);
});
test("the tooltip still lists the values with markers None (axis trigger)", () => {
  const o = cart("line", [S("v")], { format: { lineMarkers: "none" } });
  assert.equal(o.tooltip.trigger, "axis");
  const html = o.tooltip.formatter([{ dataIndex: 1, seriesIndex: 0, seriesName: "v", value: 3, axisValueLabel: "b", color: "#000" }]);
  assert.match(html, /v:<\/b> 3/);
});

// ---- the Format controls' gates ---------------------------------------------------------------------------------------
const specs = (over = {}) => lineControlSpecs({ type: "line", format: {}, shelfCount: 1, colourMeasure: false, hasSize: false, ...over });
const byKey = (list, k) => list.find((s) => s.key === k);
test("Line pattern and Line markers are offered for line, area and combo only", () => {
  for (const type of ["line", "area", "combo"]) assert.deepEqual(specs({ type, shelfCount: 2 }).map((s) => s.key), ["linePattern", "lineMarkers"], type);
  for (const type of ["bar", "stacked", "pie", "scatter", "heatmap", "table", "gantt"]) assert.deepEqual(specs({ type }), [], type);
});
test("both controls start at Solid / Automatic and read what is stored", () => {
  const [p, m] = specs();
  assert.deepEqual([p.label, p.value, p.disabled, m.label, m.value, m.disabled], ["Line pattern", "solid", null, "Line markers", "auto", null]);
  assert.deepEqual(p.choices, LINE_PATTERN_CHOICES); assert.deepEqual(m.choices, LINE_MARKER_CHOICES);
  const [p2, m2] = specs({ format: { linePattern: "dotted", lineMarkers: "none" } });
  assert.deepEqual([p2.value, m2.value], ["dotted", "none"]);
});
test("a Size field on a straight line sets its thickness: Line pattern is disabled, reads Solid and says why; markers stay offered", () => {
  const [p, m] = specs({ hasSize: true, format: { linePattern: "dashed" } });
  assert.match(p.disabled, /Size/); assert.match(p.disabled, /thickness/); assert.equal(p.value, "solid");
  assert.equal(m.disabled, null);
});
test("Size on a stepped line or an area sizes the markers: Line pattern stays offered, Line markers is disabled (Size is carried by them) and reads All", () => {
  for (const [type, format] of [["line", { lineStyle: "step" }], ["line", { lineStyle: "jump" }], ["area", {}]]) {
    const [p, m] = specs({ type, hasSize: true, format });
    assert.equal(p.disabled, null, type);
    assert.match(m.disabled, /Size/); assert.equal(m.value, "all");
  }
});
test("a colour measure on several measures gives each its own dash and marker: both controls are disabled with the reason", () => {
  const [p, m] = specs({ type: "line", shelfCount: 2, colourMeasure: true, format: { linePattern: "dashed", lineMarkers: "none" } });
  assert.match(p.disabled, /measure/); assert.equal(p.value, "solid");
  assert.match(m.disabled, /measure/); assert.equal(m.value, "all");
  const [p1] = specs({ type: "line", shelfCount: 1, colourMeasure: true });
  assert.equal(p1.disabled, null, "one measure: no cue");
});
test("a combo with bars on the right axis, or with one measure, draws no lines: both controls are disabled with the reason", () => {
  for (const [format, shelfCount] of [[{ secondaryType: "bar" }, 3], [{}, 1]]) {
    const [p, m] = specs({ type: "combo", shelfCount, format });
    assert.match(p.disabled, /no lines/); assert.match(m.disabled, /no lines/);
  }
  assert.equal(specs({ type: "combo", shelfCount: 2 })[0].disabled, null);
  assert.equal(specs({ type: "combo", shelfCount: 2, format: { secondaryType: "area" } })[0].disabled, null);
});
test("None says what it does to Marker size / shape", () => {
  const [, m] = specs({ format: { lineMarkers: "none" } });
  assert.match(m.note, /Marker size/); assert.match(m.note, /Marker shape/);
  assert.equal(specs()[1].note, null);
});
test("the controls' inputs are read from the sheet: shelf measures, a colour measure, a Size field", () => {
  const dim = { db: "d", table: "t", column: "region", category: "text" };
  const meas = (column) => ({ db: "d", table: "t", column, category: "numeric", agg: "sum" });
  const sheet = (over) => ({ ...emptySheet(), chartType: "line", columns: [dim], rows: [meas("a")], ...over });
  assert.deepEqual(lineControlInputs(sheet({})), { type: "line", format: sheet({}).format, shelfCount: 1, colourMeasure: false, hasSize: false, points: 0 });
  const several = lineControlInputs(sheet({ rows: [meas("a"), meas("b")], color: [meas("q")] }));
  assert.equal(several.shelfCount, 2, "the colour measure is not a shelf measure"); assert.equal(several.colourMeasure, true);
  assert.equal(lineControlInputs(sheet({ color: [dim] })).colourMeasure, false, "a Colour dimension is not a colour measure");
  assert.equal(lineControlInputs(sheet({ marks: { ...emptySheet().marks, size: meas("s") } })).hasSize, true);
  assert.equal(lineControlInputs(sheet({ marks: { ...emptySheet().marks, size: dim } })).hasSize, true, "a Size dimension (steps) also sets the thickness");
});

// ---- saved workbooks --------------------------------------------------------------------------------------------------
const roundTrip = (format) => {
  const sheet = { ...emptySheet(), chartType: "line", format };
  const state = { entities: new Map(), relationships: [], tabs: [{ id: "ws#1", kind: "worksheet", name: "D", sheet }], active: { kind: "worksheet", id: "ws#1" } };
  return parseWorkbook(JSON.stringify(serializeWorkbook(state)));
};
test("defaults are not stored: a new sheet carries neither key, so older files round-trip unchanged", () => {
  assert.equal("linePattern" in defaultFormat(), false); assert.equal("lineMarkers" in defaultFormat(), false);
  const r = roundTrip({ ...defaultFormat() });
  assert.equal("linePattern" in r.worksheets[0].sheet.format, false); assert.equal("lineMarkers" in r.worksheets[0].sheet.format, false);
  assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
});
test("workbook: Dashed / Dotted and All / None round-trip", () => {
  const f = roundTrip({ ...defaultFormat(), linePattern: "dotted", lineMarkers: "none" }).worksheets[0].sheet.format;
  assert.equal(f.linePattern, "dotted"); assert.equal(f.lineMarkers, "none");
  const g = roundTrip({ ...defaultFormat(), linePattern: "dashed", lineMarkers: "all" }).worksheets[0].sheet.format;
  assert.equal(g.linePattern, "dashed"); assert.equal(g.lineMarkers, "all");
});
test("workbook: an explicit default is dropped quietly; an invalid value is dropped and reported (never clamped)", () => {
  const ok = roundTrip({ ...defaultFormat(), linePattern: "solid", lineMarkers: "auto" });
  assert.equal(ok.issues.length, 0, JSON.stringify(ok.issues));
  assert.equal("linePattern" in ok.worksheets[0].sheet.format, false); assert.equal("lineMarkers" in ok.worksheets[0].sheet.format, false);
  const bad = roundTrip({ ...defaultFormat(), linePattern: "wavy", lineMarkers: "selected" });
  assert.equal("linePattern" in bad.worksheets[0].sheet.format, false); assert.equal("lineMarkers" in bad.worksheets[0].sheet.format, false);
  assert.ok(bad.issues.some((i) => /line pattern "wavy" — reset to Solid/.test(i)), JSON.stringify(bad.issues));
  assert.ok(bad.issues.some((i) => /line markers "selected" — reset to Automatic/.test(i)), JSON.stringify(bad.issues));
  for (const v of [1, true, {}, ""]) assert.ok(roundTrip({ ...defaultFormat(), linePattern: v }).issues.some((i) => /line pattern/.test(i)), String(v));
});

test("the panel's setter stores a choice, and drops the key for a default (a default is never stored)", async () => {
  const { withLineSetting } = await import("../../src/DashboardBuilder/Features/Dashboard/line-controls.js");
  assert.deepEqual(withLineSetting({ a: 1 }, "linePattern", "dashed"), { a: 1, linePattern: "dashed" });
  assert.deepEqual(withLineSetting({ linePattern: "dashed", a: 1 }, "linePattern", "solid"), { a: 1 });
  assert.deepEqual(withLineSetting({ lineMarkers: "none" }, "lineMarkers", "auto"), {});
  assert.deepEqual(withLineSetting({}, "lineMarkers", "all"), { lineMarkers: "all" });
});
test("wireLineControls builds the two selects, disables one that does nothing and titles it with the reason", async () => {
  const { wireLineControls } = await import("../../src/DashboardBuilder/Features/Dashboard/line-controls.js");
  const mk = () => { const attrs = {}; return { title: "", disabled: false, setAttribute: (k, v) => { attrs[k] = v; }, attrs }; };
  const fields = [];
  const fmtSelect = (label, choices, value, onPick) => { const select = mk(); const f = { label, choices, value, onPick, select, title: "", querySelector: () => select }; fields.push(f); return f; };
  const panel = { kids: [], append(...k) { this.kids.push(...k); } };
  const dim = { db: "d", table: "t", column: "region", category: "text" };
  const size = { db: "d", table: "t", column: "s", category: "numeric", agg: "sum" };
  const sheet = { ...emptySheet(), chartType: "line", columns: [dim], rows: [{ ...size, column: "a" }], marks: { ...emptySheet().marks, size } };
  const commits = [];
  wireLineControls(panel, sheet, fmtSelect, (next) => commits.push(next));
  assert.deepEqual(panel.kids.map((k) => k.label), ["Line pattern", "Line markers"]);
  assert.equal(fields[0].select.disabled, true); assert.match(fields[0].select.title, /thickness/); assert.equal(fields[0].title, fields[0].select.title);
  assert.equal(fields[1].select.disabled, false);
  fields[1].onPick("none");
  assert.deepEqual(commits.at(-1).lineMarkers, "none");
  fields[1].onPick("auto");
  assert.equal("lineMarkers" in commits.at(-1), false);
  const bars = []; wireLineControls({ append: (...k) => bars.push(...k) }, { ...sheet, chartType: "bar" }, fmtSelect, () => {});
  assert.deepEqual(bars, [], "a bar chart gets neither control");
});

// ---- the Size bound: the panel reads the drawn point count, so it agrees with the drawing --------------------------------
const wide = (n, format, extra = {}) => buildCartesian({ type: "line", categories: cats(n), series: [S("v", many(n))], sizes: many(n).map((v) => v + 1), sizeName: "qty", format, ...extra });
test("a straight line with Size is a thickness line up to 2,000 points and a marker-sized line past it: the drawing's pattern follows", () => {
  const at = wide(2000, { linePattern: "dashed" }), over = wide(2001, { linePattern: "dashed" });
  assert.ok(at.series.some((s) => s.type === "custom"), "2000: thickness overlay");
  assert.equal(lines(at)[0].lineStyle.type, undefined, "2000: solid");
  assert.ok(!over.series.some((s) => s.type === "custom"), "2001: no overlay, the markers carry Size");
  assert.equal(lines(over)[0].lineStyle.type, "dashed", "2001: the dash applies");
  assert.equal(lines(over)[0].showSymbol, true);
});
test("the panel agrees at the boundary: Line pattern is disabled with Size up to 2,000 points, enabled past it, where Line markers carry Size", () => {
  const spec = (points) => lineControlSpecs({ type: "line", format: {}, shelfCount: 1, hasSize: true, points });
  const [p0, m0] = spec(2000), [p1, m1] = spec(2001);
  assert.match(p0.disabled, /thickness/); assert.equal(m0.disabled, null);
  assert.equal(p1.disabled, null); assert.match(m1.disabled, /Size/); assert.equal(m1.value, "all");
  assert.equal(spec(0)[0].disabled !== null, true, "an undrawn sheet counts as within the bound");
});
test("the drawn point count reaches the panel's inputs (per sheet) and defaults to within the bound", () => {
  const dim = { db: "d", table: "t", column: "region", category: "text" };
  const sheet = { ...emptySheet(), chartType: "line", columns: [dim], rows: [{ db: "d", table: "t", column: "a", category: "numeric", agg: "sum" }] };
  assert.equal(lineControlInputs(sheet).points, 0);
  noteLinePoints(sheet, 2001); assert.equal(lineControlInputs(sheet).points, 2001);
  assert.equal(lineControlInputs({ ...sheet }).points, 0, "another sheet object has its own count");
  noteLinePoints(null, 5); noteLinePoints(3, 5);
});
test("Line markers All keeps every point on a big canvas chart: no LTTB sampling (Automatic and None still sample)", () => {
  const opt = (format) => { const o = longOpt(format); tuneForSize(o, { type: "line", format }); return o.series[0].sampling; };
  const longOpt = (format) => buildCartesian({ type: "line", categories: cats(80), series: [S("v", many(80))], format });
  assert.equal(opt({ lineMarkers: "all" }), undefined);
  assert.equal(opt({}), "lttb"); assert.equal(opt({ lineMarkers: "none" }), "lttb"); assert.equal(opt({ lineMarkers: "auto" }), "lttb");
  const o = longOpt({ lineMarkers: "all" }); tuneForSize(o, { type: "scatter", format: { lineMarkers: "all" } });
  assert.equal(o.series[0].sampling, "lttb", "only line / area / combo honour it");
});
