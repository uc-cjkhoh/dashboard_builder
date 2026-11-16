// Format → Line markers → Selected: dots only at the click-selected marks. The pure plan, the built option (line, area, combo, several series, a long line,
// Size / cue overrides), the Format control's gates, the saved-workbook rules, and the whole drawing (worksheet-render) with a worksheet or dashboard selection.
// Choices that existed before (Automatic, All, None) are proven unchanged against fixtures/line-selected-golden.json, generated from unmodified main.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { CASES, snapshot } = await import("./line-golden-cases.mjs"); // first: it installs the echarts colour stub the golden was built with
const fakeEl = () => ({ className: "", children: [], style: { setProperty() {} }, clientWidth: 600, clientHeight: 400, classList: { add() {}, remove() {}, toggle() {} },
  append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }, setAttribute() {}, addEventListener() {}, textContent: "", getContext: () => ({ measureText: (t) => ({ width: String(t).length * 7 }), font: "" }) });
globalThis.document = { createElement: fakeEl, createElementNS: fakeEl, documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "", left: "0" });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const insts = [];
globalThis.window = globalThis;
window.echarts.init = (host) => {
  const i = { host, handlers: [], lastSet: null, setOption(o) { this.lastSet = o; }, on(evt, fn) { this.handlers.push([evt, fn]); }, dispatchAction() {}, resize() {}, dispose() {}, getWidth: () => 600, getHeight: () => 400 };
  insts.push(i); return i; };

const { MATRIX, LABEL_SELECTED_CASES, sampled } = await import("./line-selected-cases.mjs");
const { buildCartesian, tuneForSize } = await import("../../src/DashboardBuilder/Features/Dashboard/chart.js");
const { LINE_MARKER_CHOICES, lineMarkersOf, lineMarkersError, markerPlan, selectGate, selectNote, selectDrawnReason } = await import("../../src/DashboardBuilder/Features/Dashboard/line-marker-model.js");
const { lineControlSpecs } = await import("../../src/DashboardBuilder/Features/Dashboard/line-style-model.js");
const { lineControlInputs, wireLineControls } = await import("../../src/DashboardBuilder/Features/Dashboard/line-controls.js");
const { LINE_MARKERS } = await import("../../src/DashboardBuilder/Features/Core/sheet-schema.js");
const { defaultFormat, emptySheet } = await import("../../src/DashboardBuilder/Features/Core/store.js");
const { parseWorkbook, serializeWorkbook } = await import("../../src/DashboardBuilder/Features/Workbook/workbook-model.js");
const { renderWorksheet } = await import("../../src/DashboardBuilder/Features/Dashboard/worksheet-render.js");

const golden = JSON.parse(readFileSync(new URL("../fixtures/line-selected-golden.json", import.meta.url), "utf8"));
beforeEach(() => { insts.length = 0; });

const S = (name, data = [1, 3, 2]) => ({ name, data });
const many = (n) => Array.from({ length: n }, (_, i) => (i * 7) % 11);
const cats = (n) => Array.from({ length: n }, (_, i) => `c${i}`);
const cart = (type, series, extra = {}) => buildCartesian({ type, categories: ["a", "b", "c"], series, ...extra });
const lines = (o) => o.series.filter((s) => s.type === "line");
const isObj = (d) => d !== null && typeof d === "object";
/** Which points of a drawn line series show a dot (plain item, or an item whose fill is not clear) — only meaningful when showSymbol is on. */
const dotted = (s) => s.data.map((d) => d != null && (!isObj(d) || (d.itemStyle?.color !== "transparent")));
const sel = (format = {}, selected = [], extra = {}) => ({ format: { lineMarkers: "selected", ...format }, selectedMarks: selected, ...extra });

// ---- unchanged: Automatic / All / None (and Label marks Selected) build exactly what main built ------------------------------------
test("Automatic, All and None build exactly what main built, for every line / area / combo case", () => {
  for (const name of Object.keys(CASES)) for (const [key, f] of MATRIX) assert.deepEqual(snapshot(name, f), golden.matrix[name][key], `${name} ${key}`);
  for (const name of Object.keys(CASES)) assert.deepEqual(snapshot(name, { lineMarkers: "auto" }), golden.matrix[name].absent, `${name}: explicit Automatic`);
});
test("beside Label marks Selected (the chart is handed its selected marks) the other choices are unchanged", () => {
  for (const [name, make] of Object.entries(LABEL_SELECTED_CASES)) for (const [key, f] of MATRIX) assert.deepEqual(JSON.parse(JSON.stringify(make(f))), golden.labelSelected[name][key], `${name} ${key}`);
});
test("a big canvas line samples for Automatic and None, and for All keeps every point: as on main", () => {
  for (const [key, f] of MATRIX) assert.deepEqual(sampled(buildCartesian, tuneForSize, f), golden.sampling[key], key);
});
test("an unchanged choice ignores selected marks handed to the chart", () => {
  for (const mode of [undefined, "auto", "all", "none"]) {
    const f = mode ? { lineMarkers: mode } : {};
    assert.deepEqual(JSON.parse(JSON.stringify(cart("line", [S("v")], { format: f, selectedMarks: [1] }))), JSON.parse(JSON.stringify(cart("line", [S("v")], { format: f }))), String(mode));
  }
});

// ---- the choice ------------------------------------------------------------------------------------------------------------
test("Selected is a Line markers choice: listed, valid, stored, read back; an unknown value still reads Automatic", () => {
  assert.deepEqual(LINE_MARKER_CHOICES, [["auto", "Automatic"], ["selected", "Selected"], ["all", "All"], ["none", "None"]]);
  assert.deepEqual([...LINE_MARKERS].sort(), ["all", "auto", "none", "selected"]);
  assert.equal(lineMarkersError("selected"), null);
  for (const v of ["Selected", "select", "", null, 0, undefined]) assert.match(lineMarkersError(v), /Line markers must be Automatic, Selected, All or None/, String(v));
  assert.equal(lineMarkersOf({ lineMarkers: "selected" }), "selected"); assert.equal(lineMarkersOf({ lineMarkers: "x" }), "auto");
});

// ---- the pure plan ---------------------------------------------------------------------------------------------------------
test("markerPlan Selected: the selected points keep their dot, every other point is clear", () => {
  const p = markerPlan({ mode: "selected", selected: [1], data: [1, 2, 3] });
  assert.equal(p.show, true); assert.equal(p.all, true);
  assert.deepEqual([0, 1, 2].map((i) => p.clear(i)), [true, false, true]);
  const two = markerPlan({ mode: "selected", selected: [0, 2], data: [1, 2, 3] });
  assert.deepEqual([0, 1, 2].map((i) => two.clear(i)), [false, true, false]);
});
test("markerPlan Selected: no selection draws no dot (show false), except a lone value", () => {
  assert.deepEqual(markerPlan({ mode: "selected", selected: [], data: [1, 2, 3] }), { show: false, all: false, clear: null });
  assert.deepEqual(markerPlan({ mode: "selected", data: [1, 2, 3] }), { show: false, all: false, clear: null }, "selected left out = none selected");
  assert.deepEqual(markerPlan({ mode: "none", data: [1, 2, 3] }), markerPlan({ mode: "selected", data: [1, 2, 3] }), "the same plan as None when nothing is selected");
  const lone = markerPlan({ mode: "selected", selected: [], data: [1, null, 3] });
  assert.equal(lone.show, true); assert.deepEqual([0, 1, 2].map((i) => lone.clear(i)), [false, true, false], "both lone values keep their dot");
  const one = markerPlan({ mode: "selected", selected: [], data: [4] });
  assert.equal(one.show, true); assert.equal(one.clear(0), false);
});
test("markerPlan Selected: a selected point and a lone value both keep their dot", () => {
  const p = markerPlan({ mode: "selected", selected: [1], data: [1, 2, null, 4, null] });
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => p.clear(i)), [true, false, true, false, true], "1 is selected, 3 is lone");
});
test("markerPlan Selected: a selected index with no value or out of range changes nothing (a gap draws no dot)", () => {
  const gap = markerPlan({ mode: "selected", selected: [1], data: [1, null, 3, 4] });
  assert.deepEqual([0, 1, 2, 3].map((i) => gap.clear(i)), [false, true, true, true], "0 is lone (neighbour is a gap), 1 selected but empty, 2-3 joined");
  for (const bad of [[9], [-1], [1.5], [NaN], ["1"], [null]]) assert.deepEqual(markerPlan({ mode: "selected", selected: bad, data: [1, 2, 3] }), { show: false, all: false, clear: null }, `${JSON.stringify(bad)}: nothing is kept`);
  for (const data of [[], [null, null], [undefined]]) assert.deepEqual(markerPlan({ mode: "selected", selected: [0], data }), { show: false, all: false, clear: null }, `no values: ${JSON.stringify(data)}`);
});
test("markerPlan Selected: a labelled series keeps clear anchors, the selected dots stay; a forced marker is left to chart.js", () => {
  const p = markerPlan({ mode: "selected", selected: [2], labelled: true, data: [1, 2, 3] });
  assert.equal(p.show, true); assert.deepEqual([0, 1, 2].map((i) => p.clear(i)), [true, true, false]);
  const none = markerPlan({ mode: "selected", selected: [], labelled: true, data: [1, 2, 3] });
  assert.equal(none.show, true); assert.deepEqual([0, 1, 2].map((i) => none.clear(i)), [true, true, true]);
  assert.equal(markerPlan({ mode: "selected", selected: [1], forced: true, data: [1, 2, 3] }), null);
});
test("markerPlan Selected: object items count by their value", () => {
  const p = markerPlan({ mode: "selected", selected: [0, 1], data: [{ value: 2 }, { value: null }, { value: 3 }] });
  assert.deepEqual([0, 1, 2].map((i) => p.clear(i)), [false, true, false], "0 is selected; 2 is lone (its neighbour is a gap)");
});

// ---- the built options -----------------------------------------------------------------------------------------------------
test("Selected on a short line: the selected point is a plain visible dot, the others are clear until hovered", () => {
  const s = cart("line", [S("v")], sel({}, [1])).series[0];
  assert.equal(s.showSymbol, true); assert.equal(s.showAllSymbol, true);
  assert.deepEqual(dotted(s), [false, true, false]);
  assert.equal(s.data[1], 3, "the selected point is left as it is: a plain marker");
  assert.equal(s.data[0].itemStyle.color, "transparent");
  assert.equal(s.data[0].emphasis.itemStyle.color, s.itemStyle.color, "hovering a clear dot brings it back in the series colour");
  assert.equal(s.data[0].value, 1, "values untouched");
});
test("Selected with nothing selected draws no marker at all, but the tooltip still has the axis pointer", () => {
  const o = cart("line", [S("v")], sel({}, []));
  assert.equal(o.series[0].showSymbol, false);
  assert.deepEqual(o.series[0].data, [1, 3, 2]);
  assert.equal(o.tooltip.trigger, "axis");
});
test("Selected shows the dot on EVERY series at the selected category", () => {
  const o = cart("line", [S("a"), S("b", [2, 2, 5])], sel({}, [2]));
  for (const s of lines(o)) { assert.equal(s.showSymbol, true); assert.deepEqual(dotted(s), [false, false, true], s.name); }
});
test("Selected on an area and on the lines of a combo (its bars are left alone)", () => {
  const a = cart("area", [S("v")], sel({}, [0])).series[0];
  assert.deepEqual(dotted(a), [true, false, false]); assert.ok(a.areaStyle);
  const c = cart("combo", [S("bars"), S("l1", [2, 2, 5]), S("l2", [3, 1, 4])], sel({}, [1]));
  assert.equal(c.series[0].type, "bar"); assert.equal(c.series[0].showSymbol, undefined); assert.deepEqual(c.series[0].data, [1, 3, 2]);
  for (const s of lines(c)) assert.deepEqual(dotted(s), [false, true, false], s.name);
  const bars = cart("combo", [S("bars"), S("b2", [2, 2, 5])], { ...sel({ secondaryType: "bar" }, [1]) });
  assert.deepEqual(JSON.parse(JSON.stringify(bars)).series.map((s) => s.type), ["bar", "bar"], "a combo with no lines has nothing to mark");
});
test("Selected on a long line (more than 60 points): only the selected points show a dot; Automatic shows none", () => {
  const data = many(80);
  const o = buildCartesian({ type: "line", categories: cats(80), series: [S("v", data)], ...sel({}, [5, 40]) });
  const s = o.series[0];
  assert.equal(s.showSymbol, true); assert.equal(s.showAllSymbol, true, "ECharts must not thin the selected dots");
  assert.deepEqual(dotted(s).flatMap((d, i) => (d ? [i] : [])), [5, 40]);
  assert.equal(buildCartesian({ type: "line", categories: cats(80), series: [S("v", data)], ...sel({}, []) }).series[0].showSymbol, false);
  assert.equal(golden.matrix.longLine.absent.series[0].showSymbol, false);
});
test("Selected keeps a lone value's dot with no selection, and adds the selected dot beside it", () => {
  const s = cart("line", [S("v", [1, 2, null, 4, null])], sel({}, [])).series[0];
  assert.equal(s.showSymbol, true); assert.deepEqual(dotted(s), [false, false, false, true, false]);
  const s2 = cart("line", [S("v", [1, 2, null, 4, null])], sel({}, [0])).series[0];
  assert.deepEqual(dotted(s2), [true, false, false, true, false]);
});
test("Selected beside Data labels: the labels keep their clear anchors, the selected dot shows", () => {
  const s = cart("line", [S("v")], sel({ dataLabels: true }, [1])).series[0];
  assert.equal(s.showSymbol, true); assert.deepEqual(dotted(s), [false, true, false]);
  assert.equal(s.label.show, true); assert.equal(s.label.formatter({ dataIndex: 0, value: 1 }), "1");
});
test("Selected is independent of Label marks: selecting marks for the dots does not change which labels are drawn", () => {
  const withLabels = cart("line", [S("v")], sel({ dataLabels: true, labelMarks: "minmax" }, [1], { labelMarks: { mode: "minmax" } })).series[0];
  assert.deepEqual([0, 1, 2].map((i) => withLabels.label.formatter({ dataIndex: i, value: [1, 3, 2][i] })), ["1", "3", ""], "Min & max labels the lowest and highest, as ever");
  assert.deepEqual(dotted(withLabels), [false, true, false]);
  const labelSelected = cart("line", [S("v")], { format: { dataLabels: true, labelMarks: "selected", lineMarkers: "selected" }, labelMarks: { mode: "selected", selected: [2], recent: [] }, selectedMarks: [1] }).series[0];
  assert.deepEqual([0, 1, 2].map((i) => labelSelected.label.formatter({ dataIndex: i, value: 0 })), ["", "", "0"], "labels follow Label marks' own selection");
  assert.deepEqual(dotted(labelSelected), [false, true, false], "dots follow Line markers' selection");
});
test("a stepped line takes Selected like a straight one", () => {
  const s = cart("line", [S("v")], sel({ lineStyle: "step" }, [2])).series[0];
  assert.equal(s.step, "end"); assert.deepEqual(dotted(s), [false, false, true]);
});
test("Selected keeps a colour measure's colours on the dot and on the hover dot, and a mark border", () => {
  const s = cart("line", [S("v")], { colorValues: [-1, 5, 9], colorName: "q", ...sel({ markBorder: "thin" }, [1]) }).series[0];
  const plain = cart("line", [S("v")], { colorValues: [-1, 5, 9], colorName: "q", format: { markBorder: "thin" } }).series[0];
  assert.deepEqual(s.data[1], plain.data[1], "the selected dot is the item it always was");
  assert.equal(s.data[0].itemStyle.color, "transparent"); assert.equal(s.data[0].itemStyle.borderColor, "transparent");
  assert.equal(s.data[0].emphasis.itemStyle.color, plain.data[0].itemStyle.color);
});
test("a measure cue and a Size-sized marker are data: Selected leaves them (the control is disabled with the reason)", () => {
  const cued = cart("line", [S("a"), S("b", [2, 2, 5])], { colorValues: [-1, 5, 9], colorName: "qty", ...sel({}, [1]) });
  assert.deepEqual(JSON.parse(JSON.stringify(cued)).series, golden.matrix.cued.absent.series.map((s) => s));
  const stepSized = cart("line", [S("v")], { sizes: [10, 20, 30], sizeName: "qty", ...sel({ lineStyle: "step" }, [1]) });
  assert.deepEqual(JSON.parse(JSON.stringify(stepSized)), golden.matrix.sizeStep.absent);
  const areaSized = cart("area", [S("v")], { sizes: [10, 20, 30], sizeName: "qty", ...sel({}, [1]) });
  assert.deepEqual(JSON.parse(JSON.stringify(areaSized)), golden.matrix.sizeArea.absent);
});
test("a Size-thickness line takes Selected: the thickness overlay is drawn, the dots ride on top", () => {
  const o = cart("line", [S("v")], { sizes: [10, 20, 30], sizeName: "qty", ...sel({}, [1]) });
  assert.deepEqual(dotted(lines(o)[0]), [false, true, false]);
  assert.ok(o.series.some((s) => s.type === "custom"));
});
test("mark opacity still covers the selected dot (no item opacity overrides it)", async () => {
  const { applyMarkOpacity } = await import("../../src/DashboardBuilder/Features/Dashboard/mark-opacity-model.js");
  const o = applyMarkOpacity(cart("line", [S("v")], sel({ markOpacity: 50 }, [1])), 0.5).series[0];
  assert.equal(o.itemStyle.opacity, 0.5);
  assert.ok(o.data.every((d) => !isObj(d) || d.itemStyle?.opacity === undefined));
});
test("a comparison line keeps no dots whatever is selected", () => {
  const o = cart("line", [S("v"), { name: "v (prior)", data: [2, 2, 2], compare: true }], sel({}, [1]));
  assert.equal(o.series[1].showSymbol, false); assert.deepEqual(dotted(o.series[0]), [false, true, false]);
});
test("Selected keeps every point on a big canvas chart: no LTTB sampling, as for All", () => {
  const spec = (f) => ({ type: "line", categories: cats(80), series: [S("v", many(80))], format: f });
  for (const [mode, expect] of [["selected", null], ["all", null], ["none", "lttb"], ["auto", "lttb"]]) {
    const sp = spec({ lineMarkers: mode }); const o = buildCartesian({ ...sp, selectedMarks: [3] }); tuneForSize(o, sp);
    assert.equal(o.series[0].sampling ?? null, expect, mode);
  }
});

// ---- the Format control ----------------------------------------------------------------------------------------------------
const specs = (over = {}) => lineControlSpecs({ type: "line", shelfCount: 1, ...over });
test("Line markers offers Selected, titled so: no selection = no markers", () => {
  const m = specs()[1];
  assert.deepEqual(m.choices, LINE_MARKER_CHOICES); assert.equal(m.value, "auto"); assert.equal(m.note, null);
  const s = specs({ format: { lineMarkers: "selected" } })[1];
  assert.equal(s.value, "selected"); assert.equal(s.disabled, null);
  assert.match(s.note, /no selection = no markers/);
  assert.match(s.note, /lone/, "a lone value keeps its dot: say so");
  assert.match(s.note, /Marker size and Marker shape style the markers that show/, "they DO style the selected dots");
  assert.doesNotMatch(s.note, /no other effect/);
});
test("Selected is disabled with the reason where Size or a cue draws the markers (as for None), and reads All", () => {
  const sized = specs({ type: "area", hasSize: true, format: { lineMarkers: "selected" } })[1];
  assert.match(sized.disabled, /Size/); assert.equal(sized.value, "all"); assert.equal(sized.note, null);
  const cued = specs({ shelfCount: 2, colourMeasure: true, format: { lineMarkers: "selected" } })[1];
  assert.match(cued.disabled, /measure/); assert.equal(cued.value, "all");
  const bars = specs({ type: "combo", shelfCount: 3, format: { secondaryType: "bar", lineMarkers: "selected" } })[1];
  assert.match(bars.disabled, /no lines/);
});
test("Selected's choice is disabled with the reason where a click could never select (the other choices stay usable); a stored Selected says why", () => {
  const off = specs({ selectReason: "No dimension." })[1];
  assert.deepEqual(off.choices, LINE_MARKER_CHOICES, "every choice is still listed");
  assert.deepEqual(off.disabledChoices, { selected: "No dimension." }); assert.equal(off.disabled, null, "the control itself stays live: Automatic, All and None still work");
  const stored = specs({ selectReason: "No dimension.", format: { lineMarkers: "selected" } })[1];
  assert.equal(stored.value, "selected"); assert.equal(stored.note, "No dimension.");
  assert.equal(specs()[1].disabledChoices, null);
  assert.match(specs({ selectNote: "Auto may group.", format: { lineMarkers: "selected" } })[1].note, /no selection = no markers.* Auto may group\./);
  assert.equal(specs({ selectNote: "Auto may group." })[1].note, null, "the caveat rides only with a stored Selected");
});
test("selectGate: no dimension, a calculated dimension, an active drill, a date part and an explicit Group dates grain each give a reason; Auto and Exact do not", () => {
  const ok = { hasDim: true, refusal: null, drilling: false, firstKeyGrouped: false, firstKeyDated: false, dateBucket: "auto" };
  assert.equal(selectGate(ok), null);
  assert.match(selectGate({ ...ok, hasDim: false }), /Add a dimension/);
  assert.equal(selectGate({ ...ok, refusal: "A calculated field can't be selected." }), "A calculated field can't be selected.");
  assert.match(selectGate({ ...ok, drilling: true }), /drill hierarchy is active/);
  assert.match(selectGate({ ...ok, firstKeyGrouped: true }), /date part/);
  assert.match(selectGate({ ...ok, firstKeyDated: true, dateBucket: "month" }), /Group dates is Month.*Group dates → Exact/);
  assert.equal(selectGate({ ...ok, firstKeyDated: true, dateBucket: "auto" }), null);
  assert.equal(selectGate({ ...ok, firstKeyDated: true, dateBucket: "exact" }), null);
  assert.equal(selectGate({ ...ok, dateBucket: "month" }), null, "a grain on a first field that is not a date is not a reason");
  assert.match(selectNote({ ...ok, firstKeyDated: true, dateBucket: "auto" }), /Group dates → Auto may group/);
  assert.equal(selectNote({ ...ok, firstKeyDated: true, dateBucket: "exact" }), null); assert.equal(selectNote(ok), null);
});
test("selectDrawnReason: a read-only view says nothing; a date-grouped first key, an active drill and a cast field on a dashboard widget each say why", () => {
  const x = { select: true, hasDim: true, bucketedKey: null, drilling: false, cast: false };
  assert.equal(selectDrawnReason(x), null);
  assert.equal(selectDrawnReason({ ...x, select: false, bucketedKey: 0 }), null);
  assert.match(selectDrawnReason({ ...x, bucketedKey: 0 }), /Selected.*dates are grouped into periods.*Group dates → Exact/);
  assert.equal(selectDrawnReason({ ...x, bucketedKey: 1 }), null, "only the first key (the one a click selects) matters");
  assert.match(selectDrawnReason({ ...x, drilling: true }), /drill hierarchy is active/);
  assert.match(selectDrawnReason({ ...x, cast: true }), /Selected.*data type cast/);
  assert.match(selectDrawnReason({ ...x, hasDim: false }), /Add a dimension/);
});
test("the controls' inputs carry the select gate: a dimension that is a real column, no drill, no date grain", () => {
  const dim = { db: "d", table: "t", column: "region", category: "text" };
  const date = { db: "d", table: "t", column: "placed", category: "temporal" };
  const meas = { db: "d", table: "t", column: "a", category: "numeric", agg: "sum" };
  const base = { ...emptySheet(), chartType: "line", rows: [meas] };
  assert.deepEqual(lineControlInputs({ ...base, columns: [dim] }).select, { reason: null, note: null });
  assert.match(lineControlInputs({ ...base, columns: [] }).select.reason, /Add a dimension/);
  assert.match(lineControlInputs({ ...base, columns: [dim], drill: { levels: [dim, { ...dim, column: "channel" }], depth: 0, path: [] } }).select.reason, /drill/);
  const dated = { ...base, columns: [date] };
  assert.deepEqual([lineControlInputs(dated).select.reason, /Auto may group/.test(lineControlInputs(dated).select.note)], [null, true], "Auto: a note, not a reason");
  assert.match(lineControlInputs({ ...dated, format: { ...dated.format, dateBucket: "month" } }).select.reason, /Group dates is Month/);
  assert.equal(lineControlInputs({ ...dated, format: { ...dated.format, dateBucket: "exact" } }).select.reason, null);
  assert.match(lineControlInputs({ ...base, columns: [{ ...date, datePart: "month" }] }).select.reason, /date part/);
  assert.equal(lineControlInputs({ ...base, columns: [dim], format: { ...base.format, dateBucket: "month" } }).select.reason, null);
});
test("the panel builds the select with Selected and titles it with the note", () => {
  const dim = { db: "d", table: "t", column: "region", category: "text" };
  const meas = { db: "d", table: "t", column: "a", category: "numeric", agg: "sum" };
  const sheet = { ...emptySheet(), chartType: "line", columns: [dim], rows: [meas], format: { ...defaultFormat(), lineMarkers: "selected" } };
  const built = [];
  const fmtSelect = (label, choices, value) => { const select = { title: "", setAttribute() {}, disabled: false }; const field = { querySelector: () => select, title: "" }; built.push({ label, choices, value, select, field }); return field; };
  wireLineControls({ append() {} }, sheet, fmtSelect, () => {});
  const m = built.find((b) => b.label === "Line markers");
  assert.equal(m.value, "selected"); assert.deepEqual(m.choices.map((c) => c[0]), ["auto", "selected", "all", "none"]);
  assert.match(m.select.title, /no selection = no markers/); assert.equal(m.select.disabled, false);
});

test("the panel disables the Selected option with its reason where a click could never select; the other options stay enabled", () => {
  const dim = { db: "d", table: "t", column: "region", category: "text" };
  const meas = { db: "d", table: "t", column: "a", category: "numeric", agg: "sum" };
  const sheet = { ...emptySheet(), chartType: "line", columns: [dim], rows: [meas], drill: { levels: [dim, { ...dim, column: "channel" }], depth: 0, path: [] }, format: { ...defaultFormat(), lineMarkers: "selected" } };
  const options = ["auto", "selected", "all", "none"].map((value) => ({ value, disabled: false, title: "" }));
  const fmtSelect = () => { const select = { title: "", options, setAttribute() {}, disabled: false }; return { querySelector: () => select, title: "" }; };
  const built = [];
  wireLineControls({ append: (f) => built.push(f) }, sheet, (label, ...rest) => { const f = fmtSelect(label, ...rest); f.label = label; return f; }, () => {});
  const byValue = Object.fromEntries(options.map((o) => [o.value, o]));
  assert.equal(byValue.selected.disabled, true); assert.match(byValue.selected.title, /drill hierarchy/);
  for (const v of ["auto", "all", "none"]) assert.equal(byValue[v].disabled, false, v);
  assert.match(built[1].querySelector().title, /drill hierarchy/, "a stored Selected: the control's title says why it draws nothing");
  assert.equal(built[1].querySelector().disabled, false, "the control itself stays usable");
});

// ---- saved workbooks -------------------------------------------------------------------------------------------------------
const roundTrip = (format) => {
  const sheet = { ...emptySheet(), chartType: "line", format };
  const state = { entities: new Map(), relationships: [], tabs: [{ id: "ws#1", kind: "worksheet", name: "D", sheet }], active: { kind: "worksheet", id: "ws#1" } };
  return parseWorkbook(JSON.stringify(serializeWorkbook(state)));
};
test("workbook: Selected round-trips; unknown values are still dropped and reported; older values are unchanged", () => {
  const r = roundTrip({ ...defaultFormat(), lineMarkers: "selected" });
  assert.equal(r.worksheets[0].sheet.format.lineMarkers, "selected"); assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
  for (const v of ["all", "none"]) assert.equal(roundTrip({ ...defaultFormat(), lineMarkers: v }).worksheets[0].sheet.format.lineMarkers, v);
  for (const v of ["Selected", "selection", "sometimes", 3, true]) {
    const bad = roundTrip({ ...defaultFormat(), lineMarkers: v });
    assert.equal("lineMarkers" in bad.worksheets[0].sheet.format, false, String(v));
    assert.ok(bad.issues.some((i) => /line markers .* — reset to Automatic/.test(i)), `${v}: ${JSON.stringify(bad.issues)}`);
  }
  const none = roundTrip({ ...defaultFormat() });
  assert.equal("lineMarkers" in none.worksheets[0].sheet.format, false); assert.equal(none.issues.length, 0);
});

// ---- the whole drawing -----------------------------------------------------------------------------------------------------
const plan = { metaOf: () => ({}), calculations: [], nameOf: (f) => f.column };
const dim = (column) => ({ db: "shop", table: "orders", column, category: "text" });
const meas = (column) => ({ db: "shop", table: "orders", column, category: "numeric", agg: "sum" });
const sheet = (over = {}) => ({ columns: [dim("region")], rows: [meas("amount")], color: [], filters: [], chartType: "line", sort: null, selection: null, drill: null,
  marks: { size: null, label: null, detail: [], tooltip: [], shape: null, path: null, angle: null }, pages: null, format: {}, period: null, ...over });
const result = (rows) => ({ rowDimensions: ["region"], columnDimensions: [], measures: ["sum(amount)"], rows: rows.map(([k, v]) => ({ keys: [k], values: [v] })), truncated: false });
const REGIONS = [["EU", 3], ["US", 9], ["JP", 1], ["UK", 9]];
const draw = (sh, res = result(REGIONS), options = {}) => { const c = fakeEl(); renderWorksheet(c, sh, res, null, { plan, ...options }); return { c, o: insts.at(-1).lastSet }; };
const sk = (value) => ({ db: "shop", table: "orders", column: "region", value, label: `region = ${value}`, action: null });
const dotsOf = (o, si = 0) => dotted(o.series[si]).flatMap((d, i) => (d ? [i] : []));

test("drawing: with no selection a Selected line shows no marker; the worksheet's click selection shows that mark's dot", () => {
  const none = draw(sheet({ format: { lineMarkers: "selected" } })).o;
  assert.equal(none.series[0].showSymbol, false);
  const one = draw(sheet({ format: { lineMarkers: "selected" }, selection: sk("JP") })).o;
  assert.equal(one.series[0].showSymbol, true); assert.deepEqual(dotsOf(one), [2]);
});
test("drawing: a dashboard widget's cross-filter selection shows its dot; the worksheet's own selection is not needed", () => {
  const o = draw(sheet({ format: { lineMarkers: "selected" } }), result(REGIONS), { selected: sk("US") }).o;
  assert.deepEqual(dotsOf(o), [1]);
});
test("drawing: a selection on another column selects nothing here", () => {
  const o = draw(sheet({ format: { lineMarkers: "selected" } }), result(REGIONS), { selected: { db: "shop", table: "orders", column: "country", value: "US" } }).o;
  assert.equal(o.series[0].showSymbol, false);
});
test("drawing: selecting works with no Data labels and with Label marks left on All (it does not depend on Label marks)", () => {
  for (const format of [{ lineMarkers: "selected" }, { lineMarkers: "selected", labelMarks: "all" }, { lineMarkers: "selected", labelMarks: "minmax" }]) {
    assert.deepEqual(dotsOf(draw(sheet({ format, selection: sk("EU") })).o), [0], JSON.stringify(format));
  }
});
test("drawing: Label marks Selected still labels the selected mark exactly as before while Line markers is Selected", () => {
  const { o } = draw(sheet({ format: { dataLabels: true, labelMarks: "selected", lineMarkers: "selected" }, selection: sk("JP") }));
  assert.deepEqual([0, 1, 2, 3].map((i) => o.series[0].label.formatter({ dataIndex: i, value: 0 })), ["", "", "0", ""]);
  assert.deepEqual(dotsOf(o), [2]);
});
test("drawing: Label marks Selected with Line markers not Selected does not change a line's markers", () => {
  const f = { dataLabels: true, labelMarks: "selected" };
  const { o } = draw(sheet({ format: f, selection: sk("JP") }));
  assert.equal(o.series[0].showSymbol, true);
  assert.ok(o.series[0].data.every((d) => !isObj(d)), "Automatic markers: no item is made clear");
});
test("drawing: an area and a line with several measures", () => {
  const two = sheet({ chartType: "area", rows: [meas("amount"), meas("qty")], format: { lineMarkers: "selected" }, selection: sk("UK") });
  const res = { ...result(REGIONS), measures: ["sum(amount)", "sum(qty)"], rows: REGIONS.map(([k, v]) => ({ keys: [k], values: [v, v + 1] })) };
  const o = draw(two, res).o;
  assert.deepEqual([dotsOf(o, 0), dotsOf(o, 1)], [[3], [3]]);
});
test("drawing: a colour split — every member's point at the selected category shows its dot", () => {
  const split = sheet({ columns: [dim("region"), dim("channel")], color: [dim("channel")], format: { lineMarkers: "selected" }, selection: sk("US") });
  const res = { rowDimensions: ["region", "channel"], columnDimensions: [], measures: ["sum(amount)"],
    rows: [["EU", "web", 1], ["EU", "shop", 2], ["US", "web", 3], ["US", "shop", 4], ["JP", "web", 5]].map(([r, ch, v]) => ({ keys: [r, ch], values: [v] })), truncated: false };
  const o = draw(split, res).o;
  const ls = o.series.filter((s) => s.type === "line");
  assert.equal(ls.length, 2);
  for (const s of ls) { assert.equal(s.showSymbol, true, s.name); assert.deepEqual(dotted(s).flatMap((d, i) => (d ? [i] : [])), [1], s.name); }
  const none = draw({ ...split, selection: null }, res).o.series.filter((s) => s.type === "line");
  for (const s of none) assert.equal(s.showSymbol, false, `${s.name}: nothing selected`);
});
const hints = (c) => c.children.filter((x) => x.className === "ws-hint").map((x) => x.textContent);
const dated = (over = {}) => sheet({ columns: [{ ...dim("placed"), category: "temporal" }], format: { lineMarkers: "selected" }, ...over });
test("drawing: a date-grouped first key (the server grouped the dates) cannot be clicked: a hint above the chart says why and names Group dates → Exact", () => {
  const res = { ...result(REGIONS), bucket: { key: 0, grain: "month" } };
  const { c, o } = draw(dated(), res);
  assert.equal(hints(c).length, 1); assert.match(hints(c)[0], /Selected.*dates are grouped into periods.*Group dates → Exact/);
  assert.equal(o.series[0].showSymbol, false);
  const plain = draw(dated(), result(REGIONS));
  assert.deepEqual(hints(plain.c), [], "Exact (no grouping happened): no hint");
});
test("drawing: a date part as the first key says why too, in the colour split as well", () => {
  const part = { ...dim("placed"), category: "temporal", datePart: "month" };
  const { c } = draw(sheet({ columns: [part], format: { lineMarkers: "selected" } }), result([["1", 3], ["2", 4]]));
  assert.match(hints(c).join(" "), /Selected.*grouped into periods/);
  const split = sheet({ columns: [dim("region"), dim("channel")], color: [dim("channel")], format: { lineMarkers: "selected" } });
  const res = { rowDimensions: ["region", "channel"], columnDimensions: [], measures: ["sum(amount)"], rows: [["EU", "web", 1]].map(([r, ch, v]) => ({ keys: [r, ch], values: [v] })), truncated: false, bucket: { key: 0, grain: "day" } };
  assert.match(hints(draw(split, res).c).join(" "), /Selected.*grouped into periods/);
});
test("drawing: an active drill hierarchy in the editor says a click steps down; a dashboard widget (select-only) on the same sheet selects and says nothing", () => {
  const drill = { levels: [dim("region"), dim("channel")], depth: 0, path: [] };
  const ed = draw(sheet({ format: { lineMarkers: "selected" }, drill }), result(REGIONS), { interactive: true, hooks: {} });
  assert.match(hints(ed.c).join(" "), /drill hierarchy is active/);
  const widget = draw(sheet({ format: { lineMarkers: "selected" }, drill }), result(REGIONS), { interactive: "select", hooks: {} });
  assert.deepEqual(hints(widget.c), []);
});
test("drawing: a field with a data type cast on a dashboard widget cannot start a cross-filter: a hint says so; the editor does not mind", () => {
  const castPlan = { ...plan, metaOf: (f) => (f.column === "region" ? { cast: "Int32" } : {}) };
  const w = draw(sheet({ format: { lineMarkers: "selected" } }), result(REGIONS), { plan: castPlan, interactive: "select", hooks: {} });
  assert.match(hints(w.c).join(" "), /data type cast/);
  const ed = draw(sheet({ format: { lineMarkers: "selected" } }), result(REGIONS), { plan: castPlan, interactive: true, hooks: {} });
  assert.deepEqual(hints(ed.c), []);
});
test("drawing: no hint where a click selects, where the choice is not Selected, or on a read-only view", () => {
  assert.deepEqual(hints(draw(sheet({ format: { lineMarkers: "selected" } })).c), []);
  assert.deepEqual(hints(draw(dated({ format: { lineMarkers: "all" } }), { ...result(REGIONS), bucket: { key: 0, grain: "month" } }).c), []);
  assert.deepEqual(hints(draw(dated(), { ...result(REGIONS), bucket: { key: 0, grain: "month" } }, { interactive: false }).c), [], "a read-only view says nothing");
});
test("drawing: a bar chart is untouched by a stored Line markers Selected", () => {
  const a = draw(sheet({ chartType: "bar", format: { lineMarkers: "selected" }, selection: sk("EU") })).o;
  const b = draw(sheet({ chartType: "bar", selection: sk("EU") })).o;
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});
test("drawing: the same chart keeps its selection for an export: the option on the instance carries the selected dot", () => {
  draw(sheet({ format: { lineMarkers: "selected" }, selection: sk("US") }));
  const inst = insts.at(-1);
  assert.deepEqual(dotsOf(inst.lastSet), [1], "exports read this very instance");
});
