import { test } from "node:test";
import assert from "node:assert/strict";
import { filterTree, capRows, runLimited, initialOpen, ROW_LIMIT } from "../../src/DashboardBuilder/Features/Schema/tree-model.js";

const nodes = [{ db: "sales", tables: ["orders", "customers"] }, { db: "staging", tables: ["orders_raw", "refunds"] }, { db: "web", tables: null }];
test("an empty query keeps every node, loaded or not", () => {
  assert.deepEqual(filterTree(nodes, "  ").map((n) => n.db), ["sales", "staging", "web"]);
});
test("a table match keeps only the matching tables of each database", () => {
  assert.deepEqual(filterTree(nodes, "ORD"), [
    { db: "sales", tables: ["orders"], nameMatch: false }, { db: "staging", tables: ["orders_raw"], nameMatch: false }]);
});
test("a database-name match keeps all its tables, loaded or not", () => {
  assert.deepEqual(filterTree(nodes, "web"), [{ db: "web", tables: null, nameMatch: true }]);
  assert.deepEqual(filterTree(nodes, "stag")[0].tables, ["orders_raw", "refunds"]);
});
test("no match gives no nodes", () => assert.deepEqual(filterTree(nodes, "zzz"), []));
test("capRows holds back rows past the limit unless showAll", () => {
  const list = Array.from({ length: ROW_LIMIT + 5 }, (_, i) => `t${i}`);
  assert.deepEqual(capRows(list, false).hidden, 5);
  assert.equal(capRows(list, false).rows.length, ROW_LIMIT);
  assert.equal(capRows(list, true).hidden, 0);
  assert.equal(capRows(["a"], false).hidden, 0);
});
test("runLimited never runs more than the limit at once, and runs everything", async () => {
  let live = 0, peak = 0; const done = [];
  await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); done.push(n); live--; });
  assert.equal(peak, 3); assert.equal(done.length, 7);
  await runLimited([], 4, async () => assert.fail("nothing to run"));
});
const base = { user: ["sales", "web"], system: ["system"] };
test("a first visit opens the first user database", () => {
  assert.deepEqual(initialOpen({ ...base, remembered: null }), { open: ["sales"], system: false });
  assert.deepEqual(initialOpen({ user: [], system: ["system"], remembered: null }), { open: [], system: false });
});
test("a remembered set is respected, even when empty, and drops databases that are gone", () => {
  assert.deepEqual(initialOpen({ ...base, remembered: { open: ["web", "gone"], system: false } }), { open: ["web"], system: false });
  assert.deepEqual(initialOpen({ ...base, remembered: { open: [], system: false } }), { open: [], system: false });
});
test("a database with a card on the canvas opens, and so does the System group for a system one", () => {
  assert.deepEqual(initialOpen({ ...base, remembered: { open: [], system: false }, placed: ["web", "web", "nope"] }), { open: ["web"], system: false });
  assert.deepEqual(initialOpen({ ...base, remembered: null, placed: ["system"] }), { open: ["system"], system: true });
  assert.equal(initialOpen({ user: ["a"], system: [], remembered: { open: [], system: true } }).system, false);
});
