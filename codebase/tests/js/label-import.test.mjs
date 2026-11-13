import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultFormat, emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
import { parseWorkbook, serializeWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

// Format → Label marks is stored as `format.labelMarks`, only when it is not All; import keeps a valid mode and resets (and reports) any other.
const roundTrip = (format) => {
  const sheet = { ...emptySheet(), format };
  const state = { entities: new Map(), relationships: [], tabs: [{ id: "ws#1", kind: "worksheet", name: "D", sheet }], active: { kind: "worksheet", id: "ws#1" } };
  return parseWorkbook(JSON.stringify(serializeWorkbook(state)));
};
const mine = (r) => r.issues.filter((i) => /label marks/.test(i));

test("a sheet that never set it round-trips without the key and without issues", () => {
  const r = roundTrip(defaultFormat());
  assert.equal("labelMarks" in r.worksheets[0].sheet.format, false);
  assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
});
test("every mode round-trips; All is the default and is not stored", () => {
  for (const m of ["minmax", "selected", "highlighted", "recent", "ends"]) assert.equal(roundTrip({ ...defaultFormat(), labelMarks: m }).worksheets[0].sheet.format.labelMarks, m);
  const all = roundTrip({ ...defaultFormat(), labelMarks: "all" });
  assert.equal("labelMarks" in all.worksheets[0].sheet.format, false); assert.equal(mine(all).length, 0);
});
test("an unknown mode is reset to All and reported", () => {
  for (const bad of ["first", "", 3, true, {}, ["minmax"], "MINMAX"]) {
    const r = roundTrip({ ...defaultFormat(), labelMarks: bad });
    assert.equal("labelMarks" in r.worksheets[0].sheet.format, false, JSON.stringify(bad));
    assert.equal(mine(r).length, 1, JSON.stringify(bad));
  }
});
test("a mode that does not suit the chart is kept (it labels every mark there and returns with a line chart)", () => {
  const r = roundTrip({ ...defaultFormat(), labelMarks: "ends" });
  assert.equal(r.worksheets[0].sheet.format.labelMarks, "ends");
  assert.equal(r.issues.length, 0);
});

// Format → Label position (`format.labelPosition`): absent = automatic; the same rules.
const minePos = (r) => r.issues.filter((i) => /label position/.test(i));
test("label position: a sheet that never set it round-trips without the key; each side round-trips; auto is not stored", () => {
  assert.equal("labelPosition" in roundTrip(defaultFormat()).worksheets[0].sheet.format, false);
  for (const p of ["above", "below", "left", "right"]) assert.equal(roundTrip({ ...defaultFormat(), labelPosition: p }).worksheets[0].sheet.format.labelPosition, p);
  const auto = roundTrip({ ...defaultFormat(), labelPosition: "auto" });
  assert.equal("labelPosition" in auto.worksheets[0].sheet.format, false); assert.equal(minePos(auto).length, 0);
});
test("an unknown label position is reset to automatic and reported, never coerced", () => {
  for (const bad of ["top", "inside", "", 3, true, {}, ["left"], "LEFT"]) {
    const r = roundTrip({ ...defaultFormat(), labelPosition: bad });
    assert.equal("labelPosition" in r.worksheets[0].sheet.format, false, JSON.stringify(bad));
    assert.equal(minePos(r).length, 1, JSON.stringify(bad));
  }
});
