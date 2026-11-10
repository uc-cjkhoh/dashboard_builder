import { test } from "node:test";
import assert from "node:assert/strict";
import { isIdLike, defaultRole } from "../../src/DashboardBuilder/Features/Dashboard/field-role.js";
import { roleOf } from "../../src/DashboardBuilder/Features/Dashboard/show-me-rules.js";

test("identifier-looking names", () => {
  for (const n of ["id", "ID", "order_id", "Customer_ID", "line_no", "sku_key", "zip_code", "orderId", "customerID", "row_num", "invoice_number", "uuid", "pk"])
    assert.equal(isIdLike(n), true, n);
  for (const n of ["quantity", "amount", "paid", "valid", "width", "no", "code_count", "grid", "unit_price", "idle_time", "", null, undefined])
    assert.equal(isIdLike(n), false, String(n));
});
test("defaultRole: numeric id-like columns are dimensions, other numbers measures, the rest dimensions", () => {
  assert.equal(defaultRole("order_id", "numeric"), "dimension");
  assert.equal(defaultRole("quantity", "numeric"), "measure");
  assert.equal(defaultRole("region", "text"), "dimension");
  assert.equal(defaultRole("order_id", "text"), "dimension");
});
test("roleOf keeps its saved behaviour: an explicit role wins, and an unstamped number is still a measure", () => {
  assert.equal(roleOf({ column: "order_id", category: "numeric", role: "measure" }), "measure");
  assert.equal(roleOf({ column: "order_id", category: "numeric" }), "measure");
});
