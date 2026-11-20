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
test("cardinality is explained in short sentences, then the key columns", () => {
  const first = (c) => describeRelationship(rel({ cardinality: c }), "a", "b").sentences[0];
  assert.equal(first("N:M"), "Many a rows can match many b rows. Matched on a.user_id and b.id.");
  assert.equal(first("1:N"), "One a row can match many b rows. Matched on a.user_id and b.id.");
  assert.equal(first("N:1"), "Many a rows can match the same b row. Matched on a.user_id and b.id.");
  assert.match(first("1:1"), /at most one b row, and the other way around\. Matched on/);
});
test("the card title says the kind in words", () => {
  assert.equal(describeRelationship(rel({ cardinality: "1:N" }), "a", "b").kind, "one to many");
  assert.equal(describeRelationship(rel({ cardinality: "N:1" }), "a", "b").kind, "many to one");
  assert.equal(describeRelationship(rel({ cardinality: "1:1" }), "a", "b").kind, "one to one");
  assert.equal(describeRelationship(rel({ cardinality: "N:M" }), "a", "b").kind, "many to many");
});
test("a compound key lists every column of each table", () => {
  const d = describeRelationship(rel({ pairs: [{ from: "day", to: "date" }] }), "a", "b");
  assert.match(d.sentences[0], /a\.user_id \+ a\.day/);
  assert.match(d.sentences[0], /b\.id \+ b\.date/);
});
test("join types say which rows are kept", () => {
  assert.match(keepSentence("inner", "a", "b"), /only rows with a match/i);
  assert.match(keepSentence("left", "a", "b"), /all a rows, even with no match in b/i);
  assert.match(keepSentence("right", "a", "b"), /all b rows, even with no match in a/i);
  assert.match(keepSentence("full", "a", "b"), /all rows of a and b/i);
  assert.match(keepSentence("left", "a", "b", false), /main table/);
});
test("a one-to-many link warns that the one side repeats", () => {
  assert.equal(describeRelationship(rel({ cardinality: "1:N" }), "a", "b").sentences.length, 3);
  assert.equal(describeRelationship(rel({ cardinality: "N:1" }), "a", "b").sentences.length, 2);
});
test("a link that aggregates before joining says totals are not repeated, and which way filters go", () => {
  const plain = describeRelationship(rel({ cardinality: "N:M" }), "a", "b").sentences;
  const agg = describeRelationship(rel({ cardinality: "N:M", aggregateFirst: true }), "a", "b").sentences;
  assert.ok(agg.some((s) => /totalled by the key first/i.test(s)));
  assert.ok(agg.some((s) => /filtering a also filters b/i.test(s)));
  assert.ok(!agg.some((s) => /counted more than once/.test(s))); // the fan-out warning goes
  assert.ok(plain.some((s) => /counted more than once\. Turn on Totals/.test(s))); // the caution says what to do about it
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
test("a note is its sentences only: no section titles repeating what each says", () => {
  for (const o of [{ cardinality: "N:M" }, { aggregateFirst: true }, {}]) assert.equal(describeRelationship(rel(o), "a", "b").heads, undefined);
});
