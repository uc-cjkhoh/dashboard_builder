import { test } from "node:test";
import assert from "node:assert/strict";
import { matchTables } from "../../src/DashboardBuilder/Features/Schema/table-filter.js";
import { advancedShouldOpen } from "../../src/DashboardBuilder/Features/Connection/connection-rules.js";
test("search is case-insensitive and trimmed; blank shows all", () => {
  const t = ["orders", "Order_items", "customers"];
  assert.deepEqual(matchTables(t, "  ORDER "), ["orders", "Order_items"]);
  assert.deepEqual(matchTables(t, "   "), t);
  assert.deepEqual(matchTables(t, "zzz"), []);
});
test("Advanced opens when TLS is off or the certificate opt-in is on", () => {
  assert.equal(advancedShouldOpen({ secure: true, allowInvalidCert: false }), false);
  assert.equal(advancedShouldOpen({ secure: false, allowInvalidCert: false }), true);
  assert.equal(advancedShouldOpen({ secure: true, allowInvalidCert: true }), true);
});
