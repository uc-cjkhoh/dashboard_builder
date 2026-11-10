import { test } from "node:test";
import assert from "node:assert/strict";
import { matchTables } from "../../src/DashboardBuilder/Features/Schema/table-filter.js";
test("search is case-insensitive and trimmed; blank shows all", () => {
  const t = ["orders", "Order_items", "customers"];
  assert.deepEqual(matchTables(t, "  ORDER "), ["orders", "Order_items"]);
  assert.deepEqual(matchTables(t, "   "), t);
  assert.deepEqual(matchTables(t, "zzz"), []);
});
