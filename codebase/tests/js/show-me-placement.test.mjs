import { test } from "node:test";
import assert from "node:assert/strict";
import { bestType, showMeOptions, placeFor, samePlacement, roleOf, issueFor }
  from "../../src/DashboardBuilder/Features/Dashboard/show-me-rules.js";
import { CHART_TYPES } from "../../src/DashboardBuilder/Features/Dashboard/viewbar-model.js";

const TYPES = CHART_TYPES.map(([id]) => id);
const TIME = new Set(["line", "area", "combo"]);
const counts = (o = {}) => ({ dims: 0, shelfDims: 0, measures: 0, hasDate: false, textValue: false,
  discreteColor: false, numericField: false, ...o });
const dim = (column, category = "text") => ({ db: "d", table: "t", column, category });
const date = (column) => dim(column, "temporal");
const meas = (column) => ({ db: "d", table: "t", column, category: "numeric", agg: "sum" });
const names = (arr) => arr.map((f) => f.column);
const isDim = (f) => roleOf(f) === "dimension";
const keyOrder = (columns, rows) => [...rows.filter(isDim), ...columns.filter(isDim)];
const measureOrder = (columns, rows) => [...columns.filter((f) => !isDim(f)), ...rows.filter((f) => !isDim(f))];

test("bestType follows the spec table, first match wins", () => {
  const cases = [
    [{}, null],
    [{ textValue: true, shelfDims: 1, measures: 1 }, "table"],
    [{ shelfDims: 3, measures: 1 }, "table"],
    [{ shelfDims: 0, measures: 2 }, "scatter"],
    [{ shelfDims: 0, measures: 1 }, "kpi"],
    [{ shelfDims: 0, measures: 3 }, "kpi"],
    [{ shelfDims: 1, measures: 1, hasDate: true }, "line"],
    [{ shelfDims: 2, measures: 2, hasDate: true }, "line"],
    [{ shelfDims: 1, measures: 2 }, "bar"],
    [{ shelfDims: 2, measures: 1 }, "heatmap"],
    [{ shelfDims: 2, measures: 2 }, "table"],
    [{ shelfDims: 1, measures: 0 }, "table"],
  ];
  for (const [o, want] of cases) assert.equal(bestType(counts(o)), want, JSON.stringify(o));
});
test("bestType ignores encodings — Colour / Detail dimensions don't steer it", () => {
  assert.equal(bestType(counts({ shelfDims: 1, dims: 3, measures: 1 })), "bar");
});
test("showMeOptions lists every type in order with its issue and outlines one valid best type", () => {
  const c = counts({ shelfDims: 1, dims: 1, measures: 1, numericField: true });
  const opts = showMeOptions(TYPES, () => c);
  assert.deepEqual(opts.map((o) => o.id), TYPES);
  for (const o of opts) assert.equal(o.issue, issueFor(o.id, c), o.id);
  assert.deepEqual(opts.filter((o) => o.recommended).map((o) => o.id), ["bar"]);
});
test("showMeOptions asks for counts per candidate type", () => {
  const seen = [];
  showMeOptions(["bar", "scatter"], (t) => { seen.push(t); return counts({ shelfDims: 1, dims: 1, measures: 1 }); });
  assert.ok(seen.includes("bar") && seen.includes("scatter"));
});
test("no recommendation without fields, or when the best type is itself invalid", () => {
  assert.equal(showMeOptions(TYPES, () => counts()).some((o) => o.recommended), false);
  // 1 dimension + discrete Colour + 2 measures: Bar is best, but the colour-split rule rejects it.
  const c = counts({ shelfDims: 1, dims: 2, measures: 2, discreteColor: true, numericField: true });
  assert.equal(showMeOptions(TYPES, () => c).some((o) => o.recommended), false);
  assert.deepEqual(showMeOptions([], () => c), []);
});

test("category types: dimensions on Columns, measures on Rows", () => {
  const p = placeFor("pie", [meas("sales")], [dim("region")]);
  assert.deepEqual(names(p.columns), ["region"]); assert.deepEqual(names(p.rows), ["sales"]);
});
test("bar and stacked stay horizontal when only Rows holds dimensions", () => {
  for (const t of ["bar", "stacked"]) {
    const p = placeFor(t, [meas("sales")], [dim("region")]);
    assert.deepEqual(names(p.columns), ["sales"], t); assert.deepEqual(names(p.rows), ["region"], t);
  }
  const v = placeFor("bar", [dim("region")], [meas("sales")]);
  assert.deepEqual(names(v.columns), ["region"]); assert.deepEqual(names(v.rows), ["sales"]);
});
test("line, area and combo put date dimensions first on Columns", () => {
  for (const t of TIME) {
    const p = placeFor(t, [dim("region"), date("day")], [meas("sales")]);
    assert.deepEqual(names(p.columns), ["day", "region"], t); assert.deepEqual(names(p.rows), ["sales"], t);
  }
});
test("point types: first measure on Columns after the dimensions, the rest on Rows", () => {
  const p = placeFor("scatter", [dim("store")], [meas("sales"), meas("profit")]);
  assert.deepEqual(names(p.columns), ["store", "sales"]); assert.deepEqual(names(p.rows), ["profit"]);
});
test("two-dimension types keep the first group-by key on Rows", () => {
  for (const t of ["heatmap", "sankey", "multiples"]) {
    const p = placeFor(t, [dim("a"), dim("b"), meas("m")], []);
    assert.deepEqual(names(p.rows), ["a"], t); assert.deepEqual(names(p.columns), ["b", "m"], t);
  }
});
test("table and text: dimensions down Rows, measures across Columns", () => {
  const p = placeFor("table", [dim("region")], [meas("sales")]);
  assert.deepEqual(names(p.rows), ["region"]); assert.deepEqual(names(p.columns), ["sales"]);
});
test("placement follows the pill's role, not its type", () => {
  const year = { ...meas("year"), role: "dimension" };
  const people = { ...dim("name"), role: "measure", agg: "count" };
  const p = placeFor("pie", [people], [year]);
  assert.deepEqual(names(p.columns), ["year"]); assert.deepEqual(names(p.rows), ["name"]);
});
test("placeFor keeps a field that sits on both shelves", () => {
  const p = placeFor("table", [dim("region")], [dim("region")]);
  assert.equal(p.rows.length, 2); assert.equal(p.columns.length, 0);
});
test("invariants hold for every type over every shelf mix", () => {
  const pool = { rd: [dim("r1"), date("r2")], cd: [dim("c1"), dim("c2")], cm: [meas("cm1"), meas("cm2")], rm: [meas("rm1"), meas("rm2")] };
  for (const t of TYPES)
    for (let a = 0; a <= 2; a++) for (let b = 0; b <= 2; b++) for (let c = 0; c <= 2; c++) for (let d = 0; d <= 2; d++) {
      const columns = [...pool.cd.slice(0, b), ...pool.cm.slice(0, c)];
      const rows = [...pool.rd.slice(0, a), ...pool.rm.slice(0, d)];
      const p = placeFor(t, columns, rows);
      const at = `${t} ${a}${b}${c}${d}`;
      const before = [...columns, ...rows], after = [...p.columns, ...p.rows];
      assert.equal(after.length, before.length, at);
      for (const f of before) assert.ok(after.includes(f), at);                       // nothing added / dropped
      for (const sh of [p.columns, p.rows]) {                                          // dimensions ahead of measures
        const m = sh.findIndex((f) => !isDim(f));
        if (m >= 0) assert.ok(sh.slice(m).every((f) => !isDim(f)), at);
      }
      assert.deepEqual(measureOrder(p.columns, p.rows), measureOrder(columns, rows), at);
      const keys = keyOrder(columns, rows);
      const want = TIME.has(t) ? [...keys.filter((f) => f.category === "temporal"), ...keys.filter((f) => f.category !== "temporal")] : keys;
      assert.deepEqual(keyOrder(p.columns, p.rows), want, at);
      assert.ok(samePlacement(p, placeFor(t, p.columns, p.rows)), `${at} idempotent`);
    }
});
test("samePlacement compares pills by identity, in order", () => {
  const x = dim("x"), y = meas("y");
  assert.ok(samePlacement({ columns: [x], rows: [y] }, { columns: [x], rows: [y] }));
  assert.ok(!samePlacement({ columns: [x], rows: [y] }, { columns: [y], rows: [x] }));
  assert.ok(!samePlacement({ columns: [x], rows: [y] }, { columns: [{ ...x }], rows: [y] }));
});
