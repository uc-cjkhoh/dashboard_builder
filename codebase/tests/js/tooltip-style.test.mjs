import { test } from "node:test";
import assert from "node:assert/strict";
import { tooltipHtml, lookupFrom } from "../../src/DashboardBuilder/Features/Dashboard/tooltip-model.js";
import { TIP_SIZES, TIP_COLOURS, checkTooltipStyle, toLines, fromLines, moveLine, addLine, removeLine, insertField }
  from "../../src/DashboardBuilder/Features/Dashboard/tooltip-style.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";
import { sanitizeSheet } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

test("sizes are the type scale; colours are token keys", () => {
  assert.deepEqual(TIP_SIZES, [14, 16, 24]);
  for (const k of Object.keys(TIP_COLOURS)) assert.match(TIP_COLOURS[k], /^--[a-z0-9-]+$/);
});
test("checkTooltipStyle: null/empty -> null; trims defaults and trailing blanks", () => {
  assert.deepEqual(checkTooltipStyle(null), { ok: true, value: null });
  assert.deepEqual(checkTooltipStyle([{}, {}]), { ok: true, value: null });
  assert.deepEqual(checkTooltipStyle([{ bold: true }, {}, null]), { ok: true, value: [{ bold: true }] });
  assert.deepEqual(checkTooltipStyle([{ size: 24, italic: true, color: "accent", junk: 1 }]).value, [{ size: 24, italic: true, color: "accent" }]);
});
test("checkTooltipStyle rejects bad shapes, sizes, colours, too many lines", () => {
  assert.equal(checkTooltipStyle("x").ok, false);
  assert.equal(checkTooltipStyle([{ size: 13 }]).ok, false);
  assert.equal(checkTooltipStyle([{ color: "#ff0000" }]).ok, false);
  assert.equal(checkTooltipStyle([{ color: "__proto__" }]).ok, false);
  assert.equal(checkTooltipStyle([{ bold: "yes" }]).ok, false);
  assert.equal(checkTooltipStyle(Array.from({ length: LIMITS.tooltipLines + 1 }, () => ({ bold: true }))).ok, false);
  assert.equal(checkTooltipStyle(Array.from({ length: LIMITS.tooltipLines }, () => ({ bold: true }))).ok, true);
});
test("tooltipHtml without a style is unchanged; with a style wraps each line", () => {
  const look = lookupFrom({ a: "1" });
  assert.equal(tooltipHtml("x\n<a>", look), "x<br><b>1</b>");
  assert.equal(tooltipHtml("x\n<a>", look, null), "x<br><b>1</b>");
  const h = tooltipHtml("x\n<a>", look, [{ size: 24, bold: true, color: "accent" }, { italic: true }]);
  assert.equal(h, `<span style="font-size:24px;font-weight:700;color:var(--accent-ink)">x</span><br><span style="font-style:italic"><b>1</b></span>`);
});
test("a style never lets user text into the style attribute", () => {
  const h = tooltipHtml("x", lookupFrom({}), [{ size: "24;x:y", color: "red;background:url(x)" }]);
  assert.ok(!h.includes("url") && !h.includes("x:y"));
});
test("toLines / fromLines round-trip text and style", () => {
  const lines = toLines("A\n<f>", [{ bold: true }]);
  assert.deepEqual(lines, [{ text: "A", bold: true }, { text: "<f>" }]);
  assert.deepEqual(fromLines(lines), { text: "A\n<f>", style: [{ bold: true }] });
  assert.deepEqual(fromLines([{ text: "" }]), { text: "", style: null });
  assert.deepEqual(toLines("", null), [{ text: "" }]);
});
test("moveLine keeps each line's style with it; bounds are no-ops", () => {
  const l = [{ text: "a", bold: true }, { text: "b" }, { text: "c" }];
  assert.deepEqual(moveLine(l, 0, 1).map((x) => x.text), ["b", "a", "c"]);
  assert.equal(moveLine(l, 0, 1)[1].bold, true);
  assert.equal(moveLine(l, 0, -1), l);
  assert.equal(moveLine(l, 2, 1), l);
});
test("addLine / removeLine respect LIMITS.tooltipLines and keep one line", () => {
  let l = [{ text: "a" }];
  assert.equal(removeLine(l, 0).length, 1);
  for (let i = 0; i < LIMITS.tooltipLines + 3; i++) l = addLine(l);
  assert.equal(l.length, LIMITS.tooltipLines);
  assert.equal(removeLine(l, 0).length, LIMITS.tooltipLines - 1);
});
test("insertField drops <name> at the caret within the 300-character total", () => {
  const l = [{ text: "ab" }, { text: "cd" }];
  assert.equal(insertField(l, 1, "f", 1, 1)[1].text, "c<f>d");
  const full = [{ text: "x".repeat(LIMITS.tooltipText) }];
  assert.equal(insertField(full, 0, "f", 0, 0), full);
});
test("workbook round-trips tooltipStyle; bad style is dropped with an issue; old files lack it", () => {
  const issues = [];
  assert.deepEqual(sanitizeSheet({ tooltipText: "a\nb", tooltipStyle: [{ bold: true }] }, "S", issues).tooltipStyle, [{ bold: true }]);
  assert.deepEqual(issues, []);
  assert.equal(sanitizeSheet({ tooltipText: "a" }, "S", issues).tooltipStyle, null);
  assert.deepEqual(issues, []);
  const bad = [];
  assert.equal(sanitizeSheet({ tooltipStyle: [{ color: "#fff" }] }, "S", bad).tooltipStyle, null);
  assert.equal(bad.length, 1);
});
