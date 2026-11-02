import { test } from "node:test";
import assert from "node:assert/strict";
import { linkKeyAction, stepIndex, cardIndex, linkHint, rowLabel } from "../../src/DashboardBuilder/Features/Relations/link-keys.js";

const src = { entityId: "e1", column: "cust_id", table: "orders" };
const tgt = { entityId: "e2", column: "id", table: "customers" };

test("Enter and Space pick, then relate; Escape only cancels a pick", () => {
  assert.equal(linkKeyAction("Enter", false), "pick");
  assert.equal(linkKeyAction(" ", false), "pick");
  assert.equal(linkKeyAction("Enter", true), "target");
  assert.equal(linkKeyAction(" ", true), "target");
  assert.equal(linkKeyAction("Escape", true), "cancel");
  assert.equal(linkKeyAction("Escape", false), null);
  assert.equal(linkKeyAction("a", true), null);
});
test("arrows move between rows, clamped", () => {
  assert.equal(linkKeyAction("ArrowDown", false), "next");
  assert.equal(linkKeyAction("ArrowUp", true), "prev");
  assert.equal(stepIndex(0, 3, 1), 1);
  assert.equal(stepIndex(2, 3, 1), 2);
  assert.equal(stepIndex(0, 3, -1), 0);
  assert.equal(stepIndex(-1, 3, 1), 0);
  assert.equal(stepIndex(-1, 3, -1), 2);
  assert.equal(stepIndex(0, 0, 1), -1);
});
test("hint says what to do, or why the focused column is refused", () => {
  assert.equal(linkHint(null, tgt, null), "");
  assert.match(linkHint(src, null, null), /Relating orders\.cust_id\. Move to a column in another table/);
  assert.match(linkHint(src, src, null), /Move to a column/);
  assert.match(linkHint(src, tgt, { ok: true }), /Press Enter to relate it to customers\.id/);
  assert.match(linkHint(src, tgt, { ok: false, problem: "Pick a column in a different table." }), /Can't relate to customers\.id: Pick a column in a different table\./);
  assert.match(linkHint(src, tgt, { ok: false, problem: null }), /^Can't relate to customers\.id\. Relating/);
});
test("row labels carry name, type, table and the next step", () => {
  assert.equal(rowLabel({ ...tgt }, "Int32", src), "id, Int32, in customers");
});

test("Home/End and [ ] are mapped", () => {
  assert.equal(linkKeyAction("Home", false), "first");
  assert.equal(linkKeyAction("End", true), "last");
  assert.equal(linkKeyAction("]", false), "nextCard");
  assert.equal(linkKeyAction("[", true), "prevCard");
});
test("cardIndex wraps around the cards", () => {
  assert.equal(cardIndex(0, 3, 1), 1);
  assert.equal(cardIndex(2, 3, 1), 0);
  assert.equal(cardIndex(0, 3, -1), 2);
  assert.equal(cardIndex(-1, 3, 1), 0);
  assert.equal(cardIndex(-1, 3, -1), 2);
  assert.equal(cardIndex(0, 0, 1), -1);
});
test("the hint names the card-switch keys", () => {
  assert.match(linkHint(src, null, null), /\[ and \]/);
});
test("the hint puts the reason first for a refused column", () => {
  assert.match(linkHint(src, tgt, { ok: false, problem: "Same table." }), /^Can't relate to customers\.id: Same table\./);
});
test("row labels no longer carry instructions", () => {
  assert.equal(rowLabel({ ...src }, "Int32", null), "cust_id, Int32, in orders");
  assert.equal(rowLabel({ ...src }, "Int32", src), "cust_id, Int32, in orders, source");
});
