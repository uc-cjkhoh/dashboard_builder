import { test } from "node:test";
import assert from "node:assert/strict";
import { splitDatabases, dbMemoryKey, rememberOpen, recallOpen, sanitizeOpenMemory } from "../../src/DashboardBuilder/Features/Schema/schema-model.js";

test("system databases come after the user ones, order kept", () => {
  const r = splitDatabases(["INFORMATION_SCHEMA", "default", "information_schema", "shop", "system"]);
  assert.deepEqual(r.user, ["default", "shop"]);
  assert.deepEqual(r.system, ["INFORMATION_SCHEMA", "information_schema", "system"]);
});
const view = { host: "ch1", port: 8443, user: "ann" };
test("the open databases are remembered per host, port and user", () => {
  assert.equal(dbMemoryKey(view), "ch1|8443|ann");
  let m = rememberOpen({}, view, { open: ["shop", "web"], system: true });
  m = rememberOpen(m, { ...view, user: "bob" }, { open: ["default"], system: false });
  assert.deepEqual(recallOpen(m, view), { open: ["shop", "web"], system: true });
  assert.deepEqual(recallOpen(m, { ...view, user: "bob" }), { open: ["default"], system: false });
});
test("a server with no memory recalls null; an empty open set is still a memory", () => {
  assert.equal(recallOpen({}, view), null);
  assert.deepEqual(recallOpen(rememberOpen({}, view, { open: [], system: false }), view), { open: [], system: false });
});
test("stored memory is cleaned and bounded", () => {
  assert.deepEqual(sanitizeOpenMemory(null), {});
  assert.deepEqual(sanitizeOpenMemory({ a: { open: ["x", "x", 5, ""], system: "yes" }, b: "no", c: [1] }), { a: { open: ["x"], system: false } });
  let m = {}; for (let i = 0; i < 40; i++) m = rememberOpen(m, { ...view, host: `h${i}` }, { open: ["d"], system: false });
  assert.equal(Object.keys(m).length, 20);
  assert.deepEqual(recallOpen(m, { ...view, host: "h39" }), { open: ["d"], system: false });
  const many = rememberOpen({}, view, { open: Array.from({ length: 80 }, (_, i) => `d${i}`), system: false });
  assert.equal(recallOpen(many, view).open.length, 50);
  assert.equal(recallOpen(many, view).open.at(-1), "d79");
});
