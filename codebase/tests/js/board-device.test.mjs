import { test } from "node:test";
import assert from "node:assert/strict";
import { DEVICES, deviceOf, previewWidth } from "../../src/DashboardBuilder/Features/Board/board-device.js";
import { isStacked, layoutBoard } from "../../src/DashboardBuilder/Features/Board/board-layout.js";

test("three devices: desktop fills the panel, tablet and phone have fixed widths", () => {
  assert.deepEqual(DEVICES.map((d) => d.key), ["desktop", "tablet", "phone"]);
  assert.equal(deviceOf("desktop").width, null);
  assert.equal(deviceOf("tablet").width, 768);
  assert.equal(deviceOf("phone").width, 390);
  assert.equal(deviceOf("nope").key, "desktop"); // unknown → desktop
});

test("previewWidth: null for desktop, never wider than the panel", () => {
  assert.equal(previewWidth("desktop", 1000), null);
  assert.equal(previewWidth("tablet", 1000), 768);
  assert.equal(previewWidth("tablet", 600), 600);
  assert.equal(previewWidth("phone", 1000), 390);
  assert.equal(previewWidth("phone", 0), 0);
});

test("a phone preview stacks the widgets, a tablet preview keeps the 12-column grid", () => {
  const widgets = [{ id: "a", x: 0, y: 0, w: 6, h: 2 }, { id: "b", x: 6, y: 0, w: 6, h: 2 }];
  assert.equal(isStacked(previewWidth("phone", 1200)), true);
  assert.equal(isStacked(previewWidth("tablet", 1200)), false);
  const phone = layoutBoard(widgets, previewWidth("phone", 1200), { rowH: 64, gap: 8 });
  assert.equal(phone.rects.get("b").left, 0);
  assert.equal(phone.rects.get("b").width, 390);
});
