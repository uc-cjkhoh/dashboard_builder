import { test } from "node:test";
import assert from "node:assert/strict";
import { removeChoice, switchField, choicesOf } from "../../src/DashboardBuilder/Features/Dashboard/field-choices.js";

const ref = (column, category = "categorical") => ({ db: "d", table: "t", column, category });
const slot = (cols, shown = 0, extra = {}) => ({ ...ref(cols[shown]), choices: cols.map((c) => ref(c)), ...extra });

test("removing the only field of a slot (no choices) does not throw and leaves the slot untouched", () => {
  const f = ref("a");
  assert.doesNotThrow(() => removeChoice(f, ref("a")));
  assert.equal(f.column, "a");
  assert.equal(f.choices, undefined);
});

test("removing a non-shown choice from two collapses to a plain field", () => {
  const f = slot(["a", "b"], 0);
  removeChoice(f, ref("b"));
  assert.equal(f.column, "a");
  assert.equal(f.choices, undefined);
});

test("removing the shown choice shows the next one", () => {
  const f = slot(["a", "b", "c"], 0);
  removeChoice(f, ref("a"));
  assert.equal(f.column, "b");
  assert.deepEqual(f.choices.map((c) => c.column), ["b", "c"]);
});

test("removing the shown choice of two leaves the other as a plain field", () => {
  const f = slot(["a", "b"], 0);
  removeChoice(f, ref("a"));
  assert.equal(f.column, "b");
  assert.equal(f.choices, undefined);
});

test("removing the shown choice keeps role and aggregation when supported, else resets (pill that used it)", () => {
  const f = { ...ref("n", "numeric"), agg: "sum", choices: [ref("n", "numeric"), ref("s", "categorical")] };
  removeChoice(f, ref("n", "numeric"));
  assert.equal(f.column, "s");
  assert.notEqual(f.agg, "sum");
});

test("a single-entry choices array (stale) is cleared without throwing", () => {
  const f = { ...ref("a"), choices: [ref("a")] };
  assert.doesNotThrow(() => removeChoice(f, ref("a")));
  assert.equal(f.column, "a");
  assert.equal(f.choices, undefined);
});

test("removing a ref that is not in the slot changes nothing", () => {
  const f = slot(["a", "b", "c"], 1);
  removeChoice(f, ref("z"));
  assert.equal(f.column, "b");
  assert.equal(f.choices.length, 3);
});

test("choicesOf falls back to the slot's own field; switchField drops a date part off a non-date field", () => {
  assert.deepEqual(choicesOf(ref("a")).map((c) => c.column), ["a"]);
  const f = { ...ref("d", "temporal"), datePart: "month" };
  switchField(f, ref("x"));
  assert.equal(f.datePart, undefined);
});
