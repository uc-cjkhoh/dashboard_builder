// Label appearance (Label flyout → Text, Font, Alignment): the pure model, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanLabelText, labelTextOf, labelTextError, labelTextResolver, LABEL_VALUE_FIELD, cleanLabelFont, labelFontError, labelFontOf, LABEL_SIZE_CHOICES,
  cleanLabelAlign, labelAlignError, labelAlignOf, LABEL_ALIGN_CHOICES, labelStyleOf, labelFieldCatalog, labelTextPreview, LABEL_FONT_SIZES, LABEL_FONT_FAMILIES, LABEL_FONT_GROUPS, MS_FONT_CHOICES, labelFontToken }
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
  assert.equal(cleanLabelFont({ size: 14, family: "ms-calibri" }).ok, true);
  assert.equal(cleanLabelFont({ family: "comic" }).ok, false);
  assert.equal(cleanLabelFont({ bold: "yes" }).ok, false);
  assert.equal(cleanLabelFont([]).ok, false);
  assert.match(labelFontError({ size: 13 }), /one of 8, 9, 10/);
});
test("font: the common point sizes are offered, Automatic first, and each is accepted", () => {
  assert.deepEqual(LABEL_FONT_SIZES, [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72]);
  assert.deepEqual(LABEL_SIZE_CHOICES.map((c) => c[0]), ["auto", ...LABEL_FONT_SIZES]);
  assert.equal(LABEL_SIZE_CHOICES[1][1], "8 px");
  for (const n of LABEL_FONT_SIZES) assert.deepEqual(cleanLabelFont({ size: n }), { ok: true, value: { size: n } });
  for (const n of [0, 7, 13, 15, 73, "12", 12.5]) assert.equal(cleanLabelFont({ size: n }).ok, false, String(n));
});
test("font: the Microsoft Typography fonts follow the worksheet's three, each with its own token", () => {
  assert.deepEqual(LABEL_FONT_FAMILIES.slice(0, 3).map((c) => c[0]), ["default", "serif", "mono"]);
  assert.deepEqual(MS_FONT_CHOICES.map((c) => c[1]), ["Arial", "Calibri", "Cambria", "Candara", "Consolas", "Constantia", "Corbel", "Courier New", "Georgia", "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana"]);
  assert.deepEqual(LABEL_FONT_GROUPS.map((g) => g.label), [null, "Microsoft Typography"]);
  for (const [id] of MS_FONT_CHOICES) {
    assert.deepEqual(cleanLabelFont({ family: id }), { ok: true, value: { family: id } }, id);
    assert.equal(labelFontToken(id), `--font-${id}`);
  }
  assert.equal(labelFontToken("default"), null); assert.equal(labelFontToken("serif"), "--font-serif"); assert.equal(labelFontToken("comic"), null);
  assert.equal(cleanLabelFont({ family: "ms-comic-sans" }).ok, false);
});
test("font: every Microsoft family has its stack in core.css", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../../src/DashboardBuilder/Features/Core/core.css", import.meta.url), "utf8");
  for (const [id] of MS_FONT_CHOICES) assert.match(css, new RegExp(`--font-${id}:\\s*[^;]+;`), id);
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
test("alignment: Left and Right swap at drawing — ECharts' align is the side on the anchor, so Left (a label that reads to the left of its mark) anchors the text's right side", () => {
  assert.equal(labelStyleOf({ labelAlign: "left" }).align, "right");
  assert.equal(labelStyleOf({ labelAlign: "right" }).align, "left");
  assert.equal(labelStyleOf({ labelAlign: "center" }).align, "center");
  assert.equal("align" in labelStyleOf({ labelAlign: "auto" }), false);
  assert.equal(labelAlignOf({ labelAlign: "left" }), "left"); // what is stored and shown is unchanged
});
test("style: an untouched format adds nothing; each set part adds its option", () => {
  const stack = (f) => ({ serif: "Georgia, serif", mono: "monospace" }[f]);
  assert.deepEqual(labelStyleOf({}, stack), {});
  assert.deepEqual(labelStyleOf({ labelFont: { family: "serif", size: 16, bold: true }, labelAlign: "left" }, stack), { fontFamily: "Georgia, serif", fontSize: 16, fontWeight: 600, align: "right" });
  assert.deepEqual(labelStyleOf({ labelFont: { size: 14 } }, stack), { fontSize: 14 });
  assert.deepEqual(labelStyleOf({ labelFont: { family: "mono" } }), {}); // no resolver: the chart's own family
});
test("the editor's catalog lists <Value> first and previews a template from the samples", () => {
  const cat = labelFieldCatalog([{ name: "orders.region", sample: "EU", kind: "dim" }, { name: "sum(amount)", sample: "$5", kind: "measure" }, { name: "Value", sample: "dup" }]);
  assert.deepEqual(cat.map((f) => f.name), ["Value", "orders.region", "sum(amount)"]);
  assert.equal(labelTextPreview("<orders.region>: <Value> / <sum(amount)> <nope>", cat), "EU: 123 / $5 <nope>");
  assert.deepEqual(labelFieldCatalog(undefined).map((f) => f.name), ["Value"]);
});
