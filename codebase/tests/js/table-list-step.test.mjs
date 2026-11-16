import { test } from "node:test";
import assert from "node:assert/strict";
import { listStep } from "../../src/DashboardBuilder/Features/Schema/table-filter.js";
test("table list arrow keys step and hold at the ends", () => {
  assert.equal(listStep(0, "ArrowDown", 3), 1);
  assert.equal(listStep(2, "ArrowDown", 3), 2);
  assert.equal(listStep(0, "ArrowUp", 3), 0);
  assert.equal(listStep(2, "ArrowUp", 3), 1);
  assert.equal(listStep(1, "Home", 3), 0);
  assert.equal(listStep(0, "End", 3), 2);
});
test("table list: other keys, an empty list and a stale index", () => {
  assert.equal(listStep(0, "Enter", 3), null);
  assert.equal(listStep(0, "ArrowDown", 0), null);
  assert.equal(listStep(9, "ArrowDown", 3), 1); // an index past the list starts from the top
  assert.equal(listStep(-1, "ArrowUp", 3), 0);
});
