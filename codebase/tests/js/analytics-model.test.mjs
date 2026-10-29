import { test } from "node:test";
import assert from "node:assert/strict";
import { refValue, trendFit, trendSeries, combine } from "../../src/DashboardBuilder/Features/Dashboard/analytics-model.js";

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

// Analytics pane items (T07-01): the draggable / clickable items and what each adds to sheet.analytics.
import { defaultAnalytics, ANALYTICS_ITEMS, itemsFor, itemActive, addItem, removeItem } from "../../src/DashboardBuilder/Features/Dashboard/analytics-model.js";
import { test as itest } from "node:test";
import iassert from "node:assert/strict";

itest("items: reference line, band, trend, forecast; forecast only on line and area", () => {
  iassert.deepEqual(ANALYTICS_ITEMS.map((i) => i.id), ["ref", "band", "trend", "forecast"]);
  iassert.deepEqual(itemsFor("bar").map((i) => i.id), ["ref", "band", "trend"]);
  iassert.deepEqual(itemsFor("line").map((i) => i.id), ["ref", "band", "trend", "forecast"]);
  iassert.deepEqual(itemsFor("area").map((i) => i.id), ["ref", "band", "trend", "forecast"]);
  iassert.deepEqual(itemsFor("table"), []);
});
itest("addItem sets a default, keeps the other parts, and does not mutate", () => {
  const a = { ...defaultAnalytics(), ref: { kind: "none", measure: 1 }, totals: { grand: true, sub: false } };
  const r = addItem(a, "ref");
  iassert.deepEqual(r.ref, { kind: "average", measure: 1 });
  iassert.equal(a.ref.kind, "none");
  iassert.deepEqual(addItem(a, "band").band, { kind: "stddev", k: 1 });
  iassert.equal(addItem(a, "trend").trend, "linear");
  iassert.equal(addItem(a, "forecast").forecast, 3);
  iassert.deepEqual(addItem(a, "trend").totals, { grand: true, sub: false });
});
itest("addItem leaves an item that is already set as it is", () => {
  const a = { ...defaultAnalytics(), ref: { kind: "median" }, trend: "log", band: { from: 1, to: 2 }, forecast: 6 };
  for (const id of ["ref", "band", "trend", "forecast"]) iassert.deepEqual(addItem(a, id), a);
});
itest("itemActive and removeItem", () => {
  const a = { ...defaultAnalytics(), ref: { kind: "max", measure: 2 }, trend: "poly2", forecast: 12, band: { kind: "stddev", k: 2 } };
  for (const id of ["ref", "band", "trend", "forecast"]) { iassert.equal(itemActive(a, id), true); iassert.equal(itemActive(removeItem(a, id), id), false); }
  iassert.deepEqual(removeItem(a, "ref").ref, { kind: "none", measure: 2 });
  iassert.equal(itemActive(defaultAnalytics(), "ref"), false);
  iassert.equal(itemActive({ ...defaultAnalytics(), ref: { kind: "constant", value: 0 } }, "ref"), true);
});
