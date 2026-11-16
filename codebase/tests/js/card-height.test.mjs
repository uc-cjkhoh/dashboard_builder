import test from "node:test";
import assert from "node:assert/strict";
import { dragListHeight, cleanListHeight, LIST_MIN, LIST_MAX } from "../../src/DashboardBuilder/Features/Canvas/card-height.js";

test("bottom edge grows and shrinks the list, top stays", () => {
  assert.deepEqual(dragListHeight({ edge: "bottom", startH: 240, startY: 100, dy: 80, fit: 1000 }), { h: 320, y: 100 });
  assert.deepEqual(dragListHeight({ edge: "bottom", startH: 240, startY: 100, dy: -80, fit: 1000 }), { h: 160, y: 100 });
});

test("top edge moves the top and keeps the bottom", () => {
  assert.deepEqual(dragListHeight({ edge: "top", startH: 240, startY: 400, dy: -80, fit: 1000 }), { h: 320, y: 320 });
  assert.deepEqual(dragListHeight({ edge: "top", startH: 240, startY: 400, dy: 80, fit: 1000 }), { h: 160, y: 480 });
});

test("heights step on the 8px grid", () => {
  assert.equal(dragListHeight({ edge: "bottom", startH: 240, startY: 0, dy: 13, fit: 1000 }).h, 256);
  assert.equal(dragListHeight({ edge: "bottom", startH: 240, startY: 0, dy: 3, fit: 1000 }).h, 240);
});

test("never past the content, never below the minimum", () => {
  assert.equal(dragListHeight({ edge: "bottom", startH: 240, startY: 0, dy: 900, fit: 500 }).h, 500);
  assert.equal(dragListHeight({ edge: "bottom", startH: 240, startY: 0, dy: -900, fit: 500 }).h, LIST_MIN);
  assert.equal(dragListHeight({ edge: "bottom", startH: 40, startY: 0, dy: 100, fit: 40 }).h, 40); // a short list cannot grow
  assert.equal(dragListHeight({ edge: "bottom", startH: 240, startY: 0, dy: 1e6, fit: Infinity }).h, LIST_MAX);
});

test("top edge stops at the canvas origin", () => {
  assert.deepEqual(dragListHeight({ edge: "top", startH: 240, startY: 40, dy: -200, fit: 1000 }), { h: 280, y: 0 });
});

test("saved list heights", () => {
  assert.equal(cleanListHeight(320), 320);
  for (const v of [null, undefined, "320", 1.5, LIST_MIN - 1, LIST_MAX + 1, -5, NaN]) assert.equal(cleanListHeight(v), null);
});

test("a workbook keeps a card's list height; a bad one is reset with a note", async () => {
  const { serializeWorkbook, parseWorkbook } = await import("../../src/DashboardBuilder/Features/Workbook/workbook-model.js");
  const entities = new Map([
    ["s.a#1", { id: "s.a#1", db: "s", table: "a", x: 0, y: 0, listHeight: 480 }],
    ["s.b#2", { id: "s.b#2", db: "s", table: "b", x: 400, y: 0 }],
  ]);
  const saved = serializeWorkbook({ entities, relationships: new Map(), tabs: [], active: null });
  assert.equal(saved.entities[0].listHeight, 480);
  assert.equal("listHeight" in saved.entities[1], false);
  const wb = parseWorkbook(JSON.stringify(saved));
  assert.equal(wb.entities[0].listHeight, 480);
  assert.equal(wb.entities[1].listHeight, undefined);
  saved.entities[0].listHeight = 5;
  const bad = parseWorkbook(JSON.stringify(saved));
  assert.equal(bad.entities[0].listHeight, undefined);
  assert.ok(bad.issues.some((i) => /s\.a: its list height was invalid/.test(i)));
});
