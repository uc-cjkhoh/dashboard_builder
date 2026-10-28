import { test } from "node:test";
import assert from "node:assert/strict";
import { checkName, renameInFormulas, usedBy, cleanCalculation, cleanCalculations } from "../../src/DashboardBuilder/Features/Calc/calc-workbook.js";
import * as store from "../../src/DashboardBuilder/Features/Core/store.js";

const C = (id, name, formula = "1") => ({ id, name, formula });

test("checkName accepts a plain name and trims it", () => {
  assert.deepEqual(checkName("  Profit margin ", [], null), { ok: true, value: "Profit margin" });
});
test("checkName rejects dots, brackets, empty, too long and case-insensitive duplicates", () => {
  for (const bad of ["a.b", "[x]", "a]", "", "   ", "x".repeat(61)]) assert.equal(checkName(bad, [], null).ok, false, bad);
  assert.equal(checkName("x".repeat(60), [], null).ok, true);
  const calcs = [C("calc1", "Profit")];
  const r = checkName("PROFIT", calcs, null);
  assert.equal(r.ok, false); assert.ok(r.error);
  assert.equal(checkName("PROFIT", calcs, "calc1").ok, true); // renaming itself in case only
});
test("renameInFormulas rewrites [Old] everywhere, not [orders.Old]", () => {
  const calcs = [C("calc1", "A"), C("calc2", "B", "SUM([A]) + [A] + [orders.A]")];
  const out = renameInFormulas(calcs, "A", "Z");
  assert.equal(out[1].formula, "SUM([Z]) + [Z] + [orders.A]");
  assert.equal(calcs[1].formula, "SUM([A]) + [A] + [orders.A]"); // input untouched
});
test("usedBy names the calculations that reference [name]", () => {
  const calcs = [C("calc1", "A"), C("calc2", "B", "[A] * 2"), C("calc3", "C", "[orders.A]")];
  assert.deepEqual(usedBy(calcs, "calc1"), ["B"]);
  assert.deepEqual(usedBy(calcs, "calc2"), []);
});
test("cleanCalculations keeps the first 20 and reports once", () => {
  const raw = Array.from({ length: 25 }, (_, i) => C(`calc${i + 1}`, `N${i}`));
  const issues = [];
  assert.equal(cleanCalculations(raw, issues).length, 20);
  assert.equal(issues.filter((i) => /first 20/.test(i)).length, 1);
});
test("cleanCalculations skips duplicate id or name, bad formulas, and reports", () => {
  const issues = [];
  const out = cleanCalculations([C("calc1", "A"), C("calc1", "B"), C("calc2", "a"), C("calc3", "C", "x".repeat(501)),
    { id: "calc4", name: "D", formula: 5 }, C("calc5", "E", "[A]")], issues);
  assert.deepEqual(out.map((c) => c.id), ["calc1", "calc5"]);
  assert.equal(issues.length, 4);
  assert.equal(cleanCalculations(undefined, []).length, 0);
  assert.equal(cleanCalculation(null, []), null);
});
test("store calculations: add, update (rename applies B3), remove, events", () => {
  let n = 0; store.bus.addEventListener("calculations:changed", () => n++);
  store.setCalculations([]);
  const a = store.addCalculation({ name: "A", formula: "1" });
  const b = store.addCalculation({ name: "B", formula: "[A] + 1" });
  assert.equal(a.id, "calc1"); assert.equal(b.id, "calc2");
  store.updateCalculation("calc1", { name: "Z" });
  assert.equal(store.calculations.find((c) => c.id === "calc2").formula, "[Z] + 1");
  store.updateCalculation("calc2", { formula: "2" });
  assert.equal(store.calculations[1].formula, "2");
  store.removeCalculation("calc1");
  assert.equal(store.calculations.length, 1);
  assert.ok(n >= 5);
  store.setCalculations([{ id: "calc7", name: "Q", formula: "1" }]);
  assert.equal(store.addCalculation({ name: "R", formula: "1" }).id, "calc8");
  store.setCalculations([]);
});
