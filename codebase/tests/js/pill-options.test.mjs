import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldPillOptions, filterPillOptions, filterSummary, markGrid } from "../../src/DashboardBuilder/Features/Dashboard/pill-options.js";

const ids = (list) => list.filter((e) => e.id).map((e) => e.id);
const PARTS = [["auto", "Auto"], ["year", "Year"], ["month", "Month"]];

test("a measure pill: aggregation radios, role, table calculation, field choices", () => {
  const r = fieldPillOptions({ measure: true, aggs: ["sum", "avg", "percentile"], agg: "avg", roleFlip: true, tableCalc: false, choices: 0, choicesOk: true });
  assert.deepEqual(ids(r), ["agg:sum", "agg:avg", "agg:percentile", "role", "tablecalc", "choices"]);
  assert.equal(r.find((e) => e.id === "agg:avg").checked, true);
  assert.equal(r.find((e) => e.id === "role").label, "Use as dimension");
});
test("a numeric pill offers a Continuous / Discrete choice in place of the role item", () => {
  const m = fieldPillOptions({ measure: true, aggs: ["sum"], roleFlip: true, numeric: true });
  assert.deepEqual(ids(m), ["agg:sum", "dc:continuous", "dc:discrete", "tablecalc"]);
  assert.equal(m.find((e) => e.id === "dc:continuous").checked, true);
  const d = fieldPillOptions({ measure: false, roleFlip: true, numeric: true });
  assert.deepEqual(ids(d), ["dc:continuous", "dc:discrete"]);
  assert.equal(d.find((e) => e.id === "dc:discrete").checked, true);
});
test("a calculated aggregate has nothing to flip or aggregate; a set table calculation shows ticked", () => {
  const r = fieldPillOptions({ measure: true, aggs: null, roleFlip: false, tableCalc: true, choicesOk: false });
  assert.deepEqual(ids(r), ["tablecalc"]);
  assert.equal(r[0].checked, true);
});
test("a date dimension: parts, finer / coarser, label policy", () => {
  const r = fieldPillOptions({ measure: false, temporal: true, parts: PARTS, part: "year", finer: "month", coarser: null, dateLabelsAll: true, roleFlip: true, choicesOk: true });
  assert.deepEqual(ids(r), ["role", "part:auto", "part:year", "part:month", "finer", "coarser", "labels", "choices"]);
  assert.equal(r.find((e) => e.id === "coarser").disabled, true);
  assert.equal(r.find((e) => e.id === "labels").checked, true);
  assert.equal(r.find((e) => e.id === "part:year").checked, true);
  assert.equal(r.find((e) => e.id === "role").label, "Use as measure");
});
test("no stray or doubled separators", () => {
  for (const o of [{ measure: true, aggs: ["sum"], roleFlip: true, tableCalc: false, choicesOk: true }, { measure: false, temporal: true, parts: PARTS, part: "auto", roleFlip: true, choicesOk: true }, { measure: true, aggs: null }]) {
    const r = fieldPillOptions(o);
    assert.notEqual(r[0]?.type, "sep"); assert.notEqual(r.at(-1)?.type, "sep");
    r.forEach((e, i) => { if (e.type === "sep") assert.notEqual(r[i + 1]?.type, "sep"); });
  }
});
test("a filter pill: operator radios, share toggle, the value editor", () => {
  const r = filterPillOptions({ ops: [["=", "is"], ["in", "is one of"]], op: "in", shared: false });
  assert.deepEqual(ids(r), ["op:=", "op:in", "share", "value"]);
  assert.equal(r.find((e) => e.id === "op:in").checked, true);
  assert.equal(r.find((e) => e.id === "share").checked, false);
  assert.equal(r.find((e) => e.id === "value").type, "custom");
});
test("markGrid chunks tools into rows of three and pads the last row", () => {
  const g = markGrid(["a", "b", "c", "d", "e"]);
  assert.deepEqual(g, [["a", "b", "c"], ["d", "e", null]]);
  assert.deepEqual(markGrid([]), []);
  assert.deepEqual(markGrid(["a", "b", "c"], 3), [["a", "b", "c"]]);
});
test("a percentile aggregation adds its percent box right after the aggregations", () => {
  const r = fieldPillOptions({ measure: true, aggs: ["sum", "percentile"], agg: "percentile", roleFlip: true, choicesOk: false });
  assert.deepEqual(ids(r), ["agg:sum", "agg:percentile", "percent", "role", "tablecalc"]);
  assert.equal(r.find((e) => e.id === "percent").type, "custom");
});
test("filterSummary reads the operand compactly", () => {
  assert.equal(filterSummary({ op: "=", value: "EU" }), "EU");
  assert.equal(filterSummary({ op: "between", values: ["1", "9"] }), "1 – 9");
  assert.equal(filterSummary({ op: "in", values: ["a", "b", "c"] }), "3");
  assert.equal(filterSummary({ op: "in", values: [] }), "");
  assert.equal(filterSummary({ op: "top", value: "5" }), "5");
  assert.equal(filterSummary({ op: "top", value: "5", bottom: true }), "5");
  assert.equal(filterSummary({ op: "=", param: "p1", value: "x" }), "parameter");
  assert.equal(filterSummary({ op: "relative", value: "last30" }), "last30");
});
