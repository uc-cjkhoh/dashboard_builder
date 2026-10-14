import { test } from "node:test";
import assert from "node:assert/strict";
import { createHistory } from "../../src/DashboardBuilder/Features/Dashboard/history.js";
import { applyFitMode } from "../../src/DashboardBuilder/Features/Dashboard/chart-fit.js";

test("undo goes back, redo forward, a new change clears redo", () => {
  const h = createHistory();
  h.record("d", { v: 1 });          // 1 → 2
  h.record("d", { v: 2 });          // 2 → 3
  assert.deepEqual(h.undo("d", { v: 3 }), { v: 2 });
  assert.deepEqual(h.undo("d", { v: 2 }), { v: 1 });
  assert.equal(h.undo("d", { v: 1 }), null);
  assert.deepEqual(h.redo("d", { v: 1 }), { v: 2 });
  h.record("d", { v: 2 });          // a new edit
  assert.equal(h.canRedo("d"), false);
});
test("history is per dashboard, copies snapshots, and is bounded", () => {
  const h = createHistory(3);
  const s = { list: [1] };
  h.record("a", s); s.list.push(2);
  assert.deepEqual(h.undo("a", s), { list: [1] }); // a copy, not the mutated object
  assert.equal(h.canUndo("b"), false);
  for (let i = 0; i < 10; i++) h.record("c", { i });
  let n = 0; while (h.undo("c", {})) n++;
  assert.equal(n, 3);
});
test("fit modes drop the minimum (and the zoom) on the fitted axis", () => {
  const base = { minWidth: 900, minHeight: 700, rotate: 90, zoom: "xy", window: 10, windowY: 20 };
  assert.deepEqual(applyFitMode(base, "standard"), { ...base, fittedX: false, fittedY: false });
  const w = applyFitMode(base, "width");
  assert.equal(w.minWidth, 0); assert.equal(w.minHeight, 700); assert.equal(w.zoom, "y");
  const e = applyFitMode(base, "entire");
  assert.equal(e.minWidth + e.minHeight, 0); assert.equal(e.zoom, null);
});
