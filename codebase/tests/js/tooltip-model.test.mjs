import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTooltip, checkTooltipText, tooltipHtml, tooltipCatalog, lookupFrom }
  from "../../src/DashboardBuilder/Features/Dashboard/tooltip-model.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";
import { sanitizeSheet } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

test("parseTooltip splits literal text and <Field> placeholders", () => {
  const p = parseTooltip("Sales for <customers.name>: <sum(amount)>!");
  assert.deepEqual(p.parts, [
    { text: "Sales for " }, { field: "customers.name" }, { text: ": " }, { field: "sum(amount)" }, { text: "!" }]);
  assert.deepEqual(p.fields, ["customers.name", "sum(amount)"]);
});
test("an unclosed < is plain text", () => {
  assert.deepEqual(parseTooltip("a < b").parts, [{ text: "a < b" }]);
});
test("checkTooltipText: blank -> null, trims, caps length, rejects non-strings", () => {
  assert.deepEqual(checkTooltipText("   "), { ok: true, value: null });
  assert.deepEqual(checkTooltipText(null), { ok: true, value: null });
  assert.deepEqual(checkTooltipText(" hi <x> "), { ok: true, value: "hi <x>" });
  assert.equal(checkTooltipText("x".repeat(LIMITS.tooltipText + 1)).ok, false);
  assert.equal(checkTooltipText("x".repeat(LIMITS.tooltipText)).ok, true);
  assert.equal(checkTooltipText(5).ok, false);
});
test("tooltipHtml substitutes values, keeps newlines as <br>", () => {
  const html = tooltipHtml("<a>\n<b>", lookupFrom({ a: "1", b: "2" }));
  assert.equal(html, "<b>1</b><br><b>2</b>");
});
test("tooltipHtml escapes literal text and values (no raw HTML)", () => {
  const html = tooltipHtml('<script>alert("x")</script> & <a>', lookupFrom({ a: '<img src=x onerror=1>' }));
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&quot;x&quot;"));
  assert.ok(html.includes("&lt;img src=x onerror=1&gt;"));
  assert.ok(html.includes("&amp;"));
});
test("an unknown placeholder renders as escaped literal text", () => {
  assert.equal(tooltipHtml("<nope>", lookupFrom({})), "&lt;nope&gt;");
});
test("a field name that is itself HTML is escaped as a key lookup only", () => {
  assert.equal(tooltipHtml("<<b>x>", lookupFrom({})), "&lt;&lt;b&gt;x&gt;");
});
test("tooltipCatalog lists dims then measures with the first mark's sample", () => {
  const cat = tooltipCatalog([{ name: "t.c", values: ["A", "B"] }], ["sum(x)"], ["10"]);
  assert.deepEqual(cat, [{ name: "t.c", sample: "A" }, { name: "sum(x)", sample: "10" }]);
});
test("workbook round-trips tooltipText; bad or over-long text is dropped with an issue", () => {
  const issues = [];
  assert.equal(sanitizeSheet({ tooltipText: "Hi <a>" }, "Sheet 1", issues).tooltipText, "Hi <a>");
  assert.deepEqual(issues, []);
  assert.equal(sanitizeSheet({}, "Sheet 1", issues).tooltipText, null);
  const bad = [];
  assert.equal(sanitizeSheet({ tooltipText: "x".repeat(LIMITS.tooltipText + 1) }, "Sheet 1", bad).tooltipText, null);
  assert.equal(bad.length, 1);
  assert.equal(sanitizeSheet({ tooltipText: { a: 1 } }, "Sheet 1", bad).tooltipText, null);
  assert.equal(bad.length, 2);
});
