import test from "node:test";
import assert from "node:assert/strict";
import { ZOOM_MIN, ZOOM_MAX, clampZoom, wheelPixels, wheelZoom, panForZoom, panToReveal, toModel } from "../../src/DashboardBuilder/Features/Canvas/canvas-zoom.js";

test("zoom is held between the limits and a bad value reads as 100%", () => {
  assert.equal(clampZoom(10), ZOOM_MAX);
  assert.equal(clampZoom(0.01), ZOOM_MIN);
  assert.equal(clampZoom(1.25), 1.25);
  for (const bad of [NaN, Infinity, undefined, "2"]) assert.equal(clampZoom(bad), 1);
});
test("wheel up zooms in, wheel down zooms out, and a still wheel changes nothing", () => {
  assert.ok(wheelZoom(1, -100) > 1);
  assert.ok(wheelZoom(1, 100) < 1);
  assert.equal(wheelZoom(1, 0), 1);
  assert.equal(wheelZoom(1, NaN), 1);
});
test("wheel zoom never leaves the limits", () => {
  assert.equal(wheelZoom(ZOOM_MAX, -5000), ZOOM_MAX);
  assert.equal(wheelZoom(ZOOM_MIN, 5000), ZOOM_MIN);
});
test("line and page wheel modes are read as pixels", () => {
  assert.equal(wheelPixels(3, 1), 48);
  assert.equal(wheelPixels(1, 2), 400);
  assert.equal(wheelPixels(7, 0), 7);
});
test("the model point under the cursor stays under it", () => {
  const pan = { x: -100, y: 40 }, cursor = { x: 300, y: 200 };
  const from = 1, to = 1.5;
  const modelBefore = { x: (cursor.x - pan.x) / from, y: (cursor.y - pan.y) / from };
  const next = panForZoom(pan, cursor, from, to);
  assert.ok(Math.abs((cursor.x - next.x) / to - modelBefore.x) < 1e-9);
  assert.ok(Math.abs((cursor.y - next.y) / to - modelBefore.y) < 1e-9);
});
test("zooming about the view's own origin leaves the pan alone", () => {
  assert.deepEqual(panForZoom({ x: 0, y: 0 }, { x: 0, y: 0 }, 1, 2), { x: 0, y: 0 });
});
test("revealing: a box inside the view needs no pan; one outside is brought in with a margin", () => {
  assert.deepEqual(panToReveal({ x: 5, y: 6 }, { left: 50, top: 50, right: 200, bottom: 150 }, 800, 600), { x: 5, y: 6 });
  assert.deepEqual(panToReveal({ x: 0, y: 0 }, { left: -100, top: 20, right: 100, bottom: 120 }, 800, 600), { x: 116, y: 0 });
  assert.deepEqual(panToReveal({ x: 0, y: 0 }, { left: 700, top: 580, right: 900, bottom: 700 }, 800, 600), { x: -116, y: -116 });
  assert.deepEqual(panToReveal({ x: 0, y: 0 }, { left: -50, top: 0, right: 2000, bottom: 100 }, 800, 600), { x: 66, y: 16 });
});
test("a screen distance becomes a model distance", () => {
  assert.equal(toModel(100, 0.5), 200);
  assert.equal(toModel(100, 2), 50);
});

import { stepZoom, fitView, panByKey, ZOOM_STEP, PAN_STEP } from "../../src/DashboardBuilder/Features/Canvas/canvas-zoom.js";

test("a zoom step is a quarter, rounded to a whole percent, and stops at the limits", () => {
  assert.equal(stepZoom(1, 1), 1.25);
  assert.equal(stepZoom(1, -1), 0.8);
  assert.equal(stepZoom(ZOOM_MAX, 1), ZOOM_MAX);
  assert.equal(stepZoom(ZOOM_MIN, -1), ZOOM_MIN);
  assert.equal(stepZoom(NaN, 1), ZOOM_STEP);
});
test("fit: cards that already fit stay at 100 % and are centred", () => {
  const { zoom, pan } = fitView([{ x: 0, y: 0, w: 400, h: 300 }], 1000, 800);
  assert.equal(zoom, 1);
  assert.deepEqual(pan, { x: 300, y: 250 });
});
test("fit: too many cards zoom out until all show, inside the margin", () => {
  const boxes = [{ x: 0, y: 0, w: 400, h: 300 }, { x: 1600, y: 1200, w: 400, h: 300 }]; // 2000 x 1500
  const { zoom, pan } = fitView(boxes, 1000, 800, 16);
  assert.ok(zoom < 1 && zoom >= ZOOM_MIN);
  assert.ok(Math.abs(zoom - Math.min(968 / 2000, 768 / 1500)) < 1e-9);
  for (const b of boxes) {
    assert.ok(b.x * zoom + pan.x >= 16 - 1e-9 && (b.x + b.w) * zoom + pan.x <= 1000 - 16 + 1e-9);
    assert.ok(b.y * zoom + pan.y >= 16 - 1e-9 && (b.y + b.h) * zoom + pan.y <= 800 - 16 + 1e-9);
  }
});
test("fit: cards that start away from the origin are found, wherever they are", () => {
  const { zoom, pan } = fitView([{ x: -500, y: 900, w: 200, h: 100 }], 600, 400);
  assert.equal(zoom, 1);
  assert.equal(-500 * zoom + pan.x, (600 - 200) / 2);
  assert.equal(900 * zoom + pan.y, (400 - 100) / 2);
});
test("fit: more than ZOOM_MIN can show lines up the top-left at the margin; nothing to fit means 100 % at the origin", () => {
  const far = fitView([{ x: 0, y: 0, w: 100000, h: 100000 }], 1000, 800);
  assert.equal(far.zoom, ZOOM_MIN);
  assert.deepEqual(far.pan, { x: 16, y: 16 });
  for (const none of [[], null, undefined, [{ x: NaN, y: 0, w: 1, h: 1 }]]) assert.deepEqual(fitView(none, 1000, 800), { zoom: 1, pan: { x: 0, y: 0 } });
  assert.deepEqual(fitView([{ x: 0, y: 0, w: 10, h: 10 }], 0, 0), { zoom: 1, pan: { x: 0, y: 0 } });
});
test("arrow keys move the ground one step (Shift: four), other keys not at all", () => {
  assert.deepEqual(panByKey({ x: 0, y: 0 }, "ArrowRight"), { x: -PAN_STEP, y: 0 });
  assert.deepEqual(panByKey({ x: 0, y: 0 }, "ArrowLeft"), { x: PAN_STEP, y: 0 });
  assert.deepEqual(panByKey({ x: 0, y: 0 }, "ArrowDown", true), { x: 0, y: -4 * PAN_STEP });
  assert.deepEqual(panByKey({ x: 5, y: 5 }, "ArrowUp"), { x: 5, y: 5 + PAN_STEP });
  const p = { x: 1, y: 2 };
  assert.equal(panByKey(p, "a"), p);
});
