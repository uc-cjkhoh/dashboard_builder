import { test } from "node:test";
import assert from "node:assert/strict";
import { sizeFractions, barThickness, markerSizeFor } from "../../src/DashboardBuilder/Features/Dashboard/mark-channel-model.js";
import {
  SIZE_SCALE_TYPES, ZERO_BASED_TYPES, sizeScaleOf, sizeScaleIsDefault, sizeRangeError, cleanSizeScale, measureShares, memberOrder, memberShares, memberRanks,
  sizeLegendText, lineWidthFor, textStepFor,
} from "../../src/DashboardBuilder/Features/Dashboard/size-scale-model.js";

// Size from a dimension, and Edit Sizes (range, From zero, Reversed): the pure maths (no DOM).
const DEFAULT = sizeScaleOf({});

test("with nothing stored, the shares are exactly what the charts drew before (span for bars / markers / tiles, zero-based for bubbles)", () => {
  const v = [10, 20, 30, null, 5];
  assert.deepEqual(measureShares(v, { zero: false, scale: DEFAULT }), sizeFractions(v), "span mode == sizeFractions");
  assert.deepEqual(measureShares([5, 5], { zero: false, scale: DEFAULT }), [1, 1]);
  // the bubble rule of chart.js's old sizeScaler: min(…, 0) .. max(…, 1)
  const old = (vals) => { const min = Math.min(...vals, 0), max = Math.max(...vals, 1), span = (max - min) || 1; return vals.map((x) => (x - min) / span); };
  for (const vals of [[3, 41, 9], [0.2, 0.5], [-4, 6, 0], [7], [0, 0]]) assert.deepEqual(measureShares(vals, { zero: true, point: true, scale: DEFAULT }), old(vals), JSON.stringify(vals));
  assert.equal(barThickness(measureShares([1, 3], { scale: DEFAULT })[1], 100), barThickness(sizeFractions([1, 3])[1], 100));
  assert.equal(markerSizeFor(measureShares([1, 3], { scale: DEFAULT })[0]), 6);
});
test("the setting's defaults: smallest 0, largest 100, from zero follows the chart, not reversed", () => {
  assert.deepEqual(DEFAULT, { smallest: 0, largest: 100, fromZero: null, reversed: false });
  assert.equal(sizeScaleIsDefault({}), true);
  assert.equal(sizeScaleIsDefault({ sizeScale: { reversed: true } }), false);
  assert.deepEqual(sizeScaleOf({ sizeScale: { smallest: 20, largest: 80, fromZero: false, reversed: true } }), { smallest: 20, largest: 80, fromZero: false, reversed: true });
  assert.deepEqual(sizeScaleOf({ sizeScale: { smallest: 90, largest: 10 } }), { smallest: 0, largest: 100, fromZero: null, reversed: false }, "a bad stored pair reads as the default");
  assert.deepEqual(sizeScaleOf({ sizeScale: "x" }), DEFAULT);
  assert.deepEqual([...ZERO_BASED_TYPES].sort(), ["circle", "scatter", "square"]);
  for (const t of ["scatter", "bar", "line", "area", "table", "text"]) assert.equal(SIZE_SCALE_TYPES.has(t), true, t);
  assert.equal(SIZE_SCALE_TYPES.has("treemap"), false, "a tile's area is its value: no range");
});
test("From zero: the span starts at 0 (or the smallest negative); off, at the data's smallest", () => {
  assert.deepEqual(measureShares([10, 20, 40], { zero: true, scale: DEFAULT }), [0.25, 0.5, 1]);
  assert.deepEqual(measureShares([10, 20, 40], { zero: false, scale: DEFAULT }), [0, 1 / 3, 1]);
});
test("From zero off a point chart has no floor of 1: values all below 1 still span the full range (bubbles keep today's floor)", () => {
  assert.deepEqual(measureShares([0.01, 0.02, 0.05], { zero: true, scale: DEFAULT }).map((x) => Math.round(x * 100) / 100), [0.2, 0.4, 1]);
  assert.deepEqual(measureShares([0.2, 0.5], { zero: true, point: true, scale: DEFAULT }), [0.2, 0.5], "bubbles: max(…, 1)");
  assert.deepEqual(measureShares([-4, 6, 0], { zero: true, scale: DEFAULT }), [0, 1, 0.4]);
  assert.deepEqual(measureShares([0, 0], { zero: true, scale: DEFAULT }), [0, 0]);
});
test("Reversed: the largest value gets the smallest mark; all equal (nothing to reverse) stays full", () => {
  const rev = { ...DEFAULT, reversed: true };
  assert.deepEqual(measureShares([10, 20, 30], { zero: false, scale: rev }), [1, 0.5, 0]);
  assert.deepEqual(measureShares([5, 5], { zero: false, scale: rev }), [1, 1]);
  assert.deepEqual(measureShares([10, null, 30], { zero: false, scale: rev }), [1, null, 0]);
});
test("Smallest / largest keep the shares inside that part of the size range", () => {
  const s = { ...DEFAULT, smallest: 20, largest: 60 };
  assert.deepEqual(measureShares([0, 5, 10], { zero: false, scale: s }).map((x) => Math.round(x * 100) / 100), [0.2, 0.4, 0.6]);
  const both = { smallest: 20, largest: 60, fromZero: null, reversed: true };
  assert.deepEqual(measureShares([0, 10], { zero: false, scale: both }).map((x) => Math.round(x * 100) / 100), [0.6, 0.2]);
});
test("sizeRangeError: whole percent 0-100, smallest below largest", () => {
  assert.equal(sizeRangeError(0, 100), null);
  assert.equal(sizeRangeError(10, 90), null);
  assert.match(sizeRangeError(50, 50), /below/);
  assert.match(sizeRangeError(-1, 100), /whole percentages/);
  assert.match(sizeRangeError(0, 101), /whole percentages/);
  assert.match(sizeRangeError(0.5, 100), /whole percentages/);
});
test("cleanSizeScale: only what differs from the default is kept; a bad part is dropped and reported, never clamped", () => {
  assert.deepEqual(cleanSizeScale(undefined), { value: null, issues: [] });
  assert.deepEqual(cleanSizeScale(null), { value: null, issues: [] });
  assert.deepEqual(cleanSizeScale({}), { value: null, issues: [] });
  assert.deepEqual(cleanSizeScale({ smallest: 0, largest: 100, reversed: false }), { value: null, issues: [] }, "all defaults = absent");
  assert.deepEqual(cleanSizeScale({ smallest: 20, largest: 80, fromZero: true, reversed: true }), { value: { smallest: 20, largest: 80, fromZero: true, reversed: true }, issues: [] });
  assert.deepEqual(cleanSizeScale({ fromZero: false }), { value: { fromZero: false }, issues: [] }, "an explicit Off is kept (it differs from a point chart's default)");
  const bad = cleanSizeScale({ smallest: 150, largest: 70.5, reversed: "yes", extra: 1 });
  assert.equal(bad.value, null);
  assert.equal(bad.issues.length, 4);
  assert.match(bad.issues.join(" "), /smallest size "150"/);
  assert.match(bad.issues.join(" "), /largest size "70.5"/);
  assert.match(bad.issues.join(" "), /reversed must be on or off/);
  assert.match(bad.issues.join(" "), /"extra" is unknown/);
  const flat = cleanSizeScale({ smallest: 70, largest: 30 });
  assert.equal(flat.value, null);
  assert.match(flat.issues[0], /not below/);
  assert.match(cleanSizeScale("big").issues[0], /object/);
  assert.match(cleanSizeScale([1]).issues[0], /object/);
});
test("memberOrder: numbers by value, text by locale, no member last; first-seen duplicates collapse", () => {
  assert.deepEqual(memberOrder(["b", "a", "b", null, "c"]).map((m) => m.raw), ["a", "b", "c", null]);
  assert.deepEqual(memberOrder([10, 9, 100]).map((m) => m.raw), [9, 10, 100]);
  assert.deepEqual(memberOrder([9, "10", "a", 100]).map((m) => m.raw), ["10", 100, 9, "a"], "mixed numbers and text: locale for every pair (transitive)");
  assert.deepEqual(memberOrder([9, "10", 100]).map((m) => m.raw), [9, "10", 100], "all numeric: by value");
  assert.deepEqual(memberOrder(["2024-02", "2024-01"]).map((m) => m.raw), ["2024-01", "2024-02"]);
});
test("memberRanks / memberShares: each member a step, spread evenly smallest to largest; one member is full size; skipped rows stay null", () => {
  const { ranks, order } = memberRanks(["b", "a", "c", "a", undefined]);
  assert.deepEqual(ranks, [1, 0, 2, 0, null]);
  assert.equal(order.length, 3);
  assert.deepEqual(memberShares(ranks, 3, DEFAULT), [0.5, 0, 1, 0, null]);
  assert.deepEqual(memberShares([0, 0], 1, DEFAULT), [1, 1]);
  assert.deepEqual(memberShares(ranks, 3, { ...DEFAULT, reversed: true }), [0.5, 1, 0, 1, null]);
  assert.deepEqual(memberShares([0, 0], 1, { ...DEFAULT, reversed: true }), [1, 1], "a lone member is not reversed");
  assert.deepEqual(memberShares([0, 1], 2, { ...DEFAULT, smallest: 50 }), [0.5, 1]);
});
test("sizeLegendText: the field and its ends in words; members name the smallest and largest step; reversed says so", () => {
  const fmtVal = (v) => String(v);
  assert.equal(sizeLegendText("sum qty", { range: { min: 3, max: 41 }, fmtVal }), "Size: sum qty (3 to 41)");
  assert.equal(sizeLegendText("sum qty", { range: { min: 3, max: 41 }, fmtVal, reversed: true }), "Size: sum qty (3 to 41, reversed)");
  assert.equal(sizeLegendText("region", { members: ["APAC", "EU", "US"] }), "Size: region (APAC to US, 3 steps)");
  assert.equal(sizeLegendText("region", { members: ["APAC"] }), "Size: region (APAC)");
  assert.equal(sizeLegendText("region", { members: ["APAC", "US"], reversed: true }), "Size: region (APAC to US, 2 steps, reversed)");
});
test("lineWidthFor: 2..12 px by share; a missing size is the thinnest. textStepFor: body / lead / title by thirds", () => {
  assert.equal(lineWidthFor(0), 2); assert.equal(lineWidthFor(1), 12); assert.equal(lineWidthFor(null), 2); assert.equal(lineWidthFor(0.5), 7);
  assert.deepEqual([0, 0.3, 0.34, 0.6, 0.67, 1, null].map(textStepFor), [0, 0, 1, 1, 2, 2, 0]);
});
