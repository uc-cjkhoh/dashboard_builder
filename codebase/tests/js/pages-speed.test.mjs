import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_SPEEDS, pageSpeedError, pageSpeedOf, pageIntervalMs, cleanPageSpeed } from "../../src/DashboardBuilder/Features/Dashboard/pages-speed-model.js";

test("an unset or unknown speed plays at Medium, the 1.5 s step Play has always used", () => {
  assert.equal(pageSpeedOf(null), "medium");
  assert.equal(pageSpeedOf({}), "medium");
  assert.equal(pageSpeedOf({ speed: "warp" }), "medium");
  assert.equal(pageIntervalMs({}), 1500);
});
test("Slow is slower and Fast faster than Medium", () => {
  assert.ok(pageIntervalMs({ speed: "slow" }) > pageIntervalMs({}));
  assert.ok(pageIntervalMs({ speed: "fast" }) < pageIntervalMs({}));
  assert.deepEqual(PAGE_SPEEDS.map(([v]) => v), ["slow", "medium", "fast"]);
});
test("a bad speed is refused, not clamped; Medium stores nothing", () => {
  assert.ok(pageSpeedError("quick"));
  assert.ok(pageSpeedError(2));
  assert.equal(pageSpeedError("fast"), null);
  assert.deepEqual(cleanPageSpeed("medium"), { ok: true, value: null });
  assert.deepEqual(cleanPageSpeed("slow"), { ok: true, value: "slow" });
  assert.equal(cleanPageSpeed("quick").ok, false);
});
