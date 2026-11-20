import { test } from "node:test";
import assert from "node:assert/strict";
import { placeTip, delayFor, SHOW_DELAY, GRACE } from "../../src/DashboardBuilder/Features/Core/hover-tip-model.js";

const view = { viewW: 1000, viewH: 800 };
const btn = (left, top, size = 32) => ({ left, top, right: left + size, bottom: top + size });

test("placeTip centres the tooltip under the control, 8px away", () => {
  assert.deepEqual(placeTip({ anchor: btn(484, 100), width: 100, height: 28, ...view }), { left: 450, top: 140, side: "below" });
});
test("placeTip flips above when it does not fit below but does above", () => {
  assert.deepEqual(placeTip({ anchor: btn(484, 760), width: 100, height: 28, ...view }), { left: 450, top: 724, side: "above" });
});
test("placeTip stays 8px inside the right and left edges", () => {
  assert.equal(placeTip({ anchor: btn(970, 10), width: 160, height: 28, ...view }).left, 832);
  assert.equal(placeTip({ anchor: btn(0, 10), width: 160, height: 28, ...view }).left, 8);
});
test("placeTip with no room either side stays inside the viewport (below, clamped)", () => {
  const at = placeTip({ anchor: btn(10, 10), width: 100, height: 790, ...view });
  assert.equal(at.side, "below");
  assert.equal(at.top, 8);
});
test("delayFor: a rest of SHOW_DELAY, none while one is up or just hid", () => {
  assert.equal(delayFor({ visible: false, sinceHiddenMs: Infinity }), SHOW_DELAY);
  assert.equal(delayFor({ visible: true, sinceHiddenMs: Infinity }), 0);
  assert.equal(delayFor({ visible: false, sinceHiddenMs: GRACE - 1 }), 0);
  assert.equal(delayFor({ visible: false, sinceHiddenMs: GRACE }), SHOW_DELAY);
});
