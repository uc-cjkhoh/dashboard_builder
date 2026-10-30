import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSides, linkRoute, roundedPath, STUB, FACING_GAP } from "../../src/DashboardBuilder/Features/Relations/link-route.js";

test("cards with a gutter face each other", () => {
  assert.deepEqual(linkSides({ left: 0, right: 300 }, { left: 400, right: 700 }), [1, -1]);
  assert.deepEqual(linkSides({ left: 400, right: 700 }, { left: 0, right: 300 }), [-1, 1]);
});

test("a gutter of exactly the minimum still faces", () => {
  assert.deepEqual(linkSides({ left: 0, right: 300 }, { left: 300 + FACING_GAP, right: 600 }), [1, -1]);
});

test("cards too close or overlapping both use the right edge", () => {
  assert.deepEqual(linkSides({ left: 0, right: 300 }, { left: 300 + FACING_GAP - 8, right: 600 }), [1, 1]);
  assert.deepEqual(linkSides({ left: 0, right: 300 }, { left: 100, right: 400 }), [1, 1]);
});

test("facing sides turn STUB out of the left card, at the gutter's middle when it is narrow", () => {
  const far = linkRoute({ x: 300, y: 40 }, 1, { x: 400, y: 120 }, -1);
  assert.deepEqual(far.points, [{ x: 300, y: 40 }, { x: 324, y: 40 }, { x: 324, y: 120 }, { x: 400, y: 120 }]);
  assert.deepEqual(far.label, { x: 324, y: 80 });
  const near = linkRoute({ x: 300, y: 40 }, 1, { x: 348, y: 120 }, -1);
  assert.equal(near.points[1].x, 324);
  assert.equal(linkRoute({ x: 300, y: 40 }, 1, { x: 332, y: 120 }, -1).points[1].x, 316);
  assert.equal(linkRoute({ x: 400, y: 40 }, -1, { x: 300, y: 120 }, 1).points[1].x, 324); // the same turn whichever end is the first
});

test("lanes shift the turn by 8px and stay a crow's foot clear of both cards", () => {
  const x = (lane) => linkRoute({ x: 300, y: 40 }, 1, { x: 348, y: 120 }, -1, lane).points[1].x;
  assert.deepEqual([x(-1), x(0), x(1)], [316, 324, 332]);
  assert.equal(linkRoute({ x: 300, y: 40 }, 1, { x: 332, y: 120 }, -1, 1).points[1].x, 317);
  assert.equal(linkRoute({ x: 300, y: 40 }, 1, { x: 300, y: 120 }, 1, 1).points[1].x, 300 + STUB + 8);
});

test("same-side routes loop out past the farther card edge", () => {
  const { points } = linkRoute({ x: 300, y: 40 }, 1, { x: 400, y: 120 }, 1);
  assert.equal(points[1].x, 400 + STUB);
  assert.equal(points[2].x, 400 + STUB);
  const left = linkRoute({ x: 100, y: 40 }, -1, { x: 0, y: 120 }, -1);
  assert.equal(left.points[1].x, -STUB);
});

test("roundedPath rounds each turn and clamps the radius to half a short run", () => {
  const pts = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 100 }];
  assert.equal(roundedPath(pts, 8), "M0,0 L42,0 Q50,0 50,8 L50,92 Q50,100 58,100 L100,100");
  const tight = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 20, y: 6 }];
  assert.match(roundedPath(tight, 8), /Q10,0 10,3/); // the 6px run allows 3px
});

test("a straight run (equal y) stays a straight line", () => {
  const { points } = linkRoute({ x: 300, y: 50 }, 1, { x: 400, y: 50 }, -1);
  assert.equal(roundedPath(points), "M300,50 L324,50 L324,50 L400,50"); // zero-length turns add no curve
});
