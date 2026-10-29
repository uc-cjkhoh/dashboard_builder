import { test } from "node:test";
import assert from "node:assert/strict";
import { RAMP_CHOICES, rampColours, colourRangeError, rangeOf, mixHex } from "../../src/DashboardBuilder/Features/Dashboard/colour-scale-model.js";
import { sanitizeSheet } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { emptySheet, defaultFormat } from "../../src/DashboardBuilder/Features/Core/store.js";

const tk = { accent: "#aa0000", accentSoft: "#ffcccc", surface: "#ffffff", cat: ["#2a78d6", "#146f14", "#e87ba4", "#c99424", "#1eac79", "#de6e41", "#4a3aa7", "#df4d4c"] };

test("mixHex blends two hexes; non-hex input yields the second colour", () => {
  assert.equal(mixHex("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mixHex("#ffffff", "#2a78d6", 1), "#2a78d6");
  assert.equal(mixHex("rgb(1,2,3)", "#2a78d6", 0.5), "#2a78d6");
});
test("rampColours: brand uses the accent pair; hues blend surface toward the categorical slot; reverse swaps", () => {
  assert.deepEqual(rampColours("brand", tk, false), ["#ffcccc", "#aa0000"]);
  assert.deepEqual(rampColours("brand", tk, true), ["#aa0000", "#ffcccc"]);
  const blue = rampColours("blue", tk, false);
  assert.equal(blue[1], "#2a78d6");
  assert.notEqual(blue[0], blue[1]);
  assert.equal(rampColours("green", tk, false)[1], "#1eac79");
  assert.deepEqual(rampColours("nope", tk, false), ["#ffcccc", "#aa0000"]);
});
test("RAMP_CHOICES lists brand first", () => { assert.equal(RAMP_CHOICES[0][0], "brand"); assert.ok(RAMP_CHOICES.length >= 4); });
test("colourRangeError: both optional, finite, min < max", () => {
  assert.equal(colourRangeError(null, null), null);
  assert.equal(colourRangeError(0, null), null);
  assert.equal(colourRangeError(0, 10), null);
  assert.match(colourRangeError(5, 5), /less than/);
  assert.match(colourRangeError(9, 1), /less than/);
  assert.match(colourRangeError(NaN, 1), /number/);
});
test("rangeOf: the data span, overridden by the set ends (never inverted)", () => {
  assert.deepEqual(rangeOf([2, 8], null, null), { min: 2, max: 8 });
  assert.deepEqual(rangeOf([2, 8], 0, null), { min: 0, max: 8 });
  assert.deepEqual(rangeOf([2, 8], null, 5), { min: 2, max: 5 });
  assert.deepEqual(rangeOf([2, 8], 10, null), { min: 10, max: 11 });
  assert.deepEqual(rangeOf([], null, null), { min: 0, max: 1 });
  assert.deepEqual(rangeOf([3, 3], null, null), { min: 3, max: 4 });
});
test("sheet round trip: colorRamp, colorMin, colorMax; old sheets default; bad values reset", () => {
  const d = defaultFormat();
  assert.equal(d.colorRamp, "brand"); assert.equal(d.colorMin, null); assert.equal(d.colorMax, null);
  const s = emptySheet();
  const ok = sanitizeSheet({ ...s, format: { ...s.format, colorRamp: "blue", colorMin: 0, colorMax: 100 } }, "S", []);
  assert.equal(ok.format.colorRamp, "blue"); assert.equal(ok.format.colorMin, 0); assert.equal(ok.format.colorMax, 100);
  const issues = [];
  const bad = sanitizeSheet({ ...s, format: { ...s.format, colorRamp: "x", colorMin: "a", colorMax: 3 } }, "S", issues);
  assert.equal(bad.format.colorRamp, "brand"); assert.equal(bad.format.colorMin, null); assert.equal(bad.format.colorMax, 3);
  assert.ok(issues.length >= 2);
  const swapped = []; const sw = sanitizeSheet({ ...s, format: { ...s.format, colorMin: 9, colorMax: 1 } }, "S", swapped);
  assert.equal(sw.format.colorMin, null); assert.equal(sw.format.colorMax, null); assert.ok(swapped.some((i) => /colour range/.test(i)));
});
