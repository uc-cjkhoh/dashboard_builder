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

import { rowsWidth, ROW_CHROME, ROW_CHROME_NO_PROFILE } from "../../src/DashboardBuilder/Features/Canvas/card-width.js";
test("rowsWidth: the longest name + the type column + the row chrome; a union / unpivot card has no Profile button to make room for", () => {
  assert.equal(rowsWidth(120, 110), 230 + ROW_CHROME);
  assert.equal(rowsWidth(120.2, 110, { profile: false }), 231 + ROW_CHROME_NO_PROFILE);
  assert.ok(ROW_CHROME > ROW_CHROME_NO_PROFILE);
});
test("rowsWidth: no rows, or bad input, asks for nothing", () => {
  for (const v of [[0, 0], [NaN, NaN], [-4, undefined], [null, null]]) assert.equal(rowsWidth(...v), 0);
});
test("rows wider than the title widen the card, up to the maximum; narrower rows change nothing", () => {
  assert.equal(entityWidth(40, L, 380).width, 380);
  assert.equal(entityWidth(40, L, 900).width, 480);
  assert.equal(entityWidth(40, L, 200).width, 300);
  assert.equal(entityWidth(300, L, 380).width, 300 + CARD_CHROME);
  assert.deepEqual(entityWidth(40, L, 900), { width: 480, truncated: false }); // the title still fits; only a row name ellipsises
  for (const v of [NaN, -1, undefined, null]) assert.equal(entityWidth(40, L, v).width, 300);
});

test("rowsWidth: a 10px or thinner (or overlay) scrollbar does not change the chrome, since the rows give back the padding; a wider one grows the card", () => {
  for (const sb of [0, 8, 10, 16]) assert.equal(rowsWidth(100, 100, { scrollbar: sb }), 200 + ROW_CHROME);
  assert.equal(rowsWidth(100, 100, { scrollbar: 17 }), 200 + ROW_CHROME + 1);
  assert.equal(rowsWidth(100, 100, { profile: false, scrollbar: 17 }), 200 + ROW_CHROME_NO_PROFILE + 1);
  assert.equal(rowsWidth(100, 100, { scrollbar: NaN }), 200 + ROW_CHROME);
});
