import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestPairs, addPair, pairText, compoundName, MAX_EXTRA_PAIRS } from "../../src/DashboardBuilder/Features/Relations/key-pairs.js";

const c = (name, category = "numeric") => ({ name, type: "x", category });
const orders = [c("id"), c("customer_id"), c("region", "text"), c("placed", "temporal"), c("note", "compound")];
const customers = [c("id"), c("CustomerId"), c("region", "text"), c("born", "temporal"), c("note", "compound")];

test("suggestPairs: same name (ignoring case and _ - spaces) and same kind, one per column", () => {
  const s = suggestPairs(orders, customers, { from: ["id"], to: ["id"] });
  assert.deepEqual(s.map((p) => [p.from, p.to]), [["region", "region"], ["customer_id", "CustomerId"]]);
});
test("suggestPairs: exact names come before looser ones", () => {
  const s = suggestPairs([c("a_b"), c("ab")], [c("AB"), c("a_b")], {});
  assert.deepEqual(s.map((p) => [p.from, p.to, p.exact]), [["a_b", "a_b", true], ["ab", "AB", false]]);
});
test("suggestPairs: kinds must be compatible, and compound / other columns never match", () => {
  assert.deepEqual(suggestPairs([c("x", "numeric")], [c("x", "text")], {}), []);
  assert.deepEqual(suggestPairs([c("n", "compound")], [c("n", "compound")], {}), []);
});
test("suggestPairs: used columns are left out, and nothing past the limit is offered", () => {
  assert.deepEqual(suggestPairs(orders, customers, { from: ["id", "customer_id", "region"] }), []);
  const many = ["a", "b", "c", "d", "e"].map((n) => c(n));
  assert.equal(suggestPairs(many, many, {}).length, MAX_EXTRA_PAIRS);
  assert.equal(suggestPairs(many, many, {}, 1).length, 1);
});
const ctx = { fromCols: orders, toCols: customers, used: { from: ["id"], to: ["id"] } };
test("addPair: appends a compatible free pair", () => {
  const r = addPair([], "region", "region", ctx);
  assert.deepEqual(r, { ok: true, pairs: [{ from: "region", to: "region" }] });
});
test("addPair: refuses a pair that is used, mismatched, duplicate or past the limit", () => {
  assert.match(addPair([], "id", "region", ctx).problem, /already in a relationship/);
  assert.match(addPair([], "region", "born", ctx).problem, /same kind/);
  assert.match(addPair([{ from: "region", to: "region" }], "region", "region", ctx).problem, /already/);
  assert.match(addPair([{ from: "customer_id", to: "CustomerId" }], "region", "CustomerId", ctx).problem, /already/);
  const full = [{ from: "a", to: "a" }, { from: "b", to: "b" }, { from: "c", to: "c" }];
  assert.match(addPair(full, "region", "region", ctx).problem, /at most/);
  assert.match(addPair([], "", "region", ctx).problem, /Pick/);
});
test("pairText and compoundName word the key", () => {
  assert.equal(pairText({ from: "a", to: "b" }), "a = b");
  assert.equal(compoundName("id", []), "id");
  assert.equal(compoundName("id", [{ from: "x", to: "y" }, { from: "z", to: "w" }], "from"), "id + x + z");
  assert.equal(compoundName("id", [{ from: "x", to: "y" }], "to"), "id + y");
});

import { suggestTarget } from "../../src/DashboardBuilder/Features/Relations/key-pairs.js";
test("suggestTarget: exact name beats a normalised one; same kind only; used columns skipped", () => {
  assert.equal(suggestTarget(c("region", "text"), [c("Region", "text"), c("region", "text")]), "region");
  assert.equal(suggestTarget(c("customer_id"), customers), "CustomerId");
  assert.equal(suggestTarget(c("region", "text"), [c("region")]), null);
  assert.equal(suggestTarget(c("id"), customers, ["id"]), null);
  assert.equal(suggestTarget(c("nothing"), customers), null);
});
