// Calculated fields — dialog/pane pure helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseFormula, deleteCalcPlan, showUseAs, useAsRole, paneState, setRoleChoice, roleChoice } from "../../src/DashboardBuilder/Features/Calc/calc-pane-model.js";
import { catalogFromEntities } from "../../src/DashboardBuilder/Features/Calc/calc-resolve.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

test("normaliseFormula turns CRLF and lone CR into LF", () => {
  assert.equal(normaliseFormula("a\r\nb\rc\nd"), "a\nb\nc\nd");
  assert.equal(normaliseFormula(undefined), "");
});

const calcs = [{ id: "calc1", name: "Net", formula: "SUM([orders.amount])" }, { id: "calc2", name: "Ratio", formula: "[Net] / 2" }, { id: "calc3", name: "Solo", formula: "1" }];
const pill = (id) => ({ calc: id, db: "", table: "", column: "x", category: "numeric", role: "measure" });
const sheet = (...ids) => ({ rows: ids.map(pill), columns: [], color: [], marks: {}, filters: [] });

test("deleteCalcPlan refuses when another calculation uses it", () => {
  assert.deepEqual(deleteCalcPlan(calcs, [sheet("calc1")], "calc1"), { refusedBy: ["Ratio"], usedInSheets: 1 });
});
test("deleteCalcPlan counts worksheets using it, else deletes freely", () => {
  assert.deepEqual(deleteCalcPlan(calcs, [sheet("calc2"), sheet("calc2"), sheet()], "calc2"), { refusedBy: null, usedInSheets: 2 });
  assert.deepEqual(deleteCalcPlan(calcs, [sheet("calc2")], "calc3"), { refusedBy: null, usedInSheets: 0 });
});

test("Use as is offered only for a row-level number", () => {
  assert.equal(showUseAs({ isAggregate: false, type: "number" }), true);
  assert.equal(showUseAs({ isAggregate: true, type: "number" }), false);
  assert.equal(showUseAs({ isAggregate: false, type: "text" }), false);
  assert.equal(showUseAs(null), false);
});
test("useAsRole accepts only the two roles", () => {
  assert.equal(useAsRole("measure"), "measure");
  assert.equal(useAsRole("dimension"), "dimension");
  assert.equal(useAsRole("x"), null);
});
test("role choices are remembered per calculation", () => {
  setRoleChoice("calc9", "dimension");
  assert.equal(roleChoice("calc9"), "dimension");
  setRoleChoice("calc9", null);
  assert.equal(roleChoice("calc9"), null);
});

test("paneState: button disabled at the limit; error flag per calculation", () => {
  const catalog = catalogFromEntities([{ db: "shop", table: "orders", columns: [{ name: "amount", category: "numeric" }] }]);
  const list = [{ id: "calc1", name: "Net", formula: "SUM([orders.amount])" }, { id: "calc2", name: "Bad", formula: "SUM([orders.gone])" }];
  const s = paneState(list, catalog);
  assert.equal(s.canAdd, true);
  assert.equal(s.items[0].error, null);
  assert.equal(s.items[0].chip.text, "Aggregate · number");
  assert.match(s.items[1].error, /gone/);
  const many = Array.from({ length: LIMITS.calculations }, (_, i) => ({ id: `calc${i + 1}`, name: `N${i}`, formula: "1" }));
  assert.equal(paneState(many, catalog).canAdd, false);
});
