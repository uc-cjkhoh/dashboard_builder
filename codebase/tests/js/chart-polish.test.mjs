import { test } from "node:test";
import assert from "node:assert/strict";
import { fitWords, kpiLastNote, histogramLabel } from "../../src/DashboardBuilder/Features/Dashboard/chart-polish.js";

test("fitWords: a negative R² is a poor fit in words, the number stays", () => {
  assert.equal(fitWords(-0.12), "poor fit (R² -0.12)");
  assert.equal(fitWords(0.2), "weak fit (R² 0.20)");
  assert.equal(fitWords(0.5), "moderate fit (R² 0.50)");
  assert.equal(fitWords(0.91), "good fit (R² 0.91)");
  assert.equal(fitWords(NaN), "R² n/a");
});
test("kpiLastNote names the member the number belongs to and that it is not a total", () => {
  assert.equal(kpiLastNote("Vietnam", 6), "Vietnam · last of 6");
  assert.equal(kpiLastNote(null, 6), "last of 6");
  assert.equal(kpiLastNote("Vietnam", 1), "Vietnam");
});
test("histogramLabel: whole-number bins read 1 or 3–4, fractional bins keep their range", () => {
  const f = (v) => String(v);
  assert.equal(histogramLabel({ x0: 1, x1: 2 }, true, f), "1");
  assert.equal(histogramLabel({ x0: 3, x1: 5 }, true, f), "3–4");
  assert.equal(histogramLabel({ x0: 1, x1: 1.4 }, false, f), "1–1.4");
});
