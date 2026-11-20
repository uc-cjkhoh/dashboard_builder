import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../../src/DashboardBuilder/Features/Canvas/empty-state.js";
test("disconnected points at the connection host", () => {
  const s = emptyState({ connected: false, databaseOpen: false });
  assert.equal(s.action, "Connect"); assert.equal(s.focusId, "conn-host");
});
test("connected with no database open points at the first database row, not the table rows that do not exist yet", () => {
  const s = emptyState({ connected: true, databaseOpen: false });
  assert.equal(s.focusId, "db-first"); assert.equal(s.action, "Open a database");
});
test("connected with a database open points at the search", () => {
  const s = emptyState({ connected: true, databaseOpen: true });
  assert.equal(s.focusId, "table-search"); assert.match(s.text, /Drag a table/);
});
