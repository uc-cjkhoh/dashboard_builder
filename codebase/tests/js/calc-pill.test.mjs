// Calculated-field pills — shape, naming, refusals, sync (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCalcPill, isCalcPill, pillName, calcPillId, sameCalcPill, refusal, syncCalcPills, usesCalc, clearCalcPills }
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
  for (const e of ["filter", "pages", "drill", "period", "sharedFilter", "selection"]) {
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
