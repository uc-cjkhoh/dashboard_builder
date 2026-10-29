import { test } from "node:test";
import assert from "node:assert/strict";
import { DATE_LABEL_MODES, normalizeDateLabels, dateLabelsOf, dateFitMode, toggleDateLabels } from "../../src/DashboardBuilder/Features/Dashboard/date-labels.js";

test("modes are all and thin; anything else reads as thin (the default)", () => {
  assert.deepEqual(DATE_LABEL_MODES, ["all", "thin"]);
  assert.equal(normalizeDateLabels("all"), "all");
  for (const v of [undefined, null, "thin", "ALL", 1, {}]) assert.equal(normalizeDateLabels(v), "thin");
});
test("toggle flips between all and thin and returns the saved value", () => {
  assert.equal(toggleDateLabels(undefined), "all");
  assert.equal(toggleDateLabels("thin"), "all");
  assert.equal(toggleDateLabels("all"), "thin");
});
test("only a date category axis gets a setting", () => {
  const sheet = (cat, f = {}) => ({ rows: [], columns: [{ db: "d", table: "t", column: "c", category: cat, role: "dimension", ...f }] });
  assert.equal(dateLabelsOf(sheet("temporal", { dateLabels: "all" }), (s) => s.columns[0]), "all");
  assert.equal(dateLabelsOf(sheet("temporal"), (s) => s.columns[0]), "thin");
  assert.equal(dateLabelsOf(sheet("text"), (s) => s.columns[0]), undefined);
  assert.equal(dateLabelsOf(sheet("temporal", { calc: "x" }), (s) => s.columns[0]), undefined);
  assert.equal(dateLabelsOf({}, () => undefined), undefined);
});
test("no setting leaves the sheet's fit mode alone", () => {
  for (const m of ["standard", "width", "height", "entire"]) assert.equal(dateFitMode(m, undefined, "vertical"), m);
});
test("thin fits the date axis to the pane so labels thin out (bottom axis: width)", () => {
  assert.equal(dateFitMode("standard", "thin", "vertical"), "width");
  assert.equal(dateFitMode("height", "thin", "vertical"), "entire");
  assert.equal(dateFitMode("entire", "thin", "vertical"), "entire");
});
test("thin on a horizontal chart fits the left axis (height)", () => {
  assert.equal(dateFitMode("standard", "thin", "horizontal"), "height");
  assert.equal(dateFitMode("width", "thin", "horizontal"), "entire");
});
test("all gives the date axis a slot and a label per member, whatever the sheet's fit", () => {
  assert.equal(dateFitMode("entire", "all", "vertical"), "height");
  assert.equal(dateFitMode("width", "all", "vertical"), "standard");
  assert.equal(dateFitMode("entire", "all", "horizontal"), "width");
  assert.equal(dateFitMode("standard", "all", "vertical"), "standard");
});
