// Per-column alignment and width on a table worksheet — pure model, workbook round-trip (T01-23).
import { test } from "node:test";
import assert from "node:assert/strict";
import { COL_MIN, COL_MAX, COL_STEP, COL_ALIGN_CHOICES, dimKey, measKey, columnWidthError, tableColumnList, setTableColumn,
  columnLook, nudgeWidth, cleanTableCols } from "../../src/DashboardBuilder/Features/Dashboard/table-columns-model.js";
import { emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
import { restoreSheet, sanitizeSheet } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

const dim = (column) => ({ db: "d", table: "t", column, category: "text" });
const mea = (column, agg = "sum") => ({ db: "d", table: "t", column, category: "numeric", agg });

test("keys name a stub dimension (d0..) or a value column (m0..)", () => {
  assert.equal(dimKey(0), "d0"); assert.equal(measKey(2), "m2");
});
test("width bounds: whole pixels from COL_MIN to COL_MAX", () => {
  assert.equal(columnWidthError(COL_MIN), null); assert.equal(columnWidthError(COL_MAX), null);
  assert.match(columnWidthError(COL_MIN - 1), /between/); assert.match(columnWidthError(COL_MAX + 1), /between/);
  assert.match(columnWidthError(100.5), /whole/); assert.match(columnWidthError("100"), /number/);
});
test("the column list: row dimensions, then the measures when they run across the top", () => {
  const s = emptySheet(); s.chartType = "table";
  s.rows = [dim("region"), dim("country")]; s.columns = [mea("amount"), mea("qty", "avg")];
  assert.deepEqual(tableColumnList(s).map((c) => c.key), ["d0", "d1", "m0", "m1"]);
  assert.deepEqual(tableColumnList(s).map((c) => c.label), ["region", "country", "sum amount", "avg qty"]);
});
test("measures down the left leave only the row dimensions addressable", () => {
  const s = emptySheet(); s.chartType = "table";
  s.rows = [dim("region"), mea("amount")]; s.columns = [dim("year")];
  assert.deepEqual(tableColumnList(s).map((c) => c.key), ["d0"]);
});
test("setTableColumn adds, merges, removes an emptied entry, and drops columns that no longer exist", () => {
  let c = setTableColumn(undefined, "m0", { align: "left" }, ["m0", "m1"]);
  assert.deepEqual(c, { m0: { align: "left" } });
  c = setTableColumn(c, "m0", { width: 120 }, ["m0", "m1"]);
  assert.deepEqual(c, { m0: { align: "left", width: 120 } });
  c = setTableColumn(c, "m1", { width: 80 }, ["m0", "m1"]);
  assert.deepEqual(Object.keys(c), ["m0", "m1"]);
  c = setTableColumn(c, "m0", { align: null }, ["m0", "m1"]);
  assert.deepEqual(c.m0, { width: 120 });
  c = setTableColumn(c, "m0", { width: null }, ["m0", "m1"]);
  assert.deepEqual(c, { m1: { width: 80 } });
  assert.deepEqual(setTableColumn(c, "m1", { width: null }, ["m0"]), undefined, "m1 is gone from the table, and emptied: nothing stored");
  assert.equal(setTableColumn({ m5: { width: 90 } }, "m0", { align: "right" }, ["m0"]).m5, undefined, "stale keys pruned");
});
test("columnLook reads one column; unset is null", () => {
  assert.deepEqual(columnLook({ m0: { align: "centre", width: 100 } }, "m0"), { align: null, width: 100 }, "a bad align is ignored");
  assert.deepEqual(columnLook({ m0: { align: "center", width: 100 } }, "m0"), { align: "center", width: 100 });
  assert.deepEqual(columnLook(undefined, "m0"), { align: null, width: null });
});
test("nudgeWidth steps by COL_STEP and stays inside the bounds", () => {
  assert.equal(nudgeWidth(100, 1), 100 + COL_STEP);
  assert.equal(nudgeWidth(100, -1), 100 - COL_STEP);
  assert.equal(nudgeWidth(COL_MIN, -1), COL_MIN); assert.equal(nudgeWidth(COL_MAX, 1), COL_MAX);
  assert.equal(nudgeWidth(null, 1, 130), 130 + COL_STEP, "automatic starts from the drawn width");
  assert.equal(nudgeWidth(500, 100), COL_MAX, "a drag past the bound stops at it");
});
test("choices start with the table-wide setting", () => {
  assert.equal(COL_ALIGN_CHOICES[0][0], "auto");
});
test("cleanTableCols keeps valid entries and reports the rest", () => {
  const issues = [];
  const out = cleanTableCols({ m0: { align: "right", width: 90 }, d1: { width: 7 }, zz: { width: 90 }, m1: { align: "up" }, m2: 5, d0: {} }, "S", issues);
  assert.deepEqual(out, { m0: { align: "right", width: 90 } });
  assert.ok(issues.length >= 4, issues.join("|"));
  assert.equal(cleanTableCols(undefined, "S", []), undefined);
  assert.equal(cleanTableCols([1], "S", []), undefined);
});
test("workbook: absent in old sheets and untouched; round-trips; bad data reported", () => {
  const s = emptySheet();
  assert.equal("tableCols" in restoreSheet(JSON.parse(JSON.stringify(s))).format, false, "an old sheet opens unchanged");
  s.format = { ...s.format, tableCols: { m0: { align: "center", width: 144 }, d0: { width: 200 } } };
  const back = restoreSheet(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(back.format.tableCols, { m0: { align: "center", width: 144 }, d0: { width: 200 } });
  const bad = JSON.parse(JSON.stringify(emptySheet())); bad.format.tableCols = { m0: { width: 99999 } };
  const issues = [];
  assert.equal(sanitizeSheet(bad, "Sheet 1", issues).format.tableCols, undefined);
  assert.match(issues.join("|"), /Sheet 1 format: column m0 width/);
  const notObj = JSON.parse(JSON.stringify(emptySheet())); notObj.format.tableCols = "wide";
  const i2 = []; assert.equal(sanitizeSheet(notObj, "Sheet 1", i2).format.tableCols, undefined); assert.equal(i2.length, 1);
});
test("keys have no leading zero (d01, m00 are not columns)", () => {
  const issues = [];
  assert.equal(cleanTableCols({ d01: { width: 90 }, m00: { width: 90 }, m0: { width: 90 } }, "S", issues).m0.width, 90);
  assert.equal(issues.length, 2);
});
test("an explicit null align or width is unset, with no note", () => {
  const issues = [];
  assert.deepEqual(cleanTableCols({ m0: { align: null, width: 90 }, m1: { align: "left", width: null }, m2: { align: null, width: null } }, "S", issues), { m0: { width: 90 }, m1: { align: "left" } });
  assert.deepEqual(issues, []);
});
test("notes about column settings are capped, with the rest counted", () => {
  const issues = [];
  const bad = {}; for (let i = 0; i < 30; i++) bad[`z${i}`] = { width: 1 };
  assert.equal(cleanTableCols(bad, "S", issues), undefined);
  assert.equal(issues.length, 6);
  assert.match(issues[5], /25 more column settings removed/);
});
