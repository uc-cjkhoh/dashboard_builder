// Calculated-field pills — shape, naming, refusals, sync (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { newCalcFilter, makeCalcPill, isCalcPill, pillName, calcPillId, sameCalcPill, refusal, syncCalcPills, usesCalc, clearCalcPills, filtersUseCalc, clearFilterCalc, CALC_AGGS }
  from "../../src/DashboardBuilder/Features/Calc/calc-pill.js";
import { catalogFromEntities, compileCalculation, calcTables } from "../../src/DashboardBuilder/Features/Calc/calc-resolve.js";
import { emptySheet, nameOf, setCalculations } from "../../src/DashboardBuilder/Features/Core/store.js";

const catalog = catalogFromEntities([{ id: "e1", db: "shop", table: "orders",
  columns: [{ name: "amount", category: "numeric" }, { name: "status", category: "text" }] }]);
const compile = (calc, calcs = [calc]) => compileCalculation(calc, calcs, catalog);
const mk = (id, name, formula) => ({ id, name, formula });

test("pill shapes: row-level measure, dimension, aggregate", () => {
  const net = mk("c1", "Net", "[orders.amount] * 2");
  const m = makeCalcPill(net, compile(net).info);
  assert.deepEqual(m, { calc: "c1", db: "", table: "", column: "Net", category: "numeric", role: "measure", agg: "sum" });
  const lbl = mk("c2", "Label", "[orders.status]");
  const d = makeCalcPill(lbl, compile(lbl).info);
  assert.deepEqual(d, { calc: "c2", db: "", table: "", column: "Label", category: "text", role: "dimension" });
  const tot = mk("c3", "Total", "SUM([orders.amount])");
  const a = makeCalcPill(tot, compile(tot).info);
  assert.equal(a.role, "measure"); assert.equal("agg" in a, false); assert.equal(a.category, "numeric");
  assert.equal(makeCalcPill(net, compile(net).info, "dimension").role, "dimension");
  assert.equal("agg" in makeCalcPill(net, compile(net).info, "dimension"), false);
});

test("isCalcPill, calcPillId, sameCalcPill", () => {
  const p = { calc: "c1", db: "", table: "", column: "Net", category: "numeric", role: "measure", agg: "sum" };
  assert.equal(isCalcPill(p), true);
  assert.equal(isCalcPill({ db: "a", table: "b", column: "c" }), false);
  assert.equal(isCalcPill(null), false);
  assert.equal(calcPillId(p, "measure"), "measure:calc:c1:sum");
  assert.equal(calcPillId({ calc: "c2" }, "dimension"), "dimension:calc:c2:");
  assert.equal(sameCalcPill(p, { ...p, column: "x" }), true);
  assert.equal(sameCalcPill(p, { ...p, calc: "c2" }), false);
  assert.equal(sameCalcPill(p, { db: "a", table: "b", column: "c" }), false);
});

test("refusal: exact message for every entry, null for plain", () => {
  const p = { calc: "c1" };
  for (const e of ["pages", "drill", "period", "sharedFilter", "selection", "shape", "angle", "choice"]) {
    assert.equal(refusal(p, e), "Calculated fields can't be used here yet.");
    assert.equal(refusal({ db: "a", table: "b", column: "c" }, e), null);
  }
});

test("pillName follows a rename and falls back to column; nameOf too", () => {
  const p = { calc: "c1", db: "", table: "", column: "Old" };
  assert.equal(pillName(p, [mk("c1", "New", "1")]), "New");
  assert.equal(pillName(p, []), "Old");
  assert.equal(pillName({ db: "a", table: "t", column: "c" }, []), "t.c");
  setCalculations([mk("c1", "Live", "1")]);
  assert.equal(nameOf(p), "Live");
  setCalculations([]);
  assert.equal(nameOf(p), "Old");
});

test("syncCalcPills flips category on type change and reports dangling", () => {
  const calc = mk("c1", "X", "[orders.amount] * 2");
  const sheet = emptySheet();
  sheet.rows = [makeCalcPill(calc, compile(calc).info)];
  sheet.marks.tooltip = [{ calc: "gone", db: "", table: "", column: "Gone", category: "numeric", role: "measure" }];
  calc.formula = "[orders.status]"; calc.name = "X2";
  const bad = syncCalcPills(sheet, [calc], catalog);
  assert.deepEqual(bad, ["gone"]);
  assert.equal(sheet.rows[0].category, "text");
  assert.equal(sheet.rows[0].role, "dimension");
  assert.equal(sheet.rows[0].column, "X2");
  assert.equal("agg" in sheet.rows[0], false);
  calc.formula = "[orders.nope]";
  assert.deepEqual(syncCalcPills(sheet, [calc], catalog), ["c1", "gone"]);
});

test("syncCalcPills keeps a measure's agg, adds sum when it becomes a row-level measure, drops it for aggregate", () => {
  const calc = mk("c1", "X", "[orders.amount]");
  const sheet = emptySheet();
  sheet.rows = [makeCalcPill(calc, compile(calc).info)];
  sheet.rows[0].agg = "avg";
  syncCalcPills(sheet, [calc], catalog);
  assert.equal(sheet.rows[0].agg, "avg");
  calc.formula = "SUM([orders.amount])";
  syncCalcPills(sheet, [calc], catalog);
  assert.equal("agg" in sheet.rows[0], false);
});

test("1+2 on Rows: no error, no tables", () => {
  const calc = mk("c1", "One", "1+2");
  const sheet = emptySheet();
  const c = compile(calc);
  assert.equal(c.error, undefined);
  sheet.rows = [makeCalcPill(calc, c.info)];
  assert.deepEqual(syncCalcPills(sheet, [calc], catalog), []);
  assert.deepEqual(calcTables(c.info), []);
});

test("usesCalc and clearCalcPills across shelves, marks, sort", () => {
  const p = (id) => ({ calc: id, db: "", table: "", column: id, category: "numeric", role: "measure", agg: "sum" });
  const plain = { db: "shop", table: "orders", column: "amount", category: "numeric" };
  const sheet = emptySheet();
  sheet.rows = [p("c1"), plain]; sheet.columns = [p("c1"), p("c2")]; sheet.color = [p("c1")];
  sheet.marks.size = p("c1"); sheet.marks.label = p("c2"); sheet.marks.shape = p("c1");
  sheet.marks.path = p("c1"); sheet.marks.angle = p("c1");
  sheet.marks.detail = [p("c1"), plain]; sheet.marks.tooltip = [p("c1")];
  sheet.sort = { by: "measure:calc:c1:sum", dir: "desc" };
  assert.equal(usesCalc(sheet, "c1"), true);
  assert.equal(usesCalc(sheet, "c3"), false);
  clearCalcPills(sheet, "c1");
  assert.deepEqual(sheet.rows, [plain]);
  assert.deepEqual(sheet.columns.map((x) => x.calc), ["c2"]);
  assert.deepEqual(sheet.color, []);
  assert.equal(sheet.marks.size, null); assert.equal(sheet.marks.shape, null);
  assert.equal(sheet.marks.path, null); assert.equal(sheet.marks.angle, null);
  assert.equal(sheet.marks.label.calc, "c2");
  assert.deepEqual(sheet.marks.detail, [plain]); assert.deepEqual(sheet.marks.tooltip, []);
  assert.equal(sheet.sort, null);
  assert.equal(usesCalc(sheet, "c1"), false);
  assert.equal(usesCalc(sheet, "c2"), true);
});

test("clearCalcPills leaves a sort on another target", () => {
  const sheet = emptySheet();
  sheet.sort = { by: "measure:shop.orders.amount:sum", dir: "asc" };
  clearCalcPills(sheet, "c1");
  assert.notEqual(sheet.sort, null);
});

const topFilter = (calc) => ({ db: "shop", table: "orders", column: "status", category: "text", op: "top", value: "5",
  topBy: { db: "", table: "", column: "Net", calc, agg: "sum" } });

test("CALC_AGGS mirrors the server's row-level aggregations and never offers count", () => {
  assert.deepEqual(CALC_AGGS, ["sum", "avg", "min", "max", "median", "stddev", "variance", "stddevPop", "variancePop", "attr", "countDistinct", "countNonNull"]);
  assert.ok(!CALC_AGGS.includes("count"));
});
test("usesCalc counts a Top-N filter ranked by the calculation", () => {
  const s = { ...emptySheet(), filters: [topFilter("c1")] };
  assert.equal(usesCalc(s, "c1"), true);
  assert.equal(usesCalc(s, "c2"), false);
});
test("clearCalcPills resets a Top-N ranking by the calculation to null and keeps the filter", () => {
  const other = { db: "shop", table: "orders", column: "amount", agg: "sum" };
  const s = { ...emptySheet(), filters: [topFilter("c1"), { ...topFilter("c2"), topBy: { ...topFilter("c2").topBy, calc: "c2" } }, { ...topFilter("x"), topBy: other }] };
  clearCalcPills(s, "c1");
  assert.equal(s.filters.length, 3);
  assert.equal(s.filters[0].topBy, null);
  assert.equal(s.filters[1].topBy.calc, "c2");
  assert.deepEqual(s.filters[2].topBy, other);
});
test("syncCalcPills drops a datePart from a calculated dimension (E12: never date-grouped)", () => {
  const d = mk("c1", "When", "[orders.status]");
  const pill = { calc: "c1", db: "", table: "", column: "When", category: "temporal", role: "dimension", datePart: "month" };
  const s = { ...emptySheet(), rows: [pill] };
  syncCalcPills(s, [d], catalog);
  assert.equal("datePart" in s.rows[0], false);
});

test("filtersUseCalc / clearFilterCalc: a (shared) Top-N ranked by a calculation", () => {
  const top = (calc) => ({ db: "shop", table: "orders", column: "status", op: "top", value: "5", topBy: { db: "", table: "", column: "Net", calc } });
  const plain = { db: "shop", table: "orders", column: "status", op: "top", value: "5", topBy: { db: "shop", table: "orders", column: "amount", agg: "sum" } };
  const shared = [top("c1"), top("c2"), plain, { db: "shop", table: "orders", column: "status", op: "=", value: "x" }];
  assert.equal(filtersUseCalc(shared, "c1"), true);
  assert.equal(filtersUseCalc(shared, "c9"), false);
  clearFilterCalc(shared, "c1");
  assert.equal(shared[0].topBy, null);
  assert.equal(shared[1].topBy.calc, "c2");
  assert.equal(shared[2].topBy.column, "amount");
  assert.equal(filtersUseCalc(shared, "c1"), false);
});

test("a calculated field dropped on Filters is allowed; only sharing refuses", () => {
  assert.equal(refusal({ calc: "c1" }, "filter"), null);
  assert.equal(refusal({ calc: "c1" }, "sharedFilter"), "Calculated fields can't be used here yet.");
});

test("newCalcFilter: a calc-id filter with the pill's category and an empty value", () => {
  const net = mk("c1", "Net", "[orders.amount] * 2");
  const f = newCalcFilter(makeCalcPill(net, compile(net).info));
  assert.deepEqual(f, { calc: "c1", db: "", table: "", column: "Net", category: "numeric", op: "=", value: "" });
});

test("usesCalc and clearCalcPills know a filter on the calculation", () => {
  const net = { calc: "c1", db: "", table: "", column: "Net", category: "numeric", op: "=", value: "1" };
  const other = { calc: "c2", db: "", table: "", column: "X", category: "numeric", op: "=", value: "1" };
  const s = { ...emptySheet(), filters: [net, other] };
  assert.equal(usesCalc(s, "c1"), true);
  assert.equal(filtersUseCalc(s.filters, "c1"), true);
  clearCalcPills(s, "c1");
  assert.deepEqual(s.filters, [other]);
  assert.equal(usesCalc(s, "c1"), false);
});

test("syncCalcPills refreshes a calculated filter's category and name, leaving its operator", () => {
  const lbl = mk("c2", "Renamed", "[orders.status]");
  const s = { ...emptySheet(), filters: [{ calc: "c2", db: "", table: "", column: "Old", category: "numeric", op: "in", values: ["a"] }] };
  assert.deepEqual(syncCalcPills(s, [lbl], catalog), []);
  assert.equal(s.filters[0].category, "text"); assert.equal(s.filters[0].column, "Renamed"); assert.equal(s.filters[0].op, "in");
  assert.deepEqual(syncCalcPills(s, [], catalog), ["c2"]);
});

test("syncCalcFilters resets an operator the calculation's new type no longer has", () => {
  const lbl = mk("c2", "L", "[orders.status]");
  const s = { ...emptySheet(), filters: [
    { calc: "c2", db: "", table: "", column: "L", category: "numeric", op: ">", value: "5" },
    { calc: "c2", db: "", table: "", column: "L", category: "text", op: "contains", value: "a" },
    { calc: "c2", db: "", table: "", column: "L", category: "text", op: "top", value: "3" }] };
  syncCalcPills(s, [lbl], catalog);
  assert.deepEqual([s.filters[0].op, s.filters[0].value], [">", "5"]); // > is still valid for text
  assert.equal(s.filters[1].op, "contains");
  assert.deepEqual([s.filters[2].op, s.filters[2].value], ["=", ""]);
  const num = mk("c3", "N", "[orders.amount]");
  const t = { ...emptySheet(), filters: [{ calc: "c3", db: "", table: "", column: "N", category: "text", op: "contains", value: "a" }] };
  syncCalcPills(t, [num], catalog);
  assert.equal(t.filters[0].category, "numeric"); assert.equal(t.filters[0].op, "=");
});
