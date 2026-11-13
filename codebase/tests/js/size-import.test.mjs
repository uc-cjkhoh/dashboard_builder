import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultFormat, emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
import { parseWorkbook, serializeWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

// Format → Edit Sizes is stored as `format.sizeScale`, only when it differs from the default; import keeps what is valid and reports the rest.
const roundTrip = (format, marks) => {
  const sheet = { ...emptySheet(), chartType: "scatter", format, ...(marks ? { marks: { ...emptySheet().marks, ...marks } } : {}) };
  const state = { entities: new Map(), relationships: [], tabs: [{ id: "ws#1", kind: "worksheet", name: "D", sheet }], active: { kind: "worksheet", id: "ws#1" } };
  return parseWorkbook(JSON.stringify(serializeWorkbook(state)));
};
const issuesAbout = (r) => r.issues.filter((i) => /size/i.test(i));

test("the default format has no size setting, so a sheet that never set one round-trips unchanged", () => {
  assert.equal("sizeScale" in defaultFormat(), false);
  const r = roundTrip(defaultFormat());
  assert.equal("sizeScale" in r.worksheets[0].sheet.format, false);
  assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
});
test("a valid sizeScale round-trips; defaults inside it are dropped", () => {
  const r = roundTrip({ ...defaultFormat(), sizeScale: { smallest: 20, largest: 80, fromZero: false, reversed: true } });
  assert.deepEqual(r.worksheets[0].sheet.format.sizeScale, { smallest: 20, largest: 80, fromZero: false, reversed: true });
  assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
  const flat = roundTrip({ ...defaultFormat(), sizeScale: { smallest: 0, largest: 100, reversed: false } });
  assert.equal("sizeScale" in flat.worksheets[0].sheet.format, false);
});
test("an invalid sizeScale resets the bad parts and says so; nothing is clamped", () => {
  const r = roundTrip({ ...defaultFormat(), sizeScale: { smallest: 150, largest: 80, reversed: "yes" } });
  assert.deepEqual(r.worksheets[0].sheet.format.sizeScale, { largest: 80 });
  assert.equal(issuesAbout(r).length, 2, JSON.stringify(r.issues));
  const crossed = roundTrip({ ...defaultFormat(), sizeScale: { smallest: 70, largest: 30 } });
  assert.equal("sizeScale" in crossed.worksheets[0].sheet.format, false);
  assert.equal(issuesAbout(crossed).length, 1);
  const junk = roundTrip({ ...defaultFormat(), sizeScale: 7 });
  assert.equal("sizeScale" in junk.worksheets[0].sheet.format, false);
  assert.equal(issuesAbout(junk).length, 1);
});
test("a dimension on Size is kept on import (a saved sheet from before has a measure there, unchanged)", () => {
  const dim = { db: "shop", table: "orders", column: "tier", category: "text" };
  const m = { db: "shop", table: "orders", column: "qty", category: "numeric", agg: "sum" };
  assert.equal(roundTrip(defaultFormat(), { size: dim }).worksheets[0].sheet.marks.size.column, "tier");
  assert.equal(roundTrip(defaultFormat(), { size: m }).worksheets[0].sheet.marks.size.agg, "sum");
});
