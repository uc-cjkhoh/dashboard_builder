import { test } from "node:test";
import assert from "node:assert/strict";
import { onBottomEdge, clampHeight, heightStore, EDGE } from "../../src/DashboardBuilder/Features/Core/edge-resize.js";

test("the strip just inside and on the bottom border is the grip", () => {
  assert.equal(onBottomEdge(500, 500), true);
  assert.equal(onBottomEdge(501, 500), true);
  assert.equal(onBottomEdge(500 - EDGE, 500), true);
});
test("above the strip or below the border is not the grip", () => {
  assert.equal(onBottomEdge(500 - EDGE - 1, 500), false);
  assert.equal(onBottomEdge(502, 500), false);
  assert.equal(onBottomEdge(Number.NaN, 500), false);
});
test("a height is kept inside [min, max] and rounded", () => {
  assert.equal(clampHeight(200.4, 80, 400), 200);
  assert.equal(clampHeight(10, 80, 400), 80);
  assert.equal(clampHeight(900, 80, 400), 400);
  assert.equal(clampHeight(300, 80, 50), 80);
  assert.equal(clampHeight(Number.NaN, 80, 400), 80);
});
const fakeStorage = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
test("heights are remembered per key and can be cleared", () => {
  const store = heightStore(fakeStorage(), "h");
  assert.equal(store.get("table:a.b"), null);
  store.set("table:a.b", 210.6); store.set("table:a.c", 90);
  assert.equal(store.get("table:a.b"), 211);
  store.clear("table:a.b");
  assert.equal(store.get("table:a.b"), null);
  assert.equal(store.get("table:a.c"), 90);
});
test("corrupt or blocked storage reads as no remembered height", () => {
  assert.equal(heightStore(fakeStorage({ h: "{nope" }), "h").get("k"), null);
  assert.equal(heightStore(fakeStorage({ h: "[1]" }), "h").get("k"), null);
  assert.equal(heightStore(fakeStorage({ h: '{"k":-5}' }), "h").get("k"), null);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const store = heightStore(blocked, "h");
  assert.equal(store.get("k"), null);
  store.set("k", 100); store.clear("k"); // no throw
  assert.equal(heightStore(null, "h").get("k"), null);
});
