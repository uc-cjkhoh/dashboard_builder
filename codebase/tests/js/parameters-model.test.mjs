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
