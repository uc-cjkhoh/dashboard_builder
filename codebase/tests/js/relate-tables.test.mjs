import { test } from "node:test";
import assert from "node:assert/strict";
import { proposeKey, isKeyish, keyText, MAX_EXTRA_PAIRS } from "../../src/DashboardBuilder/Features/Relations/key-pairs.js";
import { relationBetween, pairFor } from "../../src/DashboardBuilder/Features/Relations/relation-rules.js";
import { dropDecision } from "../../src/DashboardBuilder/Features/Relations/link-drag.js";

const c = (name, category = "numeric") => ({ name, category });
const T = (table, ...columns) => ({ table, columns });

test("isKeyish: names ending in id / key / code / no / num, snake or camel; not words that merely end so", () => {
  for (const n of ["id", "customer_id", "StoreKey", "sku_code", "order_no", "CustomerID", "line num"]) assert.equal(isKeyish(n), true, n);
  for (const n of ["paid", "grid", "piano", "region", "created_at", "monkey"]) assert.equal(isKeyish(n), false, n);
});
test("proposeKey: a foreign key onto the other table's own key wins, either way round", () => {
  const orders = T("orders", c("id"), c("customer_id"), c("region", "text"));
  const customers = T("customers", c("id"), c("region", "text"));
  assert.deepEqual(proposeKey(orders, customers), { first: { from: "customer_id", to: "id" }, pairs: [], score: 3, confident: true });
  assert.deepEqual(proposeKey(customers, orders).first, { from: "id", to: "customer_id" });
});
test("proposeKey: a same-named own key (customers.customer_id) counts as the target too", () => {
  assert.deepEqual(proposeKey(T("orders", c("customer_id")), T("customers", c("customer_id"))).first, { from: "customer_id", to: "customer_id" });
});
test("proposeKey: same-named key columns make a compound key; a bare id is never matched to id", () => {
  const sales = T("sales", c("id"), c("store_id"), c("sku_code", "text"), c("day", "temporal"));
  const stock = T("stock", c("id"), c("store_id"), c("sku_code", "text"), c("day", "temporal"));
  assert.deepEqual(proposeKey(sales, stock), { first: { from: "store_id", to: "store_id" }, pairs: [{ from: "sku_code", to: "sku_code" }], score: 2, confident: true });
  assert.equal(keyText(proposeKey(sales, stock)), "store_id = store_id, sku_code = sku_code");
});
test("proposeKey: a compound key stops at the pair limit", () => {
  const cols = ["a_id", "b_id", "c_id", "d_id", "e_id"].map((n) => c(n));
  assert.equal(proposeKey(T("x", ...cols), T("y", ...cols)).pairs.length, MAX_EXTRA_PAIRS);
});
test("proposeKey: kinds must match, used columns are skipped", () => {
  assert.equal(proposeKey(T("orders", c("customer_id", "text")), T("customers", c("id"))), null);
  assert.equal(proposeKey(T("orders", c("customer_id")), T("customers", c("id")), { from: ["customer_id"] }), null);
});
test("proposeKey: a same-named non-key column is offered but not confident; nothing in common is null", () => {
  assert.deepEqual(proposeKey(T("a", c("region", "text")), T("b", c("region", "text"))), { first: { from: "region", to: "region" }, pairs: [], score: 1, confident: false });
  assert.equal(proposeKey(T("a", c("id"), c("x")), T("b", c("id"), c("y"))), null);
});

const rel = { id: "r1", from: { entityId: "o", column: "customer_id" }, to: { entityId: "c", column: "id" }, cardinality: "N:1" };
test("relationBetween / pairFor: either way round, oriented to the relationship", () => {
  assert.equal(relationBetween([rel], "c", "o"), rel);
  assert.equal(relationBetween([rel], "o", "x"), null);
  assert.deepEqual(pairFor(rel, { entityId: "c", column: "region" }, { entityId: "o", column: "zone" }), { from: "zone", to: "region" });
});
const end = (entityId, table, column, category = "text") => ({ entityId, table, column, category });
test("dropDecision: two more columns of related tables extend that relationship", () => {
  const d = dropDecision({ relationships: [rel], from: end("o", "orders", "region"), to: end("c", "customers", "region") });
  assert.deepEqual(d, { ok: true, problem: null, kind: null, extend: "r1" });
  assert.equal(dropDecision({ relationships: [rel], from: end("o", "orders", "region"), to: end("x", "other", "region") }).extend, undefined);
});
test("dropDecision: a full relationship refuses another pair; the usual refusals still come first", () => {
  const full = { ...rel, pairs: [{ from: "a", to: "a" }, { from: "b", to: "b" }, { from: "d", to: "d" }] };
  const d = dropDecision({ relationships: [full], from: end("o", "orders", "region"), to: end("c", "customers", "region") });
  assert.equal(d.ok, false);
  assert.match(d.problem, /already match on 4 columns/);
  assert.equal(dropDecision({ relationships: [rel], from: end("o", "orders", "region"), to: end("c", "customers", "n", "numeric") }).kind, "type");
});
import { linkHint } from "../../src/DashboardBuilder/Features/Relations/link-keys.js";
test("linkHint: Enter on a column of an already related table says it adds a key column", () => {
  const s = end("o", "orders", "region"), t = end("c", "customers", "region");
  assert.equal(linkHint(s, t, { ok: true, extend: "r1" }), "Relating orders.region. Press Enter to also match it on customers.region (one more key column).");
});
