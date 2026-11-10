import test from "node:test";
import assert from "node:assert/strict";
import { treeFields, calcOnTable } from "../../src/DashboardBuilder/Features/Calc/calc-tree.js";

const field = (table, column = "a", db = "d") => ({ k: "field", db, table, column });
const bin = (l, r) => ({ k: "bin", op: "*", l, r });

test("treeFields lists every field, nested in bin / fn args", () => {
  const t = bin(field("o", "a"), { k: "fn", fn: "abs", args: [field("c", "b"), { k: "num", v: 1 }] });
  assert.deepEqual(treeFields(t).map((f) => `${f.table}.${f.column}`), ["o.a", "c.b"]);
});
test("calcOnTable: all fields on the table, a constant, or not", () => {
  assert.equal(calcOnTable(bin(field("o"), { k: "num", v: 2 }), "d", "o"), true);
  assert.equal(calcOnTable({ k: "num", v: 1 }, "d", "o"), true);
  assert.equal(calcOnTable(bin(field("o"), field("c")), "d", "o"), false);
  assert.equal(calcOnTable(field("o", "a", "other"), "d", "o"), false);
  assert.equal(calcOnTable(null, "d", "o"), false);
});
