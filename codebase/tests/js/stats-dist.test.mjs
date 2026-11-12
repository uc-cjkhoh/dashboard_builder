import { test } from "node:test";
import assert from "node:assert/strict";
import { logGamma, betaInc, fSurvival } from "../../src/DashboardBuilder/Features/Dashboard/stats-dist.js";

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test("log-gamma matches known values", () => {
  assert.ok(close(logGamma(1), 0));
  assert.ok(close(logGamma(5), Math.log(24)));
  assert.ok(close(logGamma(0.5), Math.log(Math.sqrt(Math.PI))));
  assert.ok(close(logGamma(10.5), 13.940625219403763, 1e-9));
});
test("the regularised incomplete beta matches closed forms", () => {
  assert.equal(betaInc(0, 2, 3), 0);
  assert.equal(betaInc(1, 2, 3), 1);
  assert.ok(close(betaInc(0.3, 1, 1), 0.3, 1e-12)); // uniform
  assert.ok(close(betaInc(0.5, 2, 2), 0.5, 1e-12)); // symmetric
  assert.ok(close(betaInc(0.25, 2, 2), 3 * 0.0625 - 2 * 0.015625, 1e-12)); // 3x² − 2x³
  assert.ok(close(betaInc(0.2, 0.5, 0.5), (2 / Math.PI) * Math.asin(Math.sqrt(0.2)), 1e-10)); // arcsine law
});
test("the F survival function matches published 5 % critical values and exact cases", () => {
  assert.ok(close(fSurvival(4.9646, 1, 10), 0.05, 5e-5));
  assert.ok(close(fSurvival(4.1028, 2, 10), 0.05, 5e-5));
  assert.ok(close(fSurvival(3.0984, 3, 20), 0.05, 5e-5));
  assert.ok(close(fSurvival(2.6896, 4, 30), 0.05, 5e-5));
  assert.ok(close(fSurvival(1, 1, 1), 0.5, 1e-9)); // F(1,1) has median 1
  assert.ok(close(fSurvival(1, 7, 7), 0.5, 1e-9)); // equal degrees of freedom: median 1
  assert.ok(close(fSurvival(10, 2, 8), (1 + (2 * 10) / 8) ** -4, 1e-9)); // d1 = 2: (1 + d1·F/d2)^(−d2/2)
  assert.equal(fSurvival(0, 3, 9), 1);
});
test("an F that is not a number, or degrees of freedom below 1, give null", () => {
  assert.equal(fSurvival(NaN, 1, 5), null);
  assert.equal(fSurvival(2, 0, 5), null);
  assert.equal(fSurvival(2, 1, 0), null);
  assert.equal(fSurvival(Infinity, 1, 5), 0);
});
