import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";
import { buildRowsRequest, entityRowsQuery, tableRowsRequest, rowsToCsv, rowsSummary, cellText, anyCellCut, DEFAULT_LIMIT } from "../../src/DashboardBuilder/Features/Rows/rows-model.js";

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
test("rows x columns is capped at 50,000 and the message says how many rows fit", () => {
  assert.equal(LIMITS.viewCells, 50000);
  assert.deepEqual(tableRowsRequest("d", "t", 1000, ["a", "b"]), { db: "d", table: "t", columns: ["a", "b"], limit: 1000 });
  assert.throws(() => tableRowsRequest("d", "t", 1000, new Array(51).fill("c")), /51 columns allow at most 980 rows/);
  assert.equal(tableRowsRequest("d", "t", 250, new Array(200).fill("c")).limit, 250);
});
test("a cut cell is detected so the dialog can say the CSV is lossy", () => {
  assert.equal(anyCellCut([["a", null], ["b", "x".repeat(1000) + "…"]]), true);
  assert.equal(anyCellCut([["…", "x".repeat(1000)]]), false);
});

test("T02-34: a filter on a cast field, or a mark on one, is left out and named", async () => {
  const { buildRowsRequest } = await import("../../src/DashboardBuilder/Features/Rows/rows-model.js");
  const plan = { from: { db: "d", table: "t" }, filters: [
    { db: "d", table: "t", column: "qty_s", op: ">", value: "1", cast: "number" },
    { db: "d", table: "t", column: "region", op: "=", value: "EU" }] };
  const sel = { db: "d", table: "t", column: "qty_s", value: "5" };
  const { request, notes } = buildRowsRequest({ plan, selection: sel, castOf: (f) => (f.column === "qty_s" ? "number" : undefined) });
  assert.deepEqual(request.filters.map((f) => f.column), ["region"]);
  assert.equal(notes.length, 2);
  assert.ok(notes.every((n) => /data type cast/.test(n)));
});

test("buildRowsRequest sends a calculated filter whose fields are all on the base table, with its tree", () => {
  const tree = { k: "bin", op: "*", l: { k: "field", db: "s", table: "o", column: "amount" }, r: { k: "num", v: 2 } };
  const plan = { from: { db: "s", table: "o" }, filters: [{ db: "", table: "", column: "Net", op: ">", value: "1", values: null, calc: tree }] };
  const { request, notes } = buildRowsRequest({ plan, limit: 10 });
  assert.deepEqual(request.filters, [{ column: "Net", op: ">", value: "1", values: null, calc: tree }]);
  assert.deepEqual(notes, []);
});

test("buildRowsRequest names a calculated filter that reads a joined table", () => {
  const tree = { k: "bin", op: "+", l: { k: "field", db: "s", table: "o", column: "a" }, r: { k: "field", db: "s", table: "c", column: "b" } };
  const plan = { from: { db: "s", table: "o" }, filters: [{ db: "", table: "", column: "Net", op: ">", value: "1", values: null, calc: tree }] };
  const { request, notes } = buildRowsRequest({ plan, limit: 10 });
  assert.deepEqual(request.filters, []);
  assert.deepEqual(notes, ["1 filter on a calculated field across tables isn't applied to rows."]);
});

import { firstMeasureTable, viewDataTitle } from "../../src/DashboardBuilder/Features/Rows/rows-model.js";
test("the first measure's table is the base of View data, skipping a calculated pill", () => {
  const m = (field) => ({ field, role: "shelf", agg: "sum" });
  assert.deepEqual(firstMeasureTable([m({ db: "shop", table: "orders", column: "qty" }), m({ db: "shop", table: "x", column: "y" })]), { db: "shop", table: "orders" });
  assert.deepEqual(firstMeasureTable([m({ calc: "[a]+1", name: "c" }), m({ db: "shop", table: "orders", column: "qty" })]), { db: "shop", table: "orders" });
  assert.equal(firstMeasureTable([]), null);
  assert.equal(firstMeasureTable([m({ calc: "1" })]), null);
});
test("a base other than the plan's first table reads that table; filters elsewhere are noted", () => {
  const p = { from: { db: "d", table: "customers" }, joins: [], filters: [f("customers", "country", "=", "VN"), f("orders", "qty", ">", "1")], measures: [] };
  const { request, notes } = buildRowsRequest({ plan: p, base: { db: "d", table: "orders" } });
  assert.equal(request.table, "orders");
  assert.deepEqual(request.filters, [{ column: "qty", op: ">", value: "1", values: null }]);
  assert.match(notes[0], /1 filter on a joined table isn't applied/);
});
test("the dialog title names the table plainly", () => {
  assert.equal(viewDataTitle({ db: "shop", table: "orders" }), "Rows of shop.orders behind this view");
  assert.equal(viewDataTitle({ db: "shop", table: "orders" }, "Vietnam"), "Rows of shop.orders behind Vietnam");
});

// --- the Data Source preview of one card (Canvas/data-preview.js) ---
test("a table card reads /api/rows with no source", () => {
  assert.deepEqual(entityRowsQuery({ db: "d", table: "orders" }), { load: "rows", request: { db: "d", table: "orders", limit: 100 } });
});
test("a card with custom SQL sends its query as the source of the same table", () => {
  assert.deepEqual(entityRowsQuery({ db: "d", table: "orders", customSql: "SELECT 1 AS x" }),
    { load: "rows", request: { db: "d", table: "orders", limit: 100, source: { kind: "sql", db: "d", name: "orders", sql: "SELECT 1 AS x" } } });
});
test("a union card reads /api/union with its tables (and its columns when picked)", () => {
  const source = { kind: "union", db: "d", name: "Union: a + b", tables: ["a", "b"] };
  assert.deepEqual(entityRowsQuery({ db: "d", table: source.name, source }), { load: "union", request: { db: "d", tables: ["a", "b"], limit: 100 } });
  assert.deepEqual(entityRowsQuery({ db: "d", table: source.name, source: { ...source, columns: ["id"] } }).request.columns, ["id"]);
});
test("an unpivot card reads /api/unpivot with its columns and kept columns", () => {
  const source = { kind: "unpivot", db: "d", name: "Unpivot: t", table: "t", columns: ["q1", "q2"], keep: ["id"] };
  assert.deepEqual(entityRowsQuery({ db: "d", table: source.name, source }), { load: "unpivot", request: { db: "d", table: "t", columns: ["q1", "q2"], keep: ["id"], limit: 100 } });
  assert.deepEqual(entityRowsQuery({ db: "d", table: source.name, source: { ...source, keep: undefined } }).request.keep, []);
});
test("the preview limit is checked like any row read", () => {
  assert.equal(entityRowsQuery({ db: "d", table: "t" }, 5).request.limit, 5);
  assert.throws(() => entityRowsQuery({ db: "d", table: "t" }, 0), /Limit must be between 1 and 1000/);
  assert.throws(() => entityRowsQuery({ db: "d", table: "t" }, 1001), /Limit/);
});
