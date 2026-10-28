import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";
import { buildRowsRequest, tableRowsRequest, rowsToCsv, rowsSummary, cellText, DEFAULT_LIMIT } from "../../src/DashboardBuilder/Features/Rows/rows-model.js";

const plan = (filters = []) => ({ from: { db: "d", table: "orders" }, joins: [], filters, measures: [], limit: 50 });
const f = (table, column, op, value, values = null) => ({ db: "d", table, column, op, value, values });

test("limits mirror the server: default 100, cap 1000", () => {
  assert.equal(DEFAULT_LIMIT, 100);
  assert.equal(LIMITS.viewRows, 1000);
});
test("a view with no selection reads the base table with the view's filters", () => {
  const { request, notes } = buildRowsRequest({ plan: plan([f("orders", "region", "in", "", ["N", "S"]), f("orders", "qty", ">", "3")]) });
  assert.deepEqual(request, { db: "d", table: "orders", filters: [
    { column: "region", op: "in", value: "", values: ["N", "S"] }, { column: "qty", op: ">", value: "3", values: null }], limit: 100 });
  assert.deepEqual(notes, []);
});
test("a selected mark adds a bound = filter on its column", () => {
  const { request } = buildRowsRequest({ plan: plan([f("orders", "qty", ">", "3")]), selection: { db: "d", table: "orders", column: "region", value: "N" } });
  assert.deepEqual(request.filters.at(-1), { column: "region", op: "=", value: "N", values: null });
  assert.equal(request.filters.length, 2);
});
test("a numeric selection value is sent as text", () => {
  const { request } = buildRowsRequest({ plan: plan(), selection: { db: "d", table: "orders", column: "n", value: 5 } });
  assert.equal(request.filters[0].value, "5");
});
test("filters on joined tables are skipped and counted in the notes", () => {
  const { request, notes } = buildRowsRequest({ plan: plan([f("customers", "tier", "=", "gold"), f("orders", "qty", ">", "1")]) });
  assert.equal(request.filters.length, 1);
  assert.match(notes[0], /1 filter on a joined table/);
});
test("a selection on a joined table is skipped with a note", () => {
  const { request, notes } = buildRowsRequest({ plan: plan(), selection: { db: "d", table: "customers", column: "tier", value: "gold" } });
  assert.deepEqual(request.filters, []);
  assert.match(notes[0], /selected mark.*joined table/);
});
test("a NULL mark can't be matched and says so", () => {
  const { request, notes } = buildRowsRequest({ plan: plan(), selection: { db: "d", table: "orders", column: "region", value: null } });
  assert.deepEqual(request.filters, []);
  assert.match(notes[0], /NULL/);
});
test("top-N filters are never sent (rows have no ranking)", () => {
  const { request, notes } = buildRowsRequest({ plan: plan([f("orders", "region", "top", "5")]) });
  assert.deepEqual(request.filters, []);
  assert.match(notes[0], /Top-N/);
});
test("a plan with no filters omits the filters key's content", () => {
  assert.deepEqual(buildRowsRequest({ plan: plan() }).request.filters, []);
});
test("an in-range limit is kept, an out-of-range one is refused, never clamped", () => {
  assert.equal(buildRowsRequest({ plan: plan(), limit: 1000 }).request.limit, 1000);
  assert.throws(() => buildRowsRequest({ plan: plan(), limit: 1001 }), /between 1 and 1000/);
  assert.throws(() => buildRowsRequest({ plan: plan(), limit: 0 }), /between 1 and 1000/);
});
test("a table preview asks for the first rows of one table", () => {
  assert.deepEqual(tableRowsRequest("d", "t"), { db: "d", table: "t", limit: 20 });
  assert.deepEqual(tableRowsRequest("d", "t", 5), { db: "d", table: "t", limit: 5 });
  assert.throws(() => tableRowsRequest("d", "t", 5000), /between 1 and 1000/);
});
test("CSV quotes, doubles quotes, writes null as empty and defuses formulas", () => {
  const csv = rowsToCsv([{ name: "a,b", type: "String" }, { name: "n", type: "Int32" }], [["x\"y", null], ["=1+1", "2"], ["line\nbreak", "-3"]]);
  assert.equal(csv, '"a,b",n\r\n"x""y",\r\n\'=1+1,2\r\n"line\nbreak",\'-3\r\n');
});
test("the summary says how many rows, of which table, and whether more exist", () => {
  assert.equal(rowsSummary({ rows: [[1], [2]], truncated: false }), "2 rows");
  assert.equal(rowsSummary({ rows: [[1]], truncated: false }), "1 row");
  assert.equal(rowsSummary({ rows: new Array(100).fill([1]), truncated: true }), "First 100 rows — more exist");
  assert.equal(rowsSummary({ rows: [], truncated: false }), "No rows");
});
test("cells show NULL distinctly from an empty string", () => {
  assert.deepEqual(cellText(null), { text: "NULL", isNull: true });
  assert.deepEqual(cellText(""), { text: "", isNull: false });
  assert.deepEqual(cellText("a"), { text: "a", isNull: false });
});
