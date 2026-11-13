// The Automatic colour scale (Diverging when the data crosses zero, Tableau's default) and Use full colour range — pure model, the stored shape,
// and what a new worksheet starts with. Chart integration (the legend and the marks' colours) is checked in tests/live/marks-colour-ui.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCALE_CHOICES, effectiveScale, divergingRange, fullRangeRamp, colourAtFull, fullRangeApplies, colourScaleKind } from "../../src/DashboardBuilder/Features/Dashboard/colour-scale-model.js";
import { sanitizeSheet } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { emptySheet, defaultFormat, freshSheet } from "../../src/DashboardBuilder/Features/Core/store.js";

test("choices: Automatic first, then the two explicit scales", () => {
  assert.deepEqual(SCALE_CHOICES.map(([v]) => v), ["auto", "sequential", "diverging"]);
  assert.equal(SCALE_CHOICES[0][1], "Automatic");
});
test("effectiveScale: Automatic is Diverging only when the values run from below zero to above it; explicit choices are kept", () => {
  assert.equal(effectiveScale("auto", [-5, 3, 10]), "diverging");
  assert.equal(effectiveScale("auto", [0, 3, 10]), "sequential", "touching zero is not crossing it");
  assert.equal(effectiveScale("auto", [-5, -1]), "sequential");
  assert.equal(effectiveScale("auto", [1, 2]), "sequential");
  assert.equal(effectiveScale("auto", []), "sequential");
  assert.equal(effectiveScale("auto", [null, "", NaN, "x", -1, 1]), "diverging", "missing and non-numeric values are ignored");
  assert.equal(effectiveScale("auto", ["-3", "4"]), "diverging", "numeric strings count");
  assert.equal(effectiveScale("sequential", [-5, 5]), "sequential");
  assert.equal(effectiveScale("diverging", [1, 2]), "diverging");
  assert.equal(effectiveScale(undefined, [-5, 5]), "sequential", "a sheet that stored nothing has always been Low → high");
  assert.equal(colourScaleKind("auto", [-5, 5]), "diverging");
});
test("divergingRange: Use full colour range gives each side its own span; symmetric (today) stays the default", () => {
  assert.deepEqual(divergingRange(-10, 100, 0), { min: -100, max: 100, centre: 0 });
  assert.deepEqual(divergingRange(-10, 100, 0, true), { min: -10, max: 100, centre: 0, full: true });
  assert.deepEqual(divergingRange(-10, 100, null, true), { min: -10, max: 100, centre: 0, full: true }, "the centre is 0 when the data straddles it");
  assert.deepEqual(divergingRange(10, 100, 0, true), divergingRange(10, 100, 0), "a centre outside the data has one side only: symmetric, as before");
  assert.equal(fullRangeApplies(-10, 100, 0), true); assert.equal(fullRangeApplies(0, 100, 0), false); assert.equal(fullRangeApplies(5, 100, 0), false);
});
const RAMP = ["#d98a4a", "#ffffff", "#2b62b8"];
test("fullRangeRamp: sampled stops put the centre colour on the centre, each end colour on its own end", () => {
  const stops = fullRangeRamp(RAMP, -10, 100, 0, 111); // 1.0 step per stop: the centre (0) is stop 10
  assert.equal(stops.length, 111);
  assert.equal(stops[0], RAMP[0]); assert.equal(stops[110], RAMP[2]); assert.equal(stops[10], RAMP[1]);
  assert.equal(colourAtFull(RAMP, -10, 100, 0, -10), RAMP[0]); assert.equal(colourAtFull(RAMP, -10, 100, 0, 100), RAMP[2]); assert.equal(colourAtFull(RAMP, -10, 100, 0, 0), RAMP[1]);
  const half = colourAtFull(RAMP, -10, 100, 0, 50); // halfway between the centre and the high end
  assert.ok(half !== RAMP[1] && half !== RAMP[2], half);
});
test("the stored setting: Automatic is a new worksheet's start, never an old file's; Use full colour range is optional and checked", () => {
  assert.equal(defaultFormat().colorScale, "sequential", "defaultFormat is unchanged: nothing reads old files as Automatic");
  assert.equal(emptySheet("S").format.colorScale, "sequential");
  assert.equal(freshSheet().format.colorScale, "auto", "a worksheet the user adds starts Automatic");
  assert.equal("colorFullRange" in freshSheet().format, false);
  const issues = [];
  assert.equal(sanitizeSheet(emptySheet("S"), "S", issues).format.colorScale, "sequential");
  const old = emptySheet("S"); delete old.format.colorScale; // a file from before the setting existed
  assert.equal(sanitizeSheet(old, "S", []).format.colorScale, "sequential");
  assert.equal(sanitizeSheet({ ...emptySheet("S"), format: { colorScale: "auto" } }, "S", []).format.colorScale, "auto");
  assert.equal("colorFullRange" in sanitizeSheet(emptySheet("S"), "S", []).format, false);
  assert.equal(sanitizeSheet({ ...emptySheet("S"), format: { colorFullRange: true } }, "S", []).format.colorFullRange, true);
  const bad = [];
  const s = sanitizeSheet({ ...emptySheet("S"), format: { colorFullRange: "yes", colorScale: "magic" } }, "S", bad);
  assert.equal("colorFullRange" in s.format, false); assert.equal(s.format.colorScale, "sequential"); assert.equal(bad.length, 2);
});
