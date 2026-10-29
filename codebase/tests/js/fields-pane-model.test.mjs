import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldsPaneView, readCollapsed, FIELDS_COLLAPSED_KEY } from "../../src/DashboardBuilder/Features/Dashboard/fields-pane-model.js";

test("the toggle names the action it will do", () => {
  assert.deepEqual(fieldsPaneView(false), { expanded: true, label: "Hide field list" });
  assert.deepEqual(fieldsPaneView(true), { expanded: false, label: "Show field list" });
});
test("the remembered state reads back; unreadable storage means expanded", () => {
  const store = (v) => ({ getItem: (k) => (k === FIELDS_COLLAPSED_KEY ? v : null) });
  assert.equal(readCollapsed(store("1")), true);
  assert.equal(readCollapsed(store("0")), false);
  assert.equal(readCollapsed(store(null)), false);
  assert.equal(readCollapsed({ getItem() { throw new Error("blocked"); } }), false);
  assert.equal(readCollapsed(null), false);
});
