import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTooltipFormats, tipLookup, pruneFormats, looksDate }
  from "../../src/DashboardBuilder/Features/Dashboard/tooltip-formats.js";
import { tooltipCatalog, tooltipHtml } from "../../src/DashboardBuilder/Features/Dashboard/tooltip-model.js";
import { makeValueFormatter } from "../../src/DashboardBuilder/Features/Core/format.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";
import { sanitizeSheet } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

test("checkTooltipFormats: null/empty -> null; defaults and empty entries are dropped", () => {
  assert.deepEqual(checkTooltipFormats(null), { ok: true, value: null });
  assert.deepEqual(checkTooltipFormats({}), { ok: true, value: null });
  assert.deepEqual(checkTooltipFormats({ a: {}, b: { number: "auto" }, c: { date: "auto" } }), { ok: true, value: { b: { number: "auto" } } });
  assert.deepEqual(checkTooltipFormats({ a: { number: "percent", decimals: 1 }, d: { date: "month" } }).value, { a: { number: "percent", decimals: 1 }, d: { date: "month" } });
  assert.deepEqual(checkTooltipFormats({ a: { number: "auto", decimals: 0 } }).value, { a: { number: "auto", decimals: 0 } });
});
test("checkTooltipFormats rejects bad specs, never clamps", () => {
  for (const bad of [[], "x", { a: "x" }, { a: [] }, { a: { number: "hex" } }, { a: { number: 3 } }, { a: { decimals: 11 } }, { a: { decimals: -1 } },
    { a: { decimals: 1.5 } }, { a: { date: "weekday" } }, { a: { extra: 1 } }, { ["x".repeat(201)]: { number: "compact" } }, { "": { number: "compact" } }])
    assert.equal(checkTooltipFormats(bad).ok, false, JSON.stringify(bad));
  const many = Object.fromEntries(Array.from({ length: LIMITS.tooltipFormats + 1 }, (_, i) => [`f${i}`, { number: "compact" }]));
  assert.equal(checkTooltipFormats(many).ok, false);
  assert.equal(checkTooltipFormats(JSON.parse('{"__proto__":{"number":"compact"}}')).ok, false);
});
test("pruneFormats keeps only the template's fields", () => {
  assert.deepEqual(pruneFormats({ a: { number: "compact" }, b: { number: "percent" } }, ["a"]), { a: { number: "compact" } });
  assert.equal(pruneFormats({ a: { number: "compact" } }, []), null);
  assert.equal(pruneFormats(null, ["a"]), null);
});
test("tipLookup: no formats = the view's formatter; a field format reuses the worksheet number formatter", () => {
  const fmtVal = makeValueFormatter({ numberFormat: "currency" });
  const dims = new Map([["t.d", "2024-03-15"], ["t.r", "EU"]]);
  const plain = tipLookup({ measures: { m: 1234567.891 }, dims, formats: null, fmtVal, format: { numberFormat: "currency" } });
  assert.equal(plain("m"), fmtVal(1234567.891));
  const l = tipLookup({ measures: { m: 1234567.891, n: 0.256, Percent: "12%" }, dims, formats: { m: { number: "compact", decimals: 2 }, n: { number: "percent", decimals: 0 } }, fmtVal });
  assert.equal(l("m"), makeValueFormatter({ numberFormat: "compact", decimals: 2 })(1234567.891));
  assert.equal(l("m"), "1.23M");
  assert.equal(l("n"), "26%");
  assert.equal(l("Percent"), "12%");
  assert.equal(l("nope"), undefined);
});
test("tipLookup: decimals alone keeps the view's number style; a date format reformats date values only", () => {
  const dims = new Map([["d", "2024-03-15"], ["r", "EU"]]);
  const l = tipLookup({ measures: { m: 1.23456 }, dims, formats: { m: { decimals: 1 }, d: { date: "year" }, r: { date: "year" } }, fmtVal: makeValueFormatter({}), format: {} });
  assert.equal(l("m"), makeValueFormatter({ decimals: 1 })(1.23456));
  assert.equal(l("d"), "2024");
  assert.equal(l("r"), "EU"); // not a date -> untouched
});
test("tipLookup: a null measure is the em dash; prototype names do not leak", () => {
  const l = tipLookup({ measures: { m: null }, dims: new Map(), formats: { m: { number: "compact" } }, fmtVal: makeValueFormatter({}) });
  assert.equal(l("m"), "—");
  assert.equal(l("constructor"), undefined);
});
test("formatted values still render escaped inside the template", () => {
  const l = tipLookup({ measures: { m: 5 }, dims: new Map([["d", "<b>x</b>"]]), formats: { m: { number: "percent" } }, fmtVal: makeValueFormatter({}) });
  assert.equal(tooltipHtml("<m> <d>", l), "<b>500%</b> <b>&lt;b&gt;x&lt;/b&gt;</b>");
});
test("looksDate", () => { assert.ok(looksDate("2024-01-02")); assert.ok(looksDate("2024-01-02 10:00:00")); assert.ok(!looksDate("EU")); assert.ok(!looksDate(null)); });
test("tooltipCatalog tags kind and carries the raw measure value", () => {
  const cat = tooltipCatalog([{ name: "t.c", values: ["A"] }], ["sum(x)"], ["10"], [10]);
  assert.deepEqual(cat, [{ name: "t.c", sample: "A", kind: "dim" }, { name: "sum(x)", sample: "10", kind: "measure", raw: 10 }]);
});
test("workbook round-trips tooltipFormats; invalid ones are dropped with an issue; formats need a template", () => {
  const issues = [];
  const s = sanitizeSheet({ tooltipText: "<a> <d>", tooltipFormats: { a: { number: "compact", decimals: 1 }, d: { date: "month" } } }, "Sheet 1", issues);
  assert.deepEqual(s.tooltipFormats, { a: { number: "compact", decimals: 1 }, d: { date: "month" } });
  assert.deepEqual(issues, []);
  assert.equal("tooltipFormats" in sanitizeSheet({ tooltipText: "<a>" }, "S", issues), false);
  assert.equal("tooltipFormats" in sanitizeSheet({ tooltipFormats: { a: { number: "compact" } } }, "S", issues), false);
  const bad = [];
  const r = sanitizeSheet({ tooltipText: "<a>", tooltipFormats: { a: { number: "bogus" } } }, "Sheet 1", bad);
  assert.equal("tooltipFormats" in r, false);
  assert.equal(bad.length, 1);
});
test("sampleLookup formats a measure from its raw sample only when it has a format", async () => {
  const { sampleLookup } = await import("../../src/DashboardBuilder/Features/Dashboard/tooltip-formats.js");
  const cat = [{ name: "d", sample: "2024-03-15", kind: "dim" }, { name: "m", sample: "$1.2M", kind: "measure", raw: 1234567 }, { name: "z", sample: "7", kind: "measure", raw: 7 }];
  const l = sampleLookup(cat, { m: { number: "compact" }, d: { date: "year" } });
  assert.equal(l("m"), "1.2M"); assert.equal(l("d"), "2024"); assert.equal(l("z"), "7"); assert.equal(l("q"), undefined);
  assert.equal(sampleLookup(cat, null)("m"), "$1.2M");
});

test("an explicit Auto number format overrides the view's number style", () => {
  const get = tipLookup({ measures: { Sales: 1234 }, dims: new Map(), formats: { Sales: { number: "auto" } }, fmtVal: (v) => `$${v}`, format: { numberFormat: "currency" } });
  assert.equal(get("Sales"), "1,234");
});
