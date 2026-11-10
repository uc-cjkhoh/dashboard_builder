import test from "node:test";
import assert from "node:assert/strict";
import { defaultOpFor, newFilter, caseMiss, caseMissText, conflicts, conflictNotice, conflictFor, emptyMessage, selectionLabel }
  from "../../src/DashboardBuilder/Features/Dashboard/filter-hints.js";
import { checkFilter } from "../../src/DashboardBuilder/Features/Dashboard/filter-rules.js";
import { sanitizeSheet } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

const F = (op, extra = {}) => ({ db: "d", table: "orders", column: "status", category: "text", op, value: "", ...extra });

test("a new filter on a text dimension starts as an 'in' list; other fields start as '='", () => {
  assert.equal(defaultOpFor("text"), "in");
  for (const c of ["numeric", "temporal", "boolean", undefined]) assert.equal(defaultOpFor(c), "=");
  const f = newFilter({ db: "d", table: "t", column: "c", category: "text" });
  assert.deepEqual([f.op, f.values], ["in", []]);
  assert.deepEqual([newFilter({ db: "d", table: "t", column: "n", category: "numeric" }).op, newFilter({ db: "d", table: "t", column: "n", category: "numeric" }).value], ["=", ""]);
});

test("caseMiss: a typed value that matches a member only by case names that member", () => {
  const members = ["Shipped", "Cancelled", null, "Returned"];
  assert.equal(caseMiss("shipped", members), "Shipped");
  assert.equal(caseMiss("  SHIPPED ", members), "Shipped");
  assert.equal(caseMiss("Shipped", members), null);       // exact: nothing to say
  assert.equal(caseMiss("Pending", members), null);       // no near member
  assert.equal(caseMiss("", members), null);
  assert.equal(caseMiss("x", []), null);
  assert.equal(caseMissText("shipped", "Shipped"), "No member 'shipped' — did you mean 'Shipped'?");
});

test("conflicts: two filters on one field that cannot both be true", () => {
  const a = F("in", { values: ["Cancelled", "Returned"] }), b = F("=", { value: "Shipped" });
  assert.deepEqual(conflicts([a, b]), [{ column: "orders.status", indexes: [0, 1] }]);
  assert.equal(conflictNotice([a, b]), "These two filters on orders.status exclude each other.");
  assert.equal(conflictFor([a, b], 1), "These two filters on orders.status exclude each other.");
  assert.equal(conflictFor([a, b, F("=", { value: "x", column: "other" })], 2), null);
  // two different values with =
  assert.equal(conflicts([F("=", { value: "A" }), F("=", { value: "B" })]).length, 1);
  // = against not in
  assert.equal(conflicts([F("=", { value: "A" }), F("notin", { values: ["A", "B"] })]).length, 1);
  assert.equal(conflicts([F("=", { value: "A" }), F("notin", { values: ["B"] })]).length, 0);
  // in vs in with no overlap
  assert.equal(conflicts([F("in", { values: ["A"] }), F("in", { values: ["B"] })]).length, 1);
  assert.equal(conflicts([F("in", { values: ["A", "B"] }), F("in", { values: ["B"] })]).length, 0);
  // empty or invalid filters are not applied, so they can't conflict; other tables are other fields
  assert.equal(conflicts([F("=", { value: "" }), F("=", { value: "B" })]).length, 0);
  assert.equal(conflicts([F("=", { value: "A" }), F("=", { value: "B", table: "customers" })]).length, 0);
  assert.equal(conflicts([a]).length, 0);
  assert.equal(conflictNotice([a]), null);
});

test("emptyMessage: filters that removed every row are not 'no data'", () => {
  const plain = { filters: [], period: null, pages: null, drill: null };
  assert.equal(emptyMessage(plain), "No data for these fields.");
  assert.equal(emptyMessage({ ...plain, filters: [F("=", { value: "A" })] }), "No rows match the filters.");
  assert.equal(emptyMessage({ ...plain, filters: [F("=", { value: "" })] }), "No data for these fields."); // an empty filter filters nothing
  assert.equal(emptyMessage({ ...plain, period: { preset: "last30" } }), "No rows match the filters.");
  assert.equal(emptyMessage({ ...plain, pages: { column: "c" } }), "No rows match the filters.");
  assert.equal(emptyMessage({ ...plain, drill: { levels: [{}] } }), "No rows match the filters.");
  assert.equal(emptyMessage({ ...plain, drill: { levels: [] } }), "No data for these fields.");
  assert.equal(emptyMessage(plain, { shared: 1 }), "No rows match the filters.");
  assert.equal(emptyMessage({ ...plain, selection: { action: "keep" } }), "No rows match the filters.");
  assert.equal(emptyMessage({ ...plain, selection: { action: null } }), "No data for these fields.");
});

test("selectionLabel: an active Keep only / Exclude shows on the Filters tile; a plain highlight does not", () => {
  assert.equal(selectionLabel({ action: "keep", label: "Malaysia" }), "Keep only Malaysia");
  assert.equal(selectionLabel({ action: "exclude", label: "Malaysia" }), "Exclude Malaysia");
  assert.equal(selectionLabel({ action: null, label: "Malaysia" }), null);
  assert.equal(selectionLabel(null), null);
});

test("empty '=' and empty 'in' filters are both kept on restore", () => {
  const issues = [];
  const s = sanitizeSheet({ filters: [F("="), F("in", { values: [] })] }, "w", issues);
  assert.deepEqual(s.filters.map((f) => f.op), ["=", "in"]);
  assert.equal(checkFilter(F("=")).state, "empty");
  assert.equal(checkFilter(F("in", { values: [] })).state, "empty");
});

test("Top N names its allowed range", () => {
  const f = F("top", { value: "5000", topBy: { column: "x" } });
  assert.equal(checkFilter(f).error, "Top N must be 1–1000.");
});

test("conflicts compare numbers and dates by value, not as text", () => {
  const N = (op, extra) => F(op, { category: "numeric", column: "qty", ...extra });
  assert.equal(conflicts([N("=", { value: "1" }), N("=", { value: "1.0" })]).length, 0);
  assert.equal(conflicts([N("=", { value: "1" }), N("=", { value: "2" })]).length, 1);
  assert.equal(conflicts([N("in", { values: ["1", "2"] }), N("=", { value: "2.00" })]).length, 0);
  const D = (op, extra) => F(op, { category: "temporal", column: "placed", ...extra });
  assert.equal(conflicts([D("=", { value: "2024-03-01" }), D("=", { value: "2024-03-01 00:00:00" })]).length, 0);
  assert.equal(conflicts([D("=", { value: "2024-03-01" }), D("=", { value: "2024-03-02" })]).length, 1);
  assert.equal(conflicts([F("=", { value: "A" }), F("=", { value: "a" })]).length, 1); // text stays case-sensitive
});
test("a half-filled custom range is not applied, so it does not make an empty result a filter miss", () => {
  const plain = { filters: [], period: null, pages: null, drill: null };
  const custom = { preset: "custom", from: "2024-01-01", to: null };
  assert.equal(emptyMessage({ ...plain, period: custom }), "No data for these fields.");
  assert.equal(emptyMessage({ ...plain, period: { ...custom, to: "2024-02-01" } }), "No rows match the filters.");
});
