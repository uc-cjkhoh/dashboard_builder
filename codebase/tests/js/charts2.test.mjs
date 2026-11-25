// Axis synchronisation, secondary mark type, marker size and mark borders — pure models.
import { test } from "node:test";
import assert from "node:assert/strict";
import { syncRange, SECONDARY_CHOICES, secondaryKind, dualAxisOn, rightAxisTitle, dualAxisAllowed, seriesAxis } from "../../src/DashboardBuilder/Features/Dashboard/axis-sync-model.js";
import { buildCartesian } from "../../src/DashboardBuilder/Features/Dashboard/chart.js";
import { MARK_BORDER_CHOICES, MARK_BORDER_STOPS, markBorderError, borderWidthOf, storedBorder, markBorder, MARKER_SIZE, markerSizeError, markerSizeOr, MARKER_SHAPE_CHOICES, markerSymbol, edgeOr, strokeOf, BORDER_TYPES } from "../../src/DashboardBuilder/Features/Dashboard/mark-style-model.js";
import { defaultFormat, emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
import { parseWorkbook, serializeWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

test("syncRange: one nice range spanning every series, zero included for bars", () => {
  assert.deepEqual(syncRange([[10, 20, 30], [100, 450]]), { min: 0, max: 500 });
  assert.deepEqual(syncRange([[3], [7]]), { min: 0, max: 8 });
});
test("syncRange: negatives widen the low end", () => {
  assert.deepEqual(syncRange([[-30, 10], [5, 80]]), { min: -50, max: 100 });
  assert.deepEqual(syncRange([[-5, -1], [-9]]), { min: -10, max: 0 });
});
test("syncRange: all zero, single value, no data", () => {
  assert.deepEqual(syncRange([[0, 0], [0]]), { min: 0, max: 1 });
  assert.deepEqual(syncRange([[5], []]), { min: 0, max: 5 });
  assert.deepEqual(syncRange([[-5]]), { min: -5, max: 0 });
  assert.equal(syncRange([]), null);
  assert.equal(syncRange([[], []]), null);
});
test("syncRange: NaN, null, strings and Infinity are ignored", () => {
  assert.deepEqual(syncRange([[null, NaN, 10, undefined], [Infinity, "x", 40]]), { min: 0, max: 40 });
  assert.equal(syncRange([[null, NaN], [undefined]]), null);
});
test("syncRange: very different magnitudes share the big one; tiny values stay in range", () => {
  const r = syncRange([[0.001, 0.002], [1e9]]);
  assert.equal(r.min, 0); assert.ok(r.max >= 1e9 && r.max <= 1.2e9);
  const s = syncRange([[0.0003, 0.0007]]);
  assert.equal(s.min, 0); assert.ok(Math.abs(s.max - 0.0008) < 1e-12);
});
test("syncRange without a zero baseline keeps the data range, nice-rounded", () => {
  assert.deepEqual(syncRange([[103, 118], [121]], { zeroBaseline: false }), { min: 100, max: 125 });
});

test("secondary mark type: line, bar, area; anything else is line", () => {
  assert.deepEqual(SECONDARY_CHOICES.map((c) => c[0]), ["line", "bar", "area"]);
  assert.equal(secondaryKind("bar"), "bar"); assert.equal(secondaryKind("area"), "area");
  assert.equal(secondaryKind(undefined), "line"); assert.equal(secondaryKind("radar"), "line");
});

test("border thickness bar: 0 to 3 px in steps of 0.5, the readout is px, the stored value is none or the px", () => {
  assert.deepEqual(MARK_BORDER_STOPS.map(([px]) => px), [0, 0.5, 1, 1.5, 2, 2.5, 3]);
  assert.deepEqual(MARK_BORDER_STOPS.map(([, text]) => text), ["None", "0.5 px", "1 px", "1.5 px", "2 px", "2.5 px", "3 px"]);
  for (const [px] of MARK_BORDER_STOPS) { assert.equal(markBorderError(storedBorder(px)), null, String(px)); assert.equal(markBorder(storedBorder(px), "#abc").borderWidth, px, String(px)); }
  assert.equal(storedBorder(0), "none"); assert.equal(storedBorder(1.5), 1.5);
  assert.deepEqual(["thin", "medium", "thick", "none"].map(borderWidthOf), [1, 2, 3, 0]); // older files' keys still draw
  assert.deepEqual(["thin", "medium", "thick"].map(storedBorder), [1, 2, 3]);
  for (const v of [0, -1, 0.25, 3.5, 4, "1", "huge", null, NaN]) assert.ok(markBorderError(v), String(v));
});

test("mark border: none draws no stroke; thin and thick use the muted border colour", () => {
  assert.deepEqual(MARK_BORDER_CHOICES.map((c) => c[0]), ["none", "thin", "medium", "thick"]);
  assert.deepEqual(markBorder("none", "#abc"), { borderColor: "#abc", borderWidth: 0 });
  assert.deepEqual(markBorder("thin", "#abc"), { borderColor: "#abc", borderWidth: 1 });
  assert.deepEqual(markBorder("thick", "#abc"), { borderColor: "#abc", borderWidth: 3 });
  assert.equal(markBorder("bogus", "#abc").borderWidth, 0);
  assert.equal(markBorder(undefined, "#abc").borderWidth, 0);
});

test("marker size: 4–40 whole px; blank means automatic; out of range is rejected, not clamped", () => {
  assert.deepEqual([MARKER_SIZE.min, MARKER_SIZE.max], [4, 40]);
  assert.equal(markerSizeError(4), null); assert.equal(markerSizeError(40), null);
  for (const v of [3, 41, 0, -2, 7.5, NaN, "9"]) assert.match(markerSizeError(v), /4.*40/, String(v));
  assert.equal(markerSizeOr(12, 14), 12);
  assert.equal(markerSizeOr(null, 14), 14);
  assert.equal(markerSizeOr(99, 14), 14);
});

test("defaults and old workbooks: syncAxes off, secondaryType line, markerSize auto, markBorder none", () => {
  const f = defaultFormat();
  assert.equal(f.syncAxes, false); assert.equal(f.secondaryType, "line"); assert.equal(f.markerSize, null); assert.equal(f.markBorder, "none");
});

const roundTrip = (format) => {
  const sheet = { ...emptySheet(), chartType: "combo", format };
  const state = { entities: new Map(), relationships: [], tabs: [{ id: "ws#1", kind: "worksheet", name: "D", sheet }], active: { kind: "worksheet", id: "ws#1" } };
  return parseWorkbook(JSON.stringify(serializeWorkbook(state)));
};
test("workbook: valid settings round-trip; invalid ones reset with an issue; absent ones open unchanged", () => {
  const ok = roundTrip({ syncAxes: true, secondaryType: "area", markerSize: 20, markBorder: 2.5 });
  const f = ok.worksheets[0].sheet.format;
  assert.deepEqual([f.syncAxes, f.secondaryType, f.markerSize, f.markBorder], [true, "area", 20, 2.5]);
  const bad = roundTrip({ syncAxes: "yes", secondaryType: "radar", markerSize: 99, markBorder: "huge" });
  const g = bad.worksheets[0].sheet.format;
  assert.deepEqual([g.syncAxes, g.secondaryType, g.markerSize, g.markBorder], [false, "line", null, "none"]);
  assert.ok(bad.issues.length >= 4, JSON.stringify(bad.issues));
  const old = roundTrip({ target: 5 });
  assert.equal(old.issues.length, 0, JSON.stringify(old.issues));
  assert.equal(old.worksheets[0].sheet.format.markBorder, "none");
  const legacy = roundTrip({ markBorder: "thick" }); // an older file's key becomes its px
  assert.equal(legacy.issues.length, 0); assert.equal(legacy.worksheets[0].sheet.format.markBorder, 3);
  const off = roundTrip({ markBorder: 2.25 }); // off the step: reset, never rounded
  assert.equal(off.worksheets[0].sheet.format.markBorder, "none"); assert.ok(off.issues.some((i) => /border thickness/.test(i)), JSON.stringify(off.issues));
});

test("marker shape (line charts): four shapes, circle by default, unknown falls back to circle", () => {
  assert.deepEqual(MARKER_SHAPE_CHOICES.map((c) => c[0]), ["circle", "square", "diamond", "triangle"]);
  assert.equal(markerSymbol("square"), "rect");
  assert.equal(markerSymbol("diamond"), "diamond");
  assert.equal(markerSymbol("triangle"), "triangle");
  for (const v of ["circle", "bogus", undefined, null]) assert.equal(markerSymbol(v), "circle");
  assert.equal(defaultFormat().markerShape, "circle");
});

test("edgeOr: a chosen border wins over the chart's own default edge; none keeps the default", () => {
  const dflt = { borderColor: "#fff", borderWidth: 2 };
  assert.deepEqual(edgeOr("none", "#abc", dflt), dflt);
  assert.deepEqual(edgeOr(undefined, "#abc", dflt), dflt);
  assert.deepEqual(edgeOr("thin", "#abc", dflt), { borderColor: "#abc", borderWidth: 1 });
  assert.deepEqual(edgeOr("thick", "#abc", dflt), { borderColor: "#abc", borderWidth: 3 });
});

test("workbook: marker shape round-trips; an unknown one resets to circle with an issue", () => {
  assert.equal(roundTrip({ markerShape: "diamond" }).worksheets[0].sheet.format.markerShape, "diamond");
  const bad = roundTrip({ markerShape: "star" });
  assert.equal(bad.worksheets[0].sheet.format.markerShape, "circle");
  assert.ok(bad.issues.some((i) => /marker shape/.test(i)), J(bad.issues));
  assert.equal(roundTrip({}).worksheets[0].sheet.format.markerShape, "circle");
});
const J = JSON.stringify;

test("dual axis on line / area: needs the toggle and two measures; combo is always dual; other types never", () => {
  assert.equal(dualAxisAllowed("line"), true); assert.equal(dualAxisAllowed("area"), true);
  assert.equal(dualAxisAllowed("bar"), false); assert.equal(dualAxisAllowed("scatter"), false);
  assert.equal(dualAxisOn("line", { dualAxis: true }, 2), true);
  assert.equal(dualAxisOn("area", { dualAxis: true }, 3), true);
  assert.equal(dualAxisOn("line", { dualAxis: true }, 1), false);
  assert.equal(dualAxisOn("line", { dualAxis: false }, 2), false);
  assert.equal(dualAxisOn("line", {}, 2), false);
  assert.equal(dualAxisOn("bar", { dualAxis: true }, 2), false);
  assert.equal(dualAxisOn("combo", {}, 2), true);
});
test("rightAxisTitle names every right-axis measure", () => {
  assert.equal(rightAxisTitle(["Sales", "Profit", "Qty"]), "Profit, Qty");
  assert.equal(rightAxisTitle(["Sales"]), "");
});
test("dualAxis: default off; round-trips; invalid resets with an issue; old workbooks open clean", () => {
  assert.equal(defaultFormat().dualAxis, false);
  const f = roundTrip({ dualAxis: true }).worksheets[0].sheet.format;
  assert.equal(f.dualAxis, true);
  const bad = roundTrip({ dualAxis: "yes" });
  assert.equal(bad.worksheets[0].sheet.format.dualAxis, false);
  assert.ok(bad.issues.length >= 1);
  const old = roundTrip({ target: 5 });
  assert.equal(old.issues.length, 0); assert.equal(old.worksheets[0].sheet.format.dualAxis, false);
});

test("seriesAxis: dual line / area puts every measure after the first on the right; off or a single axis stays left", () => {
  assert.deepEqual([0, 1, 2].map((i) => seriesAxis(true, i)), [0, 1, 1]);
  assert.deepEqual([0, 1].map((i) => seriesAxis(false, i)), [0, 0]);
  assert.equal(seriesAxis(true, 0, true), 1);
});

// buildCartesian reads :root tokens; give it a bare document.
globalThis.document ??= { documentElement: {} };
globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => "" });
const S = (name, compare = false) => ({ name, data: [1, 2, 3], compare });
const build = (type, format, series, extra = {}) => buildCartesian({ type, categories: ["a", "b", "c"], series, format, ...extra });

test("buildCartesian: dual line maps series to axes (compare series follow their measure) and titles the right axis", () => {
  const o = build("line", { dualAxis: true }, [S("Sales"), S("Profit"), S("Qty"), S("Sales (prev)", true), S("Profit (prev)", true), S("Qty (prev)", true)]);
  assert.equal(o.yAxis.length, 2);
  assert.deepEqual(o.series.map((s) => s.yAxisIndex), [0, 1, 1, 0, 1, 1]);
  assert.equal(o.yAxis[1].name, "Profit, Qty");
  assert.ok(o.yAxis[1].nameTruncate.maxWidth > 0);
});
test("buildCartesian: dual off, one measure, a horizontal chart, or another type keep one axis", () => {
  assert.equal(build("line", {}, [S("A"), S("B")]).yAxis.length ?? 1, 1);
  assert.equal([].concat(build("line", { dualAxis: true }, [S("A")]).yAxis).length, 1);
  assert.equal([].concat(build("line", { dualAxis: true }, [S("A"), S("B")], { orientation: "horizontal" }).yAxis).length, 1);
  assert.equal([].concat(build("bar", { dualAxis: true }, [S("A"), S("B")]).yAxis).length, 1);
  const combo = build("combo", {}, [S("A"), S("B")]);
  assert.deepEqual(combo.series.map((s) => s.yAxisIndex), [0, 1]);
});
test("buildCartesian: a reference line and band sit on their own measure's series (its axis); trend stays on the first", () => {
  const analytics = { measure: 1, ref: { name: "Average (Profit)", value: 2 }, band: { from: 1, to: 3, name: "Band" }, trend: { name: "Trend", short: "T", data: [1, 2, 3] } };
  const o = build("line", { dualAxis: true }, [S("Sales"), S("Profit")], { analytics });
  assert.ok(!o.series[0].markLine && !o.series[0].markArea);
  assert.ok(o.series[1].markLine && o.series[1].markArea);
  assert.equal(o.series[1].yAxisIndex, 1);
  assert.equal(o.series[2].name, "Trend"); assert.equal(o.series[2].yAxisIndex, undefined);
  const dflt = build("line", { dualAxis: true }, [S("Sales"), S("Profit")], { analytics: { ref: { name: "R", value: 2 } } });
  assert.ok(dflt.series[0].markLine);
});

test("mark border reaches the P36 types: a custom shape gets a stroke, none keeps its look", () => {
  for (const t of ["histogram", "boxplot", "waterfall", "bullet", "gantt", "sankey", "bar", "pie"]) assert.ok(BORDER_TYPES.has(t), t);
  assert.ok(!BORDER_TYPES.has("gauge") && !BORDER_TYPES.has("line"));
  assert.deepEqual(strokeOf("none", "#abc"), {});
  assert.deepEqual(strokeOf(undefined, "#abc"), {});
  assert.deepEqual(strokeOf("thin", "#abc"), { stroke: "#abc", lineWidth: 1 });
  assert.deepEqual(strokeOf("thick", "#abc"), { stroke: "#abc", lineWidth: 3 });
});

import { borderInk, MARK_BORDER_COLOUR_CHOICES } from "../../src/DashboardBuilder/Features/Dashboard/mark-style-model.js";
test("border width Medium and border colour from palette tokens", () => {
  assert.deepEqual(MARK_BORDER_CHOICES.map((c) => c[0]), ["none", "thin", "medium", "thick"]);
  assert.equal(markBorder("medium", "#abc").borderWidth, 2);
  assert.deepEqual(strokeOf("medium", "#abc"), { stroke: "#abc", lineWidth: 2 });
  const c = { muted: "m", ink: "i", surface: "s", brand: "a" };
  assert.deepEqual(MARK_BORDER_COLOUR_CHOICES.map((x) => x[0]), ["muted", "ink", "surface", "accent"]);
  assert.deepEqual(["muted", "ink", "surface", "accent", undefined, "pink"].map((n) => borderInk(n, c)), ["m", "i", "s", "a", "m", "m"]);
});
test("workbook: markBorderColor optional, validated, rejected not clamped", () => {
  const ok = roundTrip({ markBorder: "medium", markBorderColor: "accent" });
  assert.deepEqual([ok.worksheets[0].sheet.format.markBorder, ok.worksheets[0].sheet.format.markBorderColor], [2, "accent"]);
  const bad = roundTrip({ markBorderColor: "#ff0000" });
  assert.equal(bad.worksheets[0].sheet.format.markBorderColor, "muted");
  assert.ok(bad.issues.some((i) => /border colour/.test(i)), JSON.stringify(bad.issues));
  const old = roundTrip({ markBorder: "thin" });
  assert.equal(old.issues.length, 0); assert.equal(old.worksheets[0].sheet.format.markBorderColor, undefined);
});
