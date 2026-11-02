// Table alignment, density and shading — pure model, store default, workbook round-trip, crosstab classes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TABLE_ALIGN_CHOICES, TABLE_DENSITY_CHOICES, TABLE_SHADE_CHOICES, tableStyleClasses } from "../../src/DashboardBuilder/Features/Dashboard/table-style-model.js";
import { defaultFormat, emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
import { restoreSheet, sanitizeSheet } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

test("defaults add no classes, so a table looks as before", () => {
  assert.deepEqual(tableStyleClasses(defaultFormat()), []);
  assert.deepEqual(tableStyleClasses(undefined), []);
  assert.deepEqual(tableStyleClasses({}), []);
});
test("each choice maps to one class; unknown values are ignored", () => {
  assert.deepEqual(tableStyleClasses({ tableAlign: "center", tableDensity: "compact", tableShade: "both" }), ["xt-a-center", "xt-d-compact", "xt-s-banded", "xt-s-header"]);
  assert.deepEqual(tableStyleClasses({ tableAlign: "left", tableDensity: "roomy", tableShade: "banded" }), ["xt-a-left", "xt-d-roomy", "xt-s-banded"]);
  assert.deepEqual(tableStyleClasses({ tableAlign: "zig", tableDensity: 5, tableShade: "x" }), []);
});
test("choices list the default first", () => {
  assert.equal(TABLE_ALIGN_CHOICES[0][0], "auto");
  assert.equal(TABLE_DENSITY_CHOICES[0][0], "standard");
  assert.equal(TABLE_SHADE_CHOICES[0][0], "none");
});
test("store defaults", () => {
  const f = defaultFormat();
  assert.equal(f.tableAlign, "auto"); assert.equal(f.tableDensity, "standard"); assert.equal(f.tableShade, "none");
});
test("workbook round-trips the choices; invalid ones reset with a note; old sheets gain defaults", () => {
  const s = emptySheet();
  s.format = { ...s.format, tableAlign: "right", tableDensity: "roomy", tableShade: "header" };
  const back = restoreSheet(JSON.parse(JSON.stringify(s)));
  assert.equal(back.format.tableAlign, "right"); assert.equal(back.format.tableDensity, "roomy"); assert.equal(back.format.tableShade, "header");
  const old = JSON.parse(JSON.stringify(emptySheet()));
  for (const k of ["tableAlign", "tableDensity", "tableShade"]) delete old.format[k];
  const o = restoreSheet(old);
  assert.equal(o.format.tableAlign, "auto"); assert.equal(o.format.tableDensity, "standard"); assert.equal(o.format.tableShade, "none");
  const bad = JSON.parse(JSON.stringify(emptySheet()));
  bad.format.tableAlign = "diagonal"; bad.format.tableShade = 3;
  const b = restoreSheet(bad);
  assert.equal(b.format.tableAlign, "auto"); assert.equal(b.format.tableShade, "none");
  const issues = [];
  const bad2 = JSON.parse(JSON.stringify(emptySheet()));
  bad2.format.tableDensity = "huge";
  assert.equal(sanitizeSheet(bad2, "Sheet 1", issues).format.tableDensity, "standard");
  assert.equal(issues.length, 1);
  assert.match(issues[0], /Sheet 1 format: unknown row height "huge"/);
});
