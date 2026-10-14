import { test } from "node:test";
import assert from "node:assert/strict";
import { clampWidth } from "../../src/DashboardBuilder/Features/Core/resizer.js";

test("a width inside the range is kept (rounded)", () => {
  assert.equal(clampWidth(250.4, 180, 400), 250);
});
test("a width below the minimum snaps to the minimum", () => {
  assert.equal(clampWidth(90, 180, 400), 180);
});
test("a width above the maximum snaps to the maximum", () => {
  assert.equal(clampWidth(900, 180, 400), 400);
});
test("a maximum smaller than the minimum (narrow window) still yields the minimum", () => {
  assert.equal(clampWidth(300, 180, 120), 180);
});
test("a non-numeric width falls back to the minimum", () => {
  assert.equal(clampWidth(Number.NaN, 180, 400), 180);
});
