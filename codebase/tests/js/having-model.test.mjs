import { test } from "node:test";
import assert from "node:assert/strict";
import { HAVING_OPS, checkHaving, cleanHaving, havingPlan, havingSentence, havingNotice, havingBadge } from "../../src/DashboardBuilder/Features/Dashboard/having-model.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";
import { buildPlan } from "../../src/DashboardBuilder/Features/Dashboard/sheet-plan.js";
import { fieldPillOptions } from "../../src/DashboardBuilder/Features/Dashboard/pill-options.js";

test("the operators mirror the server whitelist (RequestRules.HavingOps)", () => {
  assert.deepEqual(HAVING_OPS.map(([v]) => v), ["=", "!=", ">", ">=", "<", "<=", "between"]);
  assert.equal(LIMITS.having, 10);
});

test("checkHaving: empty until a value, invalid for a non-number, ok for a plain number", () => {
  assert.equal(checkHaving(undefined).state, "empty");
  assert.equal(checkHaving({ op: ">", value: "" }).state, "empty");
  assert.equal(checkHaving({ op: ">", value: "1000" }).state, "ok");
  assert.equal(checkHaving({ op: ">", value: "-2.5e3" }).state, "ok");
  for (const bad of ["abc", "1,000", "NaN", "0x10", "1e999", "1 2"]) assert.equal(checkHaving({ op: ">", value: bad }).state, "invalid", bad);
  assert.match(checkHaving({ op: ">", value: "abc" }).error, /not a number/);
});

test("checkHaving: a range needs both ends in order; an unknown operator is invalid", () => {
  assert.equal(checkHaving({ op: "between", values: ["", ""] }).state, "empty");
  assert.equal(checkHaving({ op: "between", values: ["1", ""] }).state, "invalid");
  assert.equal(checkHaving({ op: "between", values: ["9", "1"] }).state, "invalid");
  assert.equal(checkHaving({ op: "between", values: ["1", "1"] }).state, "ok");
  assert.equal(checkHaving({ op: "like", value: "1" }).state, "invalid");
});

test("cleanHaving keeps only a valid stored filter, with just its own keys", () => {
  assert.deepEqual(cleanHaving({ op: ">=", value: " 5 ", junk: 1 }), { op: ">=", value: "5" });
  assert.deepEqual(cleanHaving({ op: "between", values: ["1", "2"] }), { op: "between", values: ["1", "2"] });
  for (const bad of [null, "x", { op: "like", value: "1" }, { op: ">", value: "nope" }, { op: "between", values: ["2", "1"] }, { op: ">" }]) assert.equal(cleanHaving(bad), null);
});

const m = (agg, extra = {}) => ({ field: { db: "d", table: "t", column: "amount", category: "numeric", agg, ...extra }, role: "shelf", agg });

test("havingPlan: one entry per shelf measure with a valid filter, by its position in the query", () => {
  const plan = havingPlan([m("sum"), m("avg", { having: { op: ">", value: "10" } }), m("count", { having: { op: "between", values: ["1", "5"] } }), m("min", { having: { op: ">", value: "x" } })]);
  assert.deepEqual(plan, [{ measure: 1, op: ">", value: "10" }, { measure: 2, op: "between", values: ["1", "5"] }]);
});
test("havingPlan ignores a filter on a marks-only measure (size / colour) and a filter with no value", () => {
  const size = { ...m("sum", { having: { op: ">", value: "1" } }), role: "size" };
  assert.deepEqual(havingPlan([m("sum"), size, m("sum", { having: { op: ">", value: "" } })]), []);
});
test("havingPlan never exceeds the cap", () => {
  const many = Array.from({ length: 12 }, () => m("sum", { having: { op: ">", value: "1" } }));
  assert.equal(havingPlan(many).length, LIMITS.having);
});

test("havingSentence says the measure, the condition and the number in words", () => {
  assert.equal(havingSentence("sum Sales", { op: ">=", value: "1000" }), "sum Sales is at least 1000");
  assert.equal(havingSentence("count", { op: "between", values: ["1", "5"] }), "count is between 1 and 5");
  assert.equal(havingSentence("avg Price", { op: "!=", value: "0" }), "avg Price is not 0");
});
test("havingNotice states the filter and the grain it applies at", () => {
  const n = havingNotice([{ label: "sum Sales", having: { op: ">", value: "1000" } }], ["Region", "Year"]);
  assert.equal(n, "Showing only groups where sum Sales is greater than 1000, per Region and Year.");
  assert.equal(havingNotice([{ label: "sum Sales", having: { op: ">", value: "1000" } }], []), "Showing only the total when sum Sales is greater than 1000.");
  assert.equal(havingNotice([{ label: "a", having: { op: "<", value: "1" } }, { label: "b", having: { op: "=", value: "2" } }], ["Region"]),
    "Showing only groups where a is less than 1 and b equals 2, per Region.");
  assert.equal(havingNotice([{ label: "a", having: undefined }], ["Region"]), null);
});
test("havingNotice flags an invalid filter as not applied", () => {
  assert.match(havingNotice([{ label: "sum Sales", having: { op: ">", value: "abc" } }], ["Region"]), /not applied/);
});
test("havingBadge: the short text on the pill", () => {
  assert.equal(havingBadge({ op: ">=", value: "1000" }), "≥ 1,000");
  assert.equal(havingBadge({ op: ">", value: "1000000" }), "> 1,000,000");
  assert.equal(havingBadge({ op: ">", value: "1234.5" }), "> 1,234.5");
  assert.equal(havingBadge({ op: ">", value: "-2500" }), "> -2,500");
  assert.equal(havingBadge({ op: "between", values: ["1000", "250000"] }), "1,000 – 250,000");
  assert.equal(havingBadge({ op: "between", values: ["1", "5"] }), "1 – 5");
  assert.equal(havingBadge(undefined), "");
});

test("a measure pill's menu offers the measure filter; a dimension's does not", () => {
  const ids = (l) => l.filter((e) => e.id).map((e) => e.id);
  assert.ok(ids(fieldPillOptions({ measure: true, aggs: ["sum"], roleFlip: true, numeric: true })).includes("having"));
  assert.ok(!ids(fieldPillOptions({ measure: false, roleFlip: true, numeric: true })).includes("having"));
});

// --- the query plan -----------------------------------------------------------------------------------------------
const ctx = {
  calculations: [], entities: new Map(), relationships: new Map(), sharedFilters: [], parameters: [],
  metaOf: () => ({}), nameOf: (f) => f.column, columnType: () => "Float64",
};
const sheet = (rows, columns, extra = {}) => ({ chartType: "bar", rows, columns, filters: [], marks: {}, format: {}, color: [], ...extra });
const dim = { db: "d", table: "t", column: "region", category: "text", role: "dimension" };
const sum = (having) => ({ db: "d", table: "t", column: "amount", category: "numeric", agg: "sum", ...(having ? { having } : {}) });

test("buildPlan sends the measure filter by measure position and drops the Other bucket it can't combine with", () => {
  const p = buildPlan(sheet([dim], [sum({ op: ">", value: "1000" })]), undefined, ctx);
  assert.deepEqual(p.having, [{ measure: 0, op: ">", value: "1000" }]);
  assert.equal(p.otherBucket, undefined);
});
test("buildPlan with no measure filter sends none and keeps the Other bucket", () => {
  const p = buildPlan(sheet([dim], [sum()]), undefined, ctx);
  assert.equal("having" in p, false);
});
test("buildPlan leaves an invalid measure filter out (the notice says it was not applied)", () => {
  const p = buildPlan(sheet([dim], [sum({ op: ">", value: "abc" })]), undefined, ctx);
  assert.equal("having" in p, false);
});

import { sliderBounds, sliderStep, sliderValues, sliderKey } from "../../src/DashboardBuilder/Features/Dashboard/having-model.js";

test("sliderBounds: the range of one measure column, widened by what was seen before and by the filter itself", () => {
  const rows = [{ values: [10, 5] }, { values: [30, null] }, { values: [20, 7] }];
  assert.deepEqual(sliderBounds(rows, 0, null, null), { min: 10, max: 30 });
  assert.deepEqual(sliderBounds(rows, 1, null, null), { min: 5, max: 7 });
  assert.deepEqual(sliderBounds(rows, 0, { min: 0, max: 25 }, null), { min: 0, max: 30 });
  assert.deepEqual(sliderBounds(rows, 0, null, { op: "between", values: ["0", "100"] }), { min: 0, max: 100 });
  assert.equal(sliderBounds([], 0, null, null), null);
  assert.equal(sliderBounds([{ values: [null] }], 0, null, null), null);
  assert.equal(sliderBounds([{ values: ["x"] }], 0, null, null), null);
});

test("sliderStep: 1 for whole numbers, else a power of ten of about 1/100 of the span", () => {
  assert.equal(sliderStep({ min: 0, max: 500 }), 1);
  assert.equal(sliderStep({ min: 0, max: 1 }), 0.01);
  assert.equal(sliderStep({ min: 0.5, max: 2.5 }), 0.01);
  assert.equal(sliderStep({ min: 3, max: 3 }), 1);
});

test("sliderValues: the two thumbs from a stored filter, whole range when none, never outside the bounds", () => {
  const b = { min: 0, max: 100 };
  assert.deepEqual(sliderValues(b, null), [0, 100]);
  assert.deepEqual(sliderValues(b, { op: "between", values: ["10", "30"] }), [10, 30]);
  assert.deepEqual(sliderValues(b, { op: "between", values: ["-5", "300"] }), [0, 100]);
  assert.deepEqual(sliderValues(b, { op: "between", values: ["abc", ""] }), [0, 100]);
});

test("sliderKey: a different aggregation, measure or grain is a different remembered span", () => {
  const k = sliderKey("s1", "sum amount", ["region"]);
  assert.equal(k, sliderKey("s1", "sum amount", ["region"]));
  assert.notEqual(k, sliderKey("s1", "avg amount", ["region"]));
  assert.notEqual(k, sliderKey("s1", "sum amount", ["region", "year"]));
  assert.notEqual(k, sliderKey("s2", "sum amount", ["region"]));
});

test("sliderBounds: a stale remembered span from another aggregation only matters under its own key; a stored filter outside the span widens it", () => {
  const rows = [{ values: [1] }, { values: [2] }];
  assert.deepEqual(sliderBounds(rows, 0, null, null), { min: 1, max: 2 }); // fresh key: no stale huge span
  assert.deepEqual(sliderBounds(rows, 0, null, { op: "between", values: ["0", "50"] }), { min: 0, max: 50 });
});
