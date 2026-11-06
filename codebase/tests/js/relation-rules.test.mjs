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

// Right and full joins.
import { JOIN_TYPES, normalizeJoinType, joinChoices, planJoinType, joinBadge, joinSelection, joinFromSelection, isLegacyLeft } from "../../src/DashboardBuilder/Features/Relations/relation-rules.js";

test("join types are inner, left, right, full; anything else reads as inner", () => {
  assert.deepEqual(JOIN_TYPES, ["inner", "left", "right", "full"]);
  for (const t of JOIN_TYPES) assert.equal(normalizeJoinType(t), t);
  for (const t of [undefined, null, "FULL", "cross", "full outer", 3]) assert.equal(normalizeJoinType(t), "inner");
});

test("dialog choices name the tables in plain words", () => {
  const c = joinChoices("orders", "customers");
  assert.deepEqual(c.map((x) => x.value), ["inner", "left", "right", "full"]);
  assert.deepEqual(c.map((x) => x.text), ["Inner join", "Left join", "Right join", "Full outer join"]);
  assert.equal(c[1].hint, "All rows of orders");
  assert.equal(c[2].hint, "All rows of customers");
  assert.equal(c[3].hint, "All rows of both");
  assert.match(c[0].hint, /only rows that match/i);
});

test("the FROM side is the left side: planning in reverse swaps left and right", () => {
  assert.equal(planJoinType("left", true, true), "left");
  assert.equal(planJoinType("left", false, true), "right");
  assert.equal(planJoinType("right", true, true), "right");
  assert.equal(planJoinType("right", false, true), "left");
  assert.equal(planJoinType("full", false, true), "full");
  assert.equal(planJoinType("inner", false, true), "inner");
  assert.equal(planJoinType("bogus", false, true), "inner");
});

test("badge says the join in words", () => {
  assert.equal(joinBadge("1:N", "inner"), "1:N");
  assert.equal(joinBadge("1:N", "left"), "1:N · left");
  assert.equal(joinBadge("N:M", "full"), "N:M · full");
});

test("a legacy left link (not fixed) is LEFT in both view orientations, exactly as before", () => {
  for (const fixed of [false, undefined]) {
    assert.equal(planJoinType("left", true, fixed), "left");
    assert.equal(planJoinType("left", false, fixed), "left");
  }
  assert.equal(planJoinType("left"), "left"); // no tag at all
  assert.equal(planJoinType("inner", false, false), "inner");
});

test("legacy left gets its own dialog choice; re-saving fixes the sides", () => {
  assert.equal(isLegacyLeft("left", false), true);
  assert.equal(isLegacyLeft("left", true), false);
  assert.equal(isLegacyLeft("inner", false), false);
  assert.equal(joinSelection("left", false), "legacy");
  assert.equal(joinSelection("left", true), "left");
  assert.equal(joinSelection("full", false), "full");
  const c = joinChoices("orders", "customers", true);
  assert.deepEqual(c.map((x) => x.value), ["inner", "legacy", "left", "right", "full"]);
  assert.equal(c[1].text, "Left join (older link)");
  assert.deepEqual(joinChoices("a", "b").map((x) => x.value), ["inner", "left", "right", "full"]);
  assert.deepEqual(joinFromSelection("legacy"), { joinType: "left", joinFixed: false });
  assert.deepEqual(joinFromSelection("left"), { joinType: "left", joinFixed: true });
  assert.deepEqual(joinFromSelection("inner"), { joinType: "inner", joinFixed: true });
});

test("badge prints the normalised type", () => {
  assert.equal(joinBadge("1:N", "bogus"), "1:N");
  assert.equal(joinBadge("1:N", undefined), "1:N");
});

import { relationshipOf, unlinkedCards } from "../../src/DashboardBuilder/Features/Relations/relation-rules.js";
test("a column already in a relationship can't take a second one, on either end", () => {
  const rel = { from: a, to: b, cardinality: "1:N" };
  const other = { entityId: "e3", column: "ref" };
  assert.equal(relationshipOf([rel], a), rel);
  assert.equal(relationshipOf([rel], b), rel);
  assert.equal(relationshipOf([rel], other), null);
  assert.match(linkProblem({ ...base, relationships: [rel], to: other, toLabel: "payments.ref" }), /orders\.customer_id is already in a relationship/);
  assert.match(linkProblem({ ...base, relationships: [rel], from: other, fromLabel: "payments.ref", to: b }), /customers\.id is already in a relationship/);
});
test("linkProblem reads an iterator more than once", () => {
  const rel = { from: a, to: { entityId: "e9", column: "x" }, cardinality: "1:N" };
  assert.match(linkProblem({ ...base, relationships: new Set([rel]).values() }), /already in a relationship/);
});
test("a card in no relationship is flagged once there are two relatable cards", () => {
  const rel = { from: { entityId: "e1", column: "k" }, to: { entityId: "e2", column: "k" } };
  assert.deepEqual(unlinkedCards([{ id: "e1" }], []), []);
  assert.deepEqual(unlinkedCards([{ id: "e1" }, { id: "e2" }], []), ["e1", "e2"]);
  assert.deepEqual(unlinkedCards([{ id: "e1" }, { id: "e2" }, { id: "e3" }], [rel]), ["e3"]);
  assert.deepEqual(unlinkedCards([{ id: "e1" }, { id: "e2" }, { id: "u", source: true }], [rel]), []);
  assert.deepEqual(unlinkedCards([{ id: "e1" }, { id: "u", source: true }], []), []);
});

import { linkIssue, matchingColumns, kindLabel } from "../../src/DashboardBuilder/Features/Relations/relation-rules.js";
test("a type mismatch is reported as a type issue; other refusals are not", () => {
  assert.equal(linkIssue({ ...base, toCategory: "text" }).kind, "type");
  assert.equal(linkIssue({ ...base, toCategory: "compound", fromCategory: "compound" }).kind, "type");
  assert.equal(linkIssue({ ...base, to: { entityId: "e1", column: "x" } }).kind, "other");
  assert.equal(linkIssue(base), null);
});
test("kinds read as number, text, date, boolean", () => {
  assert.deepEqual(["numeric", "text", "temporal", "boolean", "compound"].map(kindLabel), ["number", "text", "date", "boolean", "compound"]);
});
test("matching columns are the same kind, not already used, at most five", () => {
  const cols = [{ name: "a", category: "numeric" }, { name: "b", category: "text" }, { name: "c", category: "numeric" }, { name: "d", category: "numeric" }];
  assert.deepEqual(matchingColumns(cols, "numeric"), ["a", "c", "d"]);
  assert.deepEqual(matchingColumns(cols, "numeric", ["c"]), ["a", "d"]);
  assert.deepEqual(matchingColumns(cols, "numeric", [], 2), ["a", "c"]);
  assert.deepEqual(matchingColumns(cols, "boolean"), []);
});

import { heldOutCards, heldOutProblem } from "../../src/DashboardBuilder/Features/Relations/relation-rules.js";
const ent = (id, table, source) => [id, { id, db: "s", table, ...(source ? { source: {} } : {}) }];
test("held-out cards: those in no relationship once the model has two relatable cards", () => {
  const rels = new Map([["r1", { from: { entityId: "a", column: "k" }, to: { entityId: "b", column: "k" } }]]);
  assert.deepEqual(heldOutCards(new Map([ent("a", "orders"), ent("b", "customers"), ent("c", "payments")]), rels).map((c) => c.table), ["payments"]);
  assert.deepEqual(heldOutCards(new Map([ent("a", "orders")]), new Map()), []);
  assert.deepEqual(heldOutCards(new Map([ent("a", "orders"), ent("u", "u1", true)]), new Map()), []);
});
test("a view reading a held-out table is refused, naming it", () => {
  const ents = new Map([ent("a", "orders"), ent("b", "customers"), ent("c", "payments")]);
  const rels = new Map([["r1", { from: { entityId: "a", column: "k" }, to: { entityId: "b", column: "k" } }]]);
  assert.match(heldOutProblem(["s\u0000payments"], ents, rels), /^payments isn't related to another table yet/);
  assert.equal(heldOutProblem(["s\u0000orders", "s\u0000customers"], ents, rels), null);
  assert.equal(heldOutProblem(["s\u0000payments"], new Map([ent("c", "payments")]), new Map()), null);
});

import { pinOrder } from "../../src/DashboardBuilder/Features/Relations/relation-rules.js";
test("pinned keys follow their partner's position, then the order the relationships were made", () => {
  assert.deepEqual(pinOrder([{ column: "b", partnerTop: 0, seq: 2 }, { column: "a", partnerTop: 0, seq: 1 }]), ["a", "b"]); // not alphabetical by column
  assert.deepEqual(pinOrder([{ column: "a", partnerTop: 300, seq: 1 }, { column: "z", partnerTop: 20, seq: 2 }]), ["z", "a"]); // the upper partner first
  assert.deepEqual(pinOrder([{ column: "x", partnerTop: 0, seq: 3 }, { column: "y", partnerTop: 0, seq: 1 }, { column: "w", partnerTop: 0, seq: 2 }]), ["y", "w", "x"]);
});

// --- compound keys: extra pairs on a relationship count as columns in it
import { relEnds } from "../../src/DashboardBuilder/Features/Relations/relation-rules.js";
test("a relationship's extra pairs put their columns in it too", () => {
  const rel = { from: a, to: b, cardinality: "1:N", pairs: [{ from: "region", to: "area" }] };
  assert.equal(relEnds(rel).length, 4);
  assert.equal(relationshipOf([rel], { entityId: "e1", column: "region" }), rel);
  assert.equal(relationshipOf([rel], { entityId: "e2", column: "area" }), rel);
  assert.equal(relationshipOf([rel], { entityId: "e1", column: "area" }), null); // the pair is per side
  assert.match(linkProblem({ ...base, relationships: [rel], from: { entityId: "e1", column: "region" }, to: { entityId: "e2", column: "x" } }), /already in a relationship/);
  assert.equal(relEnds({ from: a, to: b }).length, 2);
});
test("the badge counts the keys of a compound link", () => {
  assert.equal(joinBadge("1:N", "inner"), "1:N");
  assert.equal(joinBadge("1:N", "inner", 2), "1:N · 3 keys");
  assert.equal(joinBadge("1:N", "left", 1), "1:N · left · 2 keys");
});

// Aggregate before joining (P43).
import { normalizeFilterDirection, applyAggregate, aggregateChoice } from "../../src/DashboardBuilder/Features/Relations/relation-rules.js";
test("a filter direction is both unless it says single", () => {
  assert.equal(normalizeFilterDirection("single"), "single");
  for (const v of ["both", "up", undefined, null, 3]) assert.equal(normalizeFilterDirection(v), "both");
});
test("applyAggregate stores only what differs from the plain join", () => {
  const r = {};
  applyAggregate(r, { aggregate: true, direction: "both" });
  assert.deepEqual(r, { aggregateFirst: true });
  applyAggregate(r, { aggregate: true, direction: "single" });
  assert.deepEqual(r, { aggregateFirst: true, filterDirection: "single" });
  applyAggregate(r, { aggregate: false, direction: "single" }); // direction means nothing without aggregating
  assert.deepEqual(r, {});
});
test("aggregateChoice reads a saved relationship back into the dialog's two controls", () => {
  assert.deepEqual(aggregateChoice({}), { aggregate: false, direction: "both" });
  assert.deepEqual(aggregateChoice({ aggregateFirst: true, filterDirection: "single" }), { aggregate: true, direction: "single" });
  assert.deepEqual(aggregateChoice({ aggregateFirst: "yes" }), { aggregate: false, direction: "both" });
});
