import { test } from "node:test";
import assert from "node:assert/strict";
import { cardType } from "../../src/DashboardBuilder/Features/Canvas/column-type.js";

test("a card shows the ClickHouse type as it is", () => {
  for (const t of ["UInt64", "Nullable(String)", "Decimal(18, 4)", "DateTime64(3, 'UTC')", "Enum8('a' = 1)", "Map(String, UInt8)", "Point"]) assert.equal(cardType(t), t);
});
test("LowCardinality wrappers are dropped, wherever they sit", () => {
  assert.equal(cardType("LowCardinality(String)"), "String");
  assert.equal(cardType("LowCardinality(Nullable(String))"), "Nullable(String)");
  assert.equal(cardType("Array(LowCardinality(String))"), "Array(String)");
  assert.equal(cardType("Map(LowCardinality(String), LowCardinality(Nullable(FixedString(2))))"), "Map(String, Nullable(FixedString(2)))");
});
test("blank, missing or unbalanced input", () => {
  assert.equal(cardType(""), "");
  assert.equal(cardType(undefined), "");
  assert.equal(cardType("LowCardinality(String"), "LowCardinality(String");
});
