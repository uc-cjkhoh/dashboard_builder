import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultShelf } from "../../src/DashboardBuilder/Features/Dashboard/placement-model.js";

test("measures place on Rows, dimensions on Columns", () => {
  assert.deepEqual(defaultShelf("measure"), { shelf: "rows", label: "Rows" });
  assert.deepEqual(defaultShelf("dimension"), { shelf: "columns", label: "Columns" });
});

import { placesOnDblClick } from "../../src/DashboardBuilder/Features/Dashboard/placement-model.js";
const target = (hit) => ({ closest: (sel) => (hit && sel.split(",").map((s) => s.trim()).includes(hit) ? {} : null) });

test("a double-click places unless it lands on a control or an editable", () => {
  assert.equal(placesOnDblClick(target(null)), true);
  for (const c of ["input", "button", "select", "[contenteditable]"]) assert.equal(placesOnDblClick(target(c)), false, c);
  assert.equal(placesOnDblClick(null), false);
});
