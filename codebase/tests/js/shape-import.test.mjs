import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultFormat, emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
import { parseWorkbook, serializeWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

// Format → Shape bins (`format.shapeBins`) and Edit member shapes (`sheet.memberShapes`): stored only when set, validated on import and reported, never clamped.
const roundTrip = (patch = {}, format = defaultFormat()) => {
  const sheet = { ...emptySheet(), chartType: "scatter", format, ...patch };
  const state = { entities: new Map(), relationships: [], tabs: [{ id: "ws#1", kind: "worksheet", name: "D", sheet }], active: { kind: "worksheet", id: "ws#1" } };
  return parseWorkbook(JSON.stringify(serializeWorkbook(state)));
};
const about = (r, re) => r.issues.filter((i) => re.test(i));

test("a sheet that never set shapes round-trips without either key and without issues", () => {
  assert.equal("shapeBins" in defaultFormat(), false);
  assert.equal("memberShapes" in emptySheet(), false);
  const r = roundTrip();
  assert.equal("shapeBins" in r.worksheets[0].sheet.format, false);
  assert.equal("memberShapes" in r.worksheets[0].sheet, false);
  assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
});

test("valid shape bins round-trip", () => {
  for (const n of [2, 3, 4, 6]) assert.equal(roundTrip({}, { ...defaultFormat(), shapeBins: n }).worksheets[0].sheet.format.shapeBins, n);
});

test("an invalid bin count is reset and reported, never clamped", () => {
  for (const bad of [1, 7, 0, -2, 3.5, "4", true]) {
    const r = roundTrip({}, { ...defaultFormat(), shapeBins: bad });
    assert.equal("shapeBins" in r.worksheets[0].sheet.format, false, String(bad));
    assert.equal(about(r, /shape bins/).length, 1, String(bad));
  }
});

test("member shapes round-trip; invalid ones are dropped and reported; a map with nothing valid leaves no key", () => {
  const ok = roundTrip({ memberShapes: { "t.region": { EU: "triangle", US: "pin" } } });
  assert.deepEqual(JSON.parse(JSON.stringify(ok.worksheets[0].sheet.memberShapes)), { "t.region": { EU: "triangle", US: "pin" } });
  assert.equal(ok.issues.length, 0);
  const mixed = roundTrip({ memberShapes: { "t.region": { EU: "triangle", US: "hexagon", JP: 7 } } });
  assert.deepEqual(JSON.parse(JSON.stringify(mixed.worksheets[0].sheet.memberShapes)), { "t.region": { EU: "triangle" } });
  assert.equal(about(mixed, /2 invalid member shapes dropped/).length, 1, JSON.stringify(mixed.issues));
  const none = roundTrip({ memberShapes: { "t.region": { EU: "hexagon" } } });
  assert.equal("memberShapes" in none.worksheets[0].sheet, false);
  assert.equal(about(none, /member shape/).length, 1);
  const junk = roundTrip({ memberShapes: [1, 2] });
  assert.equal("memberShapes" in junk.worksheets[0].sheet, false);
  assert.equal(about(junk, /member shapes weren't an object/).length, 1);
});

test("a numeric Shape field is kept on import (the measure to bin)", () => {
  const rating = { db: "d", table: "t", column: "rating", category: "numeric", agg: "sum" };
  const r = roundTrip({ marks: { ...emptySheet().marks, shape: rating } });
  assert.deepEqual(r.worksheets[0].sheet.marks.shape, rating);
});
