import { test } from "node:test";
import assert from "node:assert/strict";
import { keysCompatible, findDuplicate, linkProblem } from "../../src/DashboardBuilder/Features/Relations/relation-rules.js";
const a = { entityId: "e1", column: "customer_id" }, b = { entityId: "e2", column: "id" };
const base = { relationships: [], from: a, to: b, fromCategory: "numeric", toCategory: "numeric", fromLabel: "orders.customer_id", toLabel: "customers.id" };
test("same-kind keys relate", () => assert.equal(linkProblem(base), null));
test("a key can't relate to its own table", () => assert.match(linkProblem({ ...base, to: { entityId: "e1", column: "x" } }), /different table/));
test("a duplicate link is blocked in either direction", () => {
  const rel = { from: b, to: a, cardinality: "1:N" };
  assert.equal(findDuplicate([rel], a, b), rel);
  assert.match(linkProblem({ ...base, relationships: [rel] }), /already related/);
});
test("number-to-text keys are blocked, naming both", () => {
  const msg = linkProblem({ ...base, toCategory: "text" });
  assert.match(msg, /orders\.customer_id \(numeric\)/); assert.match(msg, /customers\.id \(text\)/);
});
test("compound and other keys never relate", () => {
  assert.equal(keysCompatible("compound", "compound"), false);
  assert.equal(keysCompatible("other", "other"), false);
  assert.equal(keysCompatible("temporal", "temporal"), true);
});
