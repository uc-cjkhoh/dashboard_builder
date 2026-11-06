import test from "node:test";
import assert from "node:assert/strict";
import { describeRelationship, keepSentence } from "../../src/DashboardBuilder/Features/Relations/relation-describe.js";

const rel = (o = {}) => ({ from: { column: "user_id" }, to: { column: "id" }, cardinality: "N:1", joinType: "inner", joinFixed: true, ...o });

test("title and key line name both tables and columns", () => {
  const d = describeRelationship(rel(), "orders", "users");
  assert.equal(d.title, "orders → users");
  assert.equal(d.keys, "orders.user_id = users.id");
});
test("cardinality is worded from the FROM side", () => {
  assert.match(describeRelationship(rel({ cardinality: "1:N" }), "a", "b").sentences[0], /^One a row matches many b rows/);
  assert.match(describeRelationship(rel({ cardinality: "N:1" }), "a", "b").sentences[0], /^Many a rows match one b row/);
  assert.match(describeRelationship(rel({ cardinality: "1:1" }), "a", "b").sentences[0], /at most one b row/);
});
test("a compound key lists every pair", () => {
  const d = describeRelationship(rel({ pairs: [{ from: "day", to: "day" }] }), "a", "b");
  assert.equal(d.keys, "a.user_id + day = b.id + day");
});
test("join types say which rows are kept", () => {
  assert.match(keepSentence("inner", "a", "b"), /only rows that match/i);
  assert.match(keepSentence("left", "a", "b"), /every a row/);
  assert.match(keepSentence("right", "a", "b"), /every b row/);
  assert.match(keepSentence("full", "a", "b"), /both tables/);
  assert.match(keepSentence("left", "a", "b", false), /base table/);
});
test("a one-to-many link warns that the one side repeats", () => {
  assert.equal(describeRelationship(rel({ cardinality: "1:N" }), "a", "b").sentences.length, 3);
  assert.equal(describeRelationship(rel({ cardinality: "N:1" }), "a", "b").sentences.length, 2);
});
