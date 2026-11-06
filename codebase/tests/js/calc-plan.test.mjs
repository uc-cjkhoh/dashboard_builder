// Calculated fields in the worksheet query plan — the pure seam (wireDim, wireMeasure, planTables, calcProblem, Top-N).
import { test } from "node:test";
import assert from "node:assert/strict";
import { wireCalcFilter, filterCalcProblem, wireDim, wireMeasure, planTables, calcProblem, measureLabel, topByRef, topByKey, wireTopBy, resolveSortTarget, statCalcProblem, STAT_CALC_HINT }
  from "../../src/DashboardBuilder/Features/Calc/calc-plan.js";
import { makeCalcPill } from "../../src/DashboardBuilder/Features/Calc/calc-pill.js";
import { catalogFromEntities, compileCalculation } from "../../src/DashboardBuilder/Features/Calc/calc-resolve.js";
import { serverFilter } from "../../src/DashboardBuilder/Features/Dashboard/filter-rules.js";

const entities = [
  { id: "e1", db: "shop", table: "orders", columns: [{ name: "amount", category: "numeric" }, { name: "status", category: "text" }, { name: "cid", category: "numeric" }] },
  { id: "e2", db: "shop", table: "customers", columns: [{ name: "id", category: "numeric" }, { name: "region", category: "text" }] },
];
const catalog = catalogFromEntities(entities);
const mk = (id, name, formula) => ({ id, name, formula });
const calcs = [
  mk("c1", "Net", "[orders.amount] * 2"),
  mk("c2", "Label", "[orders.status]"),
  mk("c3", "Ratio", "SUM([orders.amount]) / COUNT([orders.cid])"),
  mk("c4", "Cross", "[orders.amount] + [customers.id]"),
  mk("c5", "Const", "1+2"),
  mk("c6", "Gone", "[orders.missing] * 2"),
];
const ctx = { calcs, catalog };
const pillOf = (id, role) => { const c = calcs.find((x) => x.id === id); return makeCalcPill(c, compileCalculation(c, calcs, catalog).info, role); };

test("wireMeasure: aggregate calc has a tree and no agg", () => {
  const p = pillOf("c3");
  const w = wireMeasure({ field: p, role: "shelf", agg: "sum" }, ctx);
  assert.equal(w.column, "Ratio"); assert.equal(w.db, ""); assert.equal(w.table, "");
  assert.equal(w.calc.k, "bin"); assert.equal("agg" in w, false);
});

test("wireMeasure: row-level SUM pill carries agg; plain measure unchanged", () => {
  const p = pillOf("c1");
  const w = wireMeasure({ field: p, role: "shelf", agg: "sum" }, ctx);
  assert.equal(w.agg, "sum"); assert.ok(w.calc);
  assert.equal(wireMeasure({ field: { ...p, agg: "avg" }, role: "shelf", agg: "avg" }, ctx).agg, "avg");
  const plain = { db: "shop", table: "orders", column: "amount" };
  assert.deepEqual(wireMeasure({ field: plain, role: "shelf", agg: "max" }, ctx), { db: "shop", table: "orders", column: "amount", agg: "max" });
});

test("wireDim: calc dimension has tree and label; plain keeps datePart", () => {
  const w = wireDim(pillOf("c2"), ctx);
  assert.deepEqual([w.db, w.table, w.column], ["", "", "Label"]); assert.ok(w.calc);
  assert.equal("datePart" in w, false);
  const plain = { db: "shop", table: "orders", column: "d", category: "temporal", datePart: "month" };
  assert.deepEqual(wireDim(plain, ctx), { db: "shop", table: "orders", column: "d", datePart: "month" });
  assert.deepEqual(wireDim({ ...plain, datePart: "auto" }, ctx), { db: "shop", table: "orders", column: "d" });
});

test("planTables: sorted multi-table, constant is empty, plain is its own table", () => {
  assert.deepEqual(planTables(pillOf("c4"), ctx), ["shop.customers", "shop.orders"]);
  assert.deepEqual(planTables(pillOf("c5"), ctx), []);
  assert.deepEqual(planTables({ db: "shop", table: "orders", column: "amount" }, ctx), ["shop.orders"]);
  assert.deepEqual(planTables({ calc: "nope", db: "", table: "", column: "x" }, ctx), []);
});

test("calcProblem: E15 message for a vanished field or calc; null otherwise", () => {
  const ok = { rows: [pillOf("c2")], columns: [pillOf("c1")], color: [], marks: {} };
  assert.equal(calcProblem(ok, ctx), null);
  const bad = { rows: [], columns: [{ calc: "c6", db: "", table: "", column: "Gone", category: "numeric", role: "measure", agg: "sum" }], color: [], marks: {} };
  assert.equal(calcProblem(bad, ctx), "Calculation 'Gone' can't be computed: orders.missing isn't in the model.");
  const del = { rows: [{ calc: "zz", db: "", table: "", column: "Old", category: "numeric", role: "measure" }], columns: [], marks: {} };
  assert.match(calcProblem(del, ctx), /^Calculation 'Old' can't be computed: /);
  assert.equal(calcProblem({ rows: [{ db: "a", table: "b", column: "c" }], columns: [] }, ctx), null);
  const inMark = { rows: [], columns: [], marks: { tooltip: [bad.columns[0]] } };
  assert.match(calcProblem(inMark, ctx), /^Calculation 'Gone'/);
});

test("a sheet whose only pill is 1+2 involves no tables", () => {
  assert.deepEqual(planTables(pillOf("c5"), ctx), []);
  assert.equal(calcProblem({ rows: [], columns: [pillOf("c5")], marks: {} }, ctx), null);
});

test("measureLabel: calc pill is the live name only; plain is agg + name", () => {
  const p = pillOf("c1");
  assert.equal(measureLabel({ ...p, column: "stale" }, calcs), "Net");
  assert.equal(measureLabel({ db: "d", table: "t", column: "a", agg: "avg" }, calcs, "a"), "avg a");
});

test("Top-N topBy from a calc measure carries calc and label; wired to the tree", () => {
  const p = pillOf("c1");
  const ref = topByRef({ field: p, agg: "sum" }, ctx);
  assert.deepEqual(ref, { db: "", table: "", column: "Net", calc: "c1", agg: "sum" });
  const agg = topByRef({ field: pillOf("c3"), agg: "sum" }, ctx);
  assert.equal("agg" in agg, false);
  const w = wireTopBy(ref, ctx);
  assert.equal(w.column, "Net"); assert.equal(w.calc.k, "bin"); assert.equal(w.agg, "sum");
  assert.equal("agg" in wireTopBy(agg, ctx), false);
  assert.equal(wireTopBy({ db: "d", table: "t", column: "a" }, ctx).agg, "sum");
  assert.equal(topByKey({ field: p, agg: "sum" }), "calc:c1:sum");
  assert.equal(topByKey({ field: { db: "d", table: "t", column: "a" }, agg: "avg" }), "d.t.a:avg");
  const sf = serverFilter({ db: "shop", table: "orders", column: "status", op: "top", value: "5", topBy: ref }, { wireTopBy: (t) => wireTopBy(t, ctx) });
  assert.ok(sf.topBy.calc.k); assert.equal(sf.topBy.column, "Net"); assert.equal(sf.topBy.agg, "sum");
});

test("resolveSortTarget tolerates a stale agg suffix on a calc pill", () => {
  const targets = [{ alias: "k0", id: "dimension:d.t.c:" }, { alias: "v0", id: "measure:calc:c1:avg" }];
  assert.equal(resolveSortTarget(targets, "measure:calc:c1:avg").alias, "v0");
  assert.equal(resolveSortTarget(targets, "measure:calc:c1:sum").alias, "v0");
  assert.equal(resolveSortTarget(targets, "measure:calc:c1:").alias, "v0");
  assert.equal(resolveSortTarget(targets, "measure:calc:c9:sum"), undefined);
  assert.equal(resolveSortTarget(targets, "dimension:d.t.c:").alias, "k0");
  assert.equal(resolveSortTarget(targets, "dimension:d.t.x:"), undefined);
});

test("measureLabel / aggWord: countNonNull reads as non-null", async () => {
  const { aggWord } = await import("../../src/DashboardBuilder/Features/Calc/calc-plan.js");
  assert.equal(measureLabel({ agg: "countNonNull", column: "status" }, []), "non-null status");
  assert.equal(measureLabel({ agg: "countNonNull", column: "status" }, [], "State"), "non-null State");
  assert.equal(aggWord("countNonNull"), "non-null");
  assert.equal(aggWord("countDistinct"), "distinct");
  for (const a of ["median", "stddev", "variance", "attr"]) assert.equal(measureLabel({ agg: a, column: "amount" }, []), `${a} amount`);
});

const topBySheet = (topBy) => ({ columns: [], rows: [], color: [], marks: {}, filters: [{ db: "shop", table: "orders", column: "status", category: "text", op: "top", value: "3", topBy }] });
test("calcProblem also reports a Top-N ranked by a missing or uncomputable calculation", () => {
  assert.match(calcProblem(topBySheet({ db: "", table: "", column: "Old", calc: "c99" }), ctx), /Old.*no longer exists/);
  assert.match(calcProblem(topBySheet({ db: "", table: "", column: "Gone", calc: "c6", agg: "sum" }), ctx), /missing|can't be computed/i);
  assert.equal(calcProblem(topBySheet({ db: "", table: "", column: "Net", calc: "c1", agg: "sum" }), ctx), null);
  assert.equal(calcProblem(topBySheet({ db: "shop", table: "orders", column: "amount", agg: "sum" }), ctx), null);
});
test("wireTopBy never returns a calc-less ref for a calc ranking", () => {
  assert.equal(wireTopBy({ db: "", table: "", column: "Old", calc: "c99", agg: "sum" }, ctx), null);
  assert.equal(wireTopBy({ db: "", table: "", column: "Gone", calc: "c6", agg: "sum" }, ctx), null);
  assert.ok(wireTopBy({ db: "", table: "", column: "Net", calc: "c1", agg: "sum" }, ctx).calc);
});
test("statCalcProblem: the histogram refuses calc pills with a hint, other charts do not", () => {
  const withCalc = { chartType: "histogram", columns: [pillOf("c1")], rows: [] };
  assert.equal(statCalcProblem(withCalc), STAT_CALC_HINT);
  assert.equal(STAT_CALC_HINT, "A histogram doesn't use calculated fields yet.");
  assert.equal(statCalcProblem({ chartType: "boxplot", columns: [], rows: [pillOf("c1")] }), null, "the box plot reads the worksheet query, calculations included");
  assert.equal(statCalcProblem({ chartType: "bar", columns: [pillOf("c1")], rows: [] }), null);
  assert.equal(statCalcProblem({ chartType: "histogram", columns: [{ db: "a", table: "b", column: "c", category: "numeric" }], rows: [] }), null);
});

test("calcProblem also reports a shared Top-N ranked by a calculation that is gone or can't be computed", () => {
  const empty = { rows: [], columns: [], color: [], marks: {}, filters: [] };
  const top = (calc, column) => ({ db: "shop", table: "orders", column: "status", op: "top", value: "5", topBy: { db: "", table: "", column, calc } });
  assert.equal(calcProblem(empty, ctx, [top("c3", "Ratio")]), null);
  assert.equal(calcProblem(empty, ctx, [top("c6", "Gone")]), "Calculation 'Gone' can't be computed: orders.missing isn't in the model.");
  assert.match(calcProblem(empty, ctx, [top("zz", "Old")]), /^Calculation 'Old' can't be computed: it no longer exists\./);
  assert.equal(calcProblem(empty, ctx), null); // the shared list is optional
});

const cf = (id, o = {}) => ({ calc: id, db: "", table: "", column: calcs.find((x) => x.id === id)?.name ?? "Old", category: "numeric", op: ">", value: "1", ...o });

test("filterCalcProblem: a row-level calculation is fine; an aggregate, a broken or a missing one is named", () => {
  assert.equal(filterCalcProblem(cf("c1"), ctx), null);
  assert.equal(filterCalcProblem(cf("c2"), ctx), null);
  assert.match(filterCalcProblem(cf("c3"), ctx), /can't be a filter.*aggregate/s);
  assert.match(filterCalcProblem(cf("c6"), ctx), /^Calculation 'Gone' can't be computed/);
  assert.match(filterCalcProblem(cf("c9", { column: "Old" }), ctx), /^Calculation 'Old' can't be computed: it no longer exists/);
});

test("calcProblem stops the view for an aggregate calculation used as a filter", () => {
  const s = { rows: [], columns: [], marks: {}, filters: [cf("c1"), cf("c3")] };
  assert.match(calcProblem(s, ctx), /Ratio.*can't be a filter/s);
  assert.equal(calcProblem({ ...s, filters: [cf("c1")] }, ctx), null);
});

test("planTables lists the tables a calculated filter reads", () => {
  assert.deepEqual(planTables(cf("c4"), ctx), ["shop.customers", "shop.orders"]);
});

test("serverFilter wires a calculated filter as its tree, label and bound value", () => {
  const w = serverFilter(cf("c1", { op: "between", values: ["1", "9"], value: "" }), { wireCalc: (f) => wireCalcFilter(f, ctx) });
  assert.equal(w.db, ""); assert.equal(w.table, ""); assert.equal(w.column, "Net"); assert.equal(w.calc.k, "bin");
  assert.deepEqual(w.values, ["1", "9"]); assert.equal(w.op, "between");
  assert.equal(serverFilter(cf("c9"), { wireCalc: (f) => wireCalcFilter(f, ctx) }), null);
});
