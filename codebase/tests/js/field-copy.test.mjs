import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldCopies } from "../../src/DashboardBuilder/Features/Dashboard/field-copy-model.js";

test("a column field offers its column name, and its display name when renamed", () => {
  assert.deepEqual(fieldCopies({ column: "amount" }), [{ label: "Copy name", text: "amount", what: "the field name" }]);
  assert.deepEqual(fieldCopies({ column: "amount", alias: "Revenue" }), [
    { label: "Copy name", text: "Revenue", what: "the field name" },
    { label: "Copy column name", text: "amount", what: "the column name" },
  ]);
});
test("a calculated field offers its name and its formula", () => {
  assert.deepEqual(fieldCopies({ name: "Margin", formula: "[a] - [b]" }), [
    { label: "Copy name", text: "Margin", what: "the field name" },
    { label: "Copy formula", text: "[a] - [b]", what: "the formula" },
  ]);
});
test("a group field has no formula to copy", () => {
  assert.deepEqual(fieldCopies({ name: "Region group", formula: "", group: {} }).map((c) => c.label), ["Copy name"]);
});
