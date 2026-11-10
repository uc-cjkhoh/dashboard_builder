import { test } from "node:test";
import assert from "node:assert/strict";
import { checkValue, withParamValue, effectiveTopN, cleanParameter, paramTypeFor } from "../../src/DashboardBuilder/Features/Core/parameters-model.js";

const num = { id: "prm1", name: "N", type: "number", allowed: { kind: "range", min: 1, max: 50 }, value: 10 };
test("values are checked by type and allowed values", () => {
  assert.deepEqual(checkValue(num, "20"), { ok: true, value: 20 });
  assert.equal(checkValue(num, "60").ok, false);
  assert.equal(checkValue(num, "abc").ok, false);
  const list = { name: "Region", type: "text", allowed: { kind: "list", list: ["EU", "US"] } };
  assert.equal(checkValue(list, "EU").ok, true);
  assert.equal(checkValue(list, "APAC").ok, false);
  assert.equal(checkValue({ name: "D", type: "date" }, "2026-02-30").ok, false);
  assert.equal(checkValue({ name: "D", type: "date" }, "2026-02-28").value, "2026-02-28");
  assert.equal(checkValue(num, "  ").ok, false);
});
test("a bound filter reads the parameter's value; a missing parameter reads empty", () => {
  assert.equal(withParamValue({ op: "=", value: "x", param: "prm1" }, [num]).value, "10");
  assert.equal(withParamValue({ op: "=", value: "x", param: "prm9" }, [num]).value, "");
  const plain = { op: "=", value: "x" };
  assert.equal(withParamValue(plain, [num]), plain);
});
test("Top N follows a number parameter, clamped to the cap", () => {
  assert.equal(effectiveTopN({ topN: 5, topNParam: "prm1" }, [num], 5000), 10);
  assert.equal(effectiveTopN({ topN: 5, topNParam: "prm1" }, [{ ...num, value: 99999 }], 5000), 5000);
  assert.equal(effectiveTopN({ topN: 5, topNParam: "gone" }, [num], 5000), 5);
  assert.equal(effectiveTopN({ topN: null }, [], 5000), null);
});
test("parameter types for filter fields", () => {
  assert.equal(paramTypeFor("numeric"), "number");
  assert.equal(paramTypeFor("temporal"), "date");
  assert.equal(paramTypeFor("boolean"), null);
});
test("saved parameters are checked; a bad value is reset and reported", () => {
  const issues = [];
  assert.deepEqual(cleanParameter({ id: "prm3", name: "Top", type: "number", value: 7, allowed: { kind: "range", min: 1, max: 9 } }, issues),
    { id: "prm3", name: "Top", type: "number", allowed: { kind: "range", min: 1, max: 9, step: null }, value: 7 });
  assert.equal(cleanParameter({ id: "x", name: "Bad id", type: "number", value: 1 }, issues), null);
  assert.equal(cleanParameter({ id: "prm4", name: "R", type: "text", value: "Mars", allowed: { kind: "list", list: ["EU", "US"] } }, issues).value, "EU");
  assert.equal(issues.length, 2);
});

test("step size: positive finite only; stored and round-tripped for number ranges", async () => {
  const { checkStep } = await import("../../src/DashboardBuilder/Features/Core/parameters-model.js");
  assert.deepEqual(checkStep(""), { ok: true, value: null });
  assert.deepEqual(checkStep(" 0.5 "), { ok: true, value: 0.5 });
  for (const bad of ["0", "-1", "abc", "Infinity", "1e999"]) assert.equal(checkStep(bad).ok, false, bad);
  const issues = [];
  const p = cleanParameter({ id: "prm1", name: "N", type: "number", allowed: { kind: "range", min: 0, max: 10, step: 2 }, value: 4 }, issues);
  assert.equal(p.allowed.step, 2);
  const bad = cleanParameter({ id: "prm1", name: "N", type: "number", allowed: { kind: "range", min: 0, max: 10, step: -2 }, value: 4 }, []);
  assert.equal(bad.allowed.step, null);
});

import { dropParamRefs } from "../../src/DashboardBuilder/Features/Core/parameters-model.js";
test("dropParamRefs clears every reference to a deleted parameter and leaves others", () => {
  const sheet = { paramAction: { param: "prm1" }, filters: [{ column: "a", param: "prm1" }, { column: "b", param: "prm2" }],
    format: { topNParam: "prm1" }, analytics: { ref: { kind: "constant", value: 1, param: "prm1" }, band: { from: 0, to: 1, fromParam: "prm1", toParam: "prm2" } } };
  assert.equal(dropParamRefs(sheet, "prm1"), true);
  assert.equal(sheet.paramAction, null);
  assert.equal(sheet.filters[0].param, undefined);
  assert.equal(sheet.filters[1].param, "prm2");
  assert.equal(sheet.format.topNParam, undefined);
  assert.equal(sheet.analytics.ref.param, undefined);
  assert.equal(sheet.analytics.band.fromParam, undefined);
  assert.equal(sheet.analytics.band.toParam, "prm2");
  assert.equal(dropParamRefs({ paramAction: { param: "prm2" } }, "prm1"), false);
  assert.equal(dropParamRefs({}, "prm1"), false);
});

import { paramRefs } from "../../src/DashboardBuilder/Features/Core/parameters-model.js";
test("paramRefs lists every reader of a parameter", () => {
  const sheets = [{ name: "S1", sheet: { paramAction: { param: "prm1" }, filters: [{ column: "region", param: "prm1" }, { column: "b", param: "prm2" }], format: { topNParam: "prm1" },
    analytics: { ref: { kind: "constant", param: "prm1" }, band: { fromParam: "prm1", toParam: "prm2" } } } }, { name: "S2", sheet: {} }];
  const r = paramRefs(sheets, [{ column: "c", param: "prm1" }], "prm1");
  assert.equal(r.length, 6);
  assert.ok(r.includes("S1: a filter on region") && r.includes("S1: Top N") && r.includes("a shared filter on c"));
  assert.deepEqual(paramRefs(sheets, [], "prm9"), []);
});

import { effectiveWindow, effectiveForecast, FORECAST_PARAM_MAX } from "../../src/DashboardBuilder/Features/Core/parameters-model.js";
test("a moving-average window follows a number parameter (whole number 2-30), else its typed window", () => {
  const p = (value) => [{ id: "prm1", type: "number", value }];
  assert.equal(effectiveWindow({ window: 3, windowParam: "prm1" }, p(7)), 7);
  assert.equal(effectiveWindow({ window: 3, windowParam: "prm1" }, p(1)), 3, "out of range: typed window, not clamped");
  assert.equal(effectiveWindow({ window: 3, windowParam: "prm1" }, p(31)), 3);
  assert.equal(effectiveWindow({ window: 3, windowParam: "prm1" }, p(2.5)), 3, "not a whole number");
  assert.equal(effectiveWindow({ window: 5, windowParam: "gone" }, p(7)), 5);
  assert.equal(effectiveWindow({ windowParam: "prm1" }, p(0)), 3, "default 3");
  assert.equal(effectiveWindow({ window: 5 }, p(7)), 5);
  assert.equal(effectiveWindow({ window: 5, windowParam: "prm1" }, [{ id: "prm1", type: "text", value: "9" }]), 5, "only a number parameter");
});
test("a forecast follows a number parameter (whole number 0-24), else its typed steps", () => {
  const p = (value) => [{ id: "prm1", type: "number", value }];
  assert.equal(FORECAST_PARAM_MAX, 24);
  assert.equal(effectiveForecast({ forecast: 3, forecastParam: "prm1" }, p(8)), 8);
  assert.equal(effectiveForecast({ forecast: 3, forecastParam: "prm1" }, p(0)), 0);
  assert.equal(effectiveForecast({ forecast: 3, forecastParam: "prm1" }, p(25)), 3);
  assert.equal(effectiveForecast({ forecast: 3, forecastParam: "prm1" }, p(-1)), 3);
  assert.equal(effectiveForecast({ forecast: 6, forecastParam: "gone" }, p(8)), 6);
  assert.equal(effectiveForecast({ forecast: 6 }, p(8)), 6);
  assert.equal(effectiveForecast(null, p(8)), 0);
});
test("the window and forecast parameters are listed and dropped with the parameter", () => {
  const sheet = { rows: [{ column: "amount", tableCalc: { type: "moving", along: "auto", window: 3, windowParam: "prm1" } }], columns: [], analytics: { forecast: 3, forecastParam: "prm1" } };
  const r = paramRefs([{ name: "S1", sheet }], [], "prm1");
  assert.deepEqual(r, ["S1: the moving-average window on amount", "S1: the forecast"]);
  assert.equal(dropParamRefs(sheet, "prm1"), true);
  assert.equal(sheet.rows[0].tableCalc.windowParam, undefined);
  assert.equal(sheet.analytics.forecastParam, undefined);
  assert.equal(sheet.rows[0].tableCalc.window, 3);
});
