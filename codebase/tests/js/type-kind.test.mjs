import { test } from "node:test";
import assert from "node:assert/strict";
import { friendlyKind } from "../../src/DashboardBuilder/Features/Schema/type-kind.js";

test("raw ClickHouse types become plain kinds", () => {
  const cases = {
    UInt64: "whole number", Int32: "whole number", "Nullable(Int8)": "whole number",
    "Nullable(String)": "text", "LowCardinality(String)": "text", "LowCardinality(Nullable(String))": "text", FixedString: "text", UUID: "text", "Enum8('a' = 1)": "text",
    "Decimal(10, 2)": "number", Float64: "number", "Nullable(Decimal(18, 4))": "number",
    Date: "date", Date32: "date", DateTime: "date & time", "DateTime64(3)": "date & time", "DateTime('UTC')": "date & time",
    Bool: "true/false", "Array(String)": "list", "Map(String, UInt8)": "map", "Tuple(a Int8)": "group",
  };
  for (const [raw, kind] of Object.entries(cases)) assert.equal(friendlyKind(raw), kind, raw);
});
test("an unknown type is shown as it is", () => {
  assert.equal(friendlyKind("Point"), "Point");
  assert.equal(friendlyKind(""), "");
  assert.equal(friendlyKind(undefined), "");
});
