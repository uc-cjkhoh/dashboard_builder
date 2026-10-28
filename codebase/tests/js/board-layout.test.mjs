import { test } from "node:test";
import assert from "node:assert/strict";
import { columnWidth, isStacked, layoutBoard, STACK_BELOW, widgetOrder } from "../../src/DashboardBuilder/Features/Board/board-layout.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

const M = { rowH: 64, gap: 12 };
const w = (id, x, y, ww = 6, h = 4) => ({ id, kind: "sheet", sheetId: "ws#1", x, y, w: ww, h });

test("column width follows the panel width: 12 columns and 11 gaps fill it exactly", () => {
  assert.equal(columnWidth(1200, M.gap), 89);
  assert.equal(columnWidth(1200, M.gap) * 12 + 11 * M.gap, 1200);
  assert.equal(columnWidth(100, M.gap), 0); // never negative
});

test("a wide panel places a widget by whole cells", () => {
  const { stacked, rects } = layoutBoard([w("a", 0, 0), w("b", 6, 0, 6, 2), w("c", 3, 4, 2, 1)], 1200, M);
  assert.equal(stacked, false);
  assert.deepEqual(rects.get("a"), { left: 0, top: 0, width: 6 * 89 + 5 * 12, height: 4 * 64 + 3 * 12 });
  assert.deepEqual(rects.get("b"), { left: 6 * (89 + 12), top: 0, width: 6 * 89 + 5 * 12, height: 2 * 64 + 12 });
  assert.deepEqual(rects.get("c"), { left: 3 * 101, top: 4 * 76, width: 2 * 89 + 12, height: 64 });
});

test("a full-width widget spans exactly the panel", () => {
  const r = layoutBoard([w("a", 0, 0, 12, 1)], 1000, M).rects.get("a");
  assert.equal(r.left, 0);
  assert.ok(Math.abs(r.width - 1000) < 1e-9);
});

test("the canvas height is the bottom of the lowest widget (the 96-row limit is the largest it gets)", () => {
  assert.equal(layoutBoard([], 1200, M).height, 0);
  assert.equal(layoutBoard([w("a", 0, 0, 6, 4), w("b", 6, 2, 6, 3)], 1200, M).height, 5 * 64 + 4 * 12);
  const last = layoutBoard([w("z", 0, LIMITS.boardRows - 1, 6, 1)], 1200, M);
  assert.equal(last.height, LIMITS.boardRows * 64 + (LIMITS.boardRows - 1) * 12);
  assert.equal(last.rects.get("z").top, 95 * 76);
});

test("below the breakpoint widgets stack full width in reading order (top to bottom, then left to right)", () => {
  assert.equal(isStacked(STACK_BELOW - 1), true);
  assert.equal(isStacked(STACK_BELOW), false);
  const ws = [w("c", 6, 4, 6, 2), w("b", 6, 0, 6, 3), w("a", 0, 0, 6, 4)];
  assert.deepEqual(widgetOrder(ws).map((x) => x.id), ["a", "b", "c"]);
  const { stacked, rects, height } = layoutBoard(ws, 400, M);
  assert.equal(stacked, true);
  assert.deepEqual(rects.get("a"), { left: 0, top: 0, width: 400, height: 4 * 64 + 3 * 12 });
  assert.deepEqual(rects.get("b"), { left: 0, top: 4 * 64 + 3 * 12 + 12, width: 400, height: 3 * 64 + 2 * 12 });
  assert.equal(rects.get("c").top, rects.get("b").top + rects.get("b").height + 12);
  assert.equal(height, rects.get("c").top + rects.get("c").height);
});

test("a stacked widget keeps its row count (heights are not squeezed) and none overlaps another", () => {
  const ws = [w("a", 0, 0, 2, 2), w("b", 2, 0, 2, 24), w("c", 4, 0, 2, 1)];
  const { rects } = layoutBoard(ws, 320, M);
  const list = [...rects.values()];
  for (let i = 1; i < list.length; i++) assert.ok(list[i].top >= list[i - 1].top + list[i - 1].height);
  assert.equal(rects.get("b").height, 24 * 64 + 23 * 12);
});

test("an unmeasured panel (width 0) lays out nothing that is negative", () => {
  const { rects } = layoutBoard([w("a", 0, 0)], 0, M);
  const r = rects.get("a");
  assert.ok(r.width >= 0 && r.height >= 0 && r.left >= 0 && r.top >= 0);
});

test("the stacking threshold is 720px of canvas width", () => {
  assert.equal(STACK_BELOW, 720);
  assert.equal(layoutBoard([w("a", 0, 0)], 719, M).stacked, true);
  assert.equal(layoutBoard([w("a", 0, 0)], 720, M).stacked, false);
});

test("stack: true stacks at any width (print: one column in flow, each widget keeps its row count)", () => {
  const ws = [w("b", 6, 0, 6, 2), w("a", 0, 0, 6, 4)];
  const { stacked, rects } = layoutBoard(ws, 1000, { ...M, stack: true });
  assert.equal(stacked, true);
  assert.deepEqual(rects.get("a"), { left: 0, top: 0, width: 1000, height: 4 * 64 + 3 * 12 });
  assert.equal(rects.get("b").top, 4 * 64 + 3 * 12 + 12);
});
