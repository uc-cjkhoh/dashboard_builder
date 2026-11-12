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
