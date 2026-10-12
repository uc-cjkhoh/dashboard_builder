import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../../src/DashboardBuilder/Features/Canvas/empty-state.js";
test("disconnected points at the connection host", () => {
  const s = emptyState({ connected: false, databaseSelected: false });
  assert.equal(s.action, "Connect"); assert.equal(s.focusId, "conn-host");
});
test("connected without a database points at the database select, not the hidden table search", () => {
  const s = emptyState({ connected: true, databaseSelected: false });
  assert.equal(s.focusId, "db-select"); assert.equal(s.action, "Choose a database");
});
test("connected with a database points at the table search", () => {
  const s = emptyState({ connected: true, databaseSelected: true });
  assert.equal(s.focusId, "table-search"); assert.match(s.text, /Drag a table/);
});
