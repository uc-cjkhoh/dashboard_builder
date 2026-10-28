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

// T02-12 / T02-13: right and full joins.
import { JOIN_TYPES, normalizeJoinType, joinChoices, planJoinType, joinBadge } from "../../src/DashboardBuilder/Features/Relations/relation-rules.js";

test("join types are inner, left, right, full; anything else reads as inner", () => {
  assert.deepEqual(JOIN_TYPES, ["inner", "left", "right", "full"]);
  for (const t of JOIN_TYPES) assert.equal(normalizeJoinType(t), t);
  for (const t of [undefined, null, "FULL", "cross", "full outer", 3]) assert.equal(normalizeJoinType(t), "inner");
});

test("dialog choices name the tables in plain words", () => {
  const c = joinChoices("orders", "customers");
  assert.deepEqual(c.map((x) => x.value), ["inner", "left", "right", "full"]);
  assert.equal(c[1].text, "Keep all rows of orders");
  assert.equal(c[2].text, "Keep all rows of customers");
  assert.equal(c[3].text, "Keep all rows of both");
  assert.match(c[0].text, /only rows that match/i);
});

test("the FROM side is the left side: planning in reverse swaps left and right", () => {
  assert.equal(planJoinType("left", true), "left");
  assert.equal(planJoinType("left", false), "right");
  assert.equal(planJoinType("right", true), "right");
  assert.equal(planJoinType("right", false), "left");
  assert.equal(planJoinType("full", false), "full");
  assert.equal(planJoinType("inner", false), "inner");
  assert.equal(planJoinType("bogus", false), "inner");
});

test("badge says the join in words", () => {
  assert.equal(joinBadge("1:N", "inner"), "1:N");
  assert.equal(joinBadge("1:N", "left"), "1:N · left");
  assert.equal(joinBadge("N:M", "full"), "N:M · full");
});
