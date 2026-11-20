import test from "node:test";
import assert from "node:assert/strict";
import { profileFailure, profileRequest, formatCount, formatShare, formatNumber, histogramRequest, histogramView, distributionFailure, roleOf, summarize, toneOf, PROFILE_LIMITS } from "../../src/DashboardBuilder/Features/Schema/column-profile-model.js";

test("limits mirror the server (DefaultProfileTop / MaxProfileTop / MaxColumnName)", () => {
  assert.deepEqual({ ...PROFILE_LIMITS }, { top: 10, maxTop: 50, maxColumn: 1000, valueLength: 100, bins: 20 });
});
test("profileRequest builds the body and rejects out-of-range input instead of clamping", () => {
  assert.deepEqual(profileRequest("city"), { column: "city", limit: 10 });
  assert.deepEqual(profileRequest("city", 50), { column: "city", limit: 50 });
  assert.throws(() => profileRequest("city", 0), /between 1 and 50/);
  assert.throws(() => profileRequest("city", 51), /between 1 and 50/);
  assert.throws(() => profileRequest("city", 2.5), /between 1 and 50/);
  assert.throws(() => profileRequest(""), /column/i);
  assert.throws(() => profileRequest("x".repeat(1001)), /1000/);
});
test("formatCount groups thousands", () => { assert.equal(formatCount(0), "0"); assert.equal(formatCount(1234567), "1,234,567"); });
test("formatShare: exact zero and full, a floor for tiny shares, never rounds a partial share up to 100", () => {
  assert.equal(formatShare(0, 0), "0%");
  assert.equal(formatShare(0, 10), "0%");
  assert.equal(formatShare(10, 10), "100%");
  assert.equal(formatShare(1, 3), "33%");
  assert.equal(formatShare(1, 1000), "0.1%");
  assert.equal(formatShare(1, 100000), "<0.1%");
  assert.equal(formatShare(4, 100), "4.0%");
  assert.equal(formatShare(99999, 100000), "99.9%");
});
test("role follows the worksheet rule: numeric is a measure, everything else a dimension", () => {
  assert.equal(roleOf("numeric"), "measure");
  for (const c of ["text", "temporal", "boolean", "compound", "other"]) assert.equal(roleOf(c), "dimension");
});

const P = (over = {}) => ({ column: "grp", type: "Nullable(String)", category: "text", rows: 6, nulls: 1, distinct: 3, min: null, max: null,
  top: [{ value: "a", count: 2, cut: false }, { value: "b", count: 2, cut: false }, { value: "", count: 1, cut: false }, { value: null, count: 1, cut: false }], ...over });

test("summarize: tiles and honest wording", () => {
  const s = summarize(P());
  assert.deepEqual(s.tiles.map((t) => [t.label, t.value]), [["Rows", "6"], ["Distinct (approx.)", "3"], ["Null value", "1"]]);
  assert.equal(s.tiles[1].note, null);
  assert.equal(s.tiles[2].note, null);
  assert.equal(s.role, "dimension");
  assert.equal(s.details, undefined); // name and type are the dialog's title and subtitle, never a second time
});
test("summarize: min/max tiles only when present; a large table reads like any other", () => {
  const s = summarize(P({ rows: 1000000, nulls: 0, distinct: 5000, category: "numeric", min: "5", max: "20" }));
  assert.equal(s.cutNote, null);
  assert.deepEqual(s.tiles.map((t) => t.label), ["Rows", "Distinct (approx.)", "Null value", "Min", "Max"]);
  assert.equal(s.tiles[0].note, null);
  assert.equal(s.sampleNote, undefined);
  assert.equal(s.role, "measure");
});
test("summarize: top rows carry labels, counts, shares and bar widths; NULL and empty are named, cut values flagged", () => {
  const s = summarize(P({ top: [...P().top, { value: "x".repeat(100), count: 1, cut: true }] }));
  assert.deepEqual(s.top.map((t) => [t.label, t.kind, t.countText, t.shareText]),
    [["a", "value", "2", "33%"], ["b", "value", "2", "33%"], ["(empty)", "empty", "1", "17%"], ["(NULL)", "null", "1", "17%"], ["x".repeat(100) + "…", "value", "1", "17%"]]);
  assert.equal(s.top[0].bar, 33); assert.equal(s.top[0].tone, 1); assert.equal(Math.min(...s.top.map((t) => t.tone)), 0); assert.equal(s.top[4].cut, true);
  assert.match(s.cutNote, /first 100 characters.*differ only after/);
});
test("summarize: Other values closes the list at every row when the Top N leaves some out", () => {
  const s = summarize(P({ rows: 100, top: [{ value: "a", count: 40, cut: false }, { value: "b", count: 30, cut: false }] }));
  assert.deepEqual([s.other.label, s.other.kind, s.other.countText, s.other.shareText, s.other.bar], ["Other values", "other", "30", "30%", 30]);
  assert.equal(s.top.length, 2); // the Top N itself is unchanged (copy, leader, "every row is NULL" all read it)
  assert.equal(s.top.reduce((n, t) => n + t.count, 0) + s.other.count, 100);
  assert.equal(summarize(P()).other, null); // the Top N already covers every row
  assert.equal(summarize(P({ rows: 0, nulls: 0, distinct: 0, top: [] })).other, null);
});
test("summarize: an empty table has nothing to divide and no top values", () => {
  const s = summarize(P({ rows: 0, nulls: 0, distinct: 0, top: [] }));
  assert.equal(s.tiles[2].value, "0"); assert.equal(s.top.length, 0); assert.equal(s.empty, true);
});
test("copy text: the plain non-null values (cut values left out)", () => {
  const s = summarize(P({ top: [...P().top, { value: "x".repeat(100), count: 1, cut: true }] }));
  assert.equal(s.copyValues, "a\nb");
});

test("a custom SQL card's profile request carries its query as `source`", () => {
  const source = { kind: "sql", db: "shop", name: "orders", sql: "SELECT city FROM shop.o" };
  assert.deepEqual(profileRequest("city", undefined, source), { column: "city", limit: 10, source });
  assert.equal("source" in profileRequest("city", 5, null), false);
});

test("profileFailure: a timeout drops the worksheet advice; other failures pass through", () => {
  const timeout = Object.assign(new Error("The query ran longer than 30 seconds and was stopped. Add a filter, lower Top-N, or use fewer fields."), { status: 504 });
  const plain = profileFailure(timeout);
  assert.equal(plain, "The query ran longer than 30 seconds and was stopped. The profile reads every row, so a very large table can run past the limit.");
  assert.doesNotMatch(plain, /Top-N|filter/);
  assert.match(profileFailure(timeout, true), /Narrow the query with Edit SQL, then profile again\.$/);
  assert.equal(profileFailure(Object.assign(new Error("Query failed against ClickHouse."), { status: 502 })), "Query failed against ClickHouse.");
  assert.equal(profileFailure(new Error("")), "The profile could not be read.");
});

test("summarize: a reason says why there is nothing to show (no rows; every row NULL or empty), and is null when there is data", () => {
  assert.equal(summarize(P()).reason, null);
  const none = P({ rows: 0, nulls: 0, distinct: 0, top: [] });
  assert.equal(summarize(none).reason, "This table has no rows, so there is nothing to profile.");
  assert.match(summarize(none, true).reason, /^The query returns no rows, so there is nothing to profile\. Check its filters in Edit SQL\.$/);
  const only = (...top) => P({ rows: 4, nulls: 0, distinct: 1, top });
  assert.equal(summarize(only({ value: null, count: 4, cut: false })).reason, "Every row is NULL, so there are no values to list and no Min or Max.");
  assert.equal(summarize(only({ value: "", count: 4, cut: false })).reason, "Every row is empty, so there are no values to list and no Min or Max.");
  assert.equal(summarize(only({ value: null, count: 2, cut: false }, { value: "", count: 2, cut: false })).reason, "Every row is NULL or empty, so there are no values to list and no Min or Max.");
  assert.equal(summarize(only({ value: null, count: 2, cut: false }, { value: "a", count: 2, cut: false })).reason, null);
});

test("formatNumber: short, never a long float, never a rounded-away integer part, null for NaN / infinity / missing", () => {
  assert.equal(formatNumber(1234567.891), "1,234,568");
  assert.equal(formatNumber(12345.678), "12,346");
  assert.equal(formatNumber(123.456), "123.5");
  assert.equal(formatNumber(12.3456), "12.35");
  assert.equal(formatNumber(3), "3");
  assert.equal(formatNumber(0.000123456), "0.000123");
  assert.equal(formatNumber(1e-7), "1e-7");
  assert.equal(formatNumber(1.5e17), "1.5e+17");
  assert.equal(formatNumber(-0), "0");
  assert.equal(formatNumber(-42.005), "-42.01");
  for (const bad of [NaN, Infinity, -Infinity, null, undefined]) assert.equal(formatNumber(bad), null);
  assert.ok(formatNumber(12.345678901234567).length <= 12, "a float never trips the long-figure step-down");
});
const NUM = (over = {}) => P({ column: "n", type: "Int32", category: "numeric", rows: 10, nulls: 0, distinct: 10, min: "1", max: "10", summary: { mean: 5.5, median: 5.5, stdDev: 3.0276503540974917, q1: 3, q3: 8 }, ...over });
test("summarize: a numeric summary is its own group, never among the count or range tiles; text and date columns have none", () => {
  const s = summarize(NUM());
  assert.deepEqual(s.tiles.map((t) => t.label), ["Rows", "Distinct (approx.)", "Null value", "Min", "Max"]);
  assert.deepEqual(s.summary.map((t) => [t.label, t.value]), [["Mean", "5.5"], ["Median (approx.)", "5.5"], ["Std. deviation", "3.03"], ["Q1 (approx.)", "3"], ["Q3 (approx.)", "8"]]);
  assert.deepEqual(summarize(P()).summary, []);
  assert.deepEqual(summarize(P({ category: "temporal", min: "2020-01-01", max: "2020-12-31" })).summary, []);
});
test("summarize: a summary figure the server could not give leaves its tile out", () => {
  const s = summarize(NUM({ summary: { mean: 7, median: 7, stdDev: null, q1: 7, q3: 7 } }));
  assert.deepEqual(s.summary.map((t) => t.label), ["Mean", "Median (approx.)", "Q1 (approx.)", "Q3 (approx.)"]);
  assert.deepEqual(summarize(NUM({ summary: null })).summary, []);
});
test("histogramRequest: the column rules, the bin count and the custom SQL source", () => {
  assert.deepEqual(histogramRequest("n"), { column: "n", buckets: 20 });
  assert.deepEqual(histogramRequest("n", { kind: "sql" }), { column: "n", buckets: 20, source: { kind: "sql" } });
  assert.throws(() => histogramRequest(" "), /column/i);
});
test("histogramView: bars scale to the fullest bin, which is the one peak; whole-number bins read as integer ranges", () => {
  const v = histogramView({ whole: true, bins: [{ x0: 0, x1: 10, count: 5 }, { x0: 10, x1: 20, count: 20 }, { x0: 20, x1: 21, count: 1 }, { x0: 21, x1: 31, count: 0 }] }, 26);
  assert.deepEqual(v.bars.map((b) => [b.range, b.height, b.peak]), [["0–9", 25, false], ["10–19", 100, true], ["20", 5, false], ["21–30", 0, false]]);
  assert.equal(v.min, "0"); assert.equal(v.max, "30");
  assert.equal(v.peak, "Fullest bin: 10–19, 20 rows (77%)");
});
test("histogramView: fractional bins read as from – to; one bar with a count is never invisible; empty is explained", () => {
  const v = histogramView({ whole: false, bins: [{ x0: 0.5, x1: 1.25, count: 1 }, { x0: 1.25, x1: 2, count: 5000 }] }, 5001);
  assert.equal(v.bars[0].range, "0.5 – 1.25"); assert.equal(v.bars[0].height, 1);
  assert.equal(v.peak, "Fullest bin: 1.25 – 2, 5,000 rows (100%)".replace("(100%)", "(99.9%)"));
  for (const h of [{ bins: [] }, { bins: [{ x0: 0, x1: 1, count: 0 }] }, null]) { const e = histogramView(h, 0); assert.equal(e.empty, true); assert.match(e.reason, /no values/); }
});
test("distributionFailure: a timeout is reworded, anything else passes through", () => {
  assert.match(distributionFailure({ status: 504, message: "x" }), /ran past the time limit/);
  assert.match(distributionFailure({ status: 504, message: "x" }, true), /Edit SQL/);
  assert.equal(distributionFailure({ status: 502, message: "Down." }), "Down.");
});

test("toneOf: 0 at the smallest count, 1 at the largest, 1 when all are equal; histogramView bars carry it", () => {
  assert.equal(toneOf(5, 5, 25), 0); assert.equal(toneOf(25, 5, 25), 1); assert.equal(toneOf(15, 5, 25), 0.5); assert.equal(toneOf(7, 7, 7), 1);
  const v = histogramView({ bins: [{ x0: 0, x1: 10, count: 5 }, { x0: 10, x1: 20, count: 20 }] }, 25);
  assert.deepEqual(v.bars.map((b) => b.tone), [0, 1]);
});
