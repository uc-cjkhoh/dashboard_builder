import { test } from "node:test";
import assert from "node:assert/strict";
import { entityWidth, CARD_CHROME } from "../../src/DashboardBuilder/Features/Canvas/card-width.js";

const L = { min: 300, max: 480 };
test("a short name keeps the minimum width", () => {
  assert.deepEqual(entityWidth(40, L), { width: 300, truncated: false });
});
test("a longer name widens the card by its text plus the head chrome", () => {
  const r = entityWidth(300, L);
  assert.equal(r.width, 300 + CARD_CHROME);
  assert.equal(r.truncated, false);
});
test("beyond the maximum the width stops and the name is truncated", () => {
  assert.deepEqual(entityWidth(900, L), { width: 480, truncated: true });
});
test("exactly at the maximum is not truncated", () => {
  assert.deepEqual(entityWidth(480 - CARD_CHROME, L), { width: 480, truncated: false });
});
test("fractional text widths round up so the name never clips by a pixel", () => {
  assert.equal(entityWidth(300.2, L).width, Math.ceil(300.2) + CARD_CHROME);
});
test("bad input falls back to the minimum", () => {
  for (const v of [NaN, -5, undefined, null, Infinity]) assert.equal(entityWidth(v, L).width, v === Infinity ? 480 : 300);
});
test("an inverted range is read as min = max", () => {
  assert.equal(entityWidth(100, { min: 400, max: 300 }).width, 400);
});
