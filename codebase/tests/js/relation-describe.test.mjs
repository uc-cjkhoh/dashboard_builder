import test from "node:test";
import assert from "node:assert/strict";
import { describeRelationship, keepSentence } from "../../src/DashboardBuilder/Features/Relations/relation-describe.js";

const rel = (o = {}) => ({ from: { column: "user_id" }, to: { column: "id" }, cardinality: "N:1", joinType: "inner", joinFixed: true, ...o });

test("the title names both tables; sentences name table.column on both sides", () => {
  const d = describeRelationship(rel(), "orders", "users");
  assert.equal(d.title, "orders → users");
  assert.equal(d.keys, undefined); // no separate key line: the sentences carry the columns
  assert.match(d.sentences[0], /orders\.user_id/);
  assert.match(d.sentences[0], /users\.id/);
});
test("cardinality is explained with table.column on each side", () => {
  const first = (c) => describeRelationship(rel({ cardinality: c }), "a", "b").sentences[0];
  assert.equal(first("N:M"), "Many rows in a.user_id can match many rows in b.id.");
  assert.equal(first("1:N"), "One row in a.user_id can match many rows in b.id.");
  assert.equal(first("N:1"), "Many rows in a.user_id can match the same row in b.id.");
  assert.match(first("1:1"), /at most one row in b\.id/);
});
test("a compound key lists every column of each table", () => {
  const d = describeRelationship(rel({ pairs: [{ from: "day", to: "date" }] }), "a", "b");
  assert.match(d.sentences[0], /a\.user_id \+ a\.day/);
  assert.match(d.sentences[0], /b\.id \+ b\.date/);
});
test("join types say which rows are kept", () => {
  assert.match(keepSentence("inner", "a", "b"), /only when it has a match/i);
  assert.match(keepSentence("left", "a", "b"), /every a row is shown/i);
  assert.match(keepSentence("right", "a", "b"), /every b row is shown/i);
  assert.match(keepSentence("full", "a", "b"), /every row of a and b/i);
  assert.match(keepSentence("left", "a", "b", false), /main table/);
});
test("a one-to-many link warns that the one side repeats", () => {
  assert.equal(describeRelationship(rel({ cardinality: "1:N" }), "a", "b").sentences.length, 3);
  assert.equal(describeRelationship(rel({ cardinality: "N:1" }), "a", "b").sentences.length, 2);
});
test("a link that aggregates before joining says totals are not repeated, and which way filters go", () => {
  const plain = describeRelationship(rel({ cardinality: "N:M" }), "a", "b").sentences;
  const agg = describeRelationship(rel({ cardinality: "N:M", aggregateFirst: true }), "a", "b").sentences;
  assert.ok(agg.some((s) => /added up by this match first/i.test(s)));
  assert.ok(agg.some((s) => /filtering a also filters b/i.test(s)));
  assert.ok(!agg.some((s) => /counted more than once/.test(s))); // the fan-out warning goes
  assert.ok(plain.some((s) => /counted more than once/.test(s)));
  assert.ok(describeRelationship(rel({ aggregateFirst: true, filterDirection: "single" }), "a", "b").sentences.some((s) => /does not change the other/i.test(s)));
});
test("tones mark the caution and the reassurance; refs list the names to mark, longest first", () => {
  const d = describeRelationship(rel({ cardinality: "1:N" }), "orders", "users");
  assert.deepEqual(d.tones, ["", "", "warn"]);
  assert.match(d.sentences[2], /^Heads up:/);
  assert.deepEqual(d.refs.slice(0, 2).sort(), ["orders.user_id", "users.id"]);
  assert.ok(d.refs.includes("orders") && d.refs.includes("users"));
  assert.deepEqual(describeRelationship(rel({ aggregateFirst: true }), "a", "b").tones, ["", "", "ok", ""]);
});
