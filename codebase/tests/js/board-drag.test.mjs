import { test } from "node:test";
import assert from "node:assert/strict";
import { cellAt, cellRect, snapMove, snapResize } from "../../src/DashboardBuilder/Features/Board/board-layout.js";
import { createDrag, DRAG_THRESHOLD, dropPlan } from "../../src/DashboardBuilder/Features/Board/board-drag.js";

const metrics = { rowH: 64, gap: 12 };
const W = 1200; // column 89, stride 101 x 76
const SX = 101, SY = 76;
const sh = (id, x, y, w = 6, h = 4) => ({ id, kind: "sheet", sheetId: "ws#1", x, y, w, h });
const ctx = (widgets) => ({ widgets, panelWidth: W, metrics, nameOf: (w) => `W-${w.id}` });

test("cellAt: the cell under a point; outside the grid clamps to the edge cells", () => {
  assert.deepEqual(cellAt({ x: 0, y: 0 }, W, metrics), { col: 0, row: 0 });
  assert.deepEqual(cellAt({ x: 100, y: 75 }, W, metrics), { col: 0, row: 0 });
  assert.deepEqual(cellAt({ x: 101, y: 76 }, W, metrics), { col: 1, row: 1 });
  assert.deepEqual(cellAt({ x: 5000, y: 99999 }, W, metrics), { col: 11, row: 95 });
  assert.deepEqual(cellAt({ x: -30, y: -4 }, W, metrics), { col: 0, row: 0 });
  assert.deepEqual(cellAt({ x: 10, y: 10 }, 0, metrics), { col: 0, row: 0 }); // a zero-width panel never divides by zero
});

test("snapMove rounds the pointer delta to the nearest whole cell and never clamps", () => {
  const s = sh("a", 2, 3);
  assert.deepEqual(snapMove(s, 0, 0, W, metrics), s);
  assert.equal(snapMove(s, 50, 0, W, metrics).x, 2);       // just under half a stride
  assert.equal(snapMove(s, 51, 0, W, metrics).x, 3);       // over half a stride
  assert.equal(snapMove(s, -SX * 2, 0, W, metrics).x, 0);
  assert.equal(snapMove(s, -SX * 5, 0, W, metrics).x, -3);   // out of the grid: left for the refusal
  assert.equal(snapMove(s, 0, SY * 2.4, W, metrics).y, 5);
  assert.equal(snapMove(s, 0, -SY * 4, W, metrics).y, -1);
  assert.ok(Number.isFinite(snapMove(s, 10, 10, 0, metrics).x)); // a zero-width panel stays finite
});

test("snapResize rounds the delta onto w/h and never goes below 1 x 1", () => {
  const s = sh("a", 0, 0, 6, 4);
  assert.deepEqual(snapResize(s, SX * 2, SY, W, metrics), { ...s, w: 8, h: 5 });
  assert.deepEqual(snapResize(s, -SX * 3, -SY * 2, W, metrics), { ...s, w: 3, h: 2 });
  assert.deepEqual(snapResize(s, -SX * 99, -SY * 99, W, metrics), { ...s, w: 1, h: 1 });
  assert.equal(snapResize(s, SX * 20, 0, W, metrics).w, 26); // over the grid: refused by the caller
});

test("cellRect is the pixel box of the cells (the ghost)", () => {
  assert.deepEqual(cellRect({ x: 3, y: 4, w: 2, h: 1 }, W, metrics), { left: 303, top: 304, width: 2 * 89 + 12, height: 64 });
});

test("a press that stays under the threshold is a click: no ghost, end = none", () => {
  const d = createDrag();
  assert.equal(d.start("move", sh("a", 0, 0), { x: 10, y: 10 }, W), true);
  assert.equal(d.move({ x: 10 + DRAG_THRESHOLD - 1, y: 10 }, ctx([sh("a", 0, 0)])), null);
  assert.equal(d.active, false);
  assert.deepEqual(d.end({ x: 12, y: 10 }, ctx([sh("a", 0, 0)])), { type: "none" });
  assert.equal(d.pressed, false);
});

test("a move drag shows a ghost of the snapped target and commits on a free target", () => {
  const widgets = [sh("a", 0, 0), sh("b", 6, 0)];
  const d = createDrag();
  d.start("move", widgets[0], { x: 50, y: 20 }, W);
  const g = d.move({ x: 50 + SX * 2, y: 20 + SY * 5 }, ctx(widgets)); // 2 cols right collides with b? a is 6 wide at x=2 -> overlaps b
  assert.equal(d.active, true);
  assert.deepEqual(g.cand, { ...widgets[0], x: 2, y: 5 });
  assert.equal(g.error, null);
  assert.deepEqual(g.rect, cellRect(g.cand, W, metrics));
  assert.deepEqual(d.end({ x: 50 + SX * 2, y: 20 + SY * 5 }, ctx(widgets)), { type: "commit", cand: { ...widgets[0], x: 2, y: 5 }, mode: "move" });
});

test("dragging onto another widget: the ghost says why and the drop reverts with that message (never relocated)", () => {
  const widgets = [sh("a", 0, 0), sh("b", 6, 0)];
  const d = createDrag();
  d.start("move", widgets[0], { x: 0, y: 0 }, W);
  const g = d.move({ x: SX * 3, y: 0 }, ctx(widgets));
  assert.equal(g.error, "Can't move: it would overlap “W-b”.");
  const r = d.end({ x: SX * 3, y: 0 }, ctx(widgets));
  assert.equal(r.type, "revert");
  assert.equal(r.error, "Can't move: it would overlap “W-b”.");
  assert.deepEqual(r.cand, { ...widgets[0], x: 3, y: 0 });
});

test("dropping off the grid reverts: left, right, top, bottom", () => {
  const widgets = [sh("a", 1, 1)];
  for (const [dx, dy, want] of [[-SX * 3, 0, /left edge/], [SX * 9, 0, /right edge/], [0, -SY * 3, /top of the dashboard/], [0, SY * 99, /at most 96 rows/]]) {
    const d = createDrag();
    d.start("move", widgets[0], { x: 0, y: 0 }, W);
    const r = d.end({ x: dx, y: dy }, ctx(widgets)) ;
    assert.equal(r.type, "none"); // end without a move() never entered dragging
    d.start("move", widgets[0], { x: 0, y: 0 }, W);
    d.move({ x: dx, y: dy }, ctx(widgets));
    const r2 = d.end({ x: dx, y: dy }, ctx(widgets));
    assert.equal(r2.type, "revert");
    assert.match(r2.error, want);
  }
});

test("dragging back to the start (or to an unchanged cell) is none", () => {
  const widgets = [sh("a", 2, 2)];
  const d = createDrag();
  d.start("move", widgets[0], { x: 0, y: 0 }, W);
  d.move({ x: 60, y: 60 }, ctx(widgets));
  assert.deepEqual(d.end({ x: 10, y: 10 }, ctx(widgets)), { type: "none" });
});

test("resize: ghost and commit; below the minimum, over the grid and over a neighbour are refused", () => {
  const widgets = [sh("a", 0, 0, 4, 4), sh("b", 6, 0, 6, 4)];
  const run = (dx, dy) => { const d = createDrag(); d.start("resize", widgets[0], { x: 0, y: 0 }, W); d.move({ x: dx, y: dy }, ctx(widgets)); return d.end({ x: dx, y: dy }, ctx(widgets)); };
  assert.deepEqual(run(SX, SY), { type: "commit", cand: { ...widgets[0], w: 5, h: 5 }, mode: "resize" });
  assert.match(run(SX * 3, 0).error, /overlap “W-b”/);
  assert.match(run(-SX * 3, 0).error, /at least 2 columns/);
  assert.match(run(0, -SY * 3).error, /at least 2 rows/);
  assert.match(run(0, SY * 30).error, /at most 24 rows/);
  const wide = [sh("a", 8, 0, 4, 4)];
  const d = createDrag(); d.start("resize", wide[0], { x: 0, y: 0 }, W); d.move({ x: SX * 2, y: 0 }, ctx(wide));
  assert.match(d.end({ x: SX * 2, y: 0 }, ctx(wide)).error, /right edge/);
});

test("a text widget may shrink to 1 row; a worksheet widget may not", () => {
  const t = { id: "t", kind: "text", heading: "h", body: "", x: 0, y: 0, w: 12, h: 2 };
  const d = createDrag(); d.start("resize", t, { x: 0, y: 0 }, W); d.move({ x: 0, y: -SY }, ctx([t]));
  assert.equal(d.end({ x: 0, y: -SY }, ctx([t])).type, "commit");
});

test("cancel (pointercancel, blur) leaves nothing active and reports whether a ghost was showing", () => {
  const d = createDrag();
  d.start("move", sh("a", 0, 0), { x: 0, y: 0 }, W);
  assert.equal(d.cancel(), false);
  d.start("move", sh("a", 0, 0), { x: 0, y: 0 }, W);
  d.move({ x: 200, y: 0 }, ctx([sh("a", 0, 0)]));
  assert.equal(d.cancel(), true);
  assert.equal(d.active, false);
  assert.equal(d.pressed, false);
  assert.deepEqual(d.end({ x: 200, y: 0 }, ctx([sh("a", 0, 0)])), { type: "none" });
});

test("no drag on a stacked (narrow) canvas; a second start while one is running is ignored", () => {
  const d = createDrag();
  assert.equal(d.start("move", sh("a", 0, 0), { x: 0, y: 0 }, 600), false);
  assert.equal(d.start("move", sh("a", 0, 0), { x: 0, y: 0 }, W), true);
  assert.equal(d.start("resize", sh("a", 0, 0), { x: 0, y: 0 }, W), false);
});

test("dropPlan (panel drag): the default size at the cell under the pointer, slid left to fit, refused when taken or off the bottom", () => {
  const widgets = [sh("a", 0, 0)];
  const at = (col, row) => ({ x: col * SX + 10, y: row * SY + 10 });
  let p = dropPlan(widgets, "sheet", at(6, 0), ctx(widgets));
  assert.equal(p.error, null);
  assert.deepEqual(p.cand, { kind: "sheet", x: 6, y: 0, w: 6, h: 4 });
  assert.deepEqual(p.rect, cellRect(p.cand, W, metrics));
  p = dropPlan(widgets, "sheet", at(9, 5), ctx(widgets));
  assert.deepEqual([p.cand.x, p.cand.y, p.error], [6, 5, null]); // slid left to x=6 so it fits
  p = dropPlan(widgets, "sheet", at(3, 1), ctx(widgets));
  assert.match(p.error, /^Can't place: it would overlap “W-a”/);
  assert.ok(p.rect); // the ghost still shows, marked refused
  p = dropPlan(widgets, "sheet", at(0, 94), ctx(widgets));
  assert.match(p.error, /at most 96 rows/);
  p = dropPlan(widgets, "text", at(5, 6), ctx(widgets));
  assert.deepEqual([p.cand.x, p.cand.w, p.cand.h, p.error], [0, 12, 2, null]);
});

test("dropPlan: 12 widgets refuses; a stacked canvas refuses with a pointer to Add", () => {
  const twelve = Array.from({ length: 12 }, (_, i) => sh(`w${i}`, (i % 2) * 6, Math.floor(i / 2) * 4));
  assert.match(dropPlan(twelve, "sheet", { x: 10, y: 5000 }, ctx(twelve)).error, /at most 12 widgets/);
  const p = dropPlan([], "sheet", { x: 10, y: 10 }, { ...ctx([]), panelWidth: 500 });
  assert.match(p.error, /use Add/);
  assert.equal(p.rect, null);
});
