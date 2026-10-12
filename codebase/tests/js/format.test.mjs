import { test } from "node:test";
import assert from "node:assert/strict";
import { makeValueFormatter } from "../../src/DashboardBuilder/Features/Core/format.js";
test("text measure values (min/max of a date or text field) show as-is", () => {
  const f = makeValueFormatter({});
  assert.equal(f("2024-01-02"), "2024-01-02"); assert.equal(f(null), "—"); assert.equal(f(1234.5), (1234.5).toLocaleString(undefined, { maximumFractionDigits: 2 }));
});
