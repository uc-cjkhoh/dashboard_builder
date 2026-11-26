// Label appearance (Label flyout → Text, Font, Alignment): the pure model, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanLabelText, labelTextOf, labelTextError, labelTextResolver, LABEL_VALUE_FIELD, cleanLabelFont, labelFontError, labelFontOf, LABEL_SIZE_CHOICES,
  cleanLabelAlign, labelAlignError, labelAlignOf, LABEL_ALIGN_CHOICES, labelStyleOf, labelFieldCatalog, labelTextPreview }
  from "../../src/DashboardBuilder/Features/Dashboard/label-appearance-model.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

test("text: blank and <Value> alone store nothing; a template is trimmed; too long is refused", () => {
  assert.deepEqual(cleanLabelText(null), { ok: true, value: null });
  assert.deepEqual(cleanLabelText("  "), { ok: true, value: null });
  assert.deepEqual(cleanLabelText(`<${LABEL_VALUE_FIELD}>`), { ok: true, value: null });
  assert.deepEqual(cleanLabelText(" <name>: <Value> "), { ok: true, value: "<name>: <Value>" });
  assert.equal(cleanLabelText("x".repeat(LIMITS.labelText + 1)).ok, false);
  assert.equal(cleanLabelText(5).ok, false);
  assert.match(labelTextError("x".repeat(LIMITS.labelText + 1)), /at most/);
});
test("text: a stored template is read back, a bad one is the automatic text", () => {
  assert.equal(labelTextOf({ labelText: "<a>" }), "<a>");
  assert.equal(labelTextOf({ labelText: 4 }), null);
  assert.equal(labelTextOf({}), null);
  assert.equal(labelTextOf(undefined), null);
});
test("text resolver: no template is null (the chart keeps its own text)", () => {
  assert.equal(labelTextResolver(null, [], String, {}), null);
});
test("text resolver: fields per mark, measures, <Value>, unknown placeholders and plain text (never HTML-escaped)", () => {
  const fields = [{ name: "region", values: ["East & West", "North"] }];
  const r = labelTextResolver("<region> <Sales> = <Value> <nope> <b>", fields, (v) => `$${v}`, {});
  assert.equal(r(0, 0, { measures: { Sales: 5 }, valueText: "$5" }), "East & West $5 = $5 <nope> <b>");
  assert.equal(r(0, 1, { measures: { Sales: 7 }, valueText: "$7" }), "North $7 = $7 <nope> <b>");
});
test("text resolver: a grid field reads [series][mark]; a missing cell stays as typed", () => {
  const fields = [{ name: "city", grid: true, values: [["A", "B"], ["C", null]] }];
  const r = labelTextResolver("<city>", fields, String, {});
  assert.equal(r(0, 1), "B");
  assert.equal(r(1, 0), "C");
  assert.equal(r(1, 1), "<city>");
});
test("font: defaults store nothing, parts are validated and normalised", () => {
  assert.deepEqual(cleanLabelFont(null), { ok: true, value: null });
  assert.deepEqual(cleanLabelFont({ family: "default", bold: false }), { ok: true, value: null });
  assert.deepEqual(cleanLabelFont({ family: "serif", size: 16, bold: true }), { ok: true, value: { family: "serif", size: 16, bold: true } });
  assert.equal(cleanLabelFont({ size: 15 }).ok, false);
  assert.equal(cleanLabelFont({ family: "comic" }).ok, false);
  assert.equal(cleanLabelFont({ bold: "yes" }).ok, false);
  assert.equal(cleanLabelFont([]).ok, false);
  assert.match(labelFontError({ size: 12 }), /14 or 16/);
});
test("font: only the 14 / 16 px scale is offered, Automatic first", () => {
  assert.deepEqual(LABEL_SIZE_CHOICES.map((c) => c[0]), ["auto", 14, 16]);
});
test("font: the format reads back with every part present", () => {
  assert.deepEqual(labelFontOf({}), { family: "default", size: null, bold: false });
  assert.deepEqual(labelFontOf({ labelFont: { family: "mono", size: 14, bold: true } }), { family: "mono", size: 14, bold: true });
  assert.deepEqual(labelFontOf({ labelFont: { size: 99 } }), { family: "default", size: null, bold: false });
});
test("alignment: Automatic stores nothing; left / center / right are kept; anything else is refused", () => {
  assert.deepEqual(LABEL_ALIGN_CHOICES.map((c) => c[0]), ["auto", "left", "center", "right"]);
  assert.deepEqual(cleanLabelAlign("auto"), { ok: true, value: null });
  assert.deepEqual(cleanLabelAlign("center"), { ok: true, value: "center" });
  assert.equal(cleanLabelAlign("justify").ok, false);
  assert.match(labelAlignError("x"), /Automatic, Left, Center or Right/);
  assert.equal(labelAlignOf({}), "auto");
  assert.equal(labelAlignOf({ labelAlign: "right" }), "right");
  assert.equal(labelAlignOf({ labelAlign: "x" }), "auto");
});
test("style: an untouched format adds nothing; each set part adds its option", () => {
  const stack = (f) => ({ serif: "Georgia, serif", mono: "monospace" }[f]);
  assert.deepEqual(labelStyleOf({}, stack), {});
  assert.deepEqual(labelStyleOf({ labelFont: { family: "serif", size: 16, bold: true }, labelAlign: "left" }, stack), { fontFamily: "Georgia, serif", fontSize: 16, fontWeight: 600, align: "left" });
  assert.deepEqual(labelStyleOf({ labelFont: { size: 14 } }, stack), { fontSize: 14 });
  assert.deepEqual(labelStyleOf({ labelFont: { family: "mono" } }), {}); // no resolver: the chart's own family
});
test("the editor's catalog lists <Value> first and previews a template from the samples", () => {
  const cat = labelFieldCatalog([{ name: "orders.region", sample: "EU", kind: "dim" }, { name: "sum(amount)", sample: "$5", kind: "measure" }, { name: "Value", sample: "dup" }]);
  assert.deepEqual(cat.map((f) => f.name), ["Value", "orders.region", "sum(amount)"]);
  assert.equal(labelTextPreview("<orders.region>: <Value> / <sum(amount)> <nope>", cat), "EU: 123 / $5 <nope>");
  assert.deepEqual(labelFieldCatalog(undefined).map((f) => f.name), ["Value"]);
});
