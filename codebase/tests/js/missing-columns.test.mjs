import { test } from "node:test";
import assert from "node:assert/strict";
import { columnState, missingIn, pruneMissing, missingMessage, catalogIssues } from "../../src/DashboardBuilder/Features/Dashboard/missing-columns.js";
import { restoredSummary, issueCount } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

const ent = (db, table, names, extra = {}) => ({ db, table, columns: names.map((name) => ({ name })), ...extra });
const entities = new Map([["a", ent("shop", "orders", ["country", "quantity"])], ["b", ent("shop", "pending", [])]]);
const pill = (column, table = "orders", extra = {}) => ({ db: "shop", table, column, category: "numeric", ...extra });
const sheet = (over = {}) => ({ rows: [pill("country")], columns: [pill("quantity_typo", "orders", { agg: "sum" })], color: [], filters: [], marks: { detail: [], tooltip: [], label: null }, ...over });

test("columnState: ok, missing, and unknown while the catalog is not loaded or the table is not in the model", () => {
  assert.equal(columnState(entities, "shop", "orders", "quantity"), "ok");
  assert.equal(columnState(entities, "shop", "orders", "quantity_typo"), "missing");
  assert.equal(columnState(entities, "shop", "pending", "x"), "unknown");
  assert.equal(columnState(entities, "shop", "nowhere", "x"), "unknown");
});
test("missingIn lists each missing column once, across shelves, filters and marks; calculated pills are never missing", () => {
  const s = sheet({ filters: [pill("quantity_typo", "orders", { op: "=" })], marks: { detail: [], tooltip: [pill("ghost")], label: null }, rows: [pill("country"), { calc: "calc1", db: "", table: "", column: "Margin" }] });
  assert.deepEqual(missingIn(s, entities).map((m) => `${m.table}.${m.column}`), ["orders.quantity_typo", "orders.ghost"]);
});
test("the message names the column and its table", () => {
  assert.equal(missingMessage({ db: "shop", table: "orders", column: "quantity_typo" }), "orders.quantity_typo isn't in shop.orders — left out.");
});
test("pruneMissing leaves the sheet alone when nothing is missing", () => {
  const s = sheet({ columns: [pill("quantity")] });
  const r = pruneMissing(s, entities);
  assert.equal(r.sheet, s);
  assert.deepEqual(r.missing, []);
});
test("pruneMissing drops missing pills from a copy; the saved sheet keeps them", () => {
  const s = sheet({ filters: [pill("quantity_typo")], marks: { detail: [pill("ghost")], tooltip: [], label: pill("ghost2"), size: pill("quantity") }, period: pill("nope"), pages: pill("nope2"), drill: { levels: [pill("country"), pill("nope3")] } });
  const r = pruneMissing(s, entities);
  assert.equal(r.sheet.columns.length, 0);
  assert.equal(r.sheet.rows.length, 1);
  assert.equal(r.sheet.filters.length, 0);
  assert.equal(r.sheet.marks.detail.length, 0);
  assert.equal(r.sheet.marks.label, null);
  assert.equal(r.sheet.marks.size.column, "quantity");
  assert.equal(r.sheet.period, null);
  assert.equal(r.sheet.pages, null);
  assert.equal(r.sheet.drill.levels.length, 1);
  assert.equal(s.columns.length, 1, "the original is untouched");
  assert.equal(r.missing.length, 6);
});
test("catalogIssues words each missing column per worksheet, once", () => {
  const catalog = new Map([["shop\u0000orders", new Set(["country", "quantity"])]]);
  const worksheets = [{ name: "Sales by country", sheet: sheet({ filters: [pill("quantity_typo")] }) }, { name: "Other", sheet: sheet({ columns: [pill("quantity")] }) }];
  assert.deepEqual(catalogIssues(worksheets, catalog), ['Sheet "Sales by country": orders.quantity_typo isn\'t in shop.orders — left out.']);
  assert.deepEqual(catalogIssues(worksheets, new Map()), [], "an unknown table is not reported");
});

test("restoredSummary counts unions and unpivots apart from tables", () => {
  const wb = { entities: [{}, {}, { source: { kind: "union" } }, { source: { kind: "unpivot" } }], worksheets: [1], dashboards: [], stories: [] };
  assert.equal(restoredSummary(wb), "Restored your last workbook (2 tables, 2 unions/unpivots, 1 worksheet).");
  assert.equal(restoredSummary({ entities: [{}], worksheets: [], dashboards: [1, 2], stories: [1] }), "Restored your last workbook (1 table, 0 worksheets, 2 dashboards, 1 story).");
});
test("issueCount uses singular and plural", () => {
  assert.equal(issueCount(1), "1 issue");
  assert.equal(issueCount(3), "3 issues");
});
