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

import { marksOpen, marksSummary, MARKS_PREF_KEY, readMarksPref } from "../../src/DashboardBuilder/Features/Dashboard/fields-pane-model.js";
test("Marks starts collapsed only when no slot is set; a remembered choice wins", () => {
  assert.equal(marksOpen(null, 0), false);
  assert.equal(marksOpen(null, 2), true);
  assert.equal(marksOpen("open", 0), true);
  assert.equal(marksOpen("closed", 3), false);
});
test("the collapsed summary names the set slots in one line", () => {
  const tools = [{ label: "Color", count: 1 }, { label: "Size", count: 0 }, { label: "Detail", count: 2 }];
  assert.equal(marksSummary(tools), "Color, Detail (2)");
  assert.equal(marksSummary([{ label: "Color", count: 0 }]), "");
});
test("the remembered Marks choice reads back", () => {
  const store = (v) => ({ getItem: (k) => (k === MARKS_PREF_KEY ? v : null) });
  assert.equal(readMarksPref(store("open")), "open");
  assert.equal(readMarksPref(store("closed")), "closed");
  assert.equal(readMarksPref(store("x")), null);
  assert.equal(readMarksPref({ getItem() { throw new Error("blocked"); } }), null);
});
