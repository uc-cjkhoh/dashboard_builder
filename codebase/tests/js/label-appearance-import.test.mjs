// Label flyout → Text, Font, Alignment survive a save / open: kept when set, absent at the default, reset (and reported) when bad — never clamped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultFormat, emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
import { parseWorkbook, serializeWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

const roundTrip = (format) => {
  const sheet = { ...emptySheet(), format };
  const state = { entities: new Map(), relationships: [], tabs: [{ id: "ws#1", kind: "worksheet", name: "D", sheet }], active: { kind: "worksheet", id: "ws#1" } };
  return parseWorkbook(JSON.stringify(serializeWorkbook(state)));
};
const fmt = (r) => r.worksheets[0].sheet.format;

test("a sheet that never set them round-trips without the keys and without issues", () => {
  const r = roundTrip(defaultFormat());
  for (const k of ["labelText", "labelFont", "labelAlign"]) assert.equal(k in fmt(r), false, k);
  assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
});
test("set values round-trip", () => {
  const r = roundTrip({ ...defaultFormat(), labelText: "<a>: <Value>", labelFont: { family: "mono", size: 16, bold: true }, labelAlign: "right" });
  assert.equal(fmt(r).labelText, "<a>: <Value>");
  assert.deepEqual(fmt(r).labelFont, { family: "mono", size: 16, bold: true });
  assert.equal(fmt(r).labelAlign, "right");
  assert.equal(r.issues.length, 0);
});
test("defaults are not stored: blank text, <Value> alone, an all-default font, Automatic", () => {
  const r = roundTrip({ ...defaultFormat(), labelText: "<Value>", labelFont: { family: "default", bold: false }, labelAlign: "auto" });
  for (const k of ["labelText", "labelFont", "labelAlign"]) assert.equal(k in fmt(r), false, k);
  assert.equal(r.issues.length, 0);
  assert.equal("labelText" in fmt(roundTrip({ ...defaultFormat(), labelText: "   " })), false);
});
test("bad values are reset to the default and reported, never clamped", () => {
  const long = roundTrip({ ...defaultFormat(), labelText: "x".repeat(LIMITS.labelText + 1) });
  assert.equal("labelText" in fmt(long), false); assert.equal(long.issues.filter((i) => /label text/.test(i)).length, 1);
  for (const bad of [{ size: 7 }, { size: 200 }, { size: 12.5 }, { family: "comic" }, { bold: "yes" }, [], "big"]) {
    const r = roundTrip({ ...defaultFormat(), labelFont: bad });
    assert.equal("labelFont" in fmt(r), false, JSON.stringify(bad)); assert.equal(r.issues.filter((i) => /label font/.test(i)).length, 1, JSON.stringify(bad));
  }
  for (const bad of ["justify", 3, true]) {
    const r = roundTrip({ ...defaultFormat(), labelAlign: bad });
    assert.equal("labelAlign" in fmt(r), false, JSON.stringify(bad)); assert.equal(r.issues.filter((i) => /label alignment/.test(i)).length, 1, JSON.stringify(bad));
  }
});
