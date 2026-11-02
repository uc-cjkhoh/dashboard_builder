import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultShelf } from "../../src/DashboardBuilder/Features/Dashboard/placement-model.js";

test("measures place on Rows, dimensions on Columns", () => {
  assert.deepEqual(defaultShelf("measure"), { shelf: "rows", label: "Rows" });
  assert.deepEqual(defaultShelf("dimension"), { shelf: "columns", label: "Columns" });
});
