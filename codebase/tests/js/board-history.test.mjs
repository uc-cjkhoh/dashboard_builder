import { test } from "node:test";
import assert from "node:assert/strict";
import { createBoardHistory, restorable } from "../../src/DashboardBuilder/Features/Board/board-history.js";

const w = (id, x, y) => ({ id, kind: "sheet", sheetId: "ws#1", x, y, w: 6, h: 4 });
const t = (id, heading) => ({ id, kind: "text", heading, body: "", x: 0, y: 4, w: 12, h: 2 });

test("one step per edit: add, move, resize, text edit, remove undo and redo in order, keyed by dashboard", () => {
  const h = createBoardHistory();
  let cur = [];
  const commit = (next) => { h.record("db#1", cur); cur = next; };
  commit([w("a", 0, 0)]);                       // add
  commit([w("a", 2, 0)]);                       // move
  commit([{ ...w("a", 2, 0), w: 8 }]);          // resize
  commit([{ ...w("a", 2, 0), w: 8 }, t("t", "Hi")]); // add text
  commit([{ ...w("a", 2, 0), w: 8 }, t("t", "Bye")]); // text edit
  commit([t("t", "Bye")]);                      // remove
  assert.equal(h.canUndo("db#1"), true);
  assert.equal(h.canUndo("db#2"), false);
  const seen = [];
  for (let i = 0; i < 6; i++) { cur = h.undo("db#1", cur); seen.push(cur.map((x) => x.id + (x.heading ?? "") + x.x + x.w).join()); }
  assert.deepEqual(seen, ["a28,tBye012", "a28,tHi012", "a28", "a26", "a06", ""]);
  assert.equal(h.undo("db#1", cur), null);
  assert.equal(h.canRedo("db#1"), true);
  cur = h.redo("db#1", cur);
  assert.deepEqual(cur.map((x) => x.id), ["a"]);
});
test("a new edit clears redo; snapshots are copies (later mutation can't corrupt history)", () => {
  const h = createBoardHistory();
  const a = [w("a", 0, 0)];
  h.record("d", a);
  a[0].x = 9;
  const back = h.undo("d", a);
  assert.equal(back[0].x, 0);
  assert.equal(h.canRedo("d"), true);
  h.record("d", back);
  assert.equal(h.canRedo("d"), false);
});
test("history is capped at 50 steps", () => {
  const h = createBoardHistory();
  for (let i = 0; i < 60; i++) h.record("d", [w("a", i % 6, 0)]);
  let n = 0, cur = [];
  while ((cur = h.undo("d", cur))) n++;
  assert.equal(n, 50);
});
test("restorable drops worksheet widgets whose worksheet was closed, keeps text and live sheets", () => {
  const snap = [w("a", 0, 0), { ...w("b", 6, 0), sheetId: "ws#9" }, t("t", "x")];
  assert.deepEqual(restorable(snap, (id) => id === "ws#1").map((x) => x.id), ["a", "t"]);
});
