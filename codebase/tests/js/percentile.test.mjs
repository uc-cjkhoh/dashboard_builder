// Percentile as a plain measure (T04-07): the fraction rules, the label, the wire shape, the notice, the workbook round trip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { percent, isFraction, percentLabel, PERCENT_MESSAGE } from "../../src/DashboardBuilder/Features/Core/validate.js";
import { wireMeasure, measureLabel, aggWord, topByRef, topByKey, wireTopBy } from "../../src/DashboardBuilder/Features/Calc/calc-plan.js";
import { aggsFor, serverFilter } from "../../src/DashboardBuilder/Features/Dashboard/filter-rules.js";
import { approxNotice, usesUnscaledAgg, UNSCALED_NOTE } from "../../src/DashboardBuilder/Features/Dashboard/speed-notice.js";
import { aliasNames } from "../../src/DashboardBuilder/Features/Dashboard/result-model.js";
import { fieldId } from "../../src/DashboardBuilder/Features/Dashboard/sheet-plan.js";
import { measureKey } from "../../src/DashboardBuilder/Features/Dashboard/conditional-model.js";
import { syncCastCategories, withCasts } from "../../src/DashboardBuilder/Features/Dashboard/cast-model.js";
import { parseWorkbook, WORKBOOK_FORMAT } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { CALC_AGGS } from "../../src/DashboardBuilder/Features/Calc/calc-pill.js";

const f = (o = {}) => ({ db: "s", table: "orders", column: "amount", category: "numeric", agg: "percentile", p: 0.9, ...o });

test("percent(): an integer or decimal percent 0-100 becomes a 0..1 fraction", () => {
  for (const [t, p] of [["90", 0.9], ["99.9", 0.999], [" 50 ", 0.5], ["0", 0], ["100", 1], ["12.5", 0.125], ["0.000001", 1e-8], [".5", 0.005]])
    assert.deepEqual(percent(t), { ok: true, value: p }, t);
});
test("percent(): anything else is refused with one message, never clamped", () => {
  for (const t of ["", "  ", "abc", "-1", "100.1", "101", "1e2", "NaN", "Infinity", "9 0", "5%", "1.1234567", "0x10"])
    assert.deepEqual(percent(t), { ok: false, error: PERCENT_MESSAGE }, JSON.stringify(t));
  assert.match(PERCENT_MESSAGE, /0 and 100/);
});
test("isFraction(): finite numbers 0..1 only", () => {
  for (const v of [0, 0.5, 1]) assert.ok(isFraction(v));
  for (const v of [-0.1, 1.1, NaN, Infinity, -Infinity, "0.5", null, undefined]) assert.ok(!isFraction(v), String(v));
});
test("percentLabel(): the percent without float noise (the server writes the same text)", () => {
  assert.deepEqual([0.9, 0.5, 0.995, 0, 1, 0.07, 0.999, 1e-6].map(percentLabel), ["90", "50", "99.5", "0", "100", "7", "99.9", "0.0001"]);
});

test("labels: p90 amount, from the pill, the entry and the alias", () => {
  assert.equal(aggWord("percentile", 0.9), "p90");
  assert.equal(aggWord("sum"), "sum");
  assert.equal(measureLabel(f(), [], undefined), "p90 amount");
  assert.equal(measureLabel(f({ p: 0.995 }), [], "Revenue"), "p99.5 Revenue");
  assert.equal(measureLabel(f({ agg: "median" }), [], undefined), "median amount");
});
test("aliasNames labels a renamed percentile measure", () => {
  const s = { columns: [f()], rows: [{ db: "s", table: "orders", column: "region", category: "text" }], marks: {}, color: [], chartType: "bar", filters: [] };
  const out = aliasNames(s, { rowDimensions: ["s.orders.region"], columnDimensions: [], measures: ["p90 amount"], rows: [] }, (x) => (x.column === "amount" ? { alias: "Revenue" } : {}));
  assert.deepEqual(out.measures, ["p90 Revenue"]);
});

test("the plan carries p on a percentile measure and on nothing else", () => {
  assert.deepEqual(wireMeasure({ field: f(), agg: "percentile" }, {}), { db: "s", table: "orders", column: "amount", agg: "percentile", p: 0.9 });
  assert.deepEqual(wireMeasure({ field: f({ agg: "sum" }), agg: "sum" }, {}), { db: "s", table: "orders", column: "amount", agg: "sum" });
  assert.ok(!("p" in wireMeasure({ field: f({ agg: "avg", p: 0.4 }), agg: "avg" }, {})), "a stale p never rides along");
});
test("Top-N ranked by a percentile carries p, keys differ per p", () => {
  const e = { field: f(), agg: "percentile" };
  assert.deepEqual(topByRef(e, {}), { db: "s", table: "orders", column: "amount", agg: "percentile", p: 0.9 });
  assert.deepEqual(wireTopBy(topByRef(e, {}), {}), { db: "s", table: "orders", column: "amount", agg: "percentile", p: 0.9 });
  assert.notEqual(topByKey(e), topByKey({ field: f({ p: 0.5 }), agg: "percentile" }));
  assert.equal(topByKey({ field: f({ agg: "sum" }), agg: "sum" }), "s.orders.amount:sum");
  const sf = serverFilter({ db: "s", table: "orders", column: "region", op: "top", value: "3", topBy: topByRef(e, {}) }, {});
  assert.equal(sf.topBy.p, 0.9);
});
test("two percentiles of one field are different pills, sort targets and settings", () => {
  assert.notEqual(fieldId(f(), "measure"), fieldId(f({ p: 0.5 }), "measure"));
  assert.equal(fieldId(f({ agg: "sum", p: undefined }), "measure"), "measure:s.orders.amount:sum");
  assert.notEqual(measureKey({ field: f(), agg: "percentile" }), measureKey({ field: f({ p: 0.1 }), agg: "percentile" }));
  assert.equal(measureKey({ field: f({ agg: "median" }), agg: "median" }), "s.orders.amount:median");
});

test("percentile is a numeric aggregation only; calculated pills do not list it", () => {
  assert.ok(aggsFor("numeric").includes("percentile"));
  for (const c of ["text", "temporal", "boolean", "other"]) assert.ok(!aggsFor(c).includes("percentile"), c);
  assert.ok(!CALC_AGGS.includes("percentile"));
});

test("the speed notice covers a plain percentile measure", () => {
  const plain = { db: "s", table: "t", column: "c", agg: "percentile", p: 0.9 };
  assert.ok(usesUnscaledAgg([plain]));
  assert.equal(approxNotice({ distinct: false, sample: 0.1 }, [plain]), `Approximate — a 10% sample, scaled up (${UNSCALED_NOTE})`);
  assert.match(UNSCALED_NOTE, /percentile/);
});

test("a cast that makes the field non-numeric clears the percentile and its p", () => {
  const sheet = { columns: [], rows: [f({ column: "qty_s", category: "numeric" })], color: [], marks: {}, filters: [], drill: null };
  syncCastCategories(sheet, [], () => null, () => "text");
  assert.equal(sheet.rows[0].category, "text");
  assert.notEqual(sheet.rows[0].agg, "percentile");
  assert.ok(!("p" in sheet.rows[0]));
});
test("withCasts keeps p on a cast measure", () => {
  const plan = { rowDimensions: [], measures: [{ db: "d", table: "t", column: "q", agg: "percentile", p: 0.25 }], filters: [] };
  assert.equal(withCasts(plan, () => "number").measures[0].p, 0.25);
});

// --- workbook ---
const wbText = (patch) => JSON.stringify({ format: WORKBOOK_FORMAT, version: 1, entities: [], relationships: [], dashboards: [], ...patch });
const sheetOf = (sheet) => parseWorkbook(wbText({ dashboards: [{ name: "S", sheet }] }));
test("a percentile pill round-trips with its p; old workbooks are unchanged", () => {
  const wb = sheetOf({ rows: [f(), f({ agg: "sum", p: undefined })] });
  assert.equal(wb.worksheets[0].sheet.rows[0].agg, "percentile");
  assert.equal(wb.worksheets[0].sheet.rows[0].p, 0.9);
  assert.equal(wb.worksheets[0].sheet.rows[1].agg, "sum");
  assert.deepEqual(wb.issues, []);
});
test("a percentile pill with a missing, non-numeric or out-of-range p resets the aggregation with an issue", () => {
  for (const p of [undefined, "0.9", null, -0.1, 1.5, NaN]) {
    const wb = sheetOf({ rows: [f({ p })] });
    const r = wb.worksheets[0].sheet.rows[0];
    assert.equal(r.agg, "sum", String(p));
    assert.ok(!("p" in r), String(p));
    assert.ok(wb.issues.some((i) => /percentile/.test(i)), String(p));
  }
});
test("a stray p on another aggregation is dropped silently", () => {
  const wb = sheetOf({ rows: [f({ agg: "avg", p: 0.3 })] });
  assert.ok(!("p" in wb.worksheets[0].sheet.rows[0]));
  assert.deepEqual(wb.issues, []);
});
test("a percentile on a text pill resets like any aggregation the type does not offer", () => {
  const wb = sheetOf({ rows: [f({ category: "text" })] });
  assert.notEqual(wb.worksheets[0].sheet.rows[0].agg, "percentile");
  assert.ok(!("p" in wb.worksheets[0].sheet.rows[0]));
});
test("a calculated pill never keeps a percentile", () => {
  const c = { calc: "calc1", db: "", table: "", column: "M", category: "numeric", role: "measure", agg: "percentile", p: 0.5 };
  const wb = parseWorkbook(wbText({ calculations: [{ id: "calc1", name: "M", formula: "1" }], dashboards: [{ name: "X", sheet: { rows: [c] } }] }));
  assert.equal(wb.worksheets[0].sheet.rows[0].agg, "sum");
  assert.ok(!("p" in wb.worksheets[0].sheet.rows[0]));
});
const top = (topBy) => ({ db: "s", table: "orders", column: "region", category: "text", op: "top", value: "5", topBy });
test("a Top-N ranked by a percentile round-trips; a bad p drops the filter", () => {
  const ok = sheetOf({ filters: [top({ db: "s", table: "orders", column: "amount", agg: "percentile", p: 0.75 })] });
  assert.equal(ok.worksheets[0].sheet.filters[0].topBy.p, 0.75);
  for (const p of [undefined, 2, "x"]) {
    const bad = sheetOf({ filters: [top({ db: "s", table: "orders", column: "amount", agg: "percentile", p })] });
    assert.equal(bad.worksheets[0].sheet.filters.length, 0, String(p));
  }
});
test("a field default aggregation of percentile is not accepted (it needs a p; keep it out of the menu)", () => {
  const wb = parseWorkbook(wbText({ fields: { "s.orders.amount": { agg: "percentile" } } }));
  assert.deepEqual(wb.fields, {});
  assert.ok(wb.issues.some((i) => /field setting/.test(i)));
});
