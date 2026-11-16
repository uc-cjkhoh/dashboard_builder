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

// Sizes vary and the typed Start / End value (D120).
test("vary, start and end round-trip; Automatic is not stored; an old fromZero + reversed file stays valid and unchanged", () => {
  const r = roundTrip({ ...defaultFormat(), sizeScale: { vary: "range", start: 10, end: 50.5, reversed: true } });
  assert.deepEqual(r.worksheets[0].sheet.format.sizeScale, { vary: "range", start: 10, end: 50.5, reversed: true });
  assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
  assert.equal("sizeScale" in roundTrip({ ...defaultFormat(), sizeScale: { vary: "automatic" } }).worksheets[0].sheet.format, false);
  const old = roundTrip({ ...defaultFormat(), sizeScale: { fromZero: true, reversed: true } });
  assert.deepEqual(old.worksheets[0].sheet.format.sizeScale, { fromZero: true, reversed: true }, "kept as saved, drawn as before");
  assert.equal(old.issues.length, 0);
  assert.deepEqual(roundTrip({ ...defaultFormat(), sizeScale: { start: 0 } }).worksheets[0].sheet.format.sizeScale, { start: 0 });
  assert.deepEqual(roundTrip({ ...defaultFormat(), sizeScale: { end: -4 } }).worksheets[0].sheet.format.sizeScale, { end: -4 });
});
test("a bad vary, a non-number, an out-of-range or a crossed start / end is dropped and reported, never clamped", () => {
  const v = roundTrip({ ...defaultFormat(), sizeScale: { vary: "sideways", end: 9 } });
  assert.deepEqual(v.worksheets[0].sheet.format.sizeScale, { end: 9 });
  assert.equal(issuesAbout(v).length, 1, JSON.stringify(v.issues));
  const str = roundTrip({ ...defaultFormat(), sizeScale: { start: "5", end: 1e15 } });
  assert.equal("sizeScale" in str.worksheets[0].sheet.format, false);
  assert.equal(issuesAbout(str).length, 2, JSON.stringify(str.issues));
  const crossed = roundTrip({ ...defaultFormat(), sizeScale: { vary: "range", start: 9, end: 3 } });
  assert.deepEqual(crossed.worksheets[0].sheet.format.sizeScale, { vary: "range" });
  assert.equal(issuesAbout(crossed).length, 1);
  const zero = roundTrip({ ...defaultFormat(), sizeScale: { vary: "zero", start: 2, end: 8 } });
  assert.deepEqual(zero.worksheets[0].sheet.format.sizeScale, { vary: "zero", end: 8 });
  assert.equal(issuesAbout(zero).length, 1);
});
