import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultFormat, emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
import { parseWorkbook, serializeWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

// Label flyout → Allow labels to overlap (`format.labelOverlap`) and Pages flyout → Speed (`pages.speed`): stored only when not the default, validated on import and reported, never clamped.
const PAGES = { db: "shop", table: "orders", column: "region", category: "text", index: 0 };
const roundTrip = (patch = {}, format = defaultFormat()) => {
  const sheet = { ...emptySheet(), chartType: "bar", format, ...patch };
  const state = { entities: new Map(), relationships: [], tabs: [{ id: "ws#1", kind: "worksheet", name: "D", sheet }], active: { kind: "worksheet", id: "ws#1" } };
  return parseWorkbook(JSON.stringify(serializeWorkbook(state)));
};
const about = (r, re) => r.issues.filter((i) => re.test(i));

test("a sheet that never set them round-trips without either key and without issues", () => {
  assert.equal("labelOverlap" in defaultFormat(), false);
  const r = roundTrip({ pages: { ...PAGES } });
  assert.equal("labelOverlap" in r.worksheets[0].sheet.format, false);
  assert.equal("speed" in r.worksheets[0].sheet.pages, false);
  assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
});

test("labels that may not overlap round-trip; on (the default) is not stored", () => {
  assert.equal(roundTrip({}, { ...defaultFormat(), labelOverlap: false }).worksheets[0].sheet.format.labelOverlap, false);
  assert.equal("labelOverlap" in roundTrip({}, { ...defaultFormat(), labelOverlap: true }).worksheets[0].sheet.format, false);
});

test("a non-boolean Allow labels to overlap is reset and reported, never coerced", () => {
  for (const bad of ["no", 0, 1, "false"]) {
    const r = roundTrip({}, { ...defaultFormat(), labelOverlap: bad });
    assert.equal("labelOverlap" in r.worksheets[0].sheet.format, false, String(bad));
    assert.equal(about(r, /allow labels to overlap/).length, 1, String(bad));
  }
});

test("Pages speed round-trips; Medium is not stored", () => {
  for (const speed of ["slow", "fast"]) assert.equal(roundTrip({ pages: { ...PAGES, speed } }).worksheets[0].sheet.pages.speed, speed);
  assert.equal("speed" in roundTrip({ pages: { ...PAGES, speed: "medium" } }).worksheets[0].sheet.pages, false);
});

test("an unknown Pages speed is reset to Medium and reported", () => {
  for (const bad of ["warp", 2, true]) {
    const r = roundTrip({ pages: { ...PAGES, speed: bad } });
    assert.equal("speed" in r.worksheets[0].sheet.pages, false, String(bad));
    assert.equal(about(r, /pages speed/).length, 1, String(bad));
  }
});
