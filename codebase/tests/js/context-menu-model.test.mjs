import { test } from "node:test";
import assert from "node:assert/strict";
import { placeMenu, opensContext, nextFocus } from "../../src/DashboardBuilder/Features/Core/context-menu-model.js";

test("placeMenu keeps the menu inside the viewport", () => {
  assert.deepEqual(placeMenu({ x: 10, y: 20, width: 200, height: 100, viewW: 1000, viewH: 800 }), { left: 10, top: 20 });
  assert.deepEqual(placeMenu({ x: 900, y: 20, width: 200, height: 100, viewW: 1000, viewH: 800 }), { left: 792, top: 20 });
  assert.deepEqual(placeMenu({ x: 10, y: 790, width: 200, height: 100, viewW: 1000, viewH: 800 }), { left: 10, top: 692 });
  assert.deepEqual(placeMenu({ x: 10, y: 10, width: 2000, height: 2000, viewW: 500, viewH: 400 }), { left: 8, top: 8 });
});
test("opensContext: the ContextMenu key, Shift+F10, and Enter on the target itself", () => {
  const t = {};
  assert.equal(opensContext({ key: "ContextMenu", target: t, currentTarget: t }), true);
  assert.equal(opensContext({ key: "F10", shiftKey: true, target: t, currentTarget: t }), true);
  assert.equal(opensContext({ key: "F10", target: t, currentTarget: t }), false);
  assert.equal(opensContext({ key: "Enter", target: t, currentTarget: t }), true);
  assert.equal(opensContext({ key: "Enter", target: {}, currentTarget: t }), false, "Enter on an inner button is that button's");
  assert.equal(opensContext({ key: "Enter", ctrlKey: true, target: t, currentTarget: t }), false);
  assert.equal(opensContext({ key: "a", target: t, currentTarget: t }), false);
});
test("nextFocus wraps and supports Home / End", () => {
  assert.equal(nextFocus(-1, 4, "ArrowDown"), 0);
  assert.equal(nextFocus(3, 4, "ArrowDown"), 0);
  assert.equal(nextFocus(0, 4, "ArrowUp"), 3);
  assert.equal(nextFocus(2, 4, "Home"), 0);
  assert.equal(nextFocus(1, 4, "End"), 3);
  assert.equal(nextFocus(0, 0, "ArrowDown"), -1);
  assert.equal(nextFocus(1, 4, "x"), 1);
});

test("placeMenu keeps clear of an avoided rectangle (the open tool flyout)", async () => {
  const { placeMenu } = await import("../../src/DashboardBuilder/Features/Core/context-menu-model.js");
  const avoid = { left: 300, top: 200, right: 620, bottom: 500 };
  const base = { width: 360, height: 300, viewW: 1440, viewH: 900 };
  // opened inside the flyout: moves to its right edge
  assert.deepEqual(placeMenu({ ...base, x: 400, y: 330, avoid }), { left: 628, top: 330 });
  // already clear: unchanged
  assert.deepEqual(placeMenu({ ...base, x: 700, y: 330, avoid }), { left: 700, top: 330 });
  // no room on the right: goes to the left of the flyout, or stays when neither side fits
  assert.deepEqual(placeMenu({ ...base, width: 360, viewW: 760, x: 400, y: 330, avoid }), { left: 392, top: 330 }); // neither side fits: the normal placement
  assert.equal(placeMenu({ ...base, width: 200, viewW: 700, x: 400, y: 330, avoid: { ...avoid, left: 250, right: 520 } }).left, 42);
  assert.equal(placeMenu({ ...base, x: 400, y: 330, avoid: null }).left, 400);
});
