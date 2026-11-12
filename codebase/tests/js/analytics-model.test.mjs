import { test } from "node:test";
import assert from "node:assert/strict";
import { TREND_CHOICES, trendProblem, trendFormula, refValue, trendFit, trendSeries, combine, defaultAnalytics, ANALYTICS_ITEMS, itemsFor, itemActive, addItem, removeItem } from "../../src/DashboardBuilder/Features/Dashboard/analytics-model.js";

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test("reference values", () => {
  assert.equal(refValue("average", [1, 2, 3, null]), 2);
  assert.equal(refValue("median", [5, 1, 3]), 3);
  assert.equal(refValue("median", [4, 1, 3, 2]), 2.5);
  assert.equal(refValue("min", [4, -1]), -1);
  assert.equal(refValue("max", [4, -1]), 4);
  assert.equal(refValue("constant", [], 7), 7);
  assert.equal(refValue("constant", [], ""), null);
  assert.equal(refValue("average", []), null);
});
test("a linear trend recovers a straight line exactly (R² = 1)", () => {
  const fit = trendFit("linear", [3, 5, 7, 9]); // y = 3 + 2x
  assert.ok(close(fit.predict(10), 23));
  assert.ok(close(fit.r2, 1));
});
test("polynomial and logarithmic fits", () => {
  const quad = trendFit("poly2", [1, 2, 5, 10, 17]); // y = 1 + x²
  assert.ok(close(quad.predict(5), 26, 1e-6));
  const lg = trendFit("log", [0, Math.log(2), Math.log(3)].map((v) => 2 + 3 * v)); // y = 2 + 3 ln(x + 1)
  assert.ok(close(lg.predict(3), 2 + 3 * Math.log(4), 1e-6));
});
test("too few points, or none, gives no trend; blanks are skipped", () => {
  assert.equal(trendFit("linear", [5]), null);
  assert.equal(trendFit("poly2", [1, 2]), null);
  assert.ok(close(trendFit("linear", [1, null, 3]).predict(1), 2));
});
test("a forecast extends the trend past the data (linear when no trend is chosen)", () => {
  const t = trendSeries("none", [1, 2, 3], 3);
  assert.equal(t.extra, 3);
  assert.deepEqual(t.data.map((v) => Math.round(v)), [1, 2, 3, 4, 5, 6]);
});
test("totals follow the aggregation", () => {
  assert.equal(combine("sum", [1, 2, null]), 3);
  assert.equal(combine("count", [4, 6]), 10);
  assert.equal(combine("min", [4, 6]), 4);
  assert.equal(combine("max", [4, 6]), 6);
  assert.equal(combine("avg", [4, 6]), null);
  assert.equal(combine("countDistinct", [4, 6]), null);
  assert.equal(combine("sum", [null]), null);
});

import { dataValues, bandBounds, bandLabel, BAND_CHOICES, pickMeasure } from "../../src/DashboardBuilder/Features/Dashboard/analytics-model.js";
test("band bounds: typed range, standard deviation and percentile", () => {
  assert.deepEqual(bandBounds({ from: 1, to: 5 }, []), { from: 1, to: 5 });
  const sd = bandBounds({ kind: "stddev", k: 1 }, [2, 4, 4, 4, 5, 5, 7, 9]); // mean 5, sample sd 2.138...
  assert.ok(close(sd.from, 5 - Math.sqrt(32 / 7)) && close(sd.to, 5 + Math.sqrt(32 / 7)));
  assert.ok(close(bandBounds({ kind: "stddev", k: 2 }, [1, 3]).to, 2 + 2 * Math.SQRT2));
  assert.equal(bandBounds({ kind: "stddev", k: 1 }, [5]), null);
  const pc = bandBounds({ kind: "percentile", lo: 25, hi: 75 }, [1, 2, 3, 4, 5]);
  assert.deepEqual(pc, { from: 2, to: 4 });
  assert.ok(close(bandBounds({ kind: "percentile", lo: 10, hi: 90 }, [0, 10]).from, 1));
  assert.equal(bandBounds({ kind: "percentile", lo: 25, hi: 75 }, [null, ""]), null);
  assert.equal(bandBounds(null, [1]), null);
  assert.equal(bandBounds({ from: 0, to: 0 }, [1]), null); // a freshly chosen typed range draws nothing
});
test("band labels name the rule, never colour alone", () => {
  assert.equal(bandLabel({ from: 1, to: 2 }), "Band");
  assert.equal(bandLabel({ kind: "stddev", k: 2 }), "Mean ± 2σ");
  assert.equal(bandLabel({ kind: "percentile", lo: 25, hi: 75 }), "P25–P75");
  assert.ok(BAND_CHOICES.length >= 4);
});
test("the measure a reference line reads falls back to the first", () => {
  assert.equal(pickMeasure(1, 3), 1);
  assert.equal(pickMeasure(5, 3), 0);
  assert.equal(pickMeasure(undefined, 3), 0);
  assert.equal(pickMeasure(-1, 3), 0);
});
test('the "Other" remainder is not a data point for lines and bands', () => {
  const vals = dataValues([10, 20, 30, 900], [{}, {}, {}, { isOther: true }]);
  assert.deepEqual(vals, [10, 20, 30]);
  assert.equal(refValue("average", vals), 20);
  assert.ok(close(bandBounds({ kind: "stddev", k: 1 }, vals).to, 30));
});

// Analytics pane items: the draggable / clickable items and what each adds to sheet.analytics.

test("items: reference line, band, trend, forecast; forecast only on line and area", () => {
  assert.deepEqual(ANALYTICS_ITEMS.map((i) => i.id), ["ref", "band", "trend", "forecast"]);
  assert.deepEqual(itemsFor("bar").map((i) => i.id), ["ref", "band", "trend"]);
  assert.deepEqual(itemsFor("line").map((i) => i.id), ["ref", "band", "trend", "forecast"]);
  assert.deepEqual(itemsFor("area").map((i) => i.id), ["ref", "band", "trend", "forecast"]);
  assert.deepEqual(itemsFor("table"), []);
});
test("addItem sets a default, keeps the other parts, and does not mutate", () => {
  const a = { ...defaultAnalytics(), ref: { kind: "none", measure: 1 }, totals: { grand: true, sub: false } };
  const r = addItem(a, "ref");
  assert.deepEqual(r.ref, { kind: "average", measure: 1 });
  assert.equal(a.ref.kind, "none");
  assert.deepEqual(addItem(a, "band").band, { kind: "stddev", k: 1 });
  assert.equal(addItem(a, "trend").trend, "linear");
  assert.equal(addItem(a, "forecast").forecast, 3);
  assert.deepEqual(addItem(a, "trend").totals, { grand: true, sub: false });
});
test("addItem leaves an item that is already set as it is", () => {
  const a = { ...defaultAnalytics(), ref: { kind: "median" }, trend: "log", band: { from: 1, to: 2 }, forecast: 6 };
  for (const id of ["ref", "band", "trend", "forecast"]) assert.deepEqual(addItem(a, id), a);
});
test("itemActive and removeItem", () => {
  const a = { ...defaultAnalytics(), ref: { kind: "max", measure: 2 }, trend: "poly2", forecast: 12, band: { kind: "stddev", k: 2 } };
  for (const id of ["ref", "band", "trend", "forecast"]) { assert.equal(itemActive(a, id), true); assert.equal(itemActive(removeItem(a, id), id), false); }
  assert.deepEqual(removeItem(a, "ref").ref, { kind: "none", measure: 2 });
  assert.equal(itemActive(defaultAnalytics(), "ref"), false);
  assert.equal(itemActive({ ...defaultAnalytics(), ref: { kind: "constant", value: 0 } }, "ref"), true);
});
test("items have distinct icons that exist", async () => {
  const { PATHS } = await import("../../src/DashboardBuilder/Features/Core/icons.js");
  assert.equal(new Set(ANALYTICS_ITEMS.map((i) => i.icon)).size, ANALYTICS_ITEMS.length);
  for (const i of ANALYTICS_ITEMS) assert.ok(PATHS[i.icon], i.icon);
});
test("addItem ref drops a stale constant value and parameter, keeps the measure", () => {
  const a = { ...defaultAnalytics(), ref: { kind: "none", value: 5, param: "p1", measure: 1 } };
  assert.deepEqual(addItem(a, "ref").ref, { kind: "average", measure: 1 });
});
test("addItem works on analytics without a saved key", () => {
  assert.equal(addItem({ ...defaultAnalytics(), ...({}) }, "trend").trend, "linear");
});

test("a typed band's ends follow number parameters (fromParam / toParam), falling back to the typed number", () => {
  const params = [{ id: "prm1", type: "number", value: 5 }, { id: "prm2", type: "number", value: 20 }, { id: "prm3", type: "text", value: "x" }];
  assert.deepEqual(bandBounds({ from: 0, to: 10, fromParam: "prm1", toParam: "prm2" }, [], params), { from: 5, to: 20 });
  assert.deepEqual(bandBounds({ from: 0, to: 10, fromParam: "prm1" }, [], params), { from: 5, to: 10 });
  assert.deepEqual(bandBounds({ from: 1, to: 10, fromParam: "prm9", toParam: "prm3" }, [], params), { from: 1, to: 10 }, "a missing or non-number parameter falls back");
  assert.deepEqual(bandBounds({ from: 0, to: 0, fromParam: "prm2", toParam: "prm1" }, [], params), { from: 5, to: 20 }, "ends swap when the parameters cross");
  assert.equal(bandBounds({ from: 0, to: 0, fromParam: "prm1", toParam: "prm1" }, [], params), null, "equal ends draw nothing");
  assert.deepEqual(bandBounds({ from: 2, to: 4 }, []), { from: 2, to: 4 });
});

import { percentileError, bandChoice, bandFromChoice } from "../../src/DashboardBuilder/Features/Dashboard/analytics-model.js";
test("custom percentile band: 0 < lo < hi < 100, rejected not clamped", () => {
  assert.equal(percentileError(5, 95), null);
  assert.equal(percentileError(0.5, 99.5), null);
  for (const [lo, hi] of [[0, 50], [50, 100], [80, 20], [30, 30], [-1, 50], [10, 101], [NaN, 50], [null, 50], ["5", 95]]) assert.match(percentileError(lo, hi), /percentile/i, `${lo}-${hi}`);
});
test("custom percentile band choice, bounds and label", () => {
  assert.ok(BAND_CHOICES.some(([k]) => k === "pcustom"));
  assert.equal(bandChoice({ kind: "percentile", lo: 25, hi: 75 }), "p25-75");
  assert.equal(bandChoice({ kind: "percentile", lo: 5, hi: 95 }), "pcustom");
  assert.equal(bandChoice({ kind: "percentile", lo: 10, hi: 90, custom: true }), "pcustom", "typed ends equal to a preset stay custom");
  assert.deepEqual(bandFromChoice("pcustom", { kind: "percentile", lo: 5, hi: 95, custom: true }), { kind: "percentile", lo: 5, hi: 95, custom: true });
  assert.deepEqual(bandFromChoice("pcustom", { kind: "percentile", lo: 25, hi: 75 }), { kind: "percentile", lo: 5, hi: 95, custom: true });
  assert.deepEqual(bandFromChoice("pcustom", null), { kind: "percentile", lo: 5, hi: 95, custom: true });
  assert.deepEqual(bandBounds({ kind: "percentile", lo: 0.5, hi: 99.5 }, [0, 100]), { from: 0.5, to: 99.5 });
  assert.equal(bandLabel({ kind: "percentile", lo: 2.5, hi: 97.5 }), "P2.5–P97.5");
});

test("exponential and power fits recover their curves; the fit reports its sample size", () => {
  const ex = trendFit("exp", [2, 2 * Math.E, 2 * Math.E ** 2, 2 * Math.E ** 3]); // y = 2·e^x
  assert.ok(close(ex.predict(4), 2 * Math.E ** 4, 1e-6) && close(ex.r2, 1, 1e-9) && ex.n === 4);
  const pw = trendFit("power", [3, 3 * 2 ** 1.5, 3 * 3 ** 1.5, 3 * 4 ** 1.5]); // y = 3·(x+1)^1.5
  assert.ok(close(pw.predict(5), 3 * 6 ** 1.5, 1e-6) && close(pw.r2, 1, 1e-9));
});
test("exponential and power refuse values at or below zero, in plain words, never NaN", () => {
  assert.match(trendProblem("exp", [1, 0, 3]), /greater than zero/);
  assert.match(trendProblem("power", [1, -2, 3]), /greater than zero/);
  assert.equal(trendProblem("exp", [1, null, 3]), null); // blanks are skipped, not refused
  assert.equal(trendProblem("linear", [1, -2, 3]), null);
  assert.equal(trendFit("exp", [1, 0, 3]), null);
  assert.equal(trendSeries("power", [1, -1, 3], 0), null);
});
test("the formula is written out with its coefficients", () => {
  assert.equal(trendFormula("linear", trendFit("linear", [3, 5, 7, 9])), "y = 3 + 2·x");
  assert.equal(trendFormula("exp", trendFit("exp", [2, 2 * Math.E, 2 * Math.E ** 2])), "y = 2·e^(1·x)");
  assert.equal(trendFormula("power", trendFit("power", [3, 6, 9])), "y = 3·(x+1)^1");
  assert.match(trendFormula("log", trendFit("log", [1, 2, 3])), /^y = .*ln\(x\+1\)$/);
  assert.match(trendFormula("poly2", trendFit("poly2", [1, 2, 5, 10, 17])), /x²/);
});

test("R² of an exponential fit is measured on the original values (hand-computed, y = [1, 3, 2, 8])", () => {
  // fit by hand: least squares of ln y on x, then R² on the original y
  const ys = [1, 3, 2, 8], ln = ys.map(Math.log), xs = [0, 1, 2, 3];
  const mx = 1.5, my = ln.reduce((a, c) => a + c, 0) / 4;
  const b = xs.reduce((s, x, i) => s + (x - mx) * (ln[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const a = Math.exp(my - b * mx);
  const ssRes = ys.reduce((s, y, i) => s + (y - a * Math.exp(b * xs[i])) ** 2, 0), mean = 3.5;
  const ssTot = ys.reduce((s, y) => s + (y - mean) ** 2, 0);
  const fit = trendFit("exp", ys);
  assert.ok(close(fit.r2, 1 - ssRes / ssTot, 1e-9));
  assert.ok(Math.abs(fit.r2 - 0.9) < 0.2 && fit.r2 < 1); // not the ln-space R²
  assert.ok(close(fit.coef[1], b, 1e-9) && close(fit.coef[0], a, 1e-9));
});
test("formulas use one minus sign and wrap a negative exponent", () => {
  assert.equal(trendFormula("linear", trendFit("linear", [9, 7, 5, 3])), "y = 9 \u2212 2·x");
  assert.equal(trendFormula("power", trendFit("power", [4, 4 * 2 ** -0.5, 4 * 3 ** -0.5])), "y = 4·(x+1)^(\u22120.5)");
  assert.equal(trendFormula("exp", trendFit("exp", [8, 4, 2])), "y = 8·e^(\u22120.693·x)");
});
test("a blank in the middle is skipped but keeps its position; constant y gives R² 1; two points fit a line", () => {
  assert.ok(close(trendFit("linear", [1, null, 5, 7]).predict(1), 3)); // x = 0, 2, 3 -> y = 1 + 2x
  assert.equal(trendFit("linear", [1, null, 5, 7]).n, 3);
  assert.equal(trendFit("linear", [4, 4, 4]).r2, 1);
  const two = trendFit("linear", [1, 3]);
  assert.ok(close(two.predict(2), 5) && two.r2 === 1 && two.n === 2);
});
test("a series with a non-finite prediction is dropped", () => {
  assert.equal(trendSeries("exp", [1, 2, 3], 3000)?.data.every(Number.isFinite) ?? true, true);
  assert.equal(trendSeries("exp", [1e-300, 1e-200, 1e-100], 3000), null);
});

// ---- Trend models: polynomial degree, p-value, refusals ----
import { trendRefusal, pWords } from "../../src/DashboardBuilder/Features/Dashboard/analytics-model.js";
test("polynomial degrees 2, 3 and 4 recover exact polynomials", () => {
  const poly = (cs) => (x) => cs.reduce((s, c, i) => s + c * x ** i, 0);
  const cubic = poly([2, -1, 0.5, 0.25]), quartic = poly([1, 0, -2, 0, 0.1]);
  const xs = Array.from({ length: 9 }, (_, i) => i);
  const c3 = trendFit("poly3", xs.map(cubic)), c4 = trendFit("poly4", xs.map(quartic));
  assert.ok(close(c3.r2, 1, 1e-9) && close(c4.r2, 1, 1e-9));
  assert.ok(close(c3.predict(11), cubic(11), 1e-6) && close(c4.predict(11), quartic(11), 1e-5));
  assert.ok(c3.coef.every((c, i) => close(c, [2, -1, 0.5, 0.25][i], 1e-7)), "coefficients are in x, not in a scaled x");
  assert.ok(c4.coef.every((c, i) => close(c, [1, 0, -2, 0, 0.1][i], 1e-6)));
});
test("a high-degree polynomial stays stable over many points", () => {
  const ys = Array.from({ length: 2000 }, (_, x) => 5 + 0.002 * x + 1e-7 * x * x);
  const f = trendFit("poly4", ys);
  assert.ok(f && f.r2 > 0.999999);
  assert.ok(close(f.predict(1000), 5 + 2 + 0.1, 1e-3));
});
test("a polynomial of degree d needs at least d + 2 values (an exact interpolation proves nothing)", () => {
  assert.equal(trendFit("poly2", [1, 4, 9]), null);
  assert.ok(trendFit("poly2", [1, 4, 9, 17]));
  assert.equal(trendFit("poly3", [1, 4, 9, 17]), null);
  assert.ok(trendFit("poly3", [1, 4, 9, 17, 30]));
  assert.equal(trendFit("poly4", [1, 2, 3, 4, 5]), null);
  assert.ok(trendFit("poly4", [1, 2, 3, 5, 4, 8]));
  assert.match(trendProblem("poly3", [1, 4, 9, 17]), /at least 5 values/);
  assert.match(trendProblem("poly2", [1, 4, 9]), /at least 4 values/);
  assert.match(trendProblem("linear", [1]), /at least 2 values/);
  assert.equal(trendProblem("poly2", [1, 4, 9, 17]), null);
  assert.equal(trendProblem("poly2", [1, null, 9, null, 17, 4]), null); // blanks are not counted
  assert.match(trendProblem("poly2", [1, null, 9, null, 17]), /at least 4 values/);
});
test("the p-value is the F-test of the whole fit (hand-computed: y = [1, 3, 2, 5, 4], linear)", () => {
  // slope 0.8, ssTot 10, ssReg 6.4, ssRes 3.6; F = 6.4 / (3.6 / 3) = 5.3333, df (1, 3)
  const f = trendFit("linear", [1, 3, 2, 5, 4]);
  assert.ok(close(f.r2, 0.64, 1e-9));
  assert.ok(close(f.p, 0.1040, 5e-4), `p = ${f.p}`); // F(1,3) = 5.3333 -> p = 0.1040 (equals the slope's t-test, t = 2.309, 3 df)
});
test("the p-value is tiny for a clear trend, large for noise, 0 for an exact fit and null when it is undefined", () => {
  assert.ok(trendFit("linear", [1, 2.1, 2.9, 4.2, 5, 5.9, 7.1, 8]).p < 1e-6);
  assert.ok(trendFit("linear", [5, 1, 6, 2, 5, 1, 6, 2]).p > 0.5);
  assert.equal(trendFit("linear", [3, 5, 7, 9]).p, 0);
  assert.equal(trendFit("linear", [1, 3]).p, null, "two points leave no degrees of freedom");
  assert.equal(trendFit("linear", [4, 4, 4]).p, null, "a flat series has no variation to test");
  const q = trendFit("poly2", [1, 2, 5, 10, 17, 26]);
  assert.ok(q.p < 1e-6);
});
test("an exponential's p-value is the F-test on its straight-line fit of ln y", () => {
  const f = trendFit("exp", [2, 2 * Math.E, 2 * Math.E ** 2, 2 * Math.E ** 3]);
  assert.equal(f.p, 0);
  const g = trendFit("exp", [1, 3, 2, 8, 6, 20]);
  assert.ok(g.p > 0 && g.p < 0.05);
});
test("p-value wording", () => {
  assert.equal(pWords(0.0004), "p < 0.001");
  assert.equal(pWords(0), "p < 0.001");
  assert.equal(pWords(0.04567), "p = 0.046");
  assert.equal(pWords(0.5), "p = 0.500");
  assert.equal(pWords(null), "");
});
test("trendSeries carries the p-value", () => {
  const t = trendSeries("linear", [1, 3, 2, 5, 4], 0);
  assert.ok(close(t.p, 0.104, 5e-4));
  assert.equal(trendSeries("poly3", [1, 4, 9, 17], 0), null);
  assert.match(trendFormula("poly3", trendFit("poly3", [1, 4, 9, 17, 30, 50])), /x³/);
  assert.match(trendFormula("poly4", trendFit("poly4", [1, 2, 3, 5, 4, 8, 7])), /x⁴/);
});
test("a trend (and its forecast) is refused when the result is cut off", () => {
  assert.equal(trendRefusal({ truncated: false, partial: false }), null);
  assert.equal(trendRefusal({}), null);
  assert.match(trendRefusal({ truncated: true }), /cut off/);
  assert.match(trendRefusal({ partial: true }), /cut off/);
});
test("trend choices list exponential, power and the polynomial orders", () => {
  assert.deepEqual(TREND_CHOICES.map(([v]) => v), ["none", "linear", "log", "exp", "power", "poly2", "poly3", "poly4"]);
});
