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
