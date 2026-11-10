import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";
import { unionRequest, unionPickState, UNION_LIMIT } from "../../src/DashboardBuilder/Features/Rows/union-model.js";

test("limits mirror the server: 2 to 5 tables", () => {
  assert.equal(LIMITS.unionTables, 5);
  assert.equal(UNION_LIMIT, 20);
});
test("a request names the database, the tables in order and a small limit", () => {
  assert.deepEqual(unionRequest("d", ["a", "b"]), { db: "d", tables: ["a", "b"], limit: 20 });
});
test("fewer than two or more than five tables are refused", () => {
  assert.throws(() => unionRequest("d", ["a"]), /between 2 and 5/);
  assert.throws(() => unionRequest("d", ["a", "b", "c", "d", "e", "f"]), /between 2 and 5/);
  assert.doesNotThrow(() => unionRequest("d", ["a", "b", "c", "d", "e"]));
});
test("the same table twice is refused", () => assert.throws(() => unionRequest("d", ["a", "a"]), /different/));
test("the pick state says whether Show rows is allowed and what to tell the user", () => {
  assert.deepEqual(unionPickState([]), { ok: false, hint: "Pick 2 to 5 tables." });
  assert.deepEqual(unionPickState(["a"]), { ok: false, hint: "Pick 2 to 5 tables." });
  assert.deepEqual(unionPickState(["a", "b"]), { ok: true, hint: "" });
  assert.equal(unionPickState(["a", "b", "c", "d", "e", "f"]).ok, false);
});

import { sharedUnionColumns, UNION_NONE } from "../../src/DashboardBuilder/Features/Rows/union-model.js";
const c = (name, category) => ({ name, type: "x", category });
test("shared columns need the same name and kind in every table", () => {
  assert.deepEqual(sharedUnionColumns([[c("id", "number"), c("a", "text")], [c("id", "number"), c("a", "number")]]).map((x) => x.name), ["id"]);
  assert.deepEqual(sharedUnionColumns([[c("a", "text")], [c("b", "text")]]), []);
  assert.equal(sharedUnionColumns([[c("a", "text")], [c("a", "text")], [c("b", "text")]]).length, 0);
});
test("the no-shared-column sentence matches the server's", () => {
  assert.equal(UNION_NONE, "These tables share no column with the same name and kind of values.");
});
