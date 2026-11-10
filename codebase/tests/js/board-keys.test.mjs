import { test } from "node:test";
import assert from "node:assert/strict";
import { keyStep } from "../../src/DashboardBuilder/Features/Board/board-keys.js";

const sh = (id, x, y, w = 6, h = 4) => ({ id, kind: "sheet", sheetId: "ws#1", x, y, w, h });
const txt = (id, x, y, w = 12, h = 2) => ({ id, kind: "text", heading: "T", body: "", x, y, w, h });
const nameOf = (w) => `N-${w.id}`;
const step = (ws, id, key, shift = false) => keyStep(ws, ws.find((w) => w.id === id), key, shift, nameOf);

test("non-arrow keys are not handled", () => {
  assert.equal(step([sh("a", 0, 0)], "a", "Enter"), null);
  assert.equal(step([sh("a", 0, 0)], "a", "a", true), null);
});

test("arrows move by one cell and announce 1-based column and row", () => {
  const ws = [sh("a", 3, 2, 4, 3)];
  assert.deepEqual(step(ws, "a", "ArrowRight"), { ok: true, cand: { ...ws[0], x: 4 }, message: "Moved to column 5, row 3" });
  assert.deepEqual(step(ws, "a", "ArrowLeft").cand, { ...ws[0], x: 2 });
  assert.equal(step(ws, "a", "ArrowDown").message, "Moved to column 4, row 4");
  assert.equal(step(ws, "a", "ArrowUp").message, "Moved to column 4, row 2");
});

test("Shift + arrows resize from the bottom-right corner and announce the size", () => {
  const ws = [sh("a", 0, 0, 4, 3)];
  assert.equal(step(ws, "a", "ArrowRight", true).message, "Resized to 5 columns by 3 rows");
  assert.equal(step(ws, "a", "ArrowDown", true).message, "Resized to 4 columns by 4 rows");
  assert.equal(step(ws, "a", "ArrowLeft", true).message, "Resized to 3 columns by 3 rows");
  assert.equal(step(ws, "a", "ArrowUp", true).message, "Resized to 4 columns by 2 rows");
  assert.equal(step([txt("t", 0, 0, 12, 2)], "t", "ArrowUp", true).message, "Resized to 12 columns by 1 row");
});

test("every refusal says why: edges, limits, overlap", () => {
  const ws = [sh("a", 0, 0, 6, 4), sh("b", 6, 0, 6, 4), sh("c", 0, 92, 4, 4), sh("d", 0, 10, 2, 2), sh("e", 8, 20, 4, 24)];
  const why = (id, key, shift) => { const r = step(ws, id, key, shift); assert.equal(r.ok, false); return r.message; };
  assert.equal(why("a", "ArrowLeft"), "Can't move: the widget is at the left edge of the dashboard.");
  assert.equal(why("a", "ArrowUp"), "Can't move: the widget is at the top of the dashboard.");
  assert.equal(why("b", "ArrowRight"), "Can't move: the widget is at the right edge of the dashboard.");
  assert.equal(why("c", "ArrowDown"), "Can't move: the dashboard is at most 96 rows tall.");
  assert.equal(why("a", "ArrowRight"), "Can't move: it would overlap “N-b”. Move or shrink that widget first.");
  assert.equal(why("d", "ArrowLeft", true), "Can't resize: a widget is at least 2 columns wide.");
  assert.equal(why("d", "ArrowUp", true), "Can't resize: a worksheet widget is at least 2 rows tall.");
  assert.equal(why("b", "ArrowRight", true), "Can't resize: the widget is at the right edge of the dashboard.");
  assert.equal(why("e", "ArrowDown", true), "Can't resize: a widget is at most 24 rows tall.");
  assert.equal(why("a", "ArrowRight", true), "Can't resize: it would overlap “N-b”. Move or shrink that widget first.");
  assert.equal(why("c", "ArrowDown", true), "Can't resize: the dashboard is at most 96 rows tall.");
});

test("a text widget's refusal at one row names the text minimum", () => {
  const ws = [txt("t", 0, 0, 12, 1)];
  assert.equal(step(ws, "t", "ArrowUp", true).message, "Can't resize: a text widget is at least 1 row tall.");
});

test("a refused step returns no candidate, so nothing can be committed", () => {
  const r = step([sh("a", 0, 0)], "a", "ArrowLeft");
  assert.equal("cand" in r, false);
});
