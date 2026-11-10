import { test } from "node:test";
import assert from "node:assert/strict";
import { splitDatabases, dbMemoryKey, rememberDb, recallDb, sanitizeDbMemory } from "../../src/DashboardBuilder/Features/Schema/schema-model.js";

test("system databases come after the user ones, order kept", () => {
  const r = splitDatabases(["INFORMATION_SCHEMA", "default", "information_schema", "shop", "system"]);
  assert.deepEqual(r.user, ["default", "shop"]);
  assert.deepEqual(r.system, ["INFORMATION_SCHEMA", "information_schema", "system"]);
});
const view = { host: "ch1", port: 8443, user: "ann" };
test("the last database is remembered per host, port and user", () => {
  assert.equal(dbMemoryKey(view), "ch1|8443|ann");
  let m = rememberDb({}, view, "shop");
  m = rememberDb(m, { ...view, user: "bob" }, "default");
  assert.equal(recallDb(m, view, ["default", "shop"]), "shop");
  assert.equal(recallDb(m, { ...view, user: "bob" }, ["default", "shop"]), "default");
});
test("a remembered database that no longer exists is ignored", () => {
  assert.equal(recallDb(rememberDb({}, view, "gone"), view, ["shop"]), "");
  assert.equal(recallDb({}, view, ["shop"]), "");
});
test("stored memory is cleaned and bounded", () => {
  assert.deepEqual(sanitizeDbMemory(null), {});
  assert.deepEqual(sanitizeDbMemory({ a: "x", b: 5, c: "" }), { a: "x" });
  let m = {}; for (let i = 0; i < 40; i++) m = rememberDb(m, { ...view, host: `h${i}` }, "d");
  assert.equal(Object.keys(m).length, 20);
  assert.equal(recallDb(m, { ...view, host: "h39" }, ["d"]), "d");
});
