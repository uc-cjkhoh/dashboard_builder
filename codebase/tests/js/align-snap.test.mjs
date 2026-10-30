import { test } from "node:test";
import assert from "node:assert/strict";
import { snapTop, SNAP_PX } from "../../src/DashboardBuilder/Features/Canvas/align-snap.js";

test("a top within reach of a straightening position is pulled onto it", () => {
  assert.equal(snapTop(104, [100]), 100);
  assert.equal(snapTop(100 + SNAP_PX, [100]), 100);
});
test("a top beyond reach, or with no targets, is left where the pointer put it", () => {
  assert.equal(snapTop(100 + SNAP_PX + 1, [100]), 100 + SNAP_PX + 1);
  assert.equal(snapTop(77, []), 77);
});
test("the nearest of several targets wins, and non-numbers are ignored", () => {
  assert.equal(snapTop(110, [100, 112, 90]), 112);
  assert.equal(snapTop(50, [NaN, undefined, null, 52]), 52);
});
test("a custom reach is honoured", () => assert.equal(snapTop(130, [100], 40), 100));
