import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCalc, applyTableCalcs, resolveAlong, calcName, isCalc } from "../../src/DashboardBuilder/Features/Dashboard/table-calc.js";
import { makeValueFormatter } from "../../src/DashboardBuilder/Features/Core/format.js";

const one = (vals) => vals.map((v, i) => ({ keys: [`c${i}`], values: [v] }));
const run = (type, vals, extra = {}) => computeCalc(one(vals), 0, { type, along: "auto", ...extra }, 0, 1);

test("running total, % of total, difference, % difference", () => {
  assert.deepEqual(run("running", [1, 2, 3]), [1, 3, 6]);
  assert.deepEqual(run("pctTotal", [1, 1, 2]), [25, 25, 50]);
  assert.deepEqual(run("diff", [5, 8, 6]), [null, 3, -2]);
  assert.deepEqual(run("pctDiff", [100, 150, 75]), [null, 50, -50]);
});
test("rank is competition style, highest first; Other gets none", () => {
  assert.deepEqual(run("rank", [10, 30, 30, 5]), [3, 1, 1, 4]);
  const rows = [...one([10, 20]), { keys: ["Other (5 more)"], values: [99], isOther: true }];
  assert.deepEqual(computeCalc(rows, 0, { type: "rank", along: "auto" }, 0, 1), [2, 1, null]);
});
test("moving average over a window, partial at the start", () => {
  assert.deepEqual(run("moving", [3, 6, 9, 12], { window: 2 }), [3, 4.5, 7.5, 10.5]);
});
test("blanks stay blank and don't break the run", () => {
  assert.deepEqual(run("running", [1, null, 2]), [1, null, 3]);
  assert.deepEqual(run("diff", [1, null, 2]), [null, null, null]);
});
test("along Columns restarts for each Rows member; along Rows for each Columns member", () => {
  // keys [row, col]: two rows (A, B) × two columns (x, y)
  const rows = [["A", "x", 1], ["A", "y", 2], ["B", "x", 10], ["B", "y", 20]].map(([r, c, v]) => ({ keys: [r, c], values: [v] }));
  assert.deepEqual(computeCalc(rows, 0, { type: "running", along: "columns" }, 1, 1), [1, 3, 10, 30]);
  assert.deepEqual(computeCalc(rows, 0, { type: "running", along: "rows" }, 1, 1), [1, 2, 11, 22]);
});
test("auto runs along Columns when it has dimensions, else Rows", () => {
  assert.equal(resolveAlong("auto", 1, 1), "columns");
  assert.equal(resolveAlong("auto", 2, 0), "rows");
});
test("applying renames the measure and reports percentages", () => {
  const r = { rowDimensions: [], columnDimensions: ["c"], measures: ["sum amount", "count"], rows: one([1, 3]).map((x) => ({ ...x, values: [x.values[0], 7] })) };
  const out = applyTableCalcs(r, [{ type: "pctTotal", along: "auto" }, null], 0, 1);
  assert.deepEqual(out.result.measures, ["sum amount · % of total", "count"]);
  assert.deepEqual(out.result.rows.map((x) => x.values), [[25, 7], [75, 7]]);
  assert.deepEqual([...out.percent], [0]);
  assert.equal(applyTableCalcs(r, [null, null], 0, 1).result, r);
  assert.equal(calcName({ type: "moving", window: 5 }), "moving avg (5)");
  assert.equal(isCalc({ type: "none" }), false);
});
test("a percent suffix formats without scaling", () => {
  assert.equal(makeValueFormatter({ suffix: "%", numberFormat: "percent" })(23.456), "23.46%");
  assert.equal(makeValueFormatter({ suffix: "%" })(null), "—");
});

test("percentile rank: highest is 100, lowest 0, ties share, Other gets none", () => {
  const near = (got, want) => assert.ok(got.length === want.length && got.every((g, i) => Math.abs(g - want[i]) < 1e-9), JSON.stringify(got));
  near(run("pctRank", [10, 30, 20, 5]), [100 / 3, 100, 200 / 3, 0]);
  near(run("pctRank", [10, 30, 30, 5]), [100 / 3, 100, 100, 0]);
  assert.deepEqual(run("pctRank", [7]), [100]);
  const rows = [...one([10, 20]), { keys: ["Other"], values: [99], isOther: true }];
  assert.deepEqual(computeCalc(rows, 0, { type: "pctRank", along: "auto" }, 0, 1), [0, 100, null]);
  assert.ok(isCalc({ type: "pctRank" }));
  assert.equal(calcName({ type: "pctRank" }), "percentile rank");
  const r = { rowDimensions: [], columnDimensions: ["c"], measures: ["m"], rows: one([1, 2]) };
  assert.ok(applyTableCalcs(r, [{ type: "pctRank", along: "auto" }], 0, 1).percent.has(0));
});

// keys [a, b, c]: rowDims 2 (a, b), colDims 1 (c); values 1..8 in order
const cube = () => {
  const out = []; let v = 1;
  for (const a of ["A", "B"]) for (const b of ["x", "y"]) for (const c of ["p", "q"]) out.push({ keys: [a, b, c], values: [v++] });
  return out;
};
test("compute using chosen dimensions: those run together, the rest restart", () => {
  const using = (u) => computeCalc(cube(), 0, { type: "running", along: "custom", using: u }, 2, 1);
  assert.deepEqual(using([2]), [1, 3, 3, 7, 5, 11, 7, 15]);
  assert.deepEqual(using([1, 2]), [1, 3, 6, 10, 5, 11, 18, 26]);
  assert.deepEqual(using([0]), [1, 2, 3, 4, 6, 8, 10, 12]);
  assert.deepEqual(using([0, 1, 2]), [1, 3, 6, 10, 15, 21, 28, 36]);
  assert.deepEqual(using([]), computeCalc(cube(), 0, { type: "running", along: "auto" }, 2, 1));
  assert.deepEqual(using([9]), computeCalc(cube(), 0, { type: "running", along: "auto" }, 2, 1));
});
test("resolveAlong keeps custom", () => { assert.equal(resolveAlong("custom", 1, 1), "custom"); });
