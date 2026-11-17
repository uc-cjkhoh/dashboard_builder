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

test("facing sides turn in the middle of the gutter, equally far from both cards", () => {
  const far = linkRoute({ x: 300, y: 40 }, 1, { x: 400, y: 120 }, -1);
  assert.deepEqual(far.points, [{ x: 300, y: 40 }, { x: 350, y: 40 }, { x: 350, y: 120 }, { x: 400, y: 120 }]);
  assert.deepEqual(far.label, { x: 350, y: 80 });
  const near = linkRoute({ x: 300, y: 40 }, 1, { x: 348, y: 120 }, -1);
  assert.equal(near.points[1].x, 324);
  assert.equal(linkRoute({ x: 300, y: 40 }, 1, { x: 332, y: 120 }, -1).points[1].x, 316);
  assert.equal(linkRoute({ x: 400, y: 40 }, -1, { x: 300, y: 120 }, 1).points[1].x, 350); // the same turn whichever end is the first
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
  assert.equal(roundedPath(points), "M300,50 L350,50 L350,50 L400,50"); // zero-length turns add no curve
});

import { placeBadge } from "../../src/DashboardBuilder/Features/Relations/link-route.js";
test("placeBadge: midpoint when free, slides off a card, goes under when the run is blocked", () => {
  const spot = { x: 100, y: 100 };
  assert.deepEqual(placeBadge(spot, 20, 180, 34, 24, [], []), { x: 100, y: 100, under: false });
  const slid = placeBadge(spot, 20, 180, 34, 24, [{ left: 50, right: 150, top: 80, bottom: 120 }], []);
  assert.equal(slid.under, false);
  assert.ok(slid.y + 12 <= 80 || slid.y - 12 >= 120);
  const blocked = placeBadge(spot, 20, 180, 34, 24, [{ left: 50, right: 150, top: 0, bottom: 200 }], []);
  assert.deepEqual(blocked, { x: 100, y: 100, under: true });
});

import { assignLanes, laneCrossings, quietBadges, LANE_PAD } from "../../src/DashboardBuilder/Features/Relations/link-route.js";
test("assignLanes: a lone run stays on the middle; runs that never overlap share it", () => {
  assert.deepEqual(assignLanes([{ group: 300, lo: 0, hi: 100 }]), [0]);
  assert.deepEqual(assignLanes([{ group: 300, lo: 0, hi: 100 }, { group: 300, lo: 100 + LANE_PAD, hi: 200 }]), [0, 0]);
  assert.deepEqual(assignLanes([{ group: 300, lo: 0, hi: 100 }, { group: 500, lo: 0, hi: 100 }]), [0, 0]); // other gutter
});

test("assignLanes: overlapping runs never share a lane, however many, centred on 0", () => {
  const runs = Array.from({ length: 6 }, (_, i) => ({ group: 300, lo: i * 10, hi: 400 }));
  const lanes = assignLanes(runs);
  assert.equal(new Set(lanes).size, 6); // the old 3-lane cycle put the 4th on the 1st
  assert.deepEqual([...lanes].sort((a, b) => a - b), [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5]);
  assert.deepEqual(assignLanes([{ group: 1, lo: 0, hi: 50 }, { group: 1, lo: 20, hi: 80 }]), [-0.5, 0.5]);
});

test("assignLanes: a cluster's lanes are ordered so its links cross as little as possible", () => {
  // two links up from a left card to a right card (the higher left end runs nearer the left card), two down (the higher one farther out)
  const up = [{ group: 0, lo: 154, hi: 330, left: [330], right: [154] }, { group: 0, lo: 306, hi: 370, left: [370], right: [306] }];
  const [u1, u2] = assignLanes(up);
  assert.ok(u1 < u2);
  assert.equal(laneCrossings(up[0], up[1]), 0);
  const down = [{ group: 0, lo: 410, hi: 618, left: [410], right: [618] }, { group: 0, lo: 450, hi: 770, left: [450], right: [770] }];
  const [d1, d2] = assignLanes(down);
  assert.ok(d1 > d2);
});

test("assignLanes: lanes squeeze into a narrow gutter, never closer than 3px", () => {
  const runs = Array.from({ length: 5 }, (_, i) => ({ group: 0, lo: i, hi: 100, room: 16 }));
  const lanes = assignLanes(runs).sort((a, b) => a - b);
  assert.equal((lanes[4] - lanes[0]) * 8, 16); // 4 gaps in 16px
  const tight = assignLanes(runs.map((r) => ({ ...r, room: 2 }))).sort((a, b) => a - b);
  assert.equal((tight[1] - tight[0]) * 8, 3);
});

test("quietBadges: from 4 links below 125 % zoom", () => {
  assert.equal(quietBadges(3, 1), false);
  assert.equal(quietBadges(4, 1), true);
  assert.equal(quietBadges(9, 1.25), false);
});
