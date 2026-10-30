import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeColumnDrag, parseColumnDrag, dropDecision, COLUMN_MIME } from "../../src/DashboardBuilder/Features/Relations/link-drag.js";

const from = { entityId: "e1", column: "cust_id", category: "numeric", table: "orders" };
const to = { entityId: "e2", column: "id", category: "numeric", table: "customers" };

test("the payload round-trips and uses its own MIME type", () => {
  assert.equal(COLUMN_MIME, "application/x-ch-column");
  assert.deepEqual(parseColumnDrag(encodeColumnDrag("e1", "cust_id")), { entityId: "e1", column: "cust_id" });
});
test("malformed payloads are ignored", () => {
  for (const raw of [null, "", "x", "{}", '{"entityId":1,"column":"a"}', '{"entityId":"e","column":""}', "[1]"]) assert.equal(parseColumnDrag(raw), null);
});
test("a compatible pair on different cards is ok", () => {
  assert.deepEqual(dropDecision({ relationships: [], from, to }), { ok: true, problem: null, kind: null });
});
test("no target means not ok and no message", () => {
  assert.deepEqual(dropDecision({ relationships: [], from, to: null }), { ok: false, problem: null, kind: null });
});
test("same card, duplicate and kind mismatch are refused with the existing wording", () => {
  assert.match(dropDecision({ relationships: [], from, to: { ...to, entityId: "e1" } }).problem, /different table/);
  const rel = { from: { entityId: "e2", column: "id" }, to: { entityId: "e1", column: "cust_id" } };
  assert.match(dropDecision({ relationships: [rel], from, to }).problem, /already related/);
  const bad = dropDecision({ relationships: [], from, to: { ...to, category: "text" } });
  assert.equal(bad.ok, false);
  assert.match(bad.problem, /orders\.cust_id \(numeric\).*customers\.id \(text\)/);
});
