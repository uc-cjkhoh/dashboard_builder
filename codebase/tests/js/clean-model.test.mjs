import test from "node:test";
import assert from "node:assert/strict";
import { cleanPlan, parseRecode, cleanOps, CLEAN_MAX_RECODE } from "../../src/DashboardBuilder/Features/Calc/clean-model.js";
import { catalogFromEntities, compileCalculation } from "../../src/DashboardBuilder/Features/Calc/calc-resolve.js";

const F = { db: "shop", table: "orders", column: "status" };
const cols = [{ name: "status", category: "text" }, { name: "qty", category: "numeric" }, { name: "placed", category: "temporal" }];
const catalog = catalogFromEntities([{ id: "e1", db: "shop", table: "orders", columns: cols }]);
const plan = (over = {}) => cleanPlan({ field: F, category: "text", op: "trim", calcs: [], ...over });
// every plan's formula must compile in the real engine
const compiles = (p) => p.calcs.forEach((c) => assert.ok(compileCalculation({ id: "x", ...c }, [], catalog).ast, c.formula));

test("which operations a category offers", () => {
  assert.deepEqual(cleanOps("text"), ["trim", "nullTo", "recode", "date"]);
  assert.deepEqual(cleanOps("numeric"), ["nullTo"]);
  assert.deepEqual(cleanOps("temporal"), []);
});
test("trim", () => {
  const p = plan();
  assert.deepEqual(p.calcs, [{ name: "status (trimmed)", formula: "TRIM([shop.orders.status])" }]);
  compiles(p);
});
test("replace empty: text literal with doubled quotes, or a number", () => {
  const t = plan({ op: "nullTo", value: "it's n/a" });
  assert.equal(t.calcs[0].formula, "IFNULL([shop.orders.status], 'it''s n/a')");
  assert.equal(t.calcs[0].name, "status (filled)");
  compiles(t);
  const n = cleanPlan({ field: { ...F, column: "qty" }, category: "numeric", op: "nullTo", value: "-1.5", calcs: [] });
  assert.equal(n.calcs[0].formula, "IFNULL([shop.orders.qty], -1.5)");
  compiles(n);
  assert.match(cleanPlan({ field: F, category: "numeric", op: "nullTo", value: "abc", calcs: [] }).error, /number/);
  assert.match(cleanPlan({ field: F, category: "numeric", op: "nullTo", value: "1e999", calcs: [] }).error, /number/);
  assert.match(plan({ op: "nullTo", value: "x".repeat(101) }).error, /100/);
});
test("replace empty, also empty text: IF(ISNULL OR = '') on a text field", () => {
  const p = plan({ op: "nullTo", value: "n/a", emptyToo: true });
  assert.equal(p.calcs[0].formula, "IF(ISNULL([shop.orders.status]) OR [shop.orders.status] = '', 'n/a', [shop.orders.status])");
  assert.equal(p.calcs[0].name, "status (filled)");
  compiles(p);
  const q = plan({ op: "nullTo", value: "it's", emptyToo: true });
  assert.ok(q.calcs[0].formula.includes("'it''s'"));
  compiles(q);
  // a number field has no empty string: the flag is ignored
  const n = cleanPlan({ field: { ...F, column: "qty" }, category: "numeric", op: "nullTo", value: "0", emptyToo: true, calcs: [] });
  assert.equal(n.calcs[0].formula, "IFNULL([shop.orders.qty], 0)");
  // off by default
  assert.equal(plan({ op: "nullTo", value: "x" }).calcs[0].formula, "IFNULL([shop.orders.status], 'x')");
});
test("recode: simple CASE, unmatched values kept", () => {
  const p = plan({ op: "recode", pairs: [{ from: "NY", to: "New York" }, { from: "CA", to: "California" }] });
  assert.equal(p.calcs[0].formula, "CASE [shop.orders.status] WHEN 'NY' THEN 'New York' WHEN 'CA' THEN 'California' ELSE [shop.orders.status] END");
  assert.equal(p.calcs[0].name, "status (recoded)");
  compiles(p);
  assert.ok(!plan({ op: "recode", pairs: [{ from: "a", to: "b" }], keep: false }).calcs[0].formula.includes("ELSE"));
});
test("recode refuses empty, duplicate, too many and too long", () => {
  assert.match(plan({ op: "recode", pairs: [] }).error, /at least one/i);
  assert.match(plan({ op: "recode", pairs: [{ from: "a", to: "b" }, { from: "a", to: "c" }] }).error, /more than once/);
  assert.match(plan({ op: "recode", pairs: Array.from({ length: CLEAN_MAX_RECODE + 1 }, (_, i) => ({ from: `a${i}`, to: "b" })) }).error, /at most 20/);
  assert.match(plan({ op: "recode", pairs: [{ from: "a", to: "x".repeat(101) }] }).error, /100/);
  assert.match(plan({ op: "recode", pairs: Array.from({ length: 20 }, (_, i) => ({ from: "f".repeat(30) + i, to: "t".repeat(30) })) }).error, /500/);
});
test("parseRecode: one old=new per line, blank lines skipped, cut at the first =", () => {
  assert.deepEqual(parseRecode("NY = New York\n\n CA=California \na=b=c"), { pairs: [{ from: "NY", to: "New York" }, { from: "CA", to: "California" }, { from: "a", to: "b=c" }] });
  assert.match(parseRecode("nothing").error, /Line 1/);
  assert.deepEqual(parseRecode("x="), { pairs: [{ from: "x", to: "" }] });
});
test("read as date", () => {
  const p = plan({ op: "date" });
  assert.deepEqual(p.calcs, [{ name: "status (date)", formula: "DATE([shop.orders.status])" }]);
  compiles(p);
});
test("category gating, unwritable names and the workbook limit", () => {
  assert.match(cleanPlan({ field: F, category: "numeric", op: "trim", calcs: [] }).error, /text/);
  assert.match(cleanPlan({ field: F, category: "temporal", op: "nullTo", value: "x", calcs: [] }).error, /can't be cleaned/);
  assert.match(plan({ field: { ...F, column: "a.b" } }).error, /can't be written/);
  assert.match(plan({ calcs: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, name: `n${i}`, formula: "1" })) }).error, /at most 20/);
  assert.match(plan({ op: "bogus" }).error, /operation/);
});
test("a taken name gets the next free number; a display name is the base", () => {
  assert.equal(plan({ name: "Status" }).calcs[0].name, "Status (trimmed)");
  const taken = [{ id: "c1", name: "status (trimmed)", formula: "1" }];
  assert.equal(plan({ calcs: taken }).calcs[0].name, "status (trimmed 2)");
});
