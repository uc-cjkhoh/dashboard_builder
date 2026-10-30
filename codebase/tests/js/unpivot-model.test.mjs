import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";
import { unpivotRequest, unpivotPickState, UNPIVOT_LIMIT } from "../../src/DashboardBuilder/Features/Rows/unpivot-model.js";

const COLS = [
  { name: "id", type: "UInt64", category: "numeric" }, { name: "q1", type: "Int32", category: "numeric" },
  { name: "q2", type: "Float64", category: "numeric" }, { name: "note", type: "String", category: "text" },
];

test("limits mirror the server: 2 to 50 columns, 5 kept", () => {
  assert.equal(LIMITS.unpivotColumns, 50);
  assert.equal(LIMITS.unpivotKeep, 5);
  assert.equal(UNPIVOT_LIMIT, 20);
});
test("a request names the table, the columns in order, the kept ones and a small limit", () => {
  assert.deepEqual(unpivotRequest("d", "t", ["q1", "q2"], ["id"]), { db: "d", table: "t", columns: ["q1", "q2"], keep: ["id"], limit: 20 });
});
test("fewer than two or more than fifty columns are refused", () => {
  assert.throws(() => unpivotRequest("d", "t", ["q1"], []), /between 2 and 50/);
  assert.throws(() => unpivotRequest("d", "t", Array.from({ length: 51 }, (_, i) => "c" + i), []), /between 2 and 50/);
});
test("a column twice, kept and unpivoted, or more than five kept are refused", () => {
  assert.throws(() => unpivotRequest("d", "t", ["q1", "q1"], []), /different/);
  assert.throws(() => unpivotRequest("d", "t", ["q1", "q2"], ["q1"]), /different/);
  assert.throws(() => unpivotRequest("d", "t", ["q1", "q2"], ["a", "b", "c", "d", "e", "f"]), /at most 5/);
});
test("the pick state says whether Show rows is allowed and why not", () => {
  assert.deepEqual(unpivotPickState(COLS, [], []), { ok: false, hint: "Pick 2 to 50 columns to turn into rows." });
  assert.deepEqual(unpivotPickState(COLS, ["q1"], []), { ok: false, hint: "Pick 2 to 50 columns to turn into rows." });
  assert.deepEqual(unpivotPickState(COLS, ["q1", "q2"], ["id"]), { ok: true, hint: "" });
  const mixed = unpivotPickState(COLS, ["q1", "note"], []);
  assert.equal(mixed.ok, false);
  assert.match(mixed.hint, /same kind/);
});
test("columns of one kind only: a text column is not offered beside numbers", () => {
  assert.deepEqual(unpivotPickState(COLS, ["q1", "q2", "id"], []).ok, true);
});
