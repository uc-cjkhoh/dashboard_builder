import { test } from "node:test";
import assert from "node:assert/strict";
import { isNumericType, autoWidth, stepWidth, dragWidth, widthMemory, COL_MIN, COL_MAX, AUTO_MAX } from "../../src/DashboardBuilder/Features/Canvas/preview-columns.js";

test("numbers are UInt*, Int*, Float*, Decimal — through Nullable and LowCardinality", () => {
  for (const t of ["UInt8", "Int64", "UInt256", "Float32", "Float64", "Decimal(18, 4)", "Decimal64(2)", "Nullable(Int32)", "LowCardinality(Nullable(Float64))"]) assert.equal(isNumericType(t), true, t);
  for (const t of ["String", "Date", "DateTime64(3)", "Nullable(String)", "Array(Int32)", "Bool", "UUID", "IntervalDay", "", undefined]) assert.equal(isNumericType(t), false, String(t));
});
test("an automatic width fits the content, between the minimum and the automatic cap", () => {
  assert.equal(autoWidth(10), COL_MIN);
  assert.equal(autoWidth(120.2), 121);
  assert.equal(autoWidth(5000), AUTO_MAX);
  assert.equal(autoWidth(NaN), COL_MIN);
});
test("a drag moves the width by the distance dragged, inside the bounds", () => {
  assert.equal(dragWidth(120, 37), 157);
  assert.equal(dragWidth(120, -200), COL_MIN);
  assert.equal(dragWidth(500, 400), COL_MAX);
});
test("← / → step 8px, Shift five steps", () => {
  assert.equal(stepWidth(120, "ArrowRight"), 128);
  assert.equal(stepWidth(120, "ArrowLeft"), 112);
  assert.equal(stepWidth(120, "ArrowRight", true), 160);
  assert.equal(stepWidth(COL_MIN, "ArrowLeft"), COL_MIN);
});
test("widths are kept per card and column, and cleared per column or per card", () => {
  const m = widthMemory();
  assert.equal(m.get("e1", "id"), null);
  m.set("e1", "id", 90); m.set("e1", "name", 200); m.set("e2", "id", 70);
  assert.equal(m.get("e1", "id"), 90);
  m.clear("e1", "id");
  assert.equal(m.get("e1", "id"), null);
  assert.equal(m.get("e1", "name"), 200);
  m.clear("e1");
  assert.equal(m.get("e1", "name"), null);
  assert.equal(m.get("e2", "id"), 70);
});
